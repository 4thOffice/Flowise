#!/usr/bin/env node
// Token size anatomy of ts-00b traces, and the field-inventory coverage check (Task 02).
//
//   node analyze-token.mjs [--traces <dir>] [--modes M1,M2] [--scenarios S01,S07] [--detail S01,S07]
//                          [--markdown <file>] [--json <file>]
//   node analyze-token.mjs --check-inventory [<field-inventory.md>] [--verbose]
//   node analyze-token.mjs --list-paths
//
// --markdown rewrites only the block between the BEGIN/END markers when the file already has them.
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { inflate, makeBlobReader, SENTINEL_RE } from './lib/trace-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BEGIN_MARKER = '<!-- analyze-token:begin -->'
const END_MARKER = '<!-- analyze-token:end -->'
const IV_AND_TAG_BYTES = 12 + 16
const JSON_MARK = '\u0000json'

const RECORDS = 'previousExecution.executionData<json>[]'
const CATEGORIES = [
    { id: 'history', label: 'History messages (without `action`)', paths: ['pastChatHistory'], minus: ['pastChatHistory[].action'] },
    { id: 'historyAction', label: 'History `action` strings', paths: ['pastChatHistory[].action'] },
    { id: 'records', label: 'Node records (`executionData`)', paths: ['previousExecution.executionData'] },
    { id: 'inputMessages', label: 'Records: `data.input.messages`', paths: [`${RECORDS}.data.input.messages`] },
    { id: 'otherInputs', label: 'Records: other `data.input`', paths: [`${RECORDS}.data.input`], minus: [`${RECORDS}.data.input.messages`] },
    { id: 'humanInputAction', label: 'Records: `output.humanInputAction`', paths: [`${RECORDS}.data.output.humanInputAction`] },
    { id: 'otherOutputs', label: 'Records: other `data.output`', paths: [`${RECORDS}.data.output`], minus: [`${RECORDS}.data.output.humanInputAction`] },
    { id: 'stateCopies', label: 'Records: `data.state` copies', paths: [`${RECORDS}.data.state`] },
    { id: 'recordChatHistory', label: 'Records: `data.chatHistory`', paths: [`${RECORDS}.data.chatHistory`] },
    { id: 'envelope', label: '`previousExecution` without records', paths: ['previousExecution'], minus: ['previousExecution.executionData'] }
]

function parseArgs(argv) {
    const opts = {
        traces: path.join(HERE, 'traces/before'),
        modes: null,
        scenarios: null,
        detail: ['S01', 'S07'],
        markdown: null,
        json: null,
        checkInventory: null,
        verbose: false,
        listPaths: false,
        minPathBytes: 256
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = () => argv[++i]
        if (arg === '--traces') opts.traces = path.resolve(next())
        else if (arg === '--modes') opts.modes = next().split(',')
        else if (arg === '--scenarios') opts.scenarios = next().split(',')
        else if (arg === '--detail') opts.detail = next().split(',')
        else if (arg === '--markdown') opts.markdown = path.resolve(next())
        else if (arg === '--json') opts.json = path.resolve(next())
        else if (arg === '--min-path-bytes') opts.minPathBytes = Number(next())
        else if (arg === '--verbose') opts.verbose = true
        else if (arg === '--list-paths') opts.listPaths = true
        else if (arg === '--check-inventory') {
            const value = argv[i + 1]
            opts.checkInventory = value && !value.startsWith('--') ? path.resolve(next()) : path.join(HERE, '../field-inventory.md')
        } else throw new Error(`Unknown argument ${arg}`)
    }
    return opts
}

// ---------- token model: nested JSON strings become {JSON_MARK: parsed} so paths can reach inside them ----------

const isMark = (node) => Boolean(node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, JSON_MARK))

