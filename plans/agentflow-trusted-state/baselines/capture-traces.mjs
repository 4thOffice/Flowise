#!/usr/bin/env node
// Captures multi-turn Agentflow V2 conversations against an isolated Flowise and the fake LLM.
// Usage and modes: see README.md in this folder.
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { performance } from 'perf_hooks'
import { FlowiseClient, loadCaptureEnv, waitForServer, BASELINES_DIR } from './lib/flowise-client.mjs'
import { CREDENTIAL_PLACEHOLDER, deterministicUuid } from './lib/flow-builder.mjs'
import { decodeTrustedState, encodeTrustedState } from './lib/trusted-state-codec.mjs'
import { BlobStore, collapseJsonStrings, countSentinels, expandJsonStrings, inflate, makeBlobReader, pathBytes, sha256 } from './lib/trace-store.mjs'

const MODES = {
    M1: { seedAs: 'M1', clientState: { enabled: true, enabledFull: true }, endpoint: 'prediction', dbRows: false },
    M2: { seedAs: 'M2', clientState: { enabled: true, enabledFull: false }, endpoint: 'prediction', dbRows: true },
    // Execution.createdDate has second resolution, so DB mode would resume an older execution if two turns started in the same second
    M3: { seedAs: 'M3', clientState: { enabled: false, enabledFull: false }, endpoint: 'prediction', dbRows: true, turnGapMs: 1100 },
    'M1-internal': { seedAs: 'M1', endpoint: 'internal-prediction', dbRows: true, scenarioFilter: (s) => (s.internalModes ?? []).includes('M1') },
    'M1-reqflag': { seedAs: 'M1-reqflag', clientState: null, requestFlag: true, endpoint: 'prediction', dbRows: true, scenarioFilter: (s) => s.id === 'S01' },
    'M3-envflags': {
        seedAs: 'M3',
        endpoint: 'prediction',
        dbRows: true,
        turnGapMs: 1100,
        scenarioFilter: (s) => s.id === 'S01',
        serverEnv: 'DISABLE_CHAT_MESSAGE_RECORDING=true DISABLE_EXECUTION_RECORDING=true'
    }
}
const DEFAULT_MODES = ['M1', 'M2', 'M3', 'M1-internal', 'M1-reqflag']
const SEED_CONFIGS = {
    M1: MODES.M1.clientState,
    M2: MODES.M2.clientState,
    M3: MODES.M3.clientState,
    'M1-reqflag': null
}
// Merged into the seeded clientState of a scenario's flows for its afterVariants; "off" is the default (no key)
const VARIANT_CLIENT_STATE = {
    'accept-client-history-on': { acceptClientHistory: true },
    'accept-client-history-off': {}
}

function parseArgs(argv) {
    const env = loadCaptureEnv()
    const opts = {
        env,
        baseUrl: env.FLOWISE_BASE_URL,
        fakeUrl: env.FAKE_LLM_BASE_URL.replace(/\/v1\/?$/, ''),
        outDir: path.join(BASELINES_DIR, 'traces/before'),
        modes: DEFAULT_MODES,
        scenarios: null,
        runTag: Date.now().toString(36),
        serverLog: null,
        commit: null,
        label: null,
        timeoutMs: 90000,
        continueFrom: null,
        continueTurn: null,
        variant: null,
        afterVariants: false,
        emptyDb: null
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = () => argv[++i]
        if (arg === '--out-dir') opts.outDir = path.resolve(next())
        else if (arg === '--modes') opts.modes = next().split(',')
        else if (arg === '--scenarios') opts.scenarios = next().split(',')
        else if (arg === '--after-variants') opts.afterVariants = true
        else if (arg === '--empty-db') opts.emptyDb = path.resolve(next())
        else if (arg === '--run-tag') opts.runTag = next()
        else if (arg === '--server-log') opts.serverLog = path.resolve(next())
        else if (arg === '--commit') opts.commit = next()
        else if (arg === '--label') opts.label = next()
        else if (arg === '--timeout-ms') opts.timeoutMs = Number(next())
        else if (arg === '--base-url') opts.baseUrl = next().replace(/\/+$/, '')
        else if (arg === '--continue-from') opts.continueFrom = path.resolve(next())
        else if (arg === '--turn') opts.continueTurn = next()
        else if (arg === '--variant') opts.variant = next()
        else throw new Error(`Unknown argument ${arg}`)
    }
    for (const mode of opts.modes) if (!MODES[mode]) throw new Error(`Unknown mode ${mode}`)
    if (opts.continueFrom && !opts.continueTurn) throw new Error('--continue-from needs --turn <k>')
    if (opts.variant && opts.afterVariants) throw new Error('--variant and --after-variants exclude each other')
    return opts
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function loadScenarios(filter) {
    const dir = path.join(BASELINES_DIR, 'scenarios')
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ file: f, slug: f.replace(/\.json$/, ''), ...readJson(path.join(dir, f)) }))
        .filter((s) => !filter || filter.includes(s.id))
}

