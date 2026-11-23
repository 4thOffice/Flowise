#!/usr/bin/env node
// Compares two capture directories (TS6). Class A must be identical unless compare.config.json lists the
// difference for that finding, scenario, mode, turn and aspect; class B (token, payload sizes) is reported.
// Usage: node compare-traces.mjs --before <dir> --after <dir> [--config compare.config.json | --no-intended]
//        [--report <file.json>] [--markdown <file.md>]
import fs from 'fs'
import path from 'path'
import { normalizeValue, traceReader } from './lib/normalize.mjs'
import { BASELINES_DIR } from './lib/flowise-client.mjs'

const ASPECTS = ['modelRequests', 'streamedTokens', 'finalText', 'nodeSequence', 'status', 'finalState', 'action', 'error']

function parseArgs(argv) {
    const opts = { before: null, after: null, config: path.join(BASELINES_DIR, 'compare.config.json'), intended: true, report: null, markdown: null }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--before') opts.before = path.resolve(argv[++i])
        else if (arg === '--after') opts.after = path.resolve(argv[++i])
        else if (arg === '--config') opts.config = path.resolve(argv[++i])
        else if (arg === '--no-intended') opts.intended = false
        else if (arg === '--report') opts.report = path.resolve(argv[++i])
        else if (arg === '--markdown') opts.markdown = path.resolve(argv[++i])
        else throw new Error(`Unknown argument ${arg}`)
    }
    if (!opts.before || !opts.after) throw new Error('--before and --after are required')
    return opts
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const stable = (value) => JSON.stringify(value)

function listTraces(dir) {
    const out = new Map()
    for (const mode of fs.readdirSync(dir)) {
        const modeDir = path.join(dir, mode)
        if (mode === 'blobs' || !fs.statSync(modeDir).isDirectory()) continue
        for (const file of fs.readdirSync(modeDir)) if (file.endsWith('.json')) out.set(`${mode}/${file}`, path.join(modeDir, file))
    }
    return out
}

export function classA(turn, resolve) {
    const executed = resolve(turn.executedData)
    const requests = (resolve(turn.modelRequests) ?? []).map((r) => ({
        route: r.route ?? '_noroute',
        callIndex: r.callIndex,
        ruleId: r.ruleId,
        stream: r.stream,
        status: r.status,
        body: r.body
    }))
    requests.sort((a, b) => (a.route === b.route ? a.callIndex - b.callIndex : a.route < b.route ? -1 : 1))
    const action = resolve(turn.action)
    return normalizeValue({
        modelRequests: requests,
        streamedTokens: resolve(turn.tokens),
        finalText: resolve(turn.text),
        nodeSequence: Array.isArray(executed) ? executed.map((r) => `${r.nodeId}:${r.status}`).sort() : null,
        status: turn.status,
        finalState: resolve(turn.finalState),
        action: action ? { mapping: action.mapping, elements: action.elements, nodeId: action.data?.nodeId } : null,
        error: turn.response?.error ? String(turn.response.error) : null
    })
}

function firstDifference(a, b, pathLabel = '') {
    if (stable(a) === stable(b)) return null
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])]
        for (const key of keys) {
            const diff = firstDifference(a[key], b[key], Array.isArray(a) ? `${pathLabel}[${key}]` : `${pathLabel}.${key}`)
            if (diff) return diff
        }
    }
    const show = (v) => (v === undefined ? '<missing>' : JSON.stringify(v)?.slice(0, 400))
    return { path: pathLabel || '$', before: show(a), after: show(b) }
}

function turnMatches(spec, turnId, turnIds) {
    if (!spec || spec === '*') return true
    const list = Array.isArray(spec) ? spec : [spec]
    return list.some((item) => {
        if (item.endsWith('+')) return turnIds.indexOf(turnId) >= turnIds.indexOf(item.slice(0, -1))
        return item === turnId
    })
}

const listMatches = (spec, value) => !spec || spec === '*' || (Array.isArray(spec) ? spec.includes(value) : spec === value)

function coveringEntries(entries, { scenario, mode, variant, turnId, turnIds, aspect }) {
    return entries.filter(
        (entry) =>
            listMatches(entry.scenarios ?? entry.scenario, scenario) &&
            listMatches(entry.modes, mode) &&
            (entry.variant === undefined || entry.variant === variant) &&
            turnMatches(entry.turns, turnId, turnIds) &&
            listMatches(entry.aspects, aspect)
    )
}

// ---------- checks on the after trace ----------

function getPath(value, dotted) {
    return dotted.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), value)
}

