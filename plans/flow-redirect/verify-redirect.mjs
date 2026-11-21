#!/usr/bin/env node
/**
 * End-to-end check for the Redirect to Flow node against a running Flowise server.
 *
 * Seeds the zero-API-key fixture flows plus a mapping flow (Start -> Redirect to Flow), then compares
 * calls through the mapping with direct calls to the target. Exits non-zero when any check fails.
 *
 *   FLOWISE_BASE_URL (default http://localhost:3000), FLOWISE_EMAIL, FLOWISE_PASSWORD
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { performance } from 'perf_hooks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures')

const BASE_URL = process.env.FLOWISE_BASE_URL || 'http://localhost:3000'
const EMAIL = process.env.FLOWISE_EMAIL || 'redirect-e2e@flowise.local'
const PASSWORD = process.env.FLOWISE_PASSWORD || 'RedirectE2e!123'
const TIMEOUT_MS = 30000
const RUN_TAG = Date.now()

const TARGETS = {
    fork: { name: 'Redirect E2E - 01 fork-join', file: '01-parallel-fork-join-timing-and-state.json' },
    stream: { name: 'Redirect E2E - 04 multi-terminal', file: '04-multi-terminal-streaming-and-silent-leaf.json' },
    human: { name: 'Redirect E2E - 05 human input', file: '05-human-input-with-companion-text.json' },
    loop: { name: 'Redirect E2E - 06 loop', file: '06-loop-over-parallel-subgraph.json' }
}
const MAPPING_NAME = 'Redirect E2E - mapping'
const BROKEN_MAPPING_NAME = 'Redirect E2E - broken mapping'
const EMPTY_MAPPING_NAME = 'Redirect E2E - empty mapping'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const elapsed = (t0) => Math.round(performance.now() - t0)

async function waitForServer() {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${BASE_URL}/api/v1/ping`)).ok) return
        } catch {
            // server not up yet
        }
        await sleep(500)
    }
    throw new Error(`Flowise at ${BASE_URL} did not become ready`)
}

function cookiesFrom(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    return setCookies
        .filter(Boolean)
        .map((raw) => raw.split(';')[0])
        .join('; ')
}

async function login() {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const resolved = await (await post(`${BASE_URL}/api/v1/auth/resolve`, {})).json()
    if (resolved.redirectUrl === '/organization-setup') {
        const reg = await post(`${BASE_URL}/api/v1/account/register`, {
            user: { name: 'Redirect E2E', email: EMAIL, type: 'pro', credential: PASSWORD }
        })
        if (!reg.ok) throw new Error(`register failed: HTTP ${reg.status} ${await reg.text()}`)
    }
    const res = await post(`${BASE_URL}/api/v1/auth/login`, { email: EMAIL, password: PASSWORD })
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`)
    const cookie = cookiesFrom(res)
    if (!cookie) throw new Error('login returned no session cookie')
    return cookie
}

async function api(cookie, url, { method = 'GET', body } = {}) {
    const headers = { 'x-request-from': 'internal', Cookie: cookie }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${BASE_URL}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    const parsed = text ? JSON.parse(text) : null
    if (!res.ok) throw new Error(`${method} ${url} failed: HTTP ${res.status} ${text}`)
    return parsed
}

async function upsertFlow(cookie, existingByName, name, flowData) {
    const existing = existingByName.get(name)
    const body = { name, flowData: JSON.stringify(flowData), type: 'AGENTFLOW' }
    if (existing) return api(cookie, `/api/v1/chatflows/${existing.id}`, { method: 'PUT', body })
    const created = await api(cookie, '/api/v1/chatflows', { method: 'POST', body: { ...body, deployed: false, isPublic: false } })
    existingByName.set(name, created)
    return created
}

function mappingFlowData(nodeDef, startNode, targetId, extraNodes = []) {
    const id = 'redirectFlowAgentflow_0'
    const redirectNode = {
        id,
        type: 'agentFlow',
        position: { x: 320, y: 180 },
        data: {
            id,
            label: nodeDef.label,
            version: nodeDef.version,
            name: nodeDef.name,
            type: nodeDef.type,
            color: nodeDef.color,
            hideOutput: true,
            baseClasses: nodeDef.baseClasses,
            category: nodeDef.category,
            description: nodeDef.description,
            inputParams: nodeDef.inputs.map((param) => ({ ...param, id: `${id}-input-${param.name}-${param.type}` })),
            inputAnchors: [],
            inputs: targetId === undefined ? {} : { redirectFlowSelectedFlow: targetId },
            outputAnchors: [],
            outputs: {},
            selected: false
        }
    }
    const sourceHandle = startNode.data.outputAnchors[0].id
    return {
        nodes: [startNode, redirectNode, ...extraNodes],
        edges: [
            {
                source: startNode.id,
                sourceHandle,
                target: id,
                targetHandle: id,
                data: { sourceColor: startNode.data.color, targetColor: nodeDef.color, isHumanInput: false },
                type: 'agentFlow',
                id: `${startNode.id}-${sourceHandle}-${id}-${id}`
            }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
    }
}

async function predict(flowId, body) {
    const t0 = performance.now()
    const res = await fetch(`${BASE_URL}/api/v1/prediction/${flowId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, streaming: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = await res.text()
    let json = null
    try {
        json = text ? JSON.parse(text) : null
    } catch {
        json = { raw: text }
    }
    return { status: res.status, json, durationMs: elapsed(t0) }
}

async function predictStream(flowId, body) {
    const t0 = performance.now()
    const res = await fetch(`${BASE_URL}/api/v1/prediction/${flowId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, streaming: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const events = []
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
        return { status: res.status, events, body: await res.text(), durationMs: elapsed(t0) }
    }
    const decoder = new TextDecoder()
    let buffer = ''
    const flush = (frame) => {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (line) events.push({ offsetMs: elapsed(t0), ...JSON.parse(line.slice(5)) })
    }
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            flush(buffer.slice(0, idx))
            buffer = buffer.slice(idx + 2)
        }
    }
    if (buffer.trim()) flush(buffer)
    return { status: res.status, events, durationMs: elapsed(t0) }
}

const eventShape = (events) =>
    events
        .filter((e) => e.event !== 'metadata' && e.event !== 'agentFlowExecutedData')
        .map((e) => (e.event === 'nextAgentFlow' ? `nextAgentFlow:${e.data.nodeId}:${e.data.status}` : e.event))
const tokenText = (events) =>
    events
        .filter((e) => e.event === 'token')
        .map((e) => e.data)
        .join('')

const results = []
async function check(name, fn) {
    const t0 = performance.now()
    try {
        const detail = await fn()
        results.push({ name, pass: true, detail, ms: elapsed(t0) })
    } catch (err) {
        results.push({ name, pass: false, detail: err.message, ms: elapsed(t0) })
    }
}
function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function main() {
    await waitForServer()
    const cookie = await login()

    const nodeDef = await api(cookie, '/api/v1/nodes/redirectFlowAgentflow')
    const existing = await api(cookie, '/api/v1/chatflows?type=AGENTFLOW')
    const existingByName = new Map((Array.isArray(existing) ? existing : existing?.data || []).map((row) => [row.name, row]))

    const ids = {}
    let startNode
    for (const [key, def] of Object.entries(TARGETS)) {
        const flowData = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, def.file), 'utf8'))
        startNode ??= flowData.nodes.find((n) => n.data.name === 'startAgentflow')
        ids[key] = (await upsertFlow(cookie, existingByName, def.name, flowData)).id
    }
    const pointMappingAt = async (targetId) =>
        (await upsertFlow(cookie, existingByName, MAPPING_NAME, mappingFlowData(nodeDef, startNode, targetId))).id
    const directReplyNode = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, TARGETS.stream.file), 'utf8')).nodes.find(
        (n) => n.data.name === 'directReplyAgentflow'
    )
    const brokenId = (
        await upsertFlow(cookie, existingByName, BROKEN_MAPPING_NAME, mappingFlowData(nodeDef, startNode, ids.stream, [directReplyNode]))
    ).id
    const emptyId = (await upsertFlow(cookie, existingByName, EMPTY_MAPPING_NAME, mappingFlowData(nodeDef, startNode, undefined))).id

    let mappingId = await pointMappingAt(ids.stream)
    const stableMappingId = mappingId
    const chat = (label) => `redirect-e2e-${label}-${RUN_TAG}`

    await check('Node is registered on the server', async () => {
        assert(nodeDef.name === 'redirectFlowAgentflow', `unexpected node ${nodeDef.name}`)
        return `${nodeDef.label} v${nodeDef.version}`
    })

    await check('SSE parity: mapping -> 04 streams exactly like 04 directly', async () => {
        const viaMapping = await predictStream(mappingId, { question: 'hi', chatId: chat('sse-mapping') })
        const direct = await predictStream(ids.stream, { question: 'hi', chatId: chat('sse-direct') })
        assert(viaMapping.events.length > 0, `mapping returned no SSE events (HTTP ${viaMapping.status} ${viaMapping.body ?? ''})`)
        assert(
            JSON.stringify(eventShape(viaMapping.events)) === JSON.stringify(eventShape(direct.events)),
            `event sequences differ:\n  mapping ${eventShape(viaMapping.events).join(', ')}\n  direct  ${eventShape(direct.events).join(
                ', '
            )}`
        )
        assert(tokenText(viaMapping.events) === tokenText(direct.events), 'token text differs')
        const metadata = viaMapping.events.find((e) => e.event === 'metadata')
        assert(metadata?.data?.chatId === chat('sse-mapping'), `metadata chatId ${metadata?.data?.chatId}`)
        const firstToken = viaMapping.events.find((e) => e.event === 'token')
        assert(firstToken && firstToken.offsetMs < 300, `first token at ${firstToken?.offsetMs} ms`)
        return `${viaMapping.events.length} events, first token at ${firstToken.offsetMs} ms (direct ${
            direct.events.find((e) => e.event === 'token')?.offsetMs
        } ms), text ${JSON.stringify(tokenText(viaMapping.events))}`
    })

    await check('Persistence: messages stored under the target id with the client chatId', async () => {
        const chatId = chat('persist')
        const res = await predict(mappingId, { question: 'persist me', chatId })
        assert(res.status === 200, `HTTP ${res.status} ${JSON.stringify(res.json)}`)
        const underTarget = await api(cookie, `/api/v1/chatmessage/${ids.stream}?chatId=${chatId}`)
        const underMapping = await api(cookie, `/api/v1/chatmessage/${mappingId}?chatId=${chatId}`)
        assert(underTarget.length >= 2, `expected user and api messages under target, got ${underTarget.length}`)
        assert(underMapping.length === 0, `expected none under mapping, got ${underMapping.length}`)
        return `${underTarget.length} messages under target, 0 under mapping`
    })

    await check('Human input: STOPPED and resumed through the mapping', async () => {
        mappingId = await pointMappingAt(ids.human)
        const chatId = chat('human')
        const turn1 = await predict(mappingId, { question: 'please review', chatId })
        assert(turn1.status === 200, `turn 1 HTTP ${turn1.status} ${JSON.stringify(turn1.json)}`)
        const stopped = turn1.json?.agentFlowExecutedData?.some((n) => n.status === 'STOPPED')
        assert(stopped, 'turn 1 did not stop for human input')
        const turn2 = await predict(mappingId, {
            chatId,
            humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'ok' }
        })
        assert(turn2.status === 200, `turn 2 HTTP ${turn2.status} ${JSON.stringify(turn2.json)}`)
        assert(String(turn2.json?.text).includes('Approved!'), `turn 2 text ${JSON.stringify(turn2.json?.text)}`)
        return `turn 2: ${JSON.stringify(turn2.json.text)}`
    })

    await check('Abort through the mapping id stops the target run', async () => {
        mappingId = await pointMappingAt(ids.loop)
        const normal = await predict(ids.loop, { question: 'go', chatId: chat('loop-direct') })
        const chatId = chat('abort')
        const run = predict(mappingId, { question: 'go', chatId })
        await sleep(150)
        await api(cookie, `/api/v1/chatmessage/abort/${mappingId}/${chatId}`, { method: 'PUT' })
        const aborted = await run
        assert(
            aborted.durationMs < normal.durationMs * 0.7,
            `aborted run took ${aborted.durationMs} ms vs normal ${normal.durationMs} ms (HTTP ${aborted.status} ${JSON.stringify(
                aborted.json
            )})`
        )
        return `normal ${normal.durationMs} ms, aborted after ${aborted.durationMs} ms (HTTP ${aborted.status}: ${JSON.stringify(
            aborted.json?.message ?? aborted.json?.text
        )})`
    })

    await check('JSON parity and repoint: mapping -> 01 returns 01 output', async () => {
        mappingId = await pointMappingAt(ids.fork)
        assert(mappingId === stableMappingId, `repointing created a new flow ${mappingId} instead of updating ${stableMappingId}`)
        const viaMapping = await predict(mappingId, { question: 'go', chatId: chat('json-mapping') })
        const direct = await predict(ids.fork, { question: 'go', chatId: chat('json-direct') })
        assert(viaMapping.status === 200, `HTTP ${viaMapping.status} ${JSON.stringify(viaMapping.json)}`)
        assert(
            viaMapping.json?.text === direct.json?.text,
            `text ${JSON.stringify(viaMapping.json?.text)} vs ${JSON.stringify(direct.json?.text)}`
        )
        assert(viaMapping.json?.chatId === chat('json-mapping'), `chatId ${viaMapping.json?.chatId}`)
        return JSON.stringify(viaMapping.json.text)
    })

    await check('Misuse: extra node and missing target fail clearly', async () => {
        const broken = await predict(brokenId, { question: 'hi', chatId: chat('broken') })
        const empty = await predict(emptyId, { question: 'hi', chatId: chat('empty') })
        const brokenMessage = JSON.stringify(broken.json)
        const emptyMessage = JSON.stringify(empty.json)
        assert(
            broken.status >= 400 && brokenMessage.includes('only node connected to Start'),
            `extra node: ${broken.status} ${brokenMessage}`
        )
        assert(empty.status >= 400 && emptyMessage.includes('no target flow selected'), `no target: ${empty.status} ${emptyMessage}`)
        return `extra node HTTP ${broken.status}, no target HTTP ${empty.status}`
    })

    console.log(`\nRedirect to Flow end-to-end (${BASE_URL})`)
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} [${r.ms} ms]\n      ${r.detail}`)
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${results.length - failed}/${results.length} passed`)
    process.exit(failed ? 1 : 0)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
