#!/usr/bin/env node
/**
 * Reproducible baseline/after trace capture script for Agentflow V2.
 *
 * Seeds/updates all 6 zero-API-key flows under ./flows into a running Flowise
 * instance, runs flow validation, executes both non-streaming and SSE streaming
 * predictions (with bounded timeouts), and writes JSON artifacts + summary.json.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { performance } from 'perf_hooks'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FLOW_DEFINITIONS = [
    {
        slug: '01-parallel-fork-join-timing-and-state',
        name: 'Baseline 01 - Parallel Fork-Join Timing & State',
        file: '01-parallel-fork-join-timing-and-state.json'
    },
    {
        slug: '02-multi-hop-and-nested-conditions',
        name: 'Baseline 02 - Multi-Hop & Nested Conditions',
        file: '02-multi-hop-and-nested-conditions.json'
    },
    {
        slug: '03-condition-multi-edge-fanout',
        name: 'Baseline 03 - Condition Multi-Edge Fanout',
        file: '03-condition-multi-edge-fanout.json'
    },
    {
        slug: '04-multi-terminal-streaming-and-silent-leaf',
        name: 'Baseline 04 - Multi-Terminal Streaming & Silent Leaf',
        file: '04-multi-terminal-streaming-and-silent-leaf.json'
    },
    {
        slug: '05-human-input-with-companion-text',
        name: 'Baseline 05 - HumanInput With Companion Text',
        file: '05-human-input-with-companion-text.json'
    },
    {
        slug: '06-loop-over-parallel-subgraph',
        name: 'Baseline 06 - Loop Over Parallel Subgraph',
        file: '06-loop-over-parallel-subgraph.json'
    }
]

function parseArgs(argv) {
    const opts = {
        baseUrl: process.env.FLOWISE_BASE_URL || 'http://localhost:3000',
        flowsDir: path.join(__dirname, 'flows'),
        outDir: path.join(__dirname, 'traces/before'),
        timeoutMs: Number(process.env.CAPTURE_TIMEOUT_MS || 15000),
        email: process.env.FLOWISE_EMAIL || 'baseline@flowise.local',
        password: process.env.FLOWISE_PASSWORD || 'BaselineTest!123'
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = argv[i + 1]
        if (arg === '--base-url' && next) {
            opts.baseUrl = next.replace(/\/+$/, '')
            i++
        } else if (arg === '--flows-dir' && next) {
            opts.flowsDir = path.resolve(next)
            i++
        } else if (arg === '--out-dir' && next) {
            opts.outDir = path.resolve(next)
            i++
        } else if (arg === '--timeout-ms' && next) {
            opts.timeoutMs = Number(next)
            i++
        } else if (arg === '--email' && next) {
            opts.email = next
            i++
        } else if (arg === '--password' && next) {
            opts.password = next
            i++
        }
    }
    return opts
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServer(baseUrl, maxWaitMs = 60000) {
    const deadline = Date.now() + maxWaitMs
    let lastError = null
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/v1/ping`)
            if (res.ok) return
            lastError = new Error(`HTTP ${res.status}`)
        } catch (err) {
            lastError = err
        }
        await sleep(500)
    }
    throw new Error(`Flowise server at ${baseUrl} did not become ready within ${maxWaitMs}ms: ${lastError?.message}`)
}

function extractCookies(res, cookieMap) {
    const setCookies =
        typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : res.headers.get('set-cookie')
              ? [res.headers.get('set-cookie')]
              : []
    for (const raw of setCookies) {
        if (!raw) continue
        const pair = raw.split(';')[0]
        const eqIdx = pair.indexOf('=')
        if (eqIdx > 0) {
            const k = pair.slice(0, eqIdx).trim()
            const v = pair.slice(eqIdx + 1).trim()
            cookieMap.set(k, v)
        }
    }
}

function formatCookieHeader(cookieMap) {
    return Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
}

async function bootstrapAuth(baseUrl, email, password) {
    const cookieMap = new Map()

    const resolveRes = await fetch(`${baseUrl}/api/v1/auth/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
    if (!resolveRes.ok) {
        throw new Error(`/api/v1/auth/resolve failed: HTTP ${resolveRes.status} ${await resolveRes.text()}`)
    }
    const resolveData = await resolveRes.json()

    if (resolveData.redirectUrl === '/organization-setup') {
        const regRes = await fetch(`${baseUrl}/api/v1/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: {
                    name: 'Baseline Tester',
                    email,
                    type: 'pro',
                    credential: password
                }
            })
        })
        if (!regRes.ok) {
            const body = await regRes.text()
            throw new Error(`/api/v1/account/register failed: HTTP ${regRes.status} ${body}`)
        }
    }

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    })
    if (!loginRes.ok) {
        throw new Error(`/api/v1/auth/login failed: HTTP ${loginRes.status} ${await loginRes.text()}`)
    }
    extractCookies(loginRes, cookieMap)
    const cookieHeader = formatCookieHeader(cookieMap)
    if (!cookieHeader) {
        throw new Error('Login succeeded but returned no session/JWT cookies')
    }
    return cookieHeader
}

async function apiJson(url, { method = 'GET', cookieHeader, body } = {}) {
    const headers = {
        'x-request-from': 'internal'
    }
    if (cookieHeader) headers.Cookie = cookieHeader
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed
    try {
        parsed = text ? JSON.parse(text) : null
    } catch {
        parsed = text
    }
    if (!res.ok) {
        throw new Error(`${method} ${url} failed: HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)
    }
    return parsed
}

async function upsertFlows(baseUrl, flowsDir, cookieHeader) {
    const existingList = await apiJson(`${baseUrl}/api/v1/chatflows?type=AGENTFLOW`, { cookieHeader })
    const existingRows = Array.isArray(existingList) ? existingList : existingList?.data || []
    const byName = new Map(existingRows.map((row) => [row.name, row]))

    const seeded = []
    for (const def of FLOW_DEFINITIONS) {
        const flowPath = path.join(flowsDir, def.file)
        const flowJson = JSON.parse(fs.readFileSync(flowPath, 'utf8'))
        const existing = byName.get(def.name)

        let saved
        if (existing) {
            saved = await apiJson(`${baseUrl}/api/v1/chatflows/${existing.id}`, {
                method: 'PUT',
                cookieHeader,
                body: {
                    name: def.name,
                    flowData: JSON.stringify(flowJson),
                    type: 'AGENTFLOW'
                }
            })
        } else {
            saved = await apiJson(`${baseUrl}/api/v1/chatflows`, {
                method: 'POST',
                cookieHeader,
                body: {
                    name: def.name,
                    flowData: JSON.stringify(flowJson),
                    deployed: false,
                    isPublic: false,
                    type: 'AGENTFLOW'
                }
            })
        }

        const validationIssues = await apiJson(`${baseUrl}/api/v1/validation/${saved.id}`, { cookieHeader })
        seeded.push({
            ...def,
            id: saved.id,
            validationIssues
        })
    }
    return seeded
}

function extractActionFromExecutedData(executedData) {
    if (!Array.isArray(executedData)) return null
    for (let i = executedData.length - 1; i >= 0; i--) {
        const action = executedData[i]?.data?.output?.humanInputAction
        if (action) return action
    }
    return null
}

async function runNonStreaming(baseUrl, chatflowId, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    const t0 = performance.now()

    let httpStatus = null
    let timedOut = false
    let error = null
    let response = null

    try {
        const res = await fetch(`${baseUrl}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, streaming: false }),
            signal: controller.signal
        })
        httpStatus = res.status
        const raw = await res.text()
        try {
            response = raw ? JSON.parse(raw) : null
        } catch {
            response = { raw }
        }
        if (!res.ok) {
            error = `HTTP ${res.status}: ${typeof response === 'string' ? response : JSON.stringify(response)}`
        }
    } catch (err) {
        if (controller.signal.aborted) {
            timedOut = true
            error = `Timed out after ${timeoutMs}ms`
        } else {
            error = err?.message || String(err)
        }
    } finally {
        clearTimeout(timer)
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100
    const executedData = response?.agentFlowExecutedData || null
    const extractedAction = response?.action || extractActionFromExecutedData(executedData)

    return {
        mode: 'non-streaming',
        request: { ...body, streaming: false },
        httpStatus,
        durationMs,
        timedOut,
        error,
        response: response
            ? {
                  text: response.text,
                  executionId: response.executionId,
                  sessionId: response.sessionId,
                  chatId: response.chatId,
                  chatMessageId: response.chatMessageId,
                  action: extractedAction,
                  agentFlowExecutedData: executedData
              }
            : null
    }
}

async function runStreaming(baseUrl, chatflowId, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    const t0 = performance.now()

    let httpStatus = null
    let timedOut = false
    let error = null
    const events = []

    try {
        const res = await fetch(`${baseUrl}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, streaming: true }),
            signal: controller.signal
        })
        httpStatus = res.status

        if (!res.ok || !res.body) {
            const raw = await res.text()
            error = `HTTP ${res.status}: ${raw}`
        } else {
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                let sepIdx
                while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, sepIdx)
                    buffer = buffer.slice(sepIdx + 2)
                    const offsetMs = Math.round((performance.now() - t0) * 100) / 100

                    for (const line of frame.split('\n')) {
                        if (!line.startsWith('data:')) continue
                        const payloadStr = line.slice(5).trim()
                        if (!payloadStr) continue
                        try {
                            const parsed = JSON.parse(payloadStr)
                            events.push({
                                offsetMs,
                                event: parsed.event,
                                data: parsed.data
                            })
                        } catch {
                            events.push({
                                offsetMs,
                                event: 'raw',
                                data: payloadStr
                            })
                        }
                    }
                }
            }

            if (buffer.trim()) {
                const offsetMs = Math.round((performance.now() - t0) * 100) / 100
                for (const line of buffer.split('\n')) {
                    if (!line.startsWith('data:')) continue
                    const payloadStr = line.slice(5).trim()
                    if (!payloadStr) continue
                    try {
                        const parsed = JSON.parse(payloadStr)
                        events.push({ offsetMs, event: parsed.event, data: parsed.data })
                    } catch {
                        events.push({ offsetMs, event: 'raw', data: payloadStr })
                    }
                }
            }
        }
    } catch (err) {
        if (controller.signal.aborted) {
            timedOut = true
            error = `Timed out after ${timeoutMs}ms`
        } else {
            error = err?.message || String(err)
        }
    } finally {
        clearTimeout(timer)
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100
    const tokenChunks = events.filter((e) => e.event === 'token').map((e) => String(e.data ?? ''))
    const streamedText = tokenChunks.join('')
    const executedEvent = [...events].reverse().find((e) => e.event === 'agentFlowExecutedData')
    const metadataEvent = [...events].reverse().find((e) => e.event === 'metadata')
    const actionEvent = [...events].reverse().find((e) => e.event === 'action')
    const errorEvent = events.find((e) => e.event === 'error')
    if (!error && errorEvent) {
        error = String(errorEvent.data)
    }

    return {
        mode: 'streaming',
        request: { ...body, streaming: true },
        httpStatus,
        durationMs,
        timedOut,
        error,
        streamedText,
        tokenChunks,
        agentFlowEvents: events.filter((e) => e.event === 'agentFlowEvent').map((e) => ({ offsetMs: e.offsetMs, status: e.data })),
        nextAgentFlowEvents: events.filter((e) => e.event === 'nextAgentFlow').map((e) => ({ offsetMs: e.offsetMs, ...e.data })),
        action: actionEvent ? actionEvent.data : extractActionFromExecutedData(executedEvent?.data),
        metadata: metadataEvent ? metadataEvent.data : null,
        agentFlowExecutedData: executedEvent ? executedEvent.data : null,
        events
    }
}

function summarizeRun(run) {
    if (!run) return null
    const executed =
        run.mode === 'streaming' ? run.agentFlowExecutedData : run.response?.agentFlowExecutedData
    const executedNodes = Array.isArray(executed)
        ? executed.map((d) => ({ nodeId: d.nodeId, label: d.nodeLabel, status: d.status }))
        : []
    const lastExecuted = Array.isArray(executed) && executed.length ? executed[executed.length - 1] : null
    return {
        mode: run.mode,
        httpStatus: run.httpStatus,
        durationMs: run.durationMs,
        timedOut: run.timedOut,
        error: run.error,
        text: run.mode === 'streaming' ? run.streamedText : run.response?.text,
        tokenChunks: run.tokenChunks || undefined,
        finalState: lastExecuted?.data?.state ?? null,
        actionLabel: (run.mode === 'streaming' ? run.action : run.response?.action)?.data?.nodeLabel ?? null,
        executedNodes
    }
}

async function captureAll(opts) {
    console.log(`Waiting for Flowise server at ${opts.baseUrl}...`)
    await waitForServer(opts.baseUrl)
    console.log('Server is up. Bootstrapping authentication...')
    const cookieHeader = await bootstrapAuth(opts.baseUrl, opts.email, opts.password)
    console.log('Authenticated. Seeding/updating 6 Agentflow V2 flows...')
    const seededFlows = await upsertFlows(opts.baseUrl, opts.flowsDir, cookieHeader)

    fs.mkdirSync(opts.outDir, { recursive: true })
    const summary = {
        capturedAt: new Date().toISOString(),
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
        flows: []
    }

    const ts = Date.now()

    for (const flow of seededFlows) {
        console.log(`\nCapturing ${flow.slug} (${flow.id})...`)
        let runs = {}

        if (flow.slug === '02-multi-hop-and-nested-conditions') {
            runs = {
                cond1_true: {
                    nonStreaming: await runNonStreaming(opts.baseUrl, flow.id, { question: 'true-branchA' }, opts.timeoutMs),
                    streaming: await runStreaming(opts.baseUrl, flow.id, { question: 'true-branchA' }, opts.timeoutMs)
                },
                cond1_false: {
                    nonStreaming: await runNonStreaming(opts.baseUrl, flow.id, { question: 'false' }, opts.timeoutMs),
                    streaming: await runStreaming(opts.baseUrl, flow.id, { question: 'false' }, opts.timeoutMs)
                }
            }
        } else if (flow.slug === '05-human-input-with-companion-text') {
            const restSessionId = `flow05-rest-${ts}`
            const restTurn1 = await runNonStreaming(
                opts.baseUrl,
                flow.id,
                { question: 'please review', overrideConfig: { sessionId: restSessionId } },
                opts.timeoutMs
            )
            const restTurn2 = await runNonStreaming(
                opts.baseUrl,
                flow.id,
                {
                    humanInput: {
                        type: 'proceed',
                        startNodeId: 'humanInputAgentflow_0',
                        feedback: 'Approved in baseline capture'
                    },
                    overrideConfig: { sessionId: restSessionId }
                },
                opts.timeoutMs
            )

            const sseSessionId = `flow05-sse-${ts}`
            const sseTurn1 = await runStreaming(
                opts.baseUrl,
                flow.id,
                { question: 'please review', overrideConfig: { sessionId: sseSessionId } },
                opts.timeoutMs
            )
            const sseTurn2 = await runStreaming(
                opts.baseUrl,
                flow.id,
                {
                    humanInput: {
                        type: 'proceed',
                        startNodeId: 'humanInputAgentflow_0',
                        feedback: 'Approved in baseline capture'
                    },
                    overrideConfig: { sessionId: sseSessionId }
                },
                opts.timeoutMs
            )

            runs = {
                nonStreaming: {
                    sessionId: restSessionId,
                    turn1_stopped: restTurn1,
                    turn2_resume: restTurn2
                },
                streaming: {
                    sessionId: sseSessionId,
                    turn1_stopped: sseTurn1,
                    turn2_resume: sseTurn2
                }
            }
        } else {
            const questionMap = {
                '01-parallel-fork-join-timing-and-state': 'run flow 01',
                '03-condition-multi-edge-fanout': 'go-true',
                '04-multi-terminal-streaming-and-silent-leaf': 'lookup data',
                '06-loop-over-parallel-subgraph': 'run loop'
            }
            const question = questionMap[flow.slug] || 'run'
            runs = {
                nonStreaming: await runNonStreaming(opts.baseUrl, flow.id, { question }, opts.timeoutMs),
                streaming: await runStreaming(opts.baseUrl, flow.id, { question }, opts.timeoutMs)
            }
        }

        const traceDoc = {
            capturedAt: new Date().toISOString(),
            flow: {
                slug: flow.slug,
                name: flow.name,
                file: flow.file,
                chatflowId: flow.id,
                validationIssues: flow.validationIssues
            },
            runs
        }

        const outPath = path.join(opts.outDir, `${flow.slug}.json`)
        fs.writeFileSync(outPath, JSON.stringify(traceDoc, null, 2) + '\n', 'utf8')

        let summarizedRuns
        if (flow.slug === '02-multi-hop-and-nested-conditions') {
            summarizedRuns = {
                cond1_true: {
                    nonStreaming: summarizeRun(runs.cond1_true.nonStreaming),
                    streaming: summarizeRun(runs.cond1_true.streaming)
                },
                cond1_false: {
                    nonStreaming: summarizeRun(runs.cond1_false.nonStreaming),
                    streaming: summarizeRun(runs.cond1_false.streaming)
                }
            }
        } else if (flow.slug === '05-human-input-with-companion-text') {
            summarizedRuns = {
                nonStreaming: {
                    turn1_stopped: summarizeRun(runs.nonStreaming.turn1_stopped),
                    turn2_resume: summarizeRun(runs.nonStreaming.turn2_resume)
                },
                streaming: {
                    turn1_stopped: summarizeRun(runs.streaming.turn1_stopped),
                    turn2_resume: summarizeRun(runs.streaming.turn2_resume)
                }
            }
        } else {
            summarizedRuns = {
                nonStreaming: summarizeRun(runs.nonStreaming),
                streaming: summarizeRun(runs.streaming)
            }
        }

        summary.flows.push({
            slug: flow.slug,
            name: flow.name,
            chatflowId: flow.id,
            validationIssueCount: Array.isArray(flow.validationIssues) ? flow.validationIssues.length : -1,
            validationIssues: flow.validationIssues,
            runs: summarizedRuns
        })
    }

    const summaryPath = path.join(opts.outDir, 'summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')

    console.log('\n=== Seeded Flows & Trace Summary ===')
    for (const item of summary.flows) {
        console.log(`- ${item.slug} -> chatflowId=${item.chatflowId}, validationIssues=${item.validationIssueCount}`)
    }
    console.log(`Saved traces and summary to ${opts.outDir}`)
}

captureAll(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('Capture failed:', err)
    process.exit(1)
})
