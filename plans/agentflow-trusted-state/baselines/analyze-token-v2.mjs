#!/usr/bin/env node
// Token size anatomy of the v2 token in after/ traces, next to the v1 token of the same turn in before/ (Task 10).
//
//   node analyze-token-v2.mjs [--before <dir>] [--after <dir>] [--markdown <file>] [--json <file>] [--readme-table]
//
// --markdown rewrites only the block between the BEGIN/END markers when the file already has them.
// --readme-table prints the after columns of README.md §6 instead.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { inflate, makeBlobReader } from './lib/trace-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BEGIN_MARKER = '<!-- analyze-token-v2:begin -->'
const END_MARKER = '<!-- analyze-token-v2:end -->'
const DETAIL = ['S01', 'S02', 'S06', 'S07', 'S08', 'S12']
const MODE_ORDER = ['M1', 'M2', 'M3', 'M1-internal', 'M1-reqflag', 'M3-envflags']

function parseArgs(argv) {
    const opts = { before: path.join(HERE, 'traces/before'), after: path.join(HERE, 'traces/after'), markdown: null, json: null, readmeTable: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--before') opts.before = path.resolve(argv[++i])
        else if (arg === '--after') opts.after = path.resolve(argv[++i])
        else if (arg === '--markdown') opts.markdown = path.resolve(argv[++i])
        else if (arg === '--json') opts.json = path.resolve(argv[++i])
        else if (arg === '--readme-table') opts.readmeTable = true
        else throw new Error(`Unknown argument ${arg}`)
    }
    return opts
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const bytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)))
const kb = (n) => (n >= 10240 ? (n / 1024).toFixed(1) : n >= 1024 ? (n / 1024).toFixed(2) : `${n} B`)
const kbCell = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 1 : 2)} KB` : `${n} B`)
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)} %` : '—')
const statusLetter = (s) => ({ FINISHED: 'F', STOPPED: 'S', ERROR: 'E', TERMINATED: 'T' }[s] ?? '?')

function loadRuns(dir) {
    const readBlob = makeBlobReader(dir)
    const runs = []
    for (const mode of fs.readdirSync(dir)) {
        const modeDir = path.join(dir, mode)
        if (mode === 'blobs' || !fs.statSync(modeDir).isDirectory()) continue
        for (const file of fs.readdirSync(modeDir).filter((f) => f.endsWith('.json'))) {
            const trace = readJson(path.join(modeDir, file))
            runs.push({ mode, file, trace, readBlob, label: trace.scenario.id + (trace.capture?.variant ? `@${trace.capture.variant}` : '') })
        }
    }
    return runs.sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.label.localeCompare(b.label, 'en', { numeric: true }))
}

function turnFacts(turn, readBlob) {
    const token = turn.token?.received ? inflate(turn.token.decoded, readBlob) : null
    const history = token?.history ?? token?.pastChatHistory ?? []
    const children = Object.entries(turn.token?.childTokens ?? {}).map(([nodeId, c]) => ({
        nodeId,
        base64Length: c.base64Length,
        rawJsonBytes: c.sizes?.rawJsonBytes ?? 0,
        historyMessages: c.sizes?.historyMessages ?? 0,
        sentinels: c.sentinels?.total ?? 0
    }))
    return {
        id: turn.id,
        status: turn.status,
        received: Boolean(turn.token?.received),
        version: turn.token?.sizes?.version ?? (token ? (token.version === 2 ? 2 : 1) : null),
        base64: turn.token?.base64Length ?? 0,
        gzip: turn.token?.sizes?.gzipBytes ?? 0,
        raw: turn.token?.sizes?.rawJsonBytes ?? 0,
        sentinels: turn.token?.sentinels?.total ?? 0,
        historyMessages: history.length,
        lastTwoMessagesBytes: history.length >= 2 ? bytes(history.slice(-2)) - 1 : 0,
        parts: token?.version === 2
            ? {
                  history: bytes(token.history),
                  flowState: bytes(token.flowState),
                  formValues: bytes(token.formValues),
                  childFlowTokens: bytes(token.childFlowTokens),
                  pendingResume: bytes(token.pendingResume)
              }
            : null,
        pending: token?.pendingResume
            ? {
                  nodes: token.pendingResume.nodes.length,
                  prompt: token.pendingResume.nodes.reduce((n, e) => n + bytes(e.prompt), 0),
                  checkpoint: token.pendingResume.nodes.reduce((n, e) => n + bytes(e.checkpoint), 0),
                  legacyMessages: token.pendingResume.nodes.reduce((n, e) => n + bytes(e.legacyMessages), 0),
                  action: token.pendingResume.nodes.reduce((n, e) => n + bytes(e.action), 0)
              }
            : null,
        children,
        executedDataBytes: turn.sizes?.executedDataBytes ?? 0,
        actionBytes: turn.sizes?.actionBytes ?? 0,
        restJsonBytes: turn.sizes?.restJsonBytes ?? 0,
        executedSentinels: turn.sentinels?.executedData?.total ?? 0
    }
}

