#!/usr/bin/env node
// Compares v1 continuations (capture-traces.mjs --continue-from <v1 dir> --turn <k>) with the v2 conversation (Task 10).
// The expected result of turns k+1… is the v2 trace of the same scenario and mode, carried on from the content of the
// v1 token: where the upgraded v1 token holds the same history, flow state, form values, child tokens and pending
// skeleton as the v2 token of turn k, every later turn must be class A identical; where a field differs (content
// written by the old server, e.g. F05's missing answers), only the aspects that field can reach may differ.
// Usage: node compare-continuations.mjs --v1 <before dir> --expected <after dir> --continued <continue-v1 dir>
//        [--markdown <file.md>] [--report <file.json>]
import fs from 'fs'
import path from 'path'
import { BASELINES_DIR } from './lib/flowise-client.mjs'
import { normalizeValue, traceReader } from './lib/normalize.mjs'
import { classA, firstDifference, listTraces } from './compare-traces.mjs'

const ASPECTS = ['modelRequests', 'streamedTokens', 'finalText', 'nodeSequence', 'status', 'finalState', 'action', 'error']
// Aspects a differing token field can change in later turns (the fake LLM picks replies by route, turn and call index)
const REACH = {
    history: ['modelRequests'],
    formValues: ['modelRequests'],
    flowState: ['modelRequests', 'streamedTokens', 'finalText', 'nodeSequence', 'finalState'],
    childFlowTokens: ['modelRequests', 'streamedTokens', 'finalText', 'finalState'],
    pending: []
}

function parseArgs(argv) {
    const opts = { v1: null, expected: null, continued: null, markdown: null, report: null }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = () => path.resolve(argv[++i])
        if (arg === '--v1') opts.v1 = next()
        else if (arg === '--expected') opts.expected = next()
        else if (arg === '--continued') opts.continued = next()
        else if (arg === '--markdown') opts.markdown = next()
        else if (arg === '--report') opts.report = next()
        else throw new Error(`Unknown argument ${arg}`)
    }
    if (!opts.v1 || !opts.expected || !opts.continued) throw new Error('--v1, --expected and --continued are required')
    return opts
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const stable = (value) => JSON.stringify(normalizeValue(value))
const parsed = (value) => (typeof value === 'string' && /^[[{]/.test(value) ? JSON.parse(value) : value)

function formValuesOf(form) {
    if (typeof form !== 'string') return form && typeof form === 'object' ? form : {}
    const values = {}
    for (const line of form.split('\n')) {
        const [key, value] = line.split(': ').map((part) => part.trim())
        if (key && value) values[key] = value
    }
    return values
}

// Mirror of upgradeV1 (trustedState.ts) for the fields a later turn reads
function upgradedV1Content(token) {
    const records = parsed(token.previousExecution?.executionData) ?? []
    let flowState = {}
    for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]?.data?.state) {
            flowState = records[i].data.state
            break
        }
    }
    const startOutput = records.find((r) => r?.data?.name === 'startAgentflow')?.data?.output
    const state = token.previousExecution?.state
    let resumable = null
    if (state === 'STOPPED') resumable = records
    else if (state === 'ERROR' && records.length >= 2 && records.at(-1).status === 'ERROR' && records.at(-2).status === 'STOPPED') resumable = records.slice(0, -1)
    return {
        history: (token.pastChatHistory ?? []).map((m) => ({ role: m.role, content: m.content })),
        flowState,
        formValues: startOutput && typeof startOutput === 'object' && 'form' in startOutput ? formValuesOf(parsed(startOutput.form)) : {},
        childFlowTokens: [],
        pending: resumable ? resumable.filter((r) => !r.data?.parentNodeId).map((r) => ({ nodeId: r.nodeId, status: r.status })) : null,
        stoppedAgents: (resumable ?? [])
            .filter((r) => r.status === 'STOPPED' && r.data?.name === 'agentAgentflow' && Array.isArray(r.data?.output?.humanInputAction?.data?.input?.messages))
            .map((r) => r.nodeId)
    }
}

function v2Content(token) {
    return {
        history: (token.history ?? []).map((m) => ({ role: m.role, content: m.content })),
        flowState: token.flowState ?? {},
        formValues: token.formValues ?? {},
        childFlowTokens: Object.entries(token.childFlowTokens ?? {}).map(([nodeId, entry]) => ({ nodeId, flowId: entry.flowId })),
        pending: token.pendingResume ? token.pendingResume.nodes.map((n) => ({ nodeId: n.nodeId, status: n.status })) : null
    }
}

const historyOf = (turn, resolve) => {
    const token = resolve(turn.token?.decoded)
    return token ? (token.history ?? []).map((m) => ({ role: m.role, content: m.content })) : null
}

