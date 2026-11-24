// node longconv.mjs <flow> <turns> <questionBytes> — one conversation, token round-tripped, latency per turn
import crypto from 'crypto'
import { performance } from 'perf_hooks'
import { loadCaptureEnv } from '../../agentflow-trusted-state/baselines/lib/flowise-client.mjs'

const [flow = 'conditions150', turnsArg = '40', bytesArg = '1500', mode = 'token'] = process.argv.slice(2)
const env = loadCaptureEnv()
const h = crypto.createHash('sha256').update(`perf|${flow}|${mode}`).digest('hex')
const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
const filler = 'hello this is a longer customer message about an order that did not arrive on time. '.repeat(100).slice(0, Number(bytesArg))

const rows = []
for (let rep = 0; rep < 3; rep++) {
    let token
    let chatId
    for (let t = 1; t <= Number(turnsArg); t++) {
        const body = { question: `hello turn ${t} ${filler}`, chatId, trustedState: token }
        const t0 = performance.now()
        const res = await fetch(`${env.FLOWISE_BASE_URL}/api/v1/prediction/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
        const json = await res.json()
        const ms = performance.now() - t0
        if (!res.ok) throw new Error(JSON.stringify(json))
        token = json.trustedState
        chatId = json.chatId
        ;(rows[t] ??= []).push({ ms, tokenKB: token.length / 1024 })
    }
}
for (const t of [1, 5, 10, 20, 30, 40, 60, 80].filter((t) => rows[t])) {
    const ms = rows[t].map((r) => r.ms).sort((a, b) => a - b)
    console.log(
        `turn ${String(t).padStart(3)}  history ${2 * (t - 1)} msgs  token ${rows[t][0].tokenKB.toFixed(1)} KB  median ${ms[1].toFixed(
            1
        )} ms`
    )
}