function analyze(opts) {
    const beforeRuns = new Map(loadRuns(opts.before).map((r) => [`${r.mode}/${r.trace.scenario.id}`, r]))
    const rows = []
    for (const run of loadRuns(opts.after)) {
        const before = beforeRuns.get(`${run.mode}/${run.trace.scenario.id}`)
        const beforeTurns = new Map((before?.trace.turns ?? []).map((t) => [t.id, turnFacts(t, before.readBlob)]))
        const turns = run.trace.turns.map((t) => {
            const facts = turnFacts(t, run.readBlob)
            facts.before = beforeTurns.get(t.id) ?? null
            return facts
        })
        turns.forEach((t, i) => {
            const prev = turns[i - 1]
            t.growth = prev && prev.received && t.received ? { raw: t.raw - prev.raw, history: (t.parts?.history ?? 0) - (prev.parts?.history ?? 0) } : null
        })
        rows.push({ mode: run.mode, label: run.label, scenario: run.trace.scenario.id, title: run.trace.scenario.title, turns })
    }
    return rows
}

function maxBy(turns, key) {
    return turns.reduce((best, t) => (t[key] > (best?.[key] ?? -1) ? t : best), null)
}

function renderReadmeTable(rows) {
    const out = ['| Scenario | Mode | Statuses (after) | Token max / last (after) | Prompts in token (after) |', '| :--- | :--- | :--- | ---: | ---: |']
    for (const r of rows) {
        const withToken = r.turns.filter((t) => t.received)
        const max = maxBy(withToken, 'raw')
        const last = r.turns.at(-1)
        out.push(
            `| ${r.label} | ${r.mode} | ${r.turns.map((t) => statusLetter(t.status)).join(' ')} | ${max ? `${kbCell(max.raw)} (${max.id}) / ${kbCell(last.raw)}` : 'none'} | ${Math.max(0, ...r.turns.map((t) => t.sentinels))} |`
        )
    }
    return out.join('\n')
}