function compareContinuation({ trace, v1Trace, expectedTrace, readers }) {
    const k = trace.resumedFrom.afterTurn
    const turnIds = expectedTrace.turns.map((t) => t.id)
    const kIndex = turnIds.indexOf(k)
    const v1Turn = v1Trace.turns.find((t) => t.id === k)
    const expectedK = expectedTrace.turns.find((t) => t.id === k)
    const v1 = upgradedV1Content(readers.v1.resolve(v1Turn.token.decoded))
    const v2 = v2Content(readers.expected.resolve(expectedK.token.decoded))
    const differingFields = Object.keys(REACH).filter((field) => stable(v1[field]) !== stable(v2[field]))
    const allowed = new Set(differingFields.flatMap((field) => REACH[field]))
    const acceptsClientHistory = trace.flows.some((f) => f.chatbotConfig?.clientState?.acceptClientHistory)
    const external = trace.endpoint !== 'internal-prediction'

    const result = { key: null, mode: trace.mode, scenario: trace.scenario.id, variant: trace.capture?.variant ?? null, from: k, differingFields, fieldDiffs: {}, turns: [], failures: [] }
    for (const field of differingFields) result.fieldDiffs[field] = firstDifference(normalizeValue(v1[field]), normalizeValue(v2[field]))

    const expectedHistoryAtK = historyOf(expectedK, readers.expected.resolve)
    for (const expectedTurn of expectedTrace.turns.slice(kIndex + 1)) {
        const turn = trace.turns.find((t) => t.id === expectedTurn.id)
        const fail = (kind, detail) => result.failures.push({ turn: expectedTurn.id, kind, ...detail })
        if (!turn) {
            fail('missing-turn', {})
            continue
        }
        const a = classA(expectedTurn, readers.expected.resolve)
        const b = classA(turn, readers.continued.resolve)
        const turnResult = { id: turn.id, aspects: {} }
        for (const aspect of ASPECTS) {
            const diff = firstDifference(a[aspect], b[aspect])
            if (!diff) turnResult.aspects[aspect] = 'same'
            else if (allowed.has(aspect)) turnResult.aspects[aspect] = { v1Content: true, diff }
            else {
                turnResult.aspects[aspect] = { unexpected: true, diff }
                fail('unexpected-difference', { aspect, diff })
            }
        }

        // The v1 history is carried as it is: the turn's history is the upgraded v1 history plus what the v2 conversation added since
        // turn k, with the same roles and user messages; a reply may differ only where the turn's text may (allowed finalText)
        const expectedHistory = historyOf(expectedTurn, readers.expected.resolve)
        const continuedHistory = historyOf(turn, readers.continued.resolve)
        const clientHistory = acceptsClientHistory && turn.request?.body?.history
        const extendsK = expectedHistory && expectedHistoryAtK && stable(expectedHistory.slice(0, expectedHistoryAtK.length)) === stable(expectedHistoryAtK)
        const wantHistory = clientHistory || !extendsK ? expectedHistory : [...v1.history, ...expectedHistory.slice(expectedHistoryAtK.length)]
        const sameMessage = (want, got) =>
            stable(want) === stable(got) || (want?.role === 'apiMessage' && got?.role === 'apiMessage' && allowed.has('finalText'))
        turnResult.historyCarried =
            Array.isArray(continuedHistory) && continuedHistory.length === wantHistory.length && wantHistory.every((m, i) => sameMessage(m, continuedHistory[i]))
        if (!turnResult.historyCarried) fail('history-not-carried', { diff: firstDifference(normalizeValue(wantHistory), normalizeValue(continuedHistory)) })

        const token = readers.continued.resolve(turn.token?.decoded)
        const pending = token?.pendingResume
        turnResult.pendingWhileStopped = Boolean(token) && Boolean(pending) === (turn.status === 'STOPPED')
        if (!turnResult.pendingWhileStopped) fail('pending-while-stopped', {})

        // D4: a v1 Agent checkpoint stays in the pending data (system prompt included) until that Agent is resumed
        const legacyCarrier = (pending?.nodes ?? []).some((n) => Array.isArray(n.legacyMessages))
        turnResult.tokenSentinels = turn.token?.sentinels?.total ?? 0
        turnResult.legacyCheckpoint = legacyCarrier
        if (turnResult.tokenSentinels > 0 && !legacyCarrier) fail('token-sentinels', { count: turnResult.tokenSentinels })
        if (external) {
            for (const payload of ['action', 'executedData', 'restJson']) {
                if ((turn.sentinels?.[payload]?.total ?? 0) > 0) fail('payload-sentinels', { payload, count: turn.sentinels[payload].total })
            }
        }

        // D4: the first resume of a paused v1 Agent replays its stored prompt, so it sends the v1 server's requests
        if (expectedTurn === expectedTrace.turns[kIndex + 1] && v1.stoppedAgents.length && turn.request?.body?.humanInput) {
            const v1Next = v1Trace.turns.find((t) => t.id === turn.id)
            turnResult.d4ReplayEqualsV1 = stable(classA(turn, readers.continued.resolve).modelRequests) === stable(classA(v1Next, readers.v1.resolve).modelRequests)
            if (!turnResult.d4ReplayEqualsV1) fail('d4-replay', {})
        }
        result.turns.push(turnResult)
    }
    return result
}

