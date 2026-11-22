import crypto from 'crypto'
import path from 'path'

// The flows' model nodes run the real ChatOpenAI node; only its transport is replaced. Replies follow
// baselines/fake-llm/fake-openai-server.mjs: chosen by route marker, turn and per-route call index, never by content.

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')
const REAL_CHAT_OPENAI_PATH = path.join(REPO_ROOT, 'packages/components/dist/nodes/chatmodels/ChatOpenAI/ChatOpenAI.js')

export const FAKE_OPENAI_API_KEY = 'sk-fake-00b-test-key'
export const FAKE_OPENAI_BASE_URL = 'http://fake-llm.test/v1'

const CREATED = 1700000000
const ROUTE_RE = /\\?\[\\?\[route:([A-Za-z0-9.-]+)\\?\]\\?\]/

export interface ScriptedToolCall {
    id?: string
    name: string
    args?: Record<string, any>
}

export interface ScriptedReply {
    content?: string
    toolCalls?: ScriptedToolCall[]
    error?: { status?: number; message?: string }
    delayMs?: number
    chunkDelayMs?: number
    wordsPerChunk?: number
}

export interface ReplyRule {
    id?: string
    route?: string | string[]
    turn?: string | string[]
    mode?: string | string[]
    call?: number
    lastUserIncludes?: string
    anyMessageIncludes?: string
    hasToolResult?: boolean
    hasTools?: boolean
    reply: ScriptedReply
}

export interface OpenAIWireMessage {
    role: string
    content?: any
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    tool_call_id?: string
    [key: string]: any
}

export interface ModelCall {
    seq: number
    scenario: string | null
    mode: string | null
    turn: string | null
    route: string | null
    callIndex: number
    ruleId: string
    stream: boolean
    status: number
    body: Record<string, any>
    messages: OpenAIWireMessage[]
    tools: string[]
    reply: { content: string | null; toolCalls: ScriptedToolCall[] | null; error: ScriptedReply['error'] | null }
}

interface ReplyContext {
    route: string | null
    turn: string | null
    mode: string | null
    callIndex: number
    lastUser: string
    allText: string
    hasToolResult: boolean
    hasTools: boolean
}

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

const asList = <T>(value: T | T[] | undefined): T[] | undefined =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value]

export function messageText(message: OpenAIWireMessage | undefined): string {
    if (!message) return ''
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
        return message.content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
    }
    return ''
}

export function findRoute(messages: OpenAIWireMessage[]): string | null {
    const ordered = [...messages.filter((m) => m.role === 'system' || m.role === 'developer'), ...messages]
    for (const message of ordered) {
        const match = ROUTE_RE.exec(messageText(message))
        if (match) return match[1]
    }
    return null
}

function ruleMatches(rule: ReplyRule, ctx: ReplyContext): boolean {
    const routes = asList(rule.route)
    if (routes && !routes.includes(ctx.route ?? '_noroute')) return false
    const turns = asList(rule.turn)
    if (turns && !turns.includes(ctx.turn as string)) return false
    const modes = asList(rule.mode)
    if (modes && !modes.includes(ctx.mode as string)) return false
    if (rule.call !== undefined && rule.call !== ctx.callIndex) return false
    if (rule.lastUserIncludes && !ctx.lastUser.toLowerCase().includes(String(rule.lastUserIncludes).toLowerCase())) return false
    if (rule.anyMessageIncludes && !ctx.allText.includes(rule.anyMessageIncludes)) return false
    if (rule.hasToolResult !== undefined && rule.hasToolResult !== ctx.hasToolResult) return false
    if (rule.hasTools !== undefined && rule.hasTools !== ctx.hasTools) return false
    return true
}

function splitContent(content: string, wordsPerChunk: number): string[] {
    const chunks: string[] = []
    let current = ''
    let count = 0
    for (const piece of content.split(/(\s+)/)) {
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

function abortError(): Error {
    const err = new Error('The operation was aborted.')
    err.name = 'AbortError'
    return err
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError())
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(abortError())
        })
    })
}

export interface ScenarioRules {
    scenario: string
    mode?: string | null
    rules: ReplyRule[]
    defaults?: Partial<ScriptedReply>
}

export class ScriptedOpenAIServer {
    scenario: string | null = null
    mode: string | null = null
    rules: ReplyRule[] = []
    defaults: Partial<ScriptedReply> = {}
    turn: string | null = null
    readonly calls: ModelCall[] = []
    private callCounters = new Map<string, number>()
    private seq = 0

    setScenario({ scenario, mode = null, rules, defaults = {} }: ScenarioRules): void {
        this.scenario = scenario
        this.mode = mode
        this.rules = rules
        this.defaults = defaults
        this.turn = null
        this.callCounters.clear()
        this.calls.length = 0
    }

