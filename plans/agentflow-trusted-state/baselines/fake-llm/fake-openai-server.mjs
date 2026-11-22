#!/usr/bin/env node
// Deterministic OpenAI-compatible chat completions server for the trusted-state capture suite.
// Replies come from the active scenario's rules, keyed by route marker, turn and call index, never by message
// content, so an intended change in model input does not ripple into later replies.
import http from 'http'
import crypto from 'crypto'

const PORT = Number(process.env.FAKE_LLM_PORT || process.argv[2] || 3199)
const CREATED = 1700000000
const ROUTE_RE = /\\?\[\\?\[route:([A-Za-z0-9.-]+)\\?\]\\?\]/

const control = {
    scenario: null,
    rules: [],
    defaults: {},
    turn: null,
    callCounters: new Map()
}
let seq = 0
const log = []

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function messageText(message) {
    if (!message) return ''
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
        return message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
    }
    return ''
}

function findRoute(messages) {
    const ordered = [...messages.filter((m) => m.role === 'system' || m.role === 'developer'), ...messages]
    for (const message of ordered) {
        const match = ROUTE_RE.exec(messageText(message))
        if (match) return match[1]
    }
    return null
}

function asList(value) {
    return value === undefined ? undefined : Array.isArray(value) ? value : [value]
}

function ruleMatches(rule, ctx) {
    const routes = asList(rule.route)
    if (routes && !routes.includes(ctx.route ?? '_noroute')) return false
    const turns = asList(rule.turn)
    if (turns && !turns.includes(ctx.turn)) return false
    const modes = asList(rule.mode)
    if (modes && !modes.includes(ctx.mode)) return false
    if (rule.call !== undefined && rule.call !== ctx.callIndex) return false
    if (rule.lastUserIncludes && !ctx.lastUser.toLowerCase().includes(String(rule.lastUserIncludes).toLowerCase())) return false
    if (rule.anyMessageIncludes && !ctx.allText.includes(rule.anyMessageIncludes)) return false
    if (rule.hasToolResult !== undefined && rule.hasToolResult !== ctx.hasToolResult) return false
    if (rule.hasTools !== undefined && rule.hasTools !== ctx.hasTools) return false
    return true
}

function fill(template, ctx) {
    return String(template)
        .replaceAll('{turn}', ctx.turn ?? '-')
        .replaceAll('{call}', String(ctx.callIndex))
        .replaceAll('{route}', ctx.route ?? '_noroute')
        .replaceAll('{scenario}', control.scenario ?? '-')
}

function chooseReply(body) {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const route = findRoute(messages)
    const key = `${control.turn}|${route ?? '_noroute'}`
    const callIndex = control.callCounters.get(key) ?? 0
    control.callCounters.set(key, callIndex + 1)

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    const ctx = {
        route,
        turn: control.turn,
        mode: control.mode,
        callIndex,
        lastUser: messageText(lastUserMessage),
        allText: messages.map(messageText).join('\n'),
        hasToolResult: messages.length > 0 && messages[messages.length - 1].role === 'tool',
        hasTools: Array.isArray(body.tools) && body.tools.length > 0
    }

    const ruleIndex = control.rules.findIndex((rule) => ruleMatches(rule, ctx))
    if (ruleIndex >= 0) {
        const rule = control.rules[ruleIndex]
        const reply = { ...control.defaults, ...rule.reply }
        if (reply.content !== undefined) reply.content = fill(reply.content, ctx)
        if (reply.toolCalls) {
            reply.toolCalls = reply.toolCalls.map((tc, i) => ({
                id: tc.id ?? `call_${(route ?? 'noroute').replace(/[^A-Za-z0-9]/g, '')}_${ctx.turn ?? 'x'}_${callIndex}_${i}`,
                name: tc.name,
                args: tc.args ?? {}
            }))
        }
        return { ctx, ruleIndex, ruleId: rule.id ?? `rule${ruleIndex}`, reply }
    }
    const digest = sha(JSON.stringify(messages)).slice(0, 12)
    return {
        ctx,
        ruleIndex: -1,
        ruleId: 'unscripted',
        reply: { content: `FAKE-UNSCRIPTED route=${route ?? '_noroute'} turn=${ctx.turn} call=${callIndex} digest=${digest}` }
    }
}

function usageFor(body, reply) {
    const promptChars = JSON.stringify(body.messages ?? []).length
    const completionText = (reply.content ?? '') + JSON.stringify(reply.toolCalls ?? [])
    const prompt_tokens = Math.ceil(promptChars / 4)
    const completion_tokens = Math.max(1, Math.ceil(completionText.length / 4))
    return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
}

function completionId(ctx) {
    return `chatcmpl-fake-${(ctx.route ?? 'noroute').replace(/[^A-Za-z0-9-]/g, '')}-${ctx.turn ?? 'x'}-${ctx.callIndex}`
}

function splitContent(content, wordsPerChunk) {
    const words = content.split(/(\s+)/)
    const chunks = []
    let current = ''
    let count = 0
    for (const piece of words) {
        current += piece
        if (piece.trim()) count += 1
        if (count >= wordsPerChunk) {
            chunks.push(current)
            current = ''
            count = 0
        }
    }
    if (current) chunks.push(current)
    return chunks.length ? chunks : ['']
}

function writeJson(res, status, payload) {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
}