function compareAll(opts) {
    const readers = { v1: traceReader(opts.v1), expected: traceReader(opts.expected), continued: traceReader(opts.continued) }
    const results = []
    const failures = []
    for (const [key, file] of [...listTraces(opts.continued)].sort(([a], [b]) => a.localeCompare(b))) {
        const trace = readJson(file)
        if (!trace.resumedFrom) continue
        const slug = trace.scenario.file.replace(/\.json$/, '')
        const variant = trace.capture?.variant
        const v1File = path.join(opts.v1, trace.mode, `${slug}.json`)
        const expectedFile = path.join(opts.expected, trace.mode, `${slug}${variant ? `@${variant}` : ''}.json`)
        if (!fs.existsSync(v1File) || !fs.existsSync(expectedFile)) {
            failures.push({ key, kind: 'missing-reference', message: `${path.basename(v1File)} or ${path.basename(expectedFile)} missing` })
            continue
        }
        const result = compareContinuation({ trace, v1Trace: readJson(v1File), expectedTrace: readJson(expectedFile), readers })
        result.key = key
        results.push(result)
        for (const failure of result.failures) failures.push({ key, ...failure })
    }
    return { v1: shown(opts.v1), expected: shown(opts.expected), continued: shown(opts.continued), results, failures }
}

const shown = (dir) => {
    const relative = path.relative(BASELINES_DIR, dir)
    return relative.startsWith('..') ? `<outside baselines>/${path.basename(dir)}` : relative
}

function toMarkdown(report) {
    const lines = [
        '# v1 continuation comparison',
        '',
        `- v1 tokens: \`${report.v1}\`; expected (v2 conversation): \`${report.expected}\`; continuations: \`${report.continued}\``,
        `- Continuations: ${report.results.length}, turns compared: ${report.results.reduce((n, r) => n + r.turns.length, 0)}, failures: ${report.failures.length}`,
        '',
        '| Mode | Scenario | From | Turns | v1 token differs from v2 in | Aspects that differ (allowed) | History carried | D4 replay = v1 | Legacy checkpoint in token | Failures |',
        '| :--- | :--- | :--- | ---: | :--- | :--- | :---: | :---: | :--- | ---: |'
    ]
    for (const r of report.results) {
        const aspects = [...new Set(r.turns.flatMap((t) => Object.entries(t.aspects).filter(([, v]) => v !== 'same').map(([a]) => `${a} (${t.id})`)))]
        const d4 = r.turns.find((t) => t.d4ReplayEqualsV1 !== undefined)
        const legacy = r.turns.filter((t) => t.legacyCheckpoint).map((t) => `${t.id} (${t.tokenSentinels} sentinels)`)
        lines.push(
            `| ${r.mode} | ${r.scenario}${r.variant ? `@${r.variant}` : ''} | ${r.from} | ${r.turns.length} | ${r.differingFields.join(', ') || '—'} | ${aspects.join(', ') || 'none'} | ${r.turns.every((t) => t.historyCarried) ? 'yes' : '**no**'} | ${d4 ? (d4.d4ReplayEqualsV1 ? 'yes' : '**no**') : '—'} | ${legacy.join(', ') || '—'} | ${r.failures.length} |`
        )
    }
    const withDiffs = report.results.filter((r) => r.differingFields.length)
    if (withDiffs.length) {
        lines.push('', '## Where the v1 token differs from the v2 token of the same turn', '')
        for (const r of withDiffs) {
            for (const [field, diff] of Object.entries(r.fieldDiffs)) {
                lines.push(`- ${r.mode} ${r.scenario}${r.variant ? `@${r.variant}` : ''} from ${r.from}, \`${field}\` at \`${diff?.path}\`: v1 ${diff?.before} / v2 ${diff?.after}`)
            }
        }
    }
    if (report.failures.length) {
        lines.push('', '## Failures', '')
        for (const f of report.failures) lines.push(`- ${f.key} ${f.turn ?? ''} ${f.kind}${f.aspect ? ` ${f.aspect}` : ''}${f.diff ? ` at \`${f.diff.path}\`` : ''}${f.message ? `: ${f.message}` : ''}`)
    }
    return lines.join('\n') + '\n'
}

const opts = parseArgs(process.argv.slice(2))
const report = compareAll(opts)
if (opts.report) fs.writeFileSync(opts.report, JSON.stringify(report, null, 1) + '\n')
if (opts.markdown) fs.writeFileSync(opts.markdown, toMarkdown(report))
console.log(`Compared ${report.results.length} continuations, ${report.results.reduce((n, r) => n + r.turns.length, 0)} turns: ${report.failures.length} failure(s).`)
for (const f of report.failures.slice(0, 40)) {
    console.log(`  ${f.key} ${f.turn ?? ''} ${f.kind} ${f.aspect ?? ''}${f.diff ? ` at ${f.diff.path}\n      expected: ${f.diff.before}\n      got:      ${f.diff.after}` : ''}${f.message ? ` ${f.message}` : ''}`)
}
process.exit(report.failures.length ? 1 : 0)