function runCheck(check, ctx) {
    const { turn, resolve, peers, tokenV2 = {} } = ctx
    if (check.pending) return 'pending'
    const tokenHistory = () => getPath(resolve(turn.token?.decoded), check.historyPath ?? tokenV2.historyPath)
    switch (check.type) {
        case 'modelInputIncludes':
        case 'modelInputExcludes': {
            const requests = (resolve(turn.modelRequests) ?? []).filter(
                (r) => (!check.route || r.route === check.route) && (check.call === undefined || r.callIndex === check.call)
            )
            const found = requests.some((r) =>
                (r.body?.messages ?? []).some(
                    (m) =>
                        (!check.role || m.role === check.role) &&
                        (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(check.contentIncludes)
                )
            )
            return check.type === 'modelInputIncludes' ? found : requests.length > 0 && !found
        }
        case 'tokenSentinelMax':
            return (turn.token?.sentinels?.total ?? 0) <= check.max
        case 'payloadSentinelMax':
            return (turn.sentinels?.[check.payload]?.total ?? 0) <= check.max
        case 'tokenReceived':
            return Boolean(turn.token?.received) === (check.value ?? true)
        case 'tokenHistoryRoles': {
            const history = tokenHistory()
            const roles = Array.isArray(history) ? history.map((m) => m.role) : null
            return stable(roles) === stable(check.equals)
        }
        case 'tokenHistoryHasNoKey': {
            const history = tokenHistory()
            return Array.isArray(history) && history.every((m) => !(check.key in m))
        }
        case 'tokenHistoryAlternates': {
            const history = tokenHistory()
            return (
                Array.isArray(history) &&
                history.every(
                    (m, i) => m.role === (i % 2 === 0 ? 'userMessage' : 'apiMessage') && typeof m.content === 'string' && m.content.trim() !== ''
                )
            )
        }
        case 'tokenPendingWhileStopped': {
            const pending = getPath(resolve(turn.token?.decoded), check.path ?? tokenV2.pendingResumePath)
            return Boolean(turn.token?.decoded) && (pending !== undefined && pending !== null) === (turn.status === 'STOPPED')
        }
        case 'tokenHasNoKey':
            return !stable(resolve(turn.token?.decoded) ?? {}).includes(`"${check.key}"`)
        case 'tokenBytesMax':
            return (turn.token?.sizes?.rawJsonBytes ?? 0) <= check.max
        case 'actionKeysOnly': {
            const action = resolve(turn.action)
            if (!action) return false
            const flatten = (value, prefix = '') =>
                value && typeof value === 'object' && !Array.isArray(value) && !['mapping', 'elements'].includes(prefix.split('.').pop())
                    ? Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
                    : [prefix]
            return flatten(action).every((key) => check.allowed.includes(key))
        }
        case 'textIncludes':
            return String(resolve(turn.text) ?? '').includes(check.value)
        case 'finalStateEquals':
            return stable(getPath(resolve(turn.finalState) ?? {}, check.key)) === stable(check.value)
        case 'serverLogExcludes':
            return !(turn.serverLog ?? []).some((line) => new RegExp(check.pattern).test(line))
        case 'serverLogIncludes':
            return (turn.serverLog ?? []).some((line) => new RegExp(check.pattern).test(line))
        case 'payloadSentinelMin':
            return (turn.sentinels?.[check.payload]?.total ?? 0) >= check.min
        case 'tokenBytesRatioToBeforeMax': {
            const before = ctx.beforeTurn?.token?.sizes?.rawJsonBytes ?? 0
            const after = turn.token?.sizes?.rawJsonBytes ?? 0
            return before > 0 && after <= before * check.max
        }
        case 'sameClassAAsMode': {
            const peer = peers?.[check.mode]
            if (!peer) return false
            const peerTurn = peer.trace.turns.find((t) => t.id === turn.id)
            if (!peerTurn) return false
            return stable(classA(turn, resolve)) === stable(classA(peerTurn, peer.resolve))
        }
        default:
            throw new Error(`Unknown check type ${check.type}`)
    }
}

// ---------- main ----------

function compare(opts) {
    const config = opts.intended && fs.existsSync(opts.config) ? readJson(opts.config) : { intended: [] }
    const entries = (config.intended ?? []).filter((entry) => entry.status !== 'disabled')
    const beforeTraces = listTraces(opts.before)
    const afterTraces = listTraces(opts.after)
    const beforeReader = traceReader(opts.before)
    const afterReader = traceReader(opts.after)

    const afterByScenario = new Map()
    for (const [key, file] of afterTraces) {
        if (key.includes('@')) continue
        const trace = readJson(file)
        const bucket = afterByScenario.get(trace.scenario.id) ?? {}
        bucket[trace.mode] = { trace, resolve: afterReader.resolve }
        afterByScenario.set(trace.scenario.id, bucket)
    }

    const report = { before: shownPath(opts.before), after: shownPath(opts.after), intendedEntries: entries.length, pairs: [], failures: [], intendedSeen: {}, checks: [] }

    const pairsToRun = []
    for (const [key, beforeFile] of beforeTraces) {
        const variants = [...afterTraces.keys()].filter((k) => k.startsWith(key.replace(/\.json$/, '@')))
        if (!afterTraces.has(key) && !variants.length) {
            report.failures.push({ key, kind: 'missing-after', message: `${key} has no after trace` })
            continue
        }
        if (afterTraces.has(key)) pairsToRun.push({ key, beforeFile, afterFile: afterTraces.get(key), variant: null })
        for (const variantKey of variants) {
            pairsToRun.push({ key: variantKey, beforeFile, afterFile: afterTraces.get(variantKey), variant: variantKey.split('@')[1].replace(/\.json$/, '') })
        }
    }

    for (const { key, beforeFile, afterFile, variant } of pairsToRun) {
        const before = readJson(beforeFile)
        const after = readJson(afterFile)
        const scenario = before.scenario.id
        const mode = before.mode
        const turnIds = before.turns.map((t) => t.id)
        const pair = { key, scenario, mode, variant, turns: [] }

        for (const beforeTurn of before.turns) {
            const afterTurn = after.turns.find((t) => t.id === beforeTurn.id)
            if (!afterTurn) {
                report.failures.push({ key, turn: beforeTurn.id, kind: 'missing-turn', message: `turn ${beforeTurn.id} missing in after` })
                continue
            }
            const a = classA(beforeTurn, beforeReader.resolve)
            const b = classA(afterTurn, afterReader.resolve)
            const turnReport = { id: beforeTurn.id, aspects: {}, sizes: {} }
            for (const aspect of ASPECTS) {
                const diff = firstDifference(a[aspect], b[aspect])
                const covering = coveringEntries(entries, { scenario, mode, variant, turnId: beforeTurn.id, turnIds, aspect })
                if (!diff) {
                    turnReport.aspects[aspect] = 'same'
                    continue
                }
                if (covering.length) {
                    turnReport.aspects[aspect] = { intended: covering.map((e) => e.id), diff }
                    for (const entry of covering) report.intendedSeen[entry.id] = (report.intendedSeen[entry.id] ?? 0) + 1
                } else {
                    turnReport.aspects[aspect] = { unexpected: true, diff }
                    report.failures.push({ key, turn: beforeTurn.id, aspect, kind: 'unexpected-difference', diff })
                }
            }
            turnReport.sizes = {
                tokenRawJsonBytes: [beforeTurn.token?.sizes?.rawJsonBytes ?? 0, afterTurn.token?.sizes?.rawJsonBytes ?? 0],
                tokenBase64Length: [beforeTurn.token?.base64Length ?? 0, afterTurn.token?.base64Length ?? 0],
                tokenSentinels: [beforeTurn.token?.sentinels?.total ?? 0, afterTurn.token?.sentinels?.total ?? 0],
                actionInputBytes: [beforeTurn.sizes?.actionInputBytes ?? 0, afterTurn.sizes?.actionInputBytes ?? 0],
                executedDataBytes: [beforeTurn.sizes?.executedDataBytes ?? 0, afterTurn.sizes?.executedDataBytes ?? 0]
            }

            for (const entry of entries) {
                if (!entry.checks?.length) continue
                if (!listMatches(entry.scenarios ?? entry.scenario, scenario) || !listMatches(entry.modes, mode)) continue
                if (entry.variant !== undefined && entry.variant !== variant) continue
                for (const check of entry.checks) {
                    if (!turnMatches(check.turns ?? entry.turns, beforeTurn.id, turnIds)) continue
                    let passed
                    let error
                    try {
                        passed = runCheck(check, {
                            turn: afterTurn,
                            beforeTurn,
                            resolve: afterReader.resolve,
                            peers: afterByScenario.get(scenario),
                            tokenV2: config.tokenV2
                        })
                    } catch (err) {
                        passed = false
                        error = err.message
                    }
                    const result = { entry: entry.id, key, turn: beforeTurn.id, check: check.type, passed, ...(error ? { error } : {}) }
                    report.checks.push(result)
                    if (passed === false) report.failures.push({ key, turn: beforeTurn.id, kind: 'check-failed', entry: entry.id, check })
                }
            }
            pair.turns.push(turnReport)
        }
        report.pairs.push(pair)
    }

    for (const key of afterTraces.keys()) {
        if (!beforeTraces.has(key) && !beforeTraces.has(key.replace(/@[^/]+\.json$/, '.json'))) report.pairs.push({ key, afterOnly: true })
    }

    for (const entry of entries) {
        if (entry.mustDiffer === false) continue
        if (!entry.aspects?.length) continue
        const applicable = report.pairs.some(
            (p) =>
                !p.afterOnly &&
                listMatches(entry.scenarios ?? entry.scenario, p.scenario) &&
                listMatches(entry.modes, p.mode) &&
                (entry.variant === undefined || entry.variant === p.variant)
        )
        if (applicable && !report.intendedSeen[entry.id]) {
            report.failures.push({ kind: 'intended-difference-missing', entry: entry.id, message: `${entry.id} (${entry.finding}) expected a difference that did not appear` })
        }
    }
    return report
}

const shownPath = (dir) => {
    const relative = path.relative(BASELINES_DIR, dir)
    return relative.startsWith('..') ? `<outside baselines>/${path.basename(dir)}` : relative
}

function toMarkdown(report) {
    const lines = [`# Trace comparison`, '', `- Before: \`${shownPath(report.before)}\``, `- After: \`${shownPath(report.after)}\``, `- Intended entries: ${report.intendedEntries}`, `- Failures: ${report.failures.length}`, '']
    lines.push('| Trace | Turn | ' + ASPECTS.join(' | ') + ' | Token bytes (before → after) | Token sentinels |')
    lines.push('| :--- | :--- | ' + ASPECTS.map(() => ':---:').join(' | ') + ' | ---: | ---: |')
    for (const pair of report.pairs) {
        if (pair.afterOnly) continue
        for (const turn of pair.turns) {
            const cells = ASPECTS.map((aspect) => {
                const value = turn.aspects[aspect]
                if (value === 'same') return '='
                if (value?.intended) return `intended (${value.intended.join(', ')})`
                return '**DIFF**'
            })
            lines.push(
                `| ${pair.key} | ${turn.id} | ${cells.join(' | ')} | ${turn.sizes.tokenRawJsonBytes[0]} → ${turn.sizes.tokenRawJsonBytes[1]} | ${turn.sizes.tokenSentinels[0]} → ${turn.sizes.tokenSentinels[1]} |`
            )
        }
    }
    if (report.checks.length || report.intendedEntries) {
        const byEntry = new Map()
        for (const check of report.checks) {
            const row = byEntry.get(check.entry) ?? { passed: 0, failed: 0, pending: 0 }
            if (check.passed === true) row.passed += 1
            else if (check.passed === 'pending') row.pending += 1
            else row.failed += 1
            byEntry.set(check.entry, row)
        }
        lines.push('', '## Intended entries', '', '| Entry | Class A differences seen | Checks passed | Checks failed | Checks pending |', '| :--- | ---: | ---: | ---: | ---: |')
        for (const id of new Set([...Object.keys(report.intendedSeen), ...byEntry.keys()])) {
            const row = byEntry.get(id) ?? { passed: 0, failed: 0, pending: 0 }
            lines.push(`| ${id} | ${report.intendedSeen[id] ?? 0} | ${row.passed} | ${row.failed} | ${row.pending} |`)
        }
    }
    if (report.failures.length) {
        lines.push('', '## Failures', '')
        const grouped = new Map()
        for (const failure of report.failures) {
            const key = failure.kind === 'unexpected-difference' ? `${failure.kind} ${failure.key} ${failure.turn} ${failure.aspect}` : `${failure.kind} ${failure.entry ?? failure.key ?? ''}`
            const group = grouped.get(key) ?? { failure, count: 0 }
            group.count += 1
            grouped.set(key, group)
        }
        for (const [key, { failure, count }] of grouped) {
            lines.push(`- ${key}${count > 1 ? ` (${count}×)` : ''}${failure.diff ? ` at \`${failure.diff.path}\`` : failure.message ? `: ${failure.message}` : ''}`)
        }
    }
    return lines.join('\n') + '\n'
}

const opts = parseArgs(process.argv.slice(2))
const report = compare(opts)
if (opts.report) {
    fs.mkdirSync(path.dirname(opts.report), { recursive: true })
    fs.writeFileSync(opts.report, JSON.stringify(report, null, 1) + '\n')
}
if (opts.markdown) {
    fs.mkdirSync(path.dirname(opts.markdown), { recursive: true })
    fs.writeFileSync(opts.markdown, toMarkdown(report))
}
const turns = report.pairs.reduce((n, p) => n + (p.turns?.length ?? 0), 0)
const pending = report.checks.filter((c) => c.passed === 'pending').length
console.log(
    `Compared ${report.pairs.length} traces, ${turns} turns: ${report.failures.length} failure(s), ` +
        `${report.checks.length - pending} checks run, ${pending} pending.`
)
for (const failure of report.failures.slice(0, 40)) {
    console.log(`  ${failure.kind} ${failure.key ?? ''} ${failure.turn ?? ''} ${failure.aspect ?? failure.entry ?? ''}${failure.diff ? ` at ${failure.diff.path}\n      before: ${failure.diff.before}\n      after:  ${failure.diff.after}` : ''}`)
}
process.exit(report.failures.length ? 1 : 0)