function parseJsonString(value) {
    if (typeof value !== 'string' || value.length < 2 || (value[0] !== '{' && value[0] !== '[')) return undefined
    try {
        const parsed = JSON.parse(value)
        if (parsed === null || typeof parsed !== 'object') return undefined
        return JSON.stringify(parsed) === value ? parsed : undefined
    } catch {
        return undefined
    }
}

function expand(value) {
    if (Array.isArray(value)) return value.map(expand)
    if (value && typeof value === 'object') {
        const out = {}
        for (const [key, inner] of Object.entries(value)) out[key] = expand(inner)
        return out
    }
    const parsed = parseJsonString(value)
    return parsed === undefined ? value : { [JSON_MARK]: expand(parsed) }
}

function collapse(value) {
    if (Array.isArray(value)) return value.map(collapse)
    if (isMark(value)) return JSON.stringify(collapse(value[JSON_MARK]))
    if (value && typeof value === 'object') {
        const out = {}
        for (const [key, inner] of Object.entries(value)) out[key] = collapse(inner)
        return out
    }
    return value
}

function parsePath(pathString) {
    const segments = []
    const re = /([^.[<]+)|(\[\])|(<json>)|(\.)/g
    for (const match of pathString.matchAll(re)) {
        if (match[1]) segments.push(match[1])
        else if (match[2]) segments.push('[]')
        else if (match[3]) segments.push('<json>')
    }
    return segments
}

function joinPath(parent, segment) {
    if (segment === '[]' || segment === '<json>') return `${parent}${segment}`
    return parent ? `${parent}.${segment}` : segment
}

// Copy-on-write removal of every instance of a normalized path.
function without(node, segments, index = 0) {
    const segment = segments[index]
    const last = index === segments.length - 1
    if (segment === '[]') {
        if (!Array.isArray(node)) return node
        return last ? [] : node.map((item) => without(item, segments, index + 1))
    }
    if (segment === '<json>') {
        if (!isMark(node) || last) return node
        return { [JSON_MARK]: without(node[JSON_MARK], segments, index + 1) }
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || isMark(node)) return node
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return node
    if (last) {
        const { [segment]: _removed, ...rest } = node
        return rest
    }
    return { ...node, [segment]: without(node[segment], segments, index + 1) }
}

function walk(node, visit, pathString = '') {
    if (Array.isArray(node)) {
        visit(pathString, node, 'array')
        node.forEach((item) => walk(item, visit, joinPath(pathString, '[]')))
        return
    }
    if (isMark(node)) {
        visit(pathString, node, 'json-string')
        walk(node[JSON_MARK], visit, joinPath(pathString, '<json>'))
        return
    }
    if (node && typeof node === 'object') {
        visit(pathString, node, 'object')
        for (const [key, inner] of Object.entries(node)) walk(inner, visit, joinPath(pathString, key))
        return
    }
    visit(pathString, node, node === null ? 'null' : typeof node)
}

const serialize = (expanded) => JSON.stringify(collapse(expanded))
const gzipBytes = (json) => zlib.gzipSync(Buffer.from(json, 'utf8')).length
const base64Length = (gzip) => 4 * Math.ceil((IV_AND_TAG_BYTES + gzip) / 3)

function measure(expanded) {
    const json = serialize(expanded)
    const raw = Buffer.byteLength(json, 'utf8')
    const gzip = gzipBytes(json)
    return { raw, gzip, base64: base64Length(gzip) }
}

function removeAll(expanded, paths) {
    let out = expanded
    for (const p of paths) out = without(out, parsePath(p))
    return out
}

function costOf(expanded, full, paths, minus = []) {
    const base = minus.length ? removeAll(expanded, minus) : expanded
    const baseSizes = minus.length ? measure(base) : full
    const reduced = measure(removeAll(base, paths))
    return {
        raw: baseSizes.raw - reduced.raw,
        gzip: baseSizes.gzip - reduced.gzip,
        base64: baseSizes.base64 - reduced.base64
    }
}

// ---------- traces ----------

function loadTurns(opts) {
    const readBlob = makeBlobReader(opts.traces)
    const runs = []
    for (const mode of fs.readdirSync(opts.traces).sort()) {
        const dir = path.join(opts.traces, mode)
        if (mode === 'blobs' || !fs.statSync(dir).isDirectory()) continue
        if (opts.modes && !opts.modes.includes(mode)) continue
        for (const file of fs.readdirSync(dir).sort()) {
            if (!file.endsWith('.json')) continue
            const trace = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            const scenario = trace.scenario.id + (trace.capture?.variant ? `@${trace.capture.variant}` : '')
            if (opts.scenarios && !opts.scenarios.includes(trace.scenario.id)) continue
            const turns = trace.turns.map((turn) => {
                const decoded = turn.token?.decoded ? inflate(turn.token.decoded, readBlob) : undefined
                return { id: turn.id, status: turn.status, recorded: turn.token?.sizes, decoded }
            })
            runs.push({ mode, scenario, file, title: trace.scenario.title, turns })
        }
    }
    return runs
}

// ---------- analysis ----------

function analyzeToken(decoded, recorded, opts) {
    const json = JSON.stringify(decoded)
    const expanded = expand(decoded)
    if (serialize(expanded) !== json) throw new Error('nested JSON expansion does not round-trip')
    const full = measure(expanded)
    const check = recorded
        ? {
              raw: recorded.rawJsonBytes === full.raw,
              gzip: recorded.gzipBytes === full.gzip,
              base64: recorded.base64Length === full.base64
          }
        : undefined

    const instances = new Map()
    const sentinels = new Map()
    walk(expanded, (p, node, type) => {
        const entry = instances.get(p) ?? { count: 0, approxBytes: 0, types: new Set() }
        entry.count += 1
        entry.types.add(type)
        if (type !== 'json-string') entry.approxBytes += Buffer.byteLength(JSON.stringify(collapse(node)) ?? '', 'utf8')
        else entry.approxBytes += Buffer.byteLength(JSON.stringify(serialize(node)), 'utf8')
        instances.set(p, entry)
        if (typeof node === 'string') {
            const n = [...node.matchAll(SENTINEL_RE)].length
            if (n) sentinels.set(p, (sentinels.get(p) ?? 0) + n)
        }
    })

    const categories = {}
    for (const category of CATEGORIES) categories[category.id] = costOf(expanded, full, category.paths, category.minus)

    const pathCosts = []
    for (const [p, entry] of instances) {
        if (!p || p.endsWith('<json>') || entry.approxBytes < opts.minPathBytes) continue
        pathCosts.push({ path: p, instances: entry.count, ...costOf(expanded, full, [p]) })
    }
    pathCosts.sort((a, b) => b.raw - a.raw)

    const history = decoded.pastChatHistory ?? []
    let records = []
    try {
        records = JSON.parse(decoded.previousExecution?.executionData ?? '[]')
    } catch {
        records = []
    }
    const lastState = [...records].reverse().find((record) => record?.data?.state)?.data?.state ?? {}
    const projection = measure(expand({ history: history.map(({ role, content }) => ({ role, content })), state: lastState }))

    return {
        sizes: full,
        check,
        historyMessages: history.length,
        historyWithAction: history.filter((message) => message.action).length,
        records: records.length,
        executionState: decoded.previousExecution?.state,
        sentinelTotal: [...sentinels.values()].reduce((a, b) => a + b, 0),
        sentinels: Object.fromEntries([...sentinels.entries()].sort((a, b) => b[1] - a[1])),
        categories,
        pathCosts,
        paths: Object.fromEntries([...instances.entries()].map(([p, e]) => [p, { count: e.count, types: [...e.types] }])),
        projection
    }
}

function analyze(opts) {
    const runs = loadTurns(opts)
    for (const run of runs) {
        let previous
        for (const turn of run.turns) {
            if (!turn.decoded) {
                turn.analysis = null
                continue
            }
            turn.analysis = analyzeToken(turn.decoded, turn.recorded, opts)
            const sizes = turn.analysis.sizes
            turn.analysis.growth = previous
                ? { raw: sizes.raw - previous.raw, gzip: sizes.gzip - previous.gzip, base64: sizes.base64 - previous.base64 }
                : null
            previous = sizes
            delete turn.decoded
        }
    }
    return runs
}

// ---------- inventory coverage ----------

function patternToRegExp(pattern) {
    const subtree = pattern.endsWith('.**')
    const base = subtree ? pattern.slice(0, -3) : pattern
    let re = ''
    for (let i = 0; i < base.length; i++) {
        const c = base[i]
        if (c === '*') re += '[^.[<]+'
        else if (c === '{') {
            const close = base.indexOf('}', i)
            re += `(?:${base
                .slice(i + 1, close)
                .split(',')
                .map((alt) => alt.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|')})`
            i = close
        } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${re}${subtree ? '(?:(?:\\.|\\[\\]|<json>).*)?' : ''}$`)
}

function readInventoryRows(file) {
    const rows = []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
        if (!line.startsWith('|') || /^\|\s*:?-/.test(line)) return
        const cells = line.split('|').slice(1, -1)
        const patterns = [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((p) => /^(pastChatHistory|previousExecution|\$)/.test(p))
        if (!patterns.length) return
        rows.push({ line: index + 1, patterns, regexps: patterns.map(patternToRegExp), text: line, notSeen: /not in before\//i.test(line) })
    })
    return rows
}

function checkInventory(opts) {
    const runs = loadTurns({ ...opts, modes: null, scenarios: null })
    const seen = new Map()
    for (const run of runs) {
        for (const turn of run.turns) {
            if (!turn.decoded) continue
            walk(expand(turn.decoded), (p, _node, type) => {
                if (!p) return
                const entry = seen.get(p) ?? { types: new Set(), where: new Set() }
                entry.types.add(type)
                entry.where.add(`${run.mode}/${run.scenario}`)
                seen.set(p, entry)
            })
        }
    }
    const rows = readInventoryRows(opts.checkInventory)
    const uncovered = []
    const rowHits = new Map(rows.map((row) => [row, 0]))
    const mapping = []
    for (const p of [...seen.keys()].sort()) {
        const matches = rows.filter((row) => row.regexps.some((re) => re.test(p)))
        if (!matches.length) {
            uncovered.push(p)
            continue
        }
        const best = matches.reduce((a, b) => (Math.max(...b.patterns.map((x) => x.length)) > Math.max(...a.patterns.map((x) => x.length)) ? b : a))
        rowHits.set(best, rowHits.get(best) + 1)
        mapping.push({ path: p, row: best.line })
    }
    const unmarkedUnused = rows.filter((row) => !row.notSeen && !seenByAnyPattern(row, seen))
    console.log(`Inventory: ${path.relative(process.cwd(), opts.checkInventory)} (${rows.length} rows)`)
    console.log(`Token paths seen in ${path.relative(process.cwd(), opts.traces)}: ${seen.size} (all modes, all turns)`)
    if (opts.verbose) for (const m of mapping) console.log(`  ${m.path}  ->  line ${m.row}`)
    for (const row of unmarkedUnused) console.log(`WARN line ${row.line}: no path in before/ matches and the row is not marked "not in before/": ${row.patterns.join(', ')}`)
    for (const row of rows.filter((r) => r.notSeen && seenByAnyPattern(r, seen))) {
        console.log(`WARN line ${row.line}: marked "not in before/" but matches seen paths: ${row.patterns.join(', ')}`)
    }
    if (uncovered.length) {
        console.log(`FAIL: ${uncovered.length} path(s) not covered by any row:`)
        for (const p of uncovered) console.log(`  ${p}  [${[...seen.get(p).types].join('|')}] ${[...seen.get(p).where].slice(0, 4).join(', ')}`)
        process.exitCode = 1
        return
    }
    console.log(`OK: every path is covered (${mapping.length} paths -> ${new Set(mapping.map((m) => m.row)).size} rows)`)
}

function seenByAnyPattern(row, seen) {
    for (const p of seen.keys()) if (row.regexps.some((re) => re.test(p))) return true
    return false
}

// ---------- output ----------

const kb = (bytes) => (bytes === undefined || bytes === null ? '' : `${(bytes / 1024).toFixed(Math.abs(bytes) < 1024 ? 2 : 1)}`)
const signedKb = (bytes) => (bytes === undefined || bytes === null ? '—' : `${bytes >= 0 ? '+' : '−'}${(Math.abs(bytes) / 1024).toFixed(1)}`)
const pct = (part, whole) => {
    if (!whole) return ''
    const value = (100 * part) / whole
    return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}
const statusLetter = (status) => ({ FINISHED: 'F', STOPPED: 'S', ERROR: 'E', TERMINATED: 'T' })[status] ?? (status ? status[0] : '?')

function renderMarkdown(runs, opts) {
    const out = []
    const m1 = runs.filter((run) => run.mode === 'M1')
    const tokenTurns = (run) => run.turns.filter((turn) => turn.analysis)
    const last = (run) => tokenTurns(run).at(-1)?.analysis

    out.push(BEGIN_MARKER)
    out.push('')
    out.push(`Generated by \`analyze-token.mjs\` from \`${path.relative(HERE, opts.traces)}\`. Sizes in KB (1024 bytes). Gzip and base64 are recomputed from the decoded token and match the sizes recorded at capture (${countChecks(runs)}).`)
    out.push('')
    out.push('Columns: **b64** token length as sent; **gzip** compressed payload; **raw** decoded JSON. Category shares are raw bytes removed when the category is deleted from the token (escaped size inside `executionData`); gzip costs are `gzip(token) − gzip(token without the category)` and do not add up.')
    out.push('')

    out.push('### A. All token runs (last turn)')
    out.push('')
    out.push('| Scenario | Mode | Statuses | Turns with token | b64 last | gzip last | raw last | raw max (turn) | History growth / turn | History | Records | State copies | Sentinels max | History + state only (raw / gzip) |')
    out.push('| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const run of runs) {
        const turns = tokenTurns(run)
        if (!turns.length) {
            out.push(`| ${run.scenario} | ${run.mode} | ${run.turns.map((t) => statusLetter(t.status)).join(' ')} | 0 | — | — | — | — | — | — | — | — | — | — |`)
            continue
        }
        const a = last(run)
        const max = turns.reduce((best, t) => (t.analysis.sizes.raw > best.analysis.sizes.raw ? t : best))
        const historyBytes = turns.map((t) => t.analysis.categories.history.raw)
        const avgGrowth = turns.length > 1 ? (historyBytes.at(-1) - historyBytes[0]) / (turns.length - 1) : null
        const sentinelMax = Math.max(...turns.map((t) => t.analysis.sentinelTotal))
        out.push(
            `| ${run.scenario} | ${run.mode} | ${run.turns.map((t) => statusLetter(t.status)).join(' ')} | ${turns.length} | ${kb(a.sizes.base64)} | ${kb(a.sizes.gzip)} | ${kb(a.sizes.raw)} | ${kb(max.analysis.sizes.raw)} (${max.id}) | ${avgGrowth === null ? '—' : signedKb(avgGrowth)} | ${pct(a.categories.history.raw + a.categories.historyAction.raw, a.sizes.raw)} | ${pct(a.categories.records.raw, a.sizes.raw)} | ${pct(a.categories.stateCopies.raw, a.sizes.raw)} | ${sentinelMax} | ${kb(a.projection.raw)} / ${kb(a.projection.gzip)} |`
        )
    }
    out.push('')
    out.push('"History + state only" re-encodes the last turn as `{history: [{role, content}], state}` (state = last record state): an indicative lower bound for TS10, not the Task 04 design.')
    out.push('')

    out.push('### B. Every M1 scenario per turn')
    out.push('')
    for (const run of m1) {
        out.push(`**${run.scenario}** ${run.title}`)
        out.push('')
        if (!tokenTurns(run).length) {
            out.push('No token in any turn (the non-streaming response carries none, F14).')
            out.push('')
            continue
        }
        out.push('| Turn | Status | b64 | gzip | raw | Δ raw | Δ gzip | History msgs (with action) | Records | History | History action | input.messages | humanInputAction | Other inputs | Other outputs | State copies | Envelope | Sentinels |')
        out.push('| :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
        for (const turn of run.turns) {
            const a = turn.analysis
            if (!a) {
                out.push(`| ${turn.id} | ${statusLetter(turn.status)} | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |`)
                continue
            }
            const c = a.categories
            out.push(
                `| ${turn.id} | ${statusLetter(turn.status)} | ${kb(a.sizes.base64)} | ${kb(a.sizes.gzip)} | ${kb(a.sizes.raw)} | ${signedKb(a.growth?.raw)} | ${signedKb(a.growth?.gzip)} | ${a.historyMessages} (${a.historyWithAction}) | ${a.records} | ${kb(c.history.raw)} | ${kb(c.historyAction.raw)} | ${kb(c.inputMessages.raw)} | ${kb(c.humanInputAction.raw)} | ${kb(c.otherInputs.raw)} | ${kb(c.otherOutputs.raw)} | ${kb(c.stateCopies.raw)} | ${kb(c.envelope.raw)} | ${a.sentinelTotal} |`
            )
        }
        out.push('')
    }

    out.push('### C. Gzip cost per category (M1, last turn and largest turn)')
    out.push('')
    out.push(`| Scenario | Turn | gzip | ${CATEGORIES.map((c) => c.label).join(' | ')} |`)
    out.push(`| :--- | :--- | ---: | ${CATEGORIES.map(() => '---:').join(' | ')} |`)
    for (const run of m1) {
        const turns = tokenTurns(run)
        if (!turns.length) continue
        const max = turns.reduce((best, t) => (t.analysis.sizes.raw > best.analysis.sizes.raw ? t : best))
        const picks = max === turns.at(-1) ? [max] : [max, turns.at(-1)]
        for (const turn of picks) {
            const a = turn.analysis
            out.push(`| ${run.scenario} | ${turn.id} | ${kb(a.sizes.gzip)} | ${CATEGORIES.map((c) => `${kb(a.categories[c.id].gzip)} (${pct(a.categories[c.id].gzip, a.sizes.gzip)})`).join(' | ')} |`)
        }
    }
    out.push('')

    out.push('### D. Sentinel copies per path (M1, highest count in any turn)')
    out.push('')
    out.push('Each LLM/Agent/Condition Agent prompt carries one `SYSPROMPT_SENTINEL_<scenario>_<node>`; a count above the number of prompt-bearing node runs means the prompt is stored more than once.')
    out.push('')
    out.push('| Scenario | Path | Max copies (turn) |')
    out.push('| :--- | :--- | ---: |')
    for (const run of m1) {
        const best = new Map()
        for (const turn of tokenTurns(run)) {
            for (const [p, n] of Object.entries(turn.analysis.sentinels)) {
                if (!best.has(p) || best.get(p).n < n) best.set(p, { n, turn: turn.id })
            }
        }
        for (const [p, { n, turn }] of [...best.entries()].sort((a, b) => b[1].n - a[1].n)) out.push(`| ${run.scenario} | \`${p}\` | ${n} (${turn}) |`)
    }
    out.push('')

    for (const scenario of opts.detail) {
        const run = m1.find((r) => r.scenario === scenario)
        if (!run) continue
        out.push(`### E. ${scenario} in detail: gzip cost per path`)
        out.push('')
        out.push(`Paths whose serialized size is at least ${opts.minPathBytes} B, largest raw cost first (array-element paths \`…[]\` omitted: they cost the same as their array). Instances: occurrences of the normalized path in that token.`)
        out.push('')
        for (const turn of tokenTurns(run)) {
            const a = turn.analysis
            out.push(`**${turn.id}** (${turn.status}, b64 ${kb(a.sizes.base64)} / gzip ${kb(a.sizes.gzip)} / raw ${kb(a.sizes.raw)} KB, ${a.historyMessages} history messages, ${a.records} records, ${a.sentinelTotal} sentinel copies)`)
            out.push('')
            out.push('| Path | Instances | Raw cost | Gzip cost | b64 cost |')
            out.push('| :--- | ---: | ---: | ---: | ---: |')
            for (const row of a.pathCosts.filter((r) => !r.path.endsWith('[]'))) {
                out.push(`| \`${row.path}\` | ${row.instances} | ${kb(row.raw)} | ${kb(row.gzip)} | ${kb(row.base64)} |`)
            }
            out.push('')
        }
    }
    out.push(END_MARKER)
    return out.join('\n')
}

function countChecks(runs) {
    let ok = 0
    let total = 0
    for (const run of runs) {
        for (const turn of run.turns) {
            const check = turn.analysis?.check
            if (!check) continue
            total += 1
            if (check.raw && check.gzip && check.base64) ok += 1
        }
    }
    return `${ok} of ${total} tokens`
}

function writeMarkdown(file, block) {
    let content = block
    if (fs.existsSync(file)) {
        const existing = fs.readFileSync(file, 'utf8')
        const start = existing.indexOf(BEGIN_MARKER)
        const end = existing.indexOf(END_MARKER)
        if (start !== -1 && end !== -1) content = existing.slice(0, start) + block + existing.slice(end + END_MARKER.length)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`)
}

function listPaths(opts) {
    const runs = loadTurns(opts)
    const seen = new Map()
    for (const run of runs) {
        for (const turn of run.turns) {
            if (!turn.decoded) continue
            walk(expand(turn.decoded), (p, _node, type) => {
                if (!p) return
                const entry = seen.get(p) ?? { types: new Set(), modes: new Set(), scenarios: new Set(), count: 0 }
                entry.types.add(type)
                entry.modes.add(run.mode)
                entry.scenarios.add(run.scenario)
                entry.count += 1
                seen.set(p, entry)
            })
        }
    }
    for (const [p, e] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`${p}\t${[...e.types].join('|')}\t${e.count}\t${[...e.modes].join(',')}\t${[...e.scenarios].join(',')}`)
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.checkInventory) return checkInventory(opts)
    if (opts.listPaths) return listPaths(opts)
    const runs = analyze(opts)
    const mismatches = []
    for (const run of runs) {
        for (const turn of run.turns) {
            const check = turn.analysis?.check
            if (check && !(check.raw && check.gzip && check.base64)) mismatches.push(`${run.mode}/${run.scenario} ${turn.id} ${JSON.stringify(check)}`)
        }
    }
    if (mismatches.length) console.error(`Recomputed sizes differ from the capture for:\n  ${mismatches.join('\n  ')}`)
    if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(runs, null, 1))
    if (opts.markdown) writeMarkdown(opts.markdown, renderMarkdown(runs, opts))
    if (!opts.json && !opts.markdown) {
        for (const run of runs) {
            for (const turn of run.turns) {
                const a = turn.analysis
                if (!a) continue
                console.log(`${run.mode}\t${run.scenario}\t${turn.id}\t${turn.status}\tb64 ${a.sizes.base64}\tgzip ${a.sizes.gzip}\traw ${a.sizes.raw}\tsentinels ${a.sentinelTotal}`)
            }
        }
    }
}

main()