    markTurn(turn: string | null): void {
        this.turn = turn
        this.callCounters.clear()
    }

    callsSince(seq: number): ModelCall[] {
        return this.calls.filter((call) => call.seq > seq)
    }

    get lastSeq(): number {
        return this.seq
    }

    private chooseReply(body: Record<string, any>) {
        const messages: OpenAIWireMessage[] = Array.isArray(body.messages) ? body.messages : []
        const route = findRoute(messages)
        const key = `${this.turn}|${route ?? '_noroute'}`
        const callIndex = this.callCounters.get(key) ?? 0
        this.callCounters.set(key, callIndex + 1)

        const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
        const ctx: ReplyContext = {
            route,
            turn: this.turn,
            mode: this.mode,
            callIndex,
            lastUser: messageText(lastUserMessage),
            allText: messages.map(messageText).join('\n'),
            hasToolResult: messages.length > 0 && messages[messages.length - 1].role === 'tool',
            hasTools: Array.isArray(body.tools) && body.tools.length > 0
        }
        const fill = (template: string) =>
            String(template)
                .replaceAll('{turn}', ctx.turn ?? '-')
                .replaceAll('{call}', String(ctx.callIndex))
                .replaceAll('{route}', ctx.route ?? '_noroute')
                .replaceAll('{scenario}', this.scenario ?? '-')

        const ruleIndex = this.rules.findIndex((rule) => ruleMatches(rule, ctx))
        if (ruleIndex >= 0) {
            const rule = this.rules[ruleIndex]
            const reply: ScriptedReply = { ...this.defaults, ...rule.reply }
            if (reply.content !== undefined) reply.content = fill(reply.content)
            if (reply.toolCalls) {
                reply.toolCalls = reply.toolCalls.map((tc, i) => ({
                    id: tc.id ?? `call_${(route ?? 'noroute').replace(/[^A-Za-z0-9]/g, '')}_${ctx.turn ?? 'x'}_${callIndex}_${i}`,
                    name: tc.name,
                    args: tc.args ?? {}
                }))
            }
            return { ctx, ruleId: rule.id ?? `rule${ruleIndex}`, reply }
        }
        const digest = sha(JSON.stringify(messages)).slice(0, 12)
        return {
            ctx,
            ruleId: 'unscripted',
            reply: {
                content: `FAKE-UNSCRIPTED route=${route ?? '_noroute'} turn=${ctx.turn} call=${callIndex} digest=${digest}`
            } as ScriptedReply
        }
    }