async function handleCompletion(req, res, body) {
    const choice = chooseReply(body)
    const { ctx, reply } = choice
    const entry = {
        seq: ++seq,
        kind: 'request',
        at: new Date().toISOString(),
        scenario: control.scenario,
        mode: control.mode,
        turn: control.turn,
        route: ctx.route,
        callIndex: ctx.callIndex,
        ruleId: choice.ruleId,
        path: req.url,
        stream: Boolean(body.stream),
        authorization: req.headers.authorization ? 'Bearer <present>' : null,
        body,
        reply: { content: reply.content ?? null, toolCalls: reply.toolCalls ?? null, error: reply.error ?? null },
        status: reply.error ? reply.error.status ?? 500 : 200
    }
    log.push(entry)

    if (reply.delayMs) await sleep(reply.delayMs)

    if (reply.error) {
        writeJson(res, reply.error.status ?? 500, {
            error: { message: reply.error.message ?? 'Injected fake LLM failure', type: 'server_error', param: null, code: null }
        })
        return
    }

    const usage = usageFor(body, reply)
    const id = completionId(ctx)
    const model = body.model ?? 'fake-model'
    const toolCalls = reply.toolCalls ?? []
    const content = reply.content ?? (toolCalls.length ? '' : '')

    if (!body.stream) {
        const message = { role: 'assistant', content: toolCalls.length && !reply.content ? null : content, refusal: null }
        if (toolCalls.length) {
            message.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) }
            }))
        }
        writeJson(res, 200, {
            id,
            object: 'chat.completion',
            created: CREATED,
            model,
            system_fingerprint: 'fp_fake00b',
            choices: [{ index: 0, message, logprobs: null, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
            usage
        })
        return
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (choices, extra = {}) => {
        res.write(
            `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created: CREATED,
                model,
                system_fingerprint: 'fp_fake00b',
                choices,
                ...extra
            })}\n\n`
        )
    }
    const chunkDelay = reply.chunkDelayMs ?? 0

    if (toolCalls.length) {
        send([{ index: 0, delta: { role: 'assistant', content: reply.content ?? null }, logprobs: null, finish_reason: null }])
        for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            send([
                {
                    index: 0,
                    delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] },
                    logprobs: null,
                    finish_reason: null
                }
            ])
            const args = JSON.stringify(tc.args)
            const mid = Math.ceil(args.length / 2)
            for (const part of [args.slice(0, mid), args.slice(mid)]) {
                if (!part) continue
                if (chunkDelay) await sleep(chunkDelay)
                send([{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] }, logprobs: null, finish_reason: null }])
            }
        }
        send([{ index: 0, delta: {}, logprobs: null, finish_reason: 'tool_calls' }])
    } else {
        send([{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, logprobs: null, finish_reason: null }])
        for (const piece of splitContent(content, reply.wordsPerChunk ?? 4)) {
            if (chunkDelay) await sleep(chunkDelay)
            send([{ index: 0, delta: { content: piece }, logprobs: null, finish_reason: null }])
        }
        send([{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }])
    }
    if (body.stream_options?.include_usage) send([], { usage })
    res.write('data: [DONE]\n\n')
    res.end()
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (!text) return resolve({})
            try {
                resolve(JSON.parse(text))
            } catch (err) {
                reject(err)
            }
        })
        req.on('error', reject)
    })
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`)
        if (req.method === 'GET' && url.pathname === '/v1/models') {
            return writeJson(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model', created: CREATED, owned_by: 'fake' }] })
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            return await handleCompletion(req, res, await readBody(req))
        }
        if (req.method === 'POST' && url.pathname === '/__control/scenario') {
            const body = await readBody(req)
            control.scenario = body.scenario ?? null
            control.mode = body.mode ?? null
            control.rules = Array.isArray(body.rules) ? body.rules : []
            control.defaults = body.defaults ?? {}
            control.turn = null
            control.callCounters.clear()
            log.push({ seq: ++seq, kind: 'scenario', at: new Date().toISOString(), scenario: control.scenario, mode: control.mode })
            return writeJson(res, 200, { ok: true, seq, rules: control.rules.length })
        }
        if (req.method === 'POST' && url.pathname === '/__control/mark') {
            const body = await readBody(req)
            control.turn = body.turn ?? body.label ?? null
            control.callCounters.clear()
            log.push({ seq: ++seq, kind: 'mark', at: new Date().toISOString(), scenario: control.scenario, mode: control.mode, turn: control.turn })
            return writeJson(res, 200, { ok: true, seq })
        }
        if (req.method === 'POST' && url.pathname === '/__control/clear') {
            log.length = 0
            return writeJson(res, 200, { ok: true, seq })
        }
        if (req.method === 'GET' && url.pathname === '/__control/requests') {
            const since = Number(url.searchParams.get('since') ?? 0)
            return writeJson(res, 200, { seq, entries: log.filter((entry) => entry.seq > since) })
        }
        if (req.method === 'GET' && url.pathname === '/__control/health') {
            return writeJson(res, 200, { ok: true, seq, scenario: control.scenario, turn: control.turn })
        }
        writeJson(res, 404, { error: { message: `fake-openai-server: no handler for ${req.method} ${url.pathname}`, type: 'invalid_request_error' } })
    } catch (err) {
        writeJson(res, 500, { error: { message: `fake-openai-server internal error: ${err?.message ?? err}`, type: 'server_error' } })
    }
})

server.listen(PORT, () => {
    console.log(`fake-openai-server listening on :${PORT}`)
})