class FakeLlm {
    constructor(url) {
        this.url = url
    }
    async post(route, body) {
        const res = await fetch(`${this.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!res.ok) throw new Error(`fake LLM ${route}: HTTP ${res.status}`)
        return res.json()
    }
    async requestsSince(seq) {
        const res = await fetch(`${this.url}/__control/requests?since=${seq}`)
        return (await res.json()).entries.filter((entry) => entry.kind === 'request')
    }
}

// ---------- seeding ----------

const flowChatflowId = (seedAs, flowSlug) => deterministicUuid(`ts00b|${seedAs}|${flowSlug}`)
const credentialId = () => deterministicUuid('ts00b|credential|fake-openai')

async function ensureCredential(client, env) {
    const id = credentialId()
    const body = {
        name: 'TS00b Fake OpenAI',
        credentialName: 'openAIApi',
        plainDataObj: { openAIApiKey: env.FAKE_LLM_API_KEY, openAIBaseUrl: env.FAKE_LLM_BASE_URL }
    }
    try {
        await client.api(`/api/v1/credentials/${id}`)
        await client.api(`/api/v1/credentials/${id}`, { method: 'PUT', body })
    } catch {
        await client.api('/api/v1/credentials', { method: 'POST', body: { id, ...body } })
    }
    return id
}

function resolveFlowData(flowJson, seedAs, credId) {
    let text = JSON.stringify({ nodes: flowJson.nodes, edges: flowJson.edges, viewport: flowJson.viewport })
    text = text.replaceAll(CREDENTIAL_PLACEHOLDER, credId)
    text = text.replace(/\{\{TS00B_FLOW_ID:([A-Za-z0-9-]+)\}\}/g, (_, slug) => flowChatflowId(seedAs, slug))
    return text
}

async function upsertChatflow(client, { id, name, flowData, chatbotConfig, apiConfig }) {
    const body = {
        name,
        flowData,
        type: 'AGENTFLOW',
        chatbotConfig: chatbotConfig ? JSON.stringify(chatbotConfig) : null,
        apiConfig: apiConfig ? JSON.stringify(apiConfig) : null
    }
    let exists = false
    try {
        await client.api(`/api/v1/chatflows/${id}`)
        exists = true
    } catch {
        exists = false
    }
    if (exists) await client.api(`/api/v1/chatflows/${id}`, { method: 'PUT', body })
    else await client.api('/api/v1/chatflows', { method: 'POST', body: { id, deployed: false, isPublic: false, ...body } })
}

async function seedFlows(client, credId, seedAs, flowSlugs, variantClientState = {}) {
    const seeded = {}
    const ordered = [...flowSlugs].sort((a, b) => dependencyRank(a) - dependencyRank(b))
    for (const slug of ordered) {
        const flowJson = readJson(path.join(BASELINES_DIR, 'flows', `${slug}.json`))
        const id = flowChatflowId(seedAs, slug)
        const chatbotConfig = SEED_CONFIGS[seedAs] ? { clientState: { ...SEED_CONFIGS[seedAs], ...variantClientState } } : null
        const apiConfig = flowJson.chatflowSettings?.apiConfig ?? null
        await upsertChatflow(client, {
            id,
            name: `TS00b ${seedAs} ${slug}`,
            flowData: resolveFlowData(flowJson, seedAs, credId),
            chatbotConfig,
            apiConfig
        })
        seeded[slug] = { slug, chatflowId: id, name: `TS00b ${seedAs} ${slug}`, chatbotConfig, apiConfig }
    }
    return seeded
}

const dependencyRank = (slug) => (/child|S01-single/.test(slug) ? 0 : 1)

// ---------- requests ----------

function sanitizeRequestBody(body) {
    const copy = JSON.parse(JSON.stringify(body))
    if (copy.trustedState) copy.trustedState = { $token: true, base64Length: body.trustedState.length, sha256: sha256(body.trustedState) }
    return copy
}

function parseSseFrames(buffer, t0, events) {
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const offsetMs = Math.round((performance.now() - t0) * 100) / 100
        for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try {
                const parsed = JSON.parse(payload)
                events.push({ offsetMs, event: parsed.event, data: parsed.data })
            } catch {
                events.push({ offsetMs, event: 'raw', data: payload })
            }
        }
    }
    return buffer
}

async function sendTurn({ url, body, headers, timeoutMs, streaming }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const t0 = performance.now()
    const out = { httpStatus: null, timedOut: false, error: null, events: null, json: null, rawText: null }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: controller.signal
        })
        out.httpStatus = res.status
        const contentType = res.headers.get('content-type') ?? ''
        if (streaming && contentType.includes('text/event-stream') && res.body) {
            const events = []
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer = parseSseFrames(buffer + decoder.decode(value, { stream: true }), t0, events)
            }
            parseSseFrames(buffer + '\n\n', t0, events)
            out.events = events
        } else {
            out.rawText = await res.text()
            try {
                out.json = out.rawText ? JSON.parse(out.rawText) : null
            } catch {
                out.json = null
            }
            if (!res.ok) out.error = `HTTP ${res.status}: ${out.rawText.slice(0, 2000)}`
        }
    } catch (err) {
        if (controller.signal.aborted) {
            out.timedOut = true
            out.error = `Timed out after ${timeoutMs}ms`
        } else out.error = err?.message ?? String(err)
    } finally {
        clearTimeout(timer)
    }
    out.durationMs = Math.round((performance.now() - t0) * 100) / 100
    return out
}

function buildHistory(conversation, spec) {
    const history = []
    if (spec.welcome) history.push({ role: 'apiMessage', content: spec.welcome })
    history.push(...conversation.map((m) => ({ role: m.role, content: m.content })))
    if (spec.dropLastBot && history.length && history[history.length - 1].role === 'apiMessage') history.pop()
    return history
}

function buildRequestBody({ turn, scenario, mode, chatId, token, lastAction, conversation }) {
    const body = { chatId, streaming: turn.streaming ?? scenario.streaming ?? true }
    if (turn.question !== undefined) body.question = turn.question
    if (turn.form !== undefined) body.form = turn.form
    if (turn.humanInput) {
        body.humanInput = { ...turn.humanInput }
        if (!body.humanInput.startNodeId && lastAction?.data?.nodeId) body.humanInput.startNodeId = lastAction.data.nodeId
    }
    const overrideConfig = turn.overrideConfig ? JSON.parse(JSON.stringify(turn.overrideConfig)) : undefined
    let history
    if (turn.history) {
        history = buildHistory(conversation, turn.history)
        body.history = history
    }
    if (turn.llmMessagesOverride) {
        const source = history ?? buildHistory(conversation, {})
        const llmMessages = source.map((m) => ({ role: m.role === 'apiMessage' ? 'assistant' : 'user', content: m.content }))
        body.overrideConfig = { ...(overrideConfig ?? {}), llmMessages }
    } else if (overrideConfig) body.overrideConfig = overrideConfig
    if (MODES[mode].requestFlag) body.enableTrustedState = true
    if (token && turn.sendToken !== false) body.trustedState = token
    return body
}

// ---------- per-turn extraction ----------

function lastEvent(events, name) {
    return events ? [...events].reverse().find((e) => e.event === name) : undefined
}

function deriveStatus(events, executed) {
    const flowEvent = lastEvent(events, 'agentFlowEvent')
    if (flowEvent) return { status: flowEvent.data, source: 'sse' }
    if (!Array.isArray(executed)) return { status: null, source: null }
    const latest = new Map()
    for (const record of executed) if (!record?.data?.parentNodeId) latest.set(record.nodeId, record.status)
    const statuses = [...latest.values()]
    if (statuses.includes('TERMINATED')) return { status: 'TERMINATED', source: 'records' }
    if (statuses.includes('ERROR')) return { status: 'ERROR', source: 'records' }
    if (statuses.includes('STOPPED')) return { status: 'STOPPED', source: 'records' }
    return { status: 'FINISHED', source: 'records' }
}

function finalStateOf(executed) {
    if (!Array.isArray(executed)) return null
    for (let i = executed.length - 1; i >= 0; i--) if (executed[i]?.data?.state) return executed[i].data.state
    return null
}

const jsonBytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)))

function v1Summary(state) {
    let records = null
    try {
        records = state.previousExecution?.executionData ? JSON.parse(state.previousExecution.executionData) : null
    } catch {
        records = null
    }
    return {
        previousExecutionBytes: jsonBytes(state.previousExecution),
        previousExecutionState: state.previousExecution?.state ?? null,
        executionDataStringBytes: jsonBytes(state.previousExecution?.executionData),
        records: Array.isArray(records)
            ? records.map((r) => ({
                  nodeId: r.nodeId,
                  status: r.status,
                  bytes: jsonBytes(r),
                  inputMessagesBytes: jsonBytes(r.data?.input?.messages),
                  stateBytes: jsonBytes(r.data?.state)
              }))
            : null
    }
}

function v2Summary(state) {
    const pending = state.pendingResume
    return {
        flowStateBytes: jsonBytes(state.flowState),
        formValuesBytes: jsonBytes(state.formValues),
        childFlowTokensBytes: jsonBytes(state.childFlowTokens),
        pendingResumeBytes: jsonBytes(pending),
        pendingNodes: Array.isArray(pending?.nodes)
            ? pending.nodes.map((n) => ({
                  nodeId: n.nodeId,
                  status: n.status,
                  bytes: jsonBytes(n),
                  promptBytes: jsonBytes(n.prompt),
                  checkpointBytes: jsonBytes(n.checkpoint),
                  legacyMessagesBytes: jsonBytes(n.legacyMessages)
              }))
            : null
    }
}

// Child flow tokens (Execute Flow) are encrypted inside the parent token, so they are decoded here, recursively
function decodeToken(token, secret) {
    const { json, state, sizes } = decodeTrustedState(token, secret)
    const v2 = state?.version === 2
    const history = (v2 ? state.history : state.pastChatHistory) ?? []
    const childTokens = {}
    for (const [nodeId, entry] of Object.entries(v2 && state.childFlowTokens ? state.childFlowTokens : {})) {
        if (typeof entry?.token !== 'string') continue
        try {
            const child = decodeToken(entry.token, secret)
            childTokens[nodeId] = {
                flowId: entry.flowId,
                base64Length: entry.token.length,
                sizes: child.summary,
                sentinels: child.sentinels,
                decoded: child.expanded,
                childTokens: child.childTokens
            }
        } catch (err) {
            childTokens[nodeId] = { flowId: entry.flowId, base64Length: entry.token.length, error: err.message }
        }
    }
    const summary = {
        ...sizes,
        version: v2 ? 2 : 1,
        topLevelKeys: Object.keys(state),
        historyMessages: history.length,
        historyBytes: jsonBytes(history),
        historyRoles: history.map((m) => m.role),
        historyMessagesWithAction: history.filter((m) => m.action).length,
        ...(v2 ? v2Summary(state) : v1Summary(state))
    }
    const childJsons = []
    const collect = (children) => {
        for (const child of Object.values(children)) {
            if (child.decoded) childJsons.push(JSON.stringify(collapseJsonStrings(child.decoded)))
            if (child.childTokens) collect(child.childTokens)
        }
    }
    collect(childTokens)
    const sentinels = countSentinels([json, ...childJsons].join('\n'))
    return { json, expanded: expandJsonStrings(state), summary, childTokens, sentinels }
}

function sentinelReport(parts) {
    const out = {}
    for (const [key, value] of Object.entries(parts)) {
        if (value === undefined || value === null) continue
        out[key] = countSentinels(typeof value === 'string' ? value : JSON.stringify(value))
    }
    return out
}

function readServerLogSince(file, offset) {
    if (!file || offset === null) return null
    try {
        const size = fs.statSync(file).size
        if (size <= offset) return []
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        return buf
            .toString('utf8')
            .split('\n')
            .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
            .filter((line) => /warn|error|not found|⚠️|❌/i.test(line))
            .map((line) => line.slice(0, 600))
    } catch {
        return null
    }
}

const logSize = (file) => {
    try {
        return file ? fs.statSync(file).size : null
    } catch {
        return null
    }
}

// The API returns executionDataBlob as base64 of the gzip that Compression.compress stores.
function decodeExecutionBlob(row) {
    const blob = row?.executionDataBlob
    const base64 = typeof blob === 'string' ? blob : blob?.type === 'Buffer' && Array.isArray(blob.data) ? Buffer.from(blob.data).toString('base64') : null
    if (!base64) return row
    try {
        const json = zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8')
        return {
            ...row,
            executionDataBlob: { gzipBytes: Buffer.from(base64, 'base64').length, sha256: sha256(base64) },
            executionDataFromBlob: json,
            executionDataFromBlobBytes: Buffer.byteLength(json)
        }
    } catch {
        return row
    }
}

async function fetchDbRows(client, chatflows, chatId) {
    const rows = {}
    for (const flow of chatflows) {
        const executions = await client
            .api(`/api/v1/executions?agentflowId=${flow.chatflowId}&sessionId=${encodeURIComponent(chatId)}&limit=100`)
            .catch((err) => ({ error: err.message }))
        const list = Array.isArray(executions?.data) ? executions.data : []
        const detailed = []
        for (const row of list.sort((a, b) => String(a.createdDate).localeCompare(String(b.createdDate)))) {
            const full = await client.api(`/api/v1/executions/${row.id}`).catch(() => row)
            detailed.push(decodeExecutionBlob(full))
        }
        const messages = await client
            .api(`/api/v1/chatmessage/${flow.chatflowId}?chatId=${encodeURIComponent(chatId)}&order=ASC`)
            .catch((err) => ({ error: err.message }))
        rows[flow.slug] = { executions: executions?.error ? executions : detailed, chatMessages: messages }
    }
    return rows
}

// Invariant 1 (PLAN §3): a conversation works with these tables emptied before every turn
let sqlite = null
async function emptyConversationTables(file) {
    sqlite ??= await import('node:sqlite')
    const db = new sqlite.DatabaseSync(file, { timeout: 10000 })
    try {
        const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
        const removed = { chatMessages: count('chat_message'), executions: count('execution') }
        db.exec('DELETE FROM chat_message; DELETE FROM execution;')
        return removed
    } finally {
        db.close()
    }
}

// ---------- scenario run ----------

async function runScenario({ opts, client, fake, scenario, mode, seeded, blobs, resume }) {
    const modeConfig = MODES[mode]
    const flows = [scenario.flow, ...(scenario.extraFlows ?? [])].map((slug) => seeded[slug])
    const target = seeded[scenario.flow]
    const chatId = `ts00b-${opts.runTag}-${mode}-${scenario.id}`
    const endpoint = `${opts.baseUrl}/api/v1/${modeConfig.endpoint}/${target.chatflowId}`
    const headers = modeConfig.endpoint === 'internal-prediction' ? { Cookie: client.cookieHeader, 'x-request-from': 'internal' } : {}

    await fake.post('/__control/clear', {})
    await fake.post('/__control/scenario', { scenario: scenario.id, mode, rules: scenario.llm?.rules ?? [], defaults: scenario.llm?.defaults ?? {} })

    let token = resume?.token ?? null
    let lastAction = resume?.lastAction ?? null
    const conversation = resume?.conversation ?? []
    const turns = []
    const startIndex = resume ? scenario.turns.findIndex((t) => t.id === resume.afterTurn) + 1 : 0

    for (const turn of scenario.turns.slice(startIndex)) {
        if (modeConfig.turnGapMs && turns.length) await new Promise((resolve) => setTimeout(resolve, modeConfig.turnGapMs))
        const dbEmptied = opts.emptyDb ? await emptyConversationTables(opts.emptyDb) : null
        const mark = await fake.post('/__control/mark', { turn: turn.id })
        const body = buildRequestBody({ turn, scenario, mode, chatId, token, lastAction, conversation })
        const logOffset = logSize(opts.serverLog)
        const response = await sendTurn({
            url: endpoint,
            body,
            headers,
            timeoutMs: turn.timeoutMs ?? opts.timeoutMs,
            streaming: body.streaming
        })
        const modelRequests = await fake.requestsSince(mark.seq)
        const serverLog = readServerLogSince(opts.serverLog, logOffset)

        const events = response.events
        const json = response.json
        const executed = events ? lastEvent(events, 'agentFlowExecutedData')?.data ?? null : json?.agentFlowExecutedData ?? null
        const actionEvent = events ? lastEvent(events, 'action')?.data ?? null : json?.action ?? null
        const tokenEvent = events ? lastEvent(events, 'trustedStateData')?.data ?? null : null
        const newToken = tokenEvent ?? (typeof json?.trustedState === 'string' ? json.trustedState : null)
        const errorEvent = events ? events.find((e) => e.event === 'error') : null
        const tokens = events ? events.filter((e) => e.event === 'token').map((e) => String(e.data ?? '')) : null
        const text = events ? tokens.join('') : json?.text ?? null
        const { status, source: statusSource } = deriveStatus(events, executed)

        let tokenRecord = { received: false }
        if (newToken) {
            const decoded = decodeToken(newToken, opts.env.CLIENT_STATE_SERVER_SECRET)
            tokenRecord = {
                received: true,
                source: tokenEvent ? 'sse' : 'json',
                base64Length: newToken.length,
                sha256: sha256(newToken),
                sizes: decoded.summary,
                pathBytes: pathBytes(decoded.expanded),
                decoded: decoded.expanded,
                ...(Object.keys(decoded.childTokens).length ? { childTokens: decoded.childTokens } : {}),
                sentinels: decoded.sentinels
            }
        }

        const dbRows = modeConfig.dbRows ? await fetchDbRows(client, flows, chatId) : null

        const sseEvents = events
            ? events.map((e) =>
                  e.event === 'trustedStateData'
                      ? { offsetMs: e.offsetMs, event: e.event, data: { $token: true, base64Length: String(e.data).length, sha256: sha256(String(e.data)) } }
                      : e.event === 'agentFlowExecutedData'
                      ? { offsetMs: e.offsetMs, event: e.event, data: { $see: 'executedData', records: Array.isArray(e.data) ? e.data.length : null } }
                      : e
              )
            : null
        const restJson = json
            ? {
                  ...json,
                  ...(typeof json.trustedState === 'string'
                      ? { trustedState: { $token: true, base64Length: json.trustedState.length, sha256: sha256(json.trustedState) } }
                      : {}),
                  ...(json.agentFlowExecutedData ? { agentFlowExecutedData: { $see: 'executedData' } } : {})
              }
            : null

        const record = {
            id: turn.id,
            note: turn.note ?? null,
            request: { endpoint: modeConfig.endpoint, body: sanitizeRequestBody(body) },
            tokenSent: body.trustedState ? { base64Length: body.trustedState.length, sha256: sha256(body.trustedState) } : null,
            response: {
                httpStatus: response.httpStatus,
                durationMs: response.durationMs,
                timedOut: response.timedOut,
                error: response.error ?? (errorEvent ? String(errorEvent.data) : null),
                streaming: Boolean(events),
                sseEvents,
                restJson,
                rawText: !events && !json ? response.rawText : undefined
            },
            status,
            statusSource,
            text,
            tokens,
            action: actionEvent,
            executedData: executed,
            nodeSequence: Array.isArray(executed) ? executed.map((r) => `${r.nodeId}:${r.status}`) : null,
            finalState: finalStateOf(executed),
            modelRequests: modelRequests.map((r) => ({
                seq: r.seq,
                route: r.route,
                callIndex: r.callIndex,
                ruleId: r.ruleId,
                stream: r.stream,
                status: r.status,
                body: r.body,
                reply: r.reply
            })),
            token: tokenRecord,
            sentinels: {
                token: tokenRecord.sentinels ?? null,
                ...sentinelReport({
                    action: actionEvent,
                    executedData: executed,
                    restJson: json && !events ? response.rawText : null,
                    sseOtherEvents: events ? events.filter((e) => e.event !== 'trustedStateData' && e.event !== 'agentFlowExecutedData') : null,
                    modelRequests: modelRequests.map((r) => r.body),
                    dbRows
                })
            },
            sizes: {
                actionBytes: actionEvent ? Buffer.byteLength(JSON.stringify(actionEvent)) : 0,
                actionInputBytes: actionEvent?.data?.input ? Buffer.byteLength(JSON.stringify(actionEvent.data.input)) : 0,
                executedDataBytes: executed ? Buffer.byteLength(JSON.stringify(executed)) : 0,
                executedDataGzipBytes: executed ? zlib.gzipSync(JSON.stringify(executed)).length : 0,
                restJsonBytes: !events && response.rawText ? Buffer.byteLength(response.rawText) : 0
            },
            db: dbRows,
            ...(dbEmptied ? { dbEmptiedBeforeTurn: dbEmptied } : {}),
            serverLog
        }
        turns.push(record)

        const userContent =
            turn.question ??
            (turn.form ? Object.entries(turn.form).map(([k, v]) => `${k}: ${v}`).join('\n') : turn.humanInput?.feedback ?? turn.humanInput?.type)
        if (status !== 'ERROR' && status !== 'TERMINATED') {
            conversation.push({ role: 'userMessage', content: userContent })
            if (text !== null) conversation.push({ role: 'apiMessage', content: text })
        }
        if (newToken) token = newToken
        lastAction = actionEvent ?? null

        const unscripted = modelRequests.filter((r) => r.ruleId === 'unscripted').length
        console.log(
            `  ${mode} ${scenario.id} ${turn.id}: HTTP ${response.httpStatus} ${status ?? '-'} ${response.durationMs}ms, ` +
                `${modelRequests.length} model calls${unscripted ? ` (${unscripted} UNSCRIPTED)` : ''}, ` +
                `token ${tokenRecord.received ? `${tokenRecord.base64Length} b64 / sentinels ${tokenRecord.sentinels.total}` : 'none'}` +
                (record.response.error ? `, error: ${String(record.response.error).slice(0, 160)}` : '')
        )
    }

    return {
        schema: 'ts-00b-trace/1',
        scenario: { id: scenario.id, file: scenario.file, title: scenario.title, findings: scenario.findings ?? [] },
        mode,
        endpoint: modeConfig.endpoint,
        chatId,
        runTag: opts.runTag,
        resumedFrom: resume ? { traceDir: resume.traceDir, afterTurn: resume.afterTurn } : null,
        flows: flows.map((f) => ({ slug: f.slug, chatflowId: f.chatflowId, name: f.name, chatbotConfig: f.chatbotConfig, apiConfig: f.apiConfig })),
        capturedAt: new Date().toISOString(),
        turns: blobs.externalize(expandJsonStrings(turns))
    }
}

function summarizeTrace(trace) {
    return {
        scenario: trace.scenario.id,
        mode: trace.mode,
        turns: trace.turns.map((t) => ({
            id: t.id,
            httpStatus: t.response.httpStatus,
            status: t.status,
            durationMs: t.response.durationMs,
            error: t.response.error ? String(t.response.error).slice(0, 300) : null,
            text: typeof t.text === 'string' ? t.text.slice(0, 200) : t.text,
            nodes: t.nodeSequence,
            modelCalls: t.modelRequests.length,
            unscriptedCalls: t.modelRequests.filter((r) => r.ruleId === 'unscripted').length,
            tokenReceived: t.token.received,
            tokenSent: Boolean(t.tokenSent),
            tokenVersion: t.token.sizes?.version ?? null,
            tokenBase64Length: t.token.base64Length ?? 0,
            tokenRawJsonBytes: t.token.sizes?.rawJsonBytes ?? 0,
            tokenGzipBytes: t.token.sizes?.gzipBytes ?? 0,
            historyMessages: t.token.sizes?.historyMessages ?? 0,
            sentinels: Object.fromEntries(Object.entries(t.sentinels).map(([k, v]) => [k, v?.total ?? null])),
            actionInputBytes: t.sizes.actionInputBytes,
            executedDataBytes: t.sizes.executedDataBytes
        }))
    }
}

function loadResumeState(opts, mode, scenario) {
    const tracePath = path.join(opts.continueFrom, mode, `${scenario.slug}.json`)
    if (!fs.existsSync(tracePath)) return null
    const trace = readJson(tracePath)
    const readBlob = makeBlobReader(opts.continueFrom)
    const index = trace.turns.findIndex((t) => t.id === opts.continueTurn)
    const turn = trace.turns[index]
    const skip = index < 0 ? 'no such turn' : index === scenario.turns.length - 1 ? 'last turn' : !turn.token?.received ? 'no token' : null
    if (skip) {
        console.log(`  ${mode} ${scenario.id}: not continued from ${opts.continueTurn} (${skip})`)
        return null
    }
    const decoded = collapseJsonStrings(inflate(turn.token.decoded, readBlob))
    const conversation = []
    for (const t of trace.turns.slice(0, index + 1)) {
        const spec = scenario.turns.find((s) => s.id === t.id) ?? {}
        if (t.status === 'ERROR' || t.status === 'TERMINATED') continue
        conversation.push({
            role: 'userMessage',
            content: spec.question ?? (spec.form ? Object.entries(spec.form).map(([k, v]) => `${k}: ${v}`).join('\n') : spec.humanInput?.feedback ?? spec.humanInput?.type)
        })
        if (t.text !== null) conversation.push({ role: 'apiMessage', content: inflate(t.text, readBlob) })
    }
    return {
        traceDir: path.relative(BASELINES_DIR, opts.continueFrom),
        afterTurn: opts.continueTurn,
        token: encodeTrustedState(typeof decoded === 'string' ? JSON.parse(decoded) : decoded, opts.env.CLIENT_STATE_SERVER_SECRET),
        lastAction: turn.action ? inflate(turn.action, readBlob) : null,
        conversation
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2))
    console.log(`Waiting for Flowise at ${opts.baseUrl} ...`)
    await waitForServer(opts.baseUrl)
    const health = await fetch(`${opts.fakeUrl}/__control/health`).catch(() => null)
    if (!health?.ok) throw new Error(`Fake LLM not reachable at ${opts.fakeUrl}; start fake-llm/fake-openai-server.mjs first`)

    const client = new FlowiseClient(opts.baseUrl)
    await client.login(opts.env.FLOWISE_EMAIL, opts.env.FLOWISE_PASSWORD)
    const credId = await ensureCredential(client, opts.env)
    const fake = new FakeLlm(opts.fakeUrl)
    const scenarios = loadScenarios(opts.scenarios)

    fs.mkdirSync(opts.outDir, { recursive: true })
    const blobs = new BlobStore(path.join(opts.outDir, 'blobs'))
    const summaryPath = path.join(opts.outDir, 'summary.json')
    const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : { runs: {} }
    summary.schema = 'ts-00b-summary/1'

    for (const mode of opts.modes) {
        const modeConfig = MODES[mode]
        const modeScenarios = scenarios.filter((s) => (modeConfig.scenarioFilter ? modeConfig.scenarioFilter(s) : (s.modes ?? []).includes(mode)))
        if (!modeScenarios.length) continue
        if (modeConfig.serverEnv) console.log(`\n${mode} expects the server to run with: ${modeConfig.serverEnv}`)
        const flowSlugs = new Set(modeScenarios.flatMap((s) => [s.flow, ...(s.extraFlows ?? [])]))
        const seeded = await seedFlows(client, credId, modeConfig.seedAs, flowSlugs)
        console.log(`\n== ${mode}: seeded ${flowSlugs.size} flows, ${modeScenarios.length} scenarios`)
        fs.mkdirSync(path.join(opts.outDir, mode), { recursive: true })

        for (const scenario of modeScenarios) {
            const resume = opts.continueFrom ? loadResumeState(opts, mode, scenario) : null
            if (opts.continueFrom && !resume) continue
            const variants = opts.afterVariants && scenario.afterVariants?.length ? scenario.afterVariants : [opts.variant]
            for (const variant of variants) {
                let scenarioSeeded = seeded
                if (opts.afterVariants && variant) {
                    if (!(variant in VARIANT_CLIENT_STATE)) throw new Error(`No seed config for variant ${variant}`)
                    const slugs = new Set([scenario.flow, ...(scenario.extraFlows ?? [])])
                    scenarioSeeded = { ...seeded, ...(await seedFlows(client, credId, modeConfig.seedAs, slugs, VARIANT_CLIENT_STATE[variant])) }
                }
                const runResume = resume ? { ...resume, conversation: [...resume.conversation] } : null
                const trace = await runScenario({ opts, client, fake, scenario, mode, seeded: scenarioSeeded, blobs, resume: runResume })
                trace.capture = {
                    commit: opts.commit,
                    label: opts.label,
                    serverEnv: modeConfig.serverEnv ?? null,
                    variant,
                    emptyDbBeforeEveryTurn: Boolean(opts.emptyDb)
                }
                const suffix = [variant, opts.continueFrom ? `from-${opts.continueTurn}` : null]
                    .filter(Boolean)
                    .map((part) => `@${part}`)
                    .join('')
                fs.writeFileSync(path.join(opts.outDir, mode, `${scenario.slug}${suffix}.json`), JSON.stringify(trace, null, 1) + '\n')
                summary.runs[`${mode}/${scenario.id}${suffix}`] = summarizeTrace(trace)
            }
            if (opts.afterVariants && scenario.afterVariants?.length) await seedFlows(client, credId, modeConfig.seedAs, new Set([scenario.flow]))
        }
    }

    const capture = {
        commit: opts.commit,
        label: opts.label,
        runTag: opts.runTag,
        capturedAt: new Date().toISOString(),
        baseUrl: opts.baseUrl,
        fakeUrl: opts.fakeUrl,
        node: process.version,
        modes: opts.modes,
        continueFrom: opts.continueFrom ? { dir: path.relative(BASELINES_DIR, opts.continueFrom), turn: opts.continueTurn } : null,
        variant: opts.variant,
        afterVariants: opts.afterVariants,
        emptyDbBeforeEveryTurn: Boolean(opts.emptyDb)
    }
    summary.captures = [...(summary.captures ?? []), capture]
    summary.runs = Object.fromEntries(Object.entries(summary.runs).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1) + '\n')
    console.log(`\nWrote traces and summary to ${opts.outDir}`)
}

main().catch((err) => {
    console.error('Capture failed:', err)
    process.exit(1)
})