    // Bound so it can be handed to the OpenAI client as its `fetch`
    fetch = async (input: any, init: any = {}): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input))
        const signal: AbortSignal | undefined = init.signal ?? undefined
        if (signal?.aborted) throw abortError()
        if (url.pathname.endsWith('/models')) {
            return jsonResponse(200, { object: 'list', data: [{ id: 'fake-model', object: 'model', created: CREATED, owned_by: 'fake' }] })
        }
        if (!url.pathname.endsWith('/chat/completions')) {
            return jsonResponse(404, {
                error: { message: `scripted model: no handler for ${url.pathname}`, type: 'invalid_request_error' }
            })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? {}
        return this.handleCompletion(body, signal)
    }

    private async handleCompletion(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
        const { ctx, ruleId, reply } = this.chooseReply(body)
        const status = reply.error ? reply.error.status ?? 500 : 200
        this.calls.push({
            seq: ++this.seq,
            scenario: this.scenario,
            mode: this.mode,
            turn: this.turn,
            route: ctx.route,
            callIndex: ctx.callIndex,
            ruleId,
            stream: Boolean(body.stream),
            status,
            body,
            messages: Array.isArray(body.messages) ? body.messages : [],
            tools: Array.isArray(body.tools) ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name ?? tool?.type) : [],
            reply: { content: reply.content ?? null, toolCalls: reply.toolCalls ?? null, error: reply.error ?? null }
        })

        if (reply.delayMs) await sleep(reply.delayMs, signal)

        if (reply.error) {
            return jsonResponse(status, {
                error: { message: reply.error.message ?? 'Injected fake LLM failure', type: 'server_error', param: null, code: null }
            })
        }

        const promptChars = JSON.stringify(body.messages ?? []).length
        const completionText = (reply.content ?? '') + JSON.stringify(reply.toolCalls ?? [])
        const prompt_tokens = Math.ceil(promptChars / 4)
        const completion_tokens = Math.max(1, Math.ceil(completionText.length / 4))
        const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
        const id = `chatcmpl-fake-${(ctx.route ?? 'noroute').replace(/[^A-Za-z0-9-]/g, '')}-${ctx.turn ?? 'x'}-${ctx.callIndex}`
        const model = body.model ?? 'fake-model'
        const toolCalls = reply.toolCalls ?? []
        const content = reply.content ?? ''

        if (!body.stream) {
            const message: Record<string, any> = {
                role: 'assistant',
                content: toolCalls.length && !reply.content ? null : content,
                refusal: null
            }
            if (toolCalls.length) {
                message.tool_calls = toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                }))
            }
            return jsonResponse(200, {
                id,
                object: 'chat.completion',
                created: CREATED,
                model,
                system_fingerprint: 'fp_fake00b',
                choices: [{ index: 0, message, logprobs: null, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
                usage
            })
        }

        const frame = (choices: any[], extra: Record<string, any> = {}) =>
            `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created: CREATED,
                model,
                system_fingerprint: 'fp_fake00b',
                choices,
                ...extra
            })}\n\n`
        const frames: string[] = []
        if (toolCalls.length) {
            frames.push(
                frame([{ index: 0, delta: { role: 'assistant', content: reply.content ?? null }, logprobs: null, finish_reason: null }])
            )
            toolCalls.forEach((tc, i) => {
                frames.push(
                    frame([
                        {
                            index: 0,
                            delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] },
                            logprobs: null,
                            finish_reason: null
                        }
                    ])
                )
                const args = JSON.stringify(tc.args)
                const mid = Math.ceil(args.length / 2)
                for (const part of [args.slice(0, mid), args.slice(mid)]) {
                    if (!part) continue
                    frames.push(
                        frame([
                            {
                                index: 0,
                                delta: { tool_calls: [{ index: i, function: { arguments: part } }] },
                                logprobs: null,
                                finish_reason: null
                            }
                        ])
                    )
                }
            })
            frames.push(frame([{ index: 0, delta: {}, logprobs: null, finish_reason: 'tool_calls' }]))
        } else {
            frames.push(
                frame([{ index: 0, delta: { role: 'assistant', content: '', refusal: null }, logprobs: null, finish_reason: null }])
            )
            for (const piece of splitContent(content, reply.wordsPerChunk ?? 4)) {
                frames.push(frame([{ index: 0, delta: { content: piece }, logprobs: null, finish_reason: null }]))
            }
            frames.push(frame([{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]))
        }
        if (body.stream_options?.include_usage) frames.push(frame([], { usage }))
        frames.push('data: [DONE]\n\n')

        const chunkDelay = reply.chunkDelayMs ?? 0
        const encoder = new TextEncoder()
        let index = 0
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (index >= frames.length) {
                    controller.close()
                    return
                }
                if (chunkDelay && index > 0) await sleep(chunkDelay, signal)
                controller.enqueue(encoder.encode(frames[index++]))
            }
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
}

function jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

let activeServer: ScriptedOpenAIServer | undefined

export function setActiveScriptedServer(server: ScriptedOpenAIServer | undefined): void {
    activeServer = server
}

export function getActiveScriptedServer(): ScriptedOpenAIServer | undefined {
    return activeServer
}

/*
 * Registered as `chatOpenAI` in the harness component nodes, so the flows run unchanged.
 * The real node builds the model from the flow's settings; the credential lookup is skipped by passing the
 * credential values inline, LangChain's retries (6, with backoff) are turned off, and requests go to the active
 * ScriptedOpenAIServer instead of the network.
 */
class TestChatOpenAINode {
    label!: string
    name!: string
    version!: number
    type!: string
    icon!: string
    category!: string
    description!: string
    baseClasses!: string[]
    credential: any
    inputs: any[] = []
    private readonly realNode: any

    constructor() {
        const { nodeClass: RealChatOpenAI } = require(REAL_CHAT_OPENAI_PATH)
        this.realNode = new RealChatOpenAI()
        for (const key of ['label', 'name', 'version', 'type', 'icon', 'category', 'description', 'baseClasses', 'credential', 'inputs']) {
            ;(this as any)[key] = this.realNode[key]
        }
    }

    async init(nodeData: any, input: string, options: any): Promise<any> {
        const server = activeServer
        if (!server) throw new Error('No ScriptedOpenAIServer is active for the test chat model')
        const model = await this.realNode.init(
            {
                ...nodeData,
                credential: '',
                inputs: { ...nodeData.inputs, openAIApiKey: FAKE_OPENAI_API_KEY, openAIBaseUrl: FAKE_OPENAI_BASE_URL }
            },
            input,
            options
        )
        // @langchain/openai 0.6 sends requests through the inner completions/responses models, each with its own client
        const AsyncCaller = model.caller.constructor
        for (const target of [model, model.completions, model.responses].filter(Boolean)) {
            target.caller = new AsyncCaller({ maxRetries: 0 })
            target.clientConfig = { ...target.clientConfig, fetch: server.fetch }
        }
        return model
    }
}

export { TestChatOpenAINode as nodeClass }