function render(rows, opts) {
    const out = []
    const tokens = rows.flatMap((r) => r.turns).filter((t) => t.received)
    out.push(`Generated by \`analyze-token-v2.mjs\` from \`${path.relative(HERE, opts.after)}\` (${tokens.length} tokens), next to \`${path.relative(HERE, opts.before)}\`. Sizes of the token as sent: **b64** base64 length, **gzip** compressed payload, **raw** decoded JSON. Parts are the raw JSON bytes of each v2 field. Sentinels count \`SYSPROMPT_SENTINEL\` copies in the token, child flow tokens decoded and included.`)
    out.push('')

    out.push('### A. Every run: last turn and largest token')
    out.push('')
    out.push('| Scenario | Mode | Statuses | b64 last | gzip last | raw last | raw max (turn) | raw max before | Largest share of before (turn) | History share (last) | Sentinels max |')
    out.push('| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const r of rows) {
        const last = r.turns.at(-1)
        const withToken = r.turns.filter((t) => t.received)
        const max = maxBy(withToken, 'raw')
        const ratios = withToken.filter((t) => t.before?.raw).map((t) => ({ id: t.id, ratio: t.raw / t.before.raw }))
        const worst = ratios.reduce((best, x) => (x.ratio > (best?.ratio ?? -1) ? x : best), null)
        const beforeMax = Math.max(0, ...r.turns.map((t) => t.before?.raw ?? 0))
        out.push(
            `| ${r.label} | ${r.mode} | ${r.turns.map((t) => statusLetter(t.status)).join(' ')} | ${kb(last.base64)} | ${kb(last.gzip)} | ${kb(last.raw)} | ${max ? `${kb(max.raw)} (${max.id})` : '—'} | ${beforeMax ? kb(beforeMax) : 'none'} | ${worst ? `${(100 * worst.ratio).toFixed(2)} % (${worst.id})` : '—'} | ${last.parts ? pct(last.parts.history, last.raw) : '—'} | ${Math.max(0, ...r.turns.map((t) => t.sentinels))} |`
        )
    }
    out.push('')
    out.push('Sizes in KB (1024 bytes) unless marked B. "Largest share of before" is the highest `raw(after) / raw(before)` over the turns of the run; `SIZE-token-v2` allows 5 % (S12 10 %; S13 has no before token and is held to 4 KB).')

    out.push('', '### B. Growth per turn', '')
    out.push('Raw bytes per turn. **Δ** is the change from the previous turn; **Δ history** the change of the `history` field; the rest of Δ is flow state, form values, child tokens and pending data.')
    for (const id of DETAIL) {
        for (const r of rows.filter((x) => x.scenario === id && x.mode === 'M1')) {
            out.push('', `**${r.label} (${r.mode})**: ${r.title}`, '')
            out.push('| Turn | Status | raw | Δ | Δ history | Last two messages | history | flowState | formValues | childFlowTokens | pendingResume | before raw | b64 before → after |')
            out.push('| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
            for (const t of r.turns) {
                const p = t.parts ?? {}
                out.push(
                    `| ${t.id} | ${statusLetter(t.status)} | ${t.raw} | ${t.growth ? (t.growth.raw >= 0 ? '+' : '') + t.growth.raw : '—'} | ${t.growth ? (t.growth.history >= 0 ? '+' : '') + t.growth.history : '—'} | ${t.lastTwoMessagesBytes} | ${p.history ?? 0} | ${p.flowState ?? 0} | ${p.formValues ?? 0} | ${p.childFlowTokens ?? 0} | ${p.pendingResume ?? 0} | ${t.before?.raw ?? '—'} | ${t.before?.base64 ?? '—'} → ${t.base64} |`
                )
            }
        }
    }

    out.push('', '### C. Growth outside the history on turns that neither start nor end paused', '')
    out.push('Per run: the largest `Δ raw − Δ history` between two consecutive finished or failed turns, and the field it comes from.')
    out.push('')
    out.push('| Scenario | Mode | Turn pairs | Largest Δ outside history (turn) | From |')
    out.push('| :--- | :--- | ---: | ---: | :--- |')
    for (const r of rows) {
        const pairs = []
        r.turns.forEach((t, i) => {
            const prev = r.turns[i - 1]
            if (!prev || !t.growth || t.status === 'STOPPED' || prev.status === 'STOPPED' || !t.parts || !prev.parts) return
            const other = t.growth.raw - t.growth.history
            const fields = ['flowState', 'formValues', 'childFlowTokens', 'pendingResume'].map((f) => ({ f, d: t.parts[f] - prev.parts[f] })).filter((x) => x.d)
            pairs.push({ id: t.id, other, fields })
        })
        if (!pairs.length) continue
        const worst = pairs.reduce((best, p) => (Math.abs(p.other) > Math.abs(best.other) ? p : best), pairs[0])
        out.push(`| ${r.label} | ${r.mode} | ${pairs.length} | ${worst.other >= 0 ? '+' : ''}${worst.other} B (${worst.id}) | ${worst.fields.map((x) => `${x.f} ${x.d >= 0 ? '+' : ''}${x.d}`).join(', ') || '—'} |`)
    }

    out.push('', '### D. Paused tokens', '')
    out.push('| Scenario | Mode | Turn | b64 before → after | raw before → after | pendingResume | Entries | Prompts | Agent checkpoints | Actions | Sentinels |')
    out.push('| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const r of rows) {
        for (const t of r.turns.filter((x) => x.pending)) {
            out.push(
                `| ${r.label} | ${r.mode} | ${t.id} | ${t.before?.base64 ?? '—'} → ${t.base64} | ${t.before?.raw ?? '—'} → ${t.raw} | ${t.parts.pendingResume} | ${t.pending.nodes} | ${t.pending.prompt} | ${t.pending.checkpoint} | ${t.pending.action} | ${t.sentinels} |`
            )
        }
    }

    out.push('', '### E. Child flow tokens (S12)', '')
    out.push('| Mode | Turn | Parent raw | Parent b64 | Child token b64 | Child raw | Child history | Child sentinels | Parent share of before |')
    out.push('| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const r of rows.filter((x) => x.turns.some((t) => t.children.length))) {
        for (const t of r.turns) {
            for (const c of t.children) {
                out.push(`| ${r.mode} | ${t.id} | ${t.raw} | ${t.base64} | ${c.base64Length} | ${c.rawJsonBytes} | ${c.historyMessages} | ${c.sentinels} | ${t.before?.raw ? pct(t.raw, t.before.raw) : '—'} |`)
            }
        }
    }

    out.push('', '### F. Client payloads (unencrypted)', '')
    out.push('Largest per run, bytes of JSON. External runs get pruned records (TS18) and the slim action (TS20); M1-internal keeps full records.')
    out.push('')
    out.push('| Scenario | Mode | Executed data before → after | Prompts in executed data before → after | Action before → after | REST JSON before → after |')
    out.push('| :--- | :--- | ---: | ---: | ---: | ---: |')
    for (const r of rows) {
        const m = (key, src) => Math.max(0, ...r.turns.map((t) => (src === 'before' ? t.before?.[key] ?? 0 : t[key])))
        out.push(
            `| ${r.label} | ${r.mode} | ${m('executedDataBytes', 'before')} → ${m('executedDataBytes')} | ${m('executedSentinels', 'before')} → ${m('executedSentinels')} | ${m('actionBytes', 'before')} → ${m('actionBytes')} | ${m('restJsonBytes', 'before') || '—'} → ${m('restJsonBytes') || '—'} |`
        )
    }
    return out.join('\n')
}

function writeMarkdown(file, block) {
    const wrapped = `${BEGIN_MARKER}\n\n${block}\n\n${END_MARKER}`
    if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8')
        const start = text.indexOf(BEGIN_MARKER)
        const end = text.indexOf(END_MARKER)
        if (start >= 0 && end > start) {
            fs.writeFileSync(file, text.slice(0, start) + wrapped + text.slice(end + END_MARKER.length))
            return
        }
    }
    fs.writeFileSync(file, `# Token Size Anatomy, \`after/\` (Task 10)\n\n${wrapped}\n`)
}

const opts = parseArgs(process.argv.slice(2))
const rows = analyze(opts)
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(rows, null, 1) + '\n')
if (opts.readmeTable) console.log(renderReadmeTable(rows))
else if (opts.markdown) writeMarkdown(opts.markdown, render(rows, opts))
else console.log(render(rows, opts))
