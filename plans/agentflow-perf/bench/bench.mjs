// node bench.mjs --flows direct,chain150 --modes token,recording --n 100 --warmup 20 [--streaming true] --out <file in ../results>
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { performance } from 'perf_hooks'
import { fileURLToPath } from 'url'
import { FlowiseClient, loadCaptureEnv } from '../../agentflow-trusted-state/baselines/lib/flowise-client.mjs'
import { FLOWS, NODE_NAMES } from './flows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPANS = process.env.BENCH_OUT ?? path.join(HERE, 'spans.jsonl')
const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
)
const flowNames = (args.flows ?? 'direct').split(',')
const modeNames = (args.modes ?? 'token').split(',')
const N = Number(args.n ?? 100)
const WARMUP = Number(args.warmup ?? 20)
const STREAMING = args.streaming === 'true'

// token: Client State on with zero retention (no ChatMessage/Execution rows); recording: Client State off (rows written)
const MODES = {
    token: { clientState: { enabled: true, enabledFull: true } },
    recording: { clientState: { enabled: false, enabledFull: false } }
}

const env = loadCaptureEnv()
const client = new FlowiseClient(env.FLOWISE_BASE_URL)
await client.login(env.FLOWISE_EMAIL, env.FLOWISE_PASSWORD)
const defs = {}
for (const name of NODE_NAMES) defs[name] = await client.api(`/api/v1/nodes/${name}`)

const flowId = (flow, mode) => {
    const h = crypto.createHash('sha256').update(`perf|${flow}|${mode}`).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function upsert(id, name, flowData, chatbotConfig) {
    const body = { name, flowData, type: 'AGENTFLOW', chatbotConfig: JSON.stringify(chatbotConfig) }
    let exists = true
    try {
        await client.api(`/api/v1/chatflows/${id}`)
    } catch {
        exists = false
    }
    if (exists) await client.api(`/api/v1/chatflows/${id}`, { method: 'PUT', body })
    else await client.api('/api/v1/chatflows', { method: 'POST', body: { id, deployed: false, isPublic: false, ...body } })
}

let seq = 0
async function predict(id, body) {
    const benchId = `r${++seq}-${Date.now()}`
    const t0 = performance.now()
    const res = await fetch(`${env.FLOWISE_BASE_URL}/api/v1/prediction/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bench-id': benchId },
        body: JSON.stringify({ ...body, streaming: STREAMING })
    })
    const text = await res.text()
    const ms = performance.now() - t0
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
    let json
    if (STREAMING) {
        const meta = text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => JSON.parse(l.slice(5)))
        json = {
            text: meta
                .filter((e) => e.event === 'token')
                .map((e) => e.data)
                .join(''),
            trustedState: meta.find((e) => e.event === 'trustedStateData')?.data,
            events: meta.length
        }
        const m = meta.find((e) => e.event === 'metadata')
        if (m) json = { ...json, ...m.data, text: json.text || m.data.text }
    } else json = JSON.parse(text)
    return { benchId, ms, json, reqBytes: JSON.stringify(body).length, resBytes: text.length }
}

function readSpans() {
    const map = new Map()
    if (!fs.existsSync(SPANS)) return map
    for (const line of fs.readFileSync(SPANS, 'utf8').split('\n')) {
        if (!line) continue
        const rec = JSON.parse(line)
        map.set(rec.id, rec)
    }
    return map
}

const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length

const results = []
for (const flowName of flowNames) {
    const builder = FLOWS[flowName](defs)
    const flowData = JSON.stringify(builder.toJSON())
    for (const modeName of modeNames) {
        const id = flowId(flowName, modeName)
        await upsert(id, `perf ${flowName} ${modeName}`, flowData, MODES[modeName])
        const runs = { turn1: [], turn2: [] }
        // Turn 1 of a new conversation, then turn 2 carrying turn 1's token (2 history messages)
        for (let i = 0; i < WARMUP + N; i++) {
            const question = `hello ${i}`
            const t1 = await predict(id, { question })
            const t2 = await predict(id, { question: `${question} again`, chatId: t1.json.chatId, trustedState: t1.json.trustedState })
            if (i === 0) {
                console.log(
                    `${flowName}/${modeName}: text=${JSON.stringify(String(t1.json.text).slice(0, 60))} executed=${
                        t1.json.agentFlowExecutedData?.length
                    } ` +
                        `req1=${t1.reqBytes}B res1=${t1.resBytes}B req2=${t2.reqBytes}B res2=${t2.resBytes}B token2=${t2.json.trustedState?.length}`
                )
            }
            if (i >= WARMUP) {
                runs.turn1.push(t1)
                runs.turn2.push(t2)
            }
        }
        const spans = readSpans()
        for (const turn of ['turn1', 'turn2']) {
            const client = runs[turn].map((r) => r.ms)
            const server = runs[turn].map((r) => spans.get(r.benchId)?.totalMs).filter((x) => x !== undefined)
            const spanTotals = {}
            for (const r of runs[turn]) {
                const rec = spans.get(r.benchId)
                if (!rec) continue
                for (const [name, s] of Object.entries(rec.spans)) {
                    const t = spanTotals[name] || (spanTotals[name] = { n: 0, ms: 0 })
                    t.n += s.n
                    t.ms += s.ms
                }
            }
            const count = runs[turn].length
            const perReq = Object.fromEntries(
                Object.entries(spanTotals)
                    .map(([k, v]) => [k, { calls: +(v.n / count).toFixed(2), ms: +(v.ms / count).toFixed(3) }])
                    .sort((a, b) => b[1].ms - a[1].ms)
            )
            const summary = {
                flow: flowName,
                mode: modeName,
                turn,
                streaming: STREAMING,
                nodes: builder.nodes.length,
                edges: builder.edges.length,
                flowDataKB: +(flowData.length / 1024).toFixed(1),
                n: count,
                client: { p50: pct(client, 50), p90: pct(client, 90), p99: pct(client, 99), mean: mean(client) },
                server: server.length ? { p50: pct(server, 50), p90: pct(server, 90), mean: mean(server) } : null,
                spans: perReq
            }
            results.push(summary)
            console.log(
                `${flowName.padEnd(14)} ${modeName.padEnd(10)} ${turn}  client p50 ${summary.client.p50.toFixed(
                    1
                )} ms  p90 ${summary.client.p90.toFixed(1)}  mean ${summary.client.mean.toFixed(
                    1
                )}  | server mean ${summary.server?.mean.toFixed(1)}`
            )
        }
    }
}
fs.writeFileSync(path.resolve(HERE, '../results', args.out ?? 'results.json'), JSON.stringify(results, null, 2))
