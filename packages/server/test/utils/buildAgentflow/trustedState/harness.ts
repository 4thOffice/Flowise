import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'
import zlib from 'zlib'
import axios from 'axios'
import { cloneDeep } from 'lodash'
import { Response } from 'express'
import { DataSource } from 'typeorm'
import { ICommonObject } from 'flowise-components'
import { executeAgentFlow } from '../../../../src/utils/buildAgentflow'
import { SSEStreamer } from '../../../../src/utils/SSEStreamer'
import { resolveFlowRedirect } from '../../../../src/utils/flowRedirect'
import logger from '../../../../src/utils/logger'
import { getErrorMessage } from '../../../../src/errors/utils'
import { Compression } from '../../../../src/database/entities/Execution'
import { ChatFlow } from '../../../../src/database/entities/ChatFlow'
import { IComponentNodes, IReactFlowObject } from '../../../../src/Interface'
import { CachePool } from '../../../../src/CachePool'
import { UsageCacheManager } from '../../../../src/UsageCacheManager'
import { Telemetry } from '../../../../src/utils/telemetry'
import { createMockDataSource, loadComponentNodes } from '../testHelpers'
import {
    ModelCall,
    OpenAIWireMessage,
    ReplyRule,
    ScriptedOpenAIServer,
    nodeClass as TestChatOpenAINode,
    setActiveScriptedServer
} from './testChatModel'

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')
export const BASELINES_DIR = path.join(REPO_ROOT, 'plans/agentflow-trusted-state/baselines')

export const TEST_CREDENTIAL_ID = 'ts01-fake-openai-credential'
export const WORKSPACE_ID = 'ws-1'
export const ORG_ID = 'org-1'
export const BASE_URL = 'http://localhost:3000'
export const flowIdFor = (slug: string) => `ts01-${slug}`

// ---------- scenarios and flows (Task 00b suite) ----------

export interface ClientHistorySpec {
    welcome?: string
    dropLastBot?: boolean
}

export interface TurnSpec {
    id: string
    question?: string
    form?: Record<string, any>
    humanInput?: { type: 'proceed' | 'reject'; feedback?: string; startNodeId?: string }
    overrideConfig?: ICommonObject
    history?: ClientHistorySpec | Array<{ role: string; content: string }>
    llmMessagesOverride?: boolean
    streaming?: boolean
    sendToken?: boolean
    token?: string | null
    note?: string
    timeoutMs?: number
}

export interface ScenarioScript {
    id: string
    slug: string
    title: string
    flow: string
    extraFlows?: string[]
    findings?: string[]
    modes?: string[]
    streaming?: boolean
    turns: TurnSpec[]
    llm: { rules: ReplyRule[]; defaults?: Record<string, any> }
    expectedAfter?: Record<string, string>
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

export function loadScenario(id: string): ScenarioScript {
    const dir = path.join(BASELINES_DIR, 'scenarios')
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const script = readJson(path.join(dir, file))
        if (script.id === id) return { ...script, slug: file.replace(/\.json$/, '') }
    }
    throw new Error(`No scenario ${id} in ${dir}`)
}

/*
 * S11 t2: the capture server retried Agent A's HTTP 500 six times with backoff, so LLM B (300 ms) finished first and
 * its state change is part of the failed turn. The harness does not retry, so the 500 reply waits 600 ms instead.
 */
export function loadHarnessScenario(id: string): ScenarioScript {
    const script = loadScenario(id)
    return id === 'S11' ? withReplyOverrides(script, { 'agentA-error': { delayMs: 600 } }) : script
}

export interface LoadedFlow {
    slug: string
    flowData: string
    flow: IReactFlowObject
    apiConfig?: ICommonObject
}

export function loadFlow(slug: string): LoadedFlow {
    const json = readJson(path.join(BASELINES_DIR, 'flows', `${slug}.json`))
    const flowData = JSON.stringify({ nodes: json.nodes, edges: json.edges, viewport: json.viewport })
        .replaceAll('{{TS00B_CREDENTIAL_ID}}', TEST_CREDENTIAL_ID)
        .replace(/\{\{TS00B_FLOW_ID:([A-Za-z0-9-]+)\}\}/g, (_, target) => flowIdFor(target))
    return { slug, flowData, flow: JSON.parse(flowData), apiConfig: json.chatflowSettings?.apiConfig ?? undefined }
}

// ---------- modes (baselines/README.md §3) ----------

export type HarnessMode = 'M1' | 'M2' | 'M3' | 'M1-internal' | 'M1-reqflag' | 'M3-envflags'

interface ModeConfig {
    clientState: { enabled: boolean; enabledFull: boolean } | null
    isInternal?: boolean
    requestFlag?: boolean
    env?: Record<string, string>
}

export const MODES: Record<HarnessMode, ModeConfig> = {
    M1: { clientState: { enabled: true, enabledFull: true } },
    M2: { clientState: { enabled: true, enabledFull: false } },
    M3: { clientState: { enabled: false, enabledFull: false } },
    'M1-internal': { clientState: { enabled: true, enabledFull: true }, isInternal: true },
    'M1-reqflag': { clientState: null, requestFlag: true },
    'M3-envflags': {
        clientState: { enabled: false, enabledFull: false },
        env: { DISABLE_CHAT_MESSAGE_RECORDING: 'true', DISABLE_EXECUTION_RECORDING: 'true' }
    }
}

// "Accept conversation history from the client" (TS13a): key from the Task 04 design, built in Task 06
export const ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG = { clientState: { acceptClientHistory: true } }

// ---------- component nodes ----------

const COMPONENT_SPECS: Record<string, string> = {
    startAgentflow: 'agentflow/Start/Start.js',
    agentAgentflow: 'agentflow/Agent/Agent.js',
    llmAgentflow: 'agentflow/LLM/LLM.js',
    conditionAgentAgentflow: 'agentflow/ConditionAgent/ConditionAgent.js',
    conditionAgentflow: 'agentflow/Condition/Condition.js',
    customFunctionAgentflow: 'agentflow/CustomFunction/CustomFunction.js',
    directReplyAgentflow: 'agentflow/DirectReply/DirectReply.js',
    humanInputAgentflow: 'agentflow/HumanInput/HumanInput.js',
    loopAgentflow: 'agentflow/Loop/Loop.js',
    iterationAgentflow: 'agentflow/Iteration/Iteration.js',
    executeFlowAgentflow: 'agentflow/ExecuteFlow/ExecuteFlow.js',
    redirectFlowAgentflow: 'agentflow/RedirectFlow/RedirectFlow.js',
    calculator: 'tools/Calculator/Calculator.js',
    currentDateTime: 'tools/CurrentDateTime/CurrentDateTime.js'
}

let componentNodesCache: IComponentNodes | undefined

export function loadHarnessComponentNodes(): IComponentNodes {
    if (!componentNodesCache) {
        const nodes = loadComponentNodes(COMPONENT_SPECS)
        nodes.chatOpenAI = Object.assign(new TestChatOpenAINode() as any, { filePath: require.resolve('./testChatModel') })
        componentNodesCache = nodes
    }
    return componentNodesCache
}

// ---------- data source ----------

export interface RepositoryRead {
    entity: 'Execution' | 'ChatMessage'
    method: string
    where: unknown
    allowed: boolean
}

export type ReadGuard = 'record' | 'throw'

const READ_METHODS = new Set(['find', 'findOne', 'findOneBy', 'findBy', 'findAndCount', 'count', 'createQueryBuilder'])

// updateExecution reads the row it is about to update by id; that belongs to recording executions (TS5), not to the conversation
function isExecutionRecordingRead(entity: string, method: string, args: any[]): boolean {
    if (entity !== 'Execution' || method !== 'findOneBy') return false
    const keys = Object.keys(args[0] ?? {}).sort()
    return keys.length === 2 && keys[0] === 'id' && keys[1] === 'workspaceId'
}

function cloneWhere(args: any[]): unknown {
    try {
        return JSON.parse(JSON.stringify(args[0]?.where ?? args[0] ?? null))
    } catch {
        return String(args[0])
    }
}

export interface HarnessDataSource {
    appDataSource: DataSource
    executions: any[]
    chatMessages: any[]
    reads: RepositoryRead[]
    readGuard: ReadGuard
}

export function createHarnessDataSource(chatflows: ChatFlow[], readGuard: ReadGuard = 'record'): HarnessDataSource {
    const inner = createMockDataSource()
    const holder: HarnessDataSource = {
        appDataSource: undefined as unknown as DataSource,
        executions: inner.executions,
        chatMessages: inner.chatMessages,
        reads: [],
        readGuard
    }
    const guard = (entity: 'Execution' | 'ChatMessage') => {
        const repo = inner.appDataSource.getRepository({ name: entity } as any) as any
        return new Proxy(repo, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver)
                if (typeof prop !== 'string' || !READ_METHODS.has(prop) || typeof value !== 'function') return value
                return (...args: any[]) => {
                    const allowed = isExecutionRecordingRead(entity, prop, args)
                    holder.reads.push({ entity, method: prop, where: cloneWhere(args), allowed })
                    if (holder.readGuard === 'throw' && !allowed) {
                        throw new Error(`${entity}.${prop} read during an Agentflow V2 conversation`)
                    }
                    return value.apply(target, args)
                }
            }
        })
    }
    const repositories: Record<string, any> = {
        Execution: guard('Execution'),
        ChatMessage: guard('ChatMessage'),
        ChatFlow: { findOneBy: async (where: { id: string }) => chatflows.find((cf) => cf.id === where?.id) ?? null }
    }
    holder.appDataSource = {
        getRepository: (entity: any) => {
            const name = typeof entity === 'function' ? entity.name : entity?.name
            return repositories[name] ?? inner.appDataSource.getRepository(entity)
        }
    } as unknown as DataSource
    return holder
}

export async function executionRecords(row: any): Promise<any[]> {
    const json = row.executionDataBlob ? await Compression.decompress(row.executionDataBlob) : row.executionData
    return JSON.parse(json || '[]')
}

// ---------- token codec (mirror of src/utils/trustedStateHelper.ts) ----------

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function tokenKey(): Buffer {
    const secret = process.env.CLIENT_STATE_SERVER_SECRET
    if (!secret) throw new Error('CLIENT_STATE_SERVER_SECRET is not set (test/setupEnv.ts sets it)')
    return Buffer.from(secret, 'hex')
}

export interface DecodedToken {
    state: any
    json: string
    sizes: { base64Length: number; payloadBytes: number; gzipBytes: number; rawJsonBytes: number }
}

export function decodeToken(token: string): DecodedToken {
    const payload = Buffer.from(token, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), payload.subarray(0, IV_LENGTH))
    decipher.setAuthTag(payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH))
    const gzipped = Buffer.concat([decipher.update(payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)), decipher.final()])
    const json = zlib.gunzipSync(gzipped).toString('utf8')
    return {
        state: JSON.parse(json),
        json,
        sizes: {
            base64Length: token.length,
            payloadBytes: payload.length,
            gzipBytes: gzipped.length,
            rawJsonBytes: Buffer.byteLength(json)
        }
    }
}

export function encodeToken(state: unknown): string {
    const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(state), 'utf8'))
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv)
    const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

/*
 * Bytes of the JSON at `pathExpr` inside a decoded token (or any value); `<json>` parses a JSON string at that point,
 * e.g. tokenSize(state, 'previousExecution.executionData<json>[0].data.input.messages'). A missing path measures 0.
 */
export function tokenSize(value: unknown, pathExpr = ''): number {
    let current: any = value
    for (const step of pathExpr.match(/<json>|\[\d+\]|[^.[\]<>]+/g) ?? []) {
        if (current === undefined || current === null) return 0
        if (step === '<json>') current = typeof current === 'string' ? JSON.parse(current) : current
        else if (step.startsWith('[')) current = current[Number(step.slice(1, -1))]
        else current = current[step]
    }
    return current === undefined ? 0 : Buffer.byteLength(JSON.stringify(current))
}

export const SENTINEL_RE = /SYSPROMPT_SENTINEL_[A-Za-z0-9]+_[A-Za-z0-9]+/g

export function countSentinels(payload: unknown): { total: number; bySentinel: Record<string, number> } {
    const text = typeof payload === 'string' ? payload : payload === undefined ? '' : JSON.stringify(payload)
    const bySentinel: Record<string, number> = {}
    let total = 0
    for (const match of (text ?? '').matchAll(SENTINEL_RE)) {
        bySentinel[match[0]] = (bySentinel[match[0]] ?? 0) + 1
        total += 1
    }
    return { total, bySentinel }
}

// Token field accessors. They know the v1 layout only; an unknown layout throws so that a token format change
// cannot make a check pass by reading a field that no longer exists. Task 04/05 adds the v2 field names here.
const assertV1Token = (state: any) => {
    if (!state || typeof state !== 'object' || !('pastChatHistory' in state)) {
        throw new Error(`Unknown trustedState layout (keys: ${Object.keys(state ?? {}).join(', ')}); update the harness token accessors`)
    }
}

export function tokenHistory(state: any): any[] {
    assertV1Token(state)
    return state.pastChatHistory ?? []
}

export function tokenRecords(state: any): any[] {
    assertV1Token(state)
    const raw = state.previousExecution?.executionData
    return raw ? JSON.parse(raw) : []
}

export interface TokenSummary {
    base64Length: number
    gzipBytes: number
    rawJsonBytes: number
    topLevelKeys: string[]
    historyMessages: number
    historyRoles: string[]
    historyBytes: number
    historyMessagesWithAction: number
    records: Array<{ nodeId: string; status: string }>
}

export function summarizeToken(decoded: DecodedToken): TokenSummary {
    const history = tokenHistory(decoded.state)
    return {
        base64Length: decoded.sizes.base64Length,
        gzipBytes: decoded.sizes.gzipBytes,
        rawJsonBytes: decoded.sizes.rawJsonBytes,
        topLevelKeys: Object.keys(decoded.state),
        historyMessages: history.length,
        historyRoles: history.map((m: any) => m.role),
        historyBytes: Buffer.byteLength(JSON.stringify(history)),
        historyMessagesWithAction: history.filter((m: any) => m.action).length,
        records: tokenRecords(decoded.state).map((r: any) => ({ nodeId: r.nodeId, status: r.status }))
    }
}

// ---------- SSE wire recording ----------

export interface WireEvent {
    event: string
    data: any
}

function attachWireRecorder(sseStreamer: SSEStreamer, chatId: string, isInternal: boolean) {
    const chunks: string[] = []
    const res = {
        write: (chunk: string) => {
            chunks.push(chunk)
            return true
        },
        end: (chunk?: string) => {
            if (chunk) chunks.push(chunk)
        },
        setHeader: () => undefined,
        flushHeaders: () => undefined
    } as unknown as Response
    if (isInternal) sseStreamer.addClient(chatId, res)
    else sseStreamer.addExternalClient(chatId, res)
    return {
        events: (): WireEvent[] => {
            const events: WireEvent[] = []
            for (const frame of chunks.join('').split('\n\n')) {
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue
                    const payload = line.slice(5).trim()
                    if (payload) events.push(JSON.parse(payload))
                }
            }
            return events
        }
    }
}

// ---------- logs ----------

export interface LogEntry {
    level: 'warn' | 'error'
    source: 'logger' | 'console'
    message: string
}

function captureLogs(): { entries: LogEntry[]; restore: () => void } {
    const entries: LogEntry[] = []
    const forward = process.env.TS_HARNESS_LOGS === '1'
    const spy = (target: any, level: 'warn' | 'error', source: LogEntry['source']) => {
        const original = target[level].bind(target)
        return jest.spyOn(target, level).mockImplementation((...args: any[]) => {
            entries.push({ level, source, message: util.format(...args) })
            if (forward) original(...args)
            return target
        })
    }
    const spies = [
        spy(logger, 'warn', 'logger'),
        spy(logger, 'error', 'logger'),
        spy(console, 'warn', 'console'),
        spy(console, 'error', 'console')
    ]
    return { entries, restore: () => spies.forEach((s) => s.mockRestore()) }
}

// ---------- conversation runner ----------

export interface ChildFlowCall {
    flowId: string
    request: ICommonObject
    result?: ICommonObject
    error?: string
}

export interface TurnResult {
    id: string
    request: ICommonObject
    tokenSent: string | null
    streaming: boolean
    status: string | null
    error: string | null
    text: string | null
    tokens: string[]
    events: WireEvent[]
    action: any
    executedData: any[] | null
    nodeSequence: string[]
    finalState: ICommonObject | null
    result: ICommonObject | null
    modelCalls: ModelCall[]
    modelCallsByRoute: Record<string, ModelCall[]>
    token: string | null
    tokenSource: 'sse' | 'json' | null
    /** Tokens the server built this turn, including any it could not deliver (e.g. non-streaming responses today) */
    serverTokens: string[]
    decoded: DecodedToken | null
    tokenSummary: TokenSummary | null
    sentinels: Record<string, number | null>
    childCalls: ChildFlowCall[]
    db: { executions: any[]; chatMessages: any[]; newExecutions: number; newChatMessages: number }
    reads: RepositoryRead[]
    logs: LogEntry[]
}

export interface ConversationOptions {
    scenario: string | ScenarioScript
    mode?: HarnessMode
    /** Added to the chatbotConfig of the scenario's own flow, not to the flows it calls */
    chatbotConfig?: ICommonObject
    readGuard?: ReadGuard
    /** Every turn starts with an empty database (nothing written by earlier turns can be read back) */
    freshDataSourcePerTurn?: boolean
    chatId?: string
}

interface ChainState {
    token: string | null
    lastAction: any
    conversation: Array<{ role: 'userMessage' | 'apiMessage'; content: string }>
}

const telemetry = { sendTelemetry: async () => undefined } as unknown as Telemetry

function deriveStatus(events: WireEvent[] | null, executed: any[] | null): string | null {
    const flowEvent = events ? [...events].reverse().find((e) => e.event === 'agentFlowEvent') : undefined
    if (flowEvent) return flowEvent.data
    if (!Array.isArray(executed)) return null
    const latest = new Map<string, string>()
    for (const record of executed) if (!record?.data?.parentNodeId) latest.set(record.nodeId, record.status)
    const statuses = [...latest.values()]
    if (statuses.includes('TERMINATED')) return 'TERMINATED'
    if (statuses.includes('ERROR')) return 'ERROR'
    if (statuses.includes('STOPPED')) return 'STOPPED'
    return 'FINISHED'
}

function finalStateOf(executed: any[] | null): ICommonObject | null {
    if (!Array.isArray(executed)) return null
    for (let i = executed.length - 1; i >= 0; i--) if (executed[i]?.data?.state) return executed[i].data.state
    return null
}

function buildClientHistory(conversation: ChainState['conversation'], spec: ClientHistorySpec) {
    const history: Array<{ role: string; content: string }> = []
    if (spec.welcome) history.push({ role: 'apiMessage', content: spec.welcome })
    history.push(...conversation.map((m) => ({ role: m.role, content: m.content })))
    if (spec.dropLastBot && history.length && history[history.length - 1].role === 'apiMessage') history.pop()
    return history
}

function groupByRoute(calls: ModelCall[]): Record<string, ModelCall[]> {
    const grouped: Record<string, ModelCall[]> = {}
    for (const call of calls) (grouped[call.route ?? '_noroute'] ??= []).push(call)
    return grouped
}

export class Conversation {
    readonly scenario: ScenarioScript
    readonly mode: HarnessMode
    readonly chatId: string
    readonly server = new ScriptedOpenAIServer()
    readonly chatflows: Record<string, ChatFlow> = {}
    readonly turns: TurnResult[] = []
    dataSource: HarnessDataSource
    private readonly modeConfig: ModeConfig
    private readonly options: ConversationOptions
    private chain: ChainState = { token: null, lastAction: null, conversation: [] }
    private readonly chainBefore = new Map<string, ChainState>()
    private currentChildCalls: ChildFlowCall[] = []

    constructor(options: ConversationOptions) {
        this.options = options
        this.scenario = typeof options.scenario === 'string' ? loadHarnessScenario(options.scenario) : options.scenario
        this.mode = options.mode ?? 'M1'
        this.modeConfig = MODES[this.mode]
        this.chatId = options.chatId ?? `ts01-${this.mode}-${this.scenario.id}-${crypto.randomBytes(4).toString('hex')}`
        for (const slug of [this.scenario.flow, ...(this.scenario.extraFlows ?? [])]) {
            const loaded = loadFlow(slug)
            const isTarget = slug === this.scenario.flow
            const extraConfig: ICommonObject = isTarget ? options.chatbotConfig ?? {} : {}
            const clientState =
                this.modeConfig.clientState || extraConfig.clientState
                    ? { ...(this.modeConfig.clientState ?? {}), ...(extraConfig.clientState ?? {}) }
                    : undefined
            const chatbotConfig = { ...extraConfig, ...(clientState ? { clientState } : {}) }
            this.chatflows[slug] = {
                id: flowIdFor(slug),
                name: `TS01 ${this.mode} ${slug}`,
                type: 'AGENTFLOW',
                flowData: loaded.flowData,
                workspaceId: WORKSPACE_ID,
                chatbotConfig: Object.keys(chatbotConfig).length ? JSON.stringify(chatbotConfig) : undefined,
                apiConfig: loaded.apiConfig ? JSON.stringify(loaded.apiConfig) : undefined
            } as ChatFlow
        }
        this.dataSource = this.newDataSource()
        this.server.setScenario({
            scenario: this.scenario.id,
            mode: this.mode,
            rules: this.scenario.llm?.rules ?? [],
            defaults: this.scenario.llm?.defaults
        })
    }

    private newDataSource(): HarnessDataSource {
        return createHarnessDataSource(Object.values(this.chatflows), this.options.readGuard ?? 'record')
    }

    turn(id: string): TurnResult {
        const found = this.turns.find((t) => t.id === id)
        if (!found) throw new Error(`Turn ${id} has not run`)
        return found
    }

    async run(turn: string | TurnSpec, overrides: Partial<TurnSpec> = {}): Promise<TurnResult> {
        const spec = { ...this.specFor(turn), ...overrides }
        this.chainBefore.set(spec.id, cloneDeep(this.chain))
        const result = await this.execute(spec, this.chain)
        this.turns.push(result)
        this.advance(spec, result)
        return result
    }

    async runAll(): Promise<TurnResult[]> {
        const done = new Set(this.turns.map((t) => t.id))
        for (const spec of this.scenario.turns) {
            if (!done.has(spec.id)) await this.run(spec)
        }
        return this.turns
    }

    // Runs a turn again from the state it started from; the conversation does not advance and the database is restored
    async replay(turnId: string, overrides: Partial<TurnSpec> = {}): Promise<TurnResult> {
        const before = this.chainBefore.get(turnId)
        if (!before) throw new Error(`Turn ${turnId} has not run, so it cannot be replayed`)
        const spec = { ...this.specFor(turnId), ...overrides }
        const executions = cloneDeep(this.dataSource.executions)
        const chatMessages = cloneDeep(this.dataSource.chatMessages)
        const reads = this.dataSource.reads.length
        try {
            return await this.execute(spec, cloneDeep(before))
        } finally {
            this.dataSource.executions.splice(0, this.dataSource.executions.length, ...executions)
            this.dataSource.chatMessages.splice(0, this.dataSource.chatMessages.length, ...chatMessages)
            this.dataSource.reads.length = reads
        }
    }

    private specFor(turn: string | TurnSpec): TurnSpec {
        if (typeof turn !== 'string') return turn
        const spec = this.scenario.turns.find((t) => t.id === turn)
        if (!spec) throw new Error(`Scenario ${this.scenario.id} has no turn ${turn}`)
        return spec
    }

    private advance(spec: TurnSpec, result: TurnResult) {
        const userContent =
            spec.question ??
            (spec.form
                ? Object.entries(spec.form)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')
                : spec.humanInput?.feedback ?? spec.humanInput?.type ?? '')
        if (result.status !== 'ERROR' && result.status !== 'TERMINATED') {
            this.chain.conversation.push({ role: 'userMessage', content: userContent })
            if (result.text !== null) this.chain.conversation.push({ role: 'apiMessage', content: result.text })
        }
        if (result.token) this.chain.token = result.token
        this.chain.lastAction = result.action ?? null
    }

    private buildRequestBody(spec: TurnSpec, chain: ChainState): ICommonObject {
        const body: ICommonObject = { chatId: this.chatId, streaming: spec.streaming ?? this.scenario.streaming ?? true }
        if (spec.question !== undefined) body.question = spec.question
        if (spec.form !== undefined) body.form = cloneDeep(spec.form)
        if (spec.humanInput) {
            body.humanInput = { ...spec.humanInput }
            if (!body.humanInput.startNodeId && chain.lastAction?.data?.nodeId) body.humanInput.startNodeId = chain.lastAction.data.nodeId
        }
        const overrideConfig = spec.overrideConfig ? cloneDeep(spec.overrideConfig) : undefined
        let history: Array<{ role: string; content: string }> | undefined
        if (spec.history) {
            history = Array.isArray(spec.history) ? cloneDeep(spec.history) : buildClientHistory(chain.conversation, spec.history)
            body.history = history
        }
        if (spec.llmMessagesOverride) {
            const source = history ?? buildClientHistory(chain.conversation, {})
            body.overrideConfig = {
                ...(overrideConfig ?? {}),
                llmMessages: source.map((m) => ({ role: m.role === 'apiMessage' ? 'assistant' : 'user', content: m.content }))
            }
        } else if (overrideConfig) body.overrideConfig = overrideConfig
        if (this.modeConfig.requestFlag) body.enableTrustedState = true
        const token = spec.token !== undefined ? spec.token : chain.token
        if (token && spec.sendToken !== false) body.trustedState = token
        return body
    }

    private executeFlow(chatflow: ChatFlow, incomingInput: ICommonObject, sseStreamer: SSEStreamer, extra: ICommonObject = {}) {
        return executeAgentFlow({
            componentNodes: loadHarnessComponentNodes(),
            incomingInput: { history: [], streaming: false, ...incomingInput } as any,
            chatflow,
            chatId: incomingInput.chatId,
            appDataSource: this.dataSource.appDataSource,
            telemetry,
            usageCacheManager: {} as UsageCacheManager,
            cachePool: {} as CachePool,
            sseStreamer,
            baseURL: BASE_URL,
            isInternal: Boolean(this.modeConfig.isInternal),
            uploadedFilesContent: '',
            fileUploads: [],
            signal: new AbortController(),
            orgId: ORG_ID,
            workspaceId: WORKSPACE_ID,
            subscriptionId: '',
            productId: '',
            ...extra
        })
    }

    // Execute Flow calls POST {baseURL}/api/v1/prediction/:id with axios; serve it from the seeded flows, like the server would
    private installChildFlowAdapter(): () => void {
        const previous = axios.defaults.adapter
        axios.defaults.adapter = async (config: any) => {
            const url = new URL(config.url, config.baseURL ?? BASE_URL)
            const match = /\/api\/v1\/prediction\/([^/]+)$/.exec(url.pathname)
            const child = match ? Object.values(this.chatflows).find((cf) => cf.id === match[1]) : undefined
            if (!child) throw new Error(`Unexpected HTTP request in the trusted state harness: ${config.method} ${config.url}`)
            const request = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {}
            const headers = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers ?? {}
            const call: ChildFlowCall = { flowId: child.id, request: cloneDeep(request) }
            this.currentChildCalls.push(call)
            try {
                const resolved = await resolveFlowRedirect(child, this.dataSource.appDataSource)
                const result = await this.executeFlow(
                    resolved,
                    { ...request, chatId: request.chatId ?? crypto.randomUUID() },
                    new SSEStreamer(),
                    { isTool: headers['flowise-tool'] === 'true' }
                )
                call.result = cloneDeep(result)
                return { data: result, status: 200, statusText: 'OK', headers: {}, config, request: {} }
            } catch (error) {
                call.error = getErrorMessage(error)
                throw error
            }
        }
        return () => {
            axios.defaults.adapter = previous
        }
    }

    private async execute(spec: TurnSpec, chain: ChainState): Promise<TurnResult> {
        if (this.options.freshDataSourcePerTurn) this.dataSource = this.newDataSource()
        this.server.markTurn(spec.id)
        const body = this.buildRequestBody(spec, chain)
        const streaming = body.streaming === true || body.streaming === 'true'
        const isInternal = Boolean(this.modeConfig.isInternal)
        const seqBefore = this.server.lastSeq
        const executionsBefore = this.dataSource.executions.length
        const chatMessagesBefore = this.dataSource.chatMessages.length
        const readsBefore = this.dataSource.reads.length
        this.currentChildCalls = []

        const sseStreamer = new SSEStreamer()
        const serverTokens: string[] = []
        const streamTrustedState = sseStreamer.streamTrustedStateDataEvent.bind(sseStreamer)
        sseStreamer.streamTrustedStateDataEvent = (chatId: string, data: any) => {
            if (chatId === this.chatId) serverTokens.push(data)
            streamTrustedState(chatId, data)
        }
        const wire = streaming ? attachWireRecorder(sseStreamer, this.chatId, isInternal) : undefined

        const savedEnv: Record<string, string | undefined> = {}
        for (const [key, value] of Object.entries(this.modeConfig.env ?? {})) {
            savedEnv[key] = process.env[key]
            process.env[key] = value
        }
        const logs = captureLogs()
        const restoreAdapter = this.installChildFlowAdapter()
        setActiveScriptedServer(this.server)

        let result: ICommonObject | null = null
        let error: string | null = null
        try {
            const chatflow = await resolveFlowRedirect(this.chatflows[this.scenario.flow], this.dataSource.appDataSource)
            result = (await this.executeFlow(chatflow, cloneDeep(body), sseStreamer)) as ICommonObject
            if (streaming) sseStreamer.streamMetadataEvent(this.chatId, result)
        } catch (err) {
            error = `Error: predictionsServices.buildChatflow - ${getErrorMessage(err)}`
            if (streaming) sseStreamer.streamErrorEvent(this.chatId, error)
        } finally {
            if (streaming) sseStreamer.removeClient(this.chatId)
            setActiveScriptedServer(undefined)
            restoreAdapter()
            logs.restore()
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
            }
        }

        const events = wire ? wire.events() : []
        const lastEvent = (name: string) => [...events].reverse().find((e) => e.event === name)
        const executedData = streaming ? lastEvent('agentFlowExecutedData')?.data ?? null : result?.agentFlowExecutedData ?? null
        const action = streaming ? lastEvent('action')?.data ?? null : result?.action ?? null
        const sseToken = streaming ? lastEvent('trustedStateData')?.data ?? null : null
        const jsonToken = !streaming && typeof result?.trustedState === 'string' ? result.trustedState : null
        const token = sseToken ?? jsonToken
        const tokens = events.filter((e) => e.event === 'token').map((e) => String(e.data ?? ''))
        const text = streaming ? tokens.join('') : result?.text ?? null
        const decoded = token ? decodeToken(token) : null
        const modelCalls = this.server.callsSince(seqBefore)

        return {
            id: spec.id,
            request: body,
            tokenSent: body.trustedState ?? null,
            streaming,
            status: deriveStatus(streaming ? events : null, executedData),
            error,
            text,
            tokens,
            events,
            action,
            executedData,
            nodeSequence: Array.isArray(executedData) ? executedData.map((r: any) => `${r.nodeId}:${r.status}`) : [],
            finalState: finalStateOf(executedData),
            result,
            modelCalls,
            modelCallsByRoute: groupByRoute(modelCalls),
            token,
            tokenSource: sseToken ? 'sse' : jsonToken ? 'json' : null,
            serverTokens,
            decoded,
            tokenSummary: decoded ? summarizeToken(decoded) : null,
            sentinels: {
                token: decoded ? countSentinels(decoded.json).total : null,
                action: action ? countSentinels(action).total : null,
                executedData: executedData ? countSentinels(executedData).total : null,
                restJson: !streaming && result ? countSentinels(result).total : null,
                modelRequests: countSentinels(modelCalls.map((c) => c.body)).total
            },
            childCalls: this.currentChildCalls,
            db: {
                executions: cloneDeep(this.dataSource.executions),
                chatMessages: cloneDeep(this.dataSource.chatMessages),
                newExecutions: this.dataSource.executions.length - executionsBefore,
                newChatMessages: this.dataSource.chatMessages.length - chatMessagesBefore
            },
            reads: this.dataSource.reads.slice(readsBefore),
            logs: logs.entries
        }
    }
}

export async function startConversation(options: ConversationOptions): Promise<Conversation> {
    return new Conversation(options)
}

export interface RunConversationOptions extends ConversationOptions {
    turns?: Array<string | TurnSpec>
}

export async function runConversation(options: RunConversationOptions): Promise<Conversation> {
    const conversation = new Conversation(options)
    if (options.turns) {
        for (const turn of options.turns) await conversation.run(turn)
    } else {
        await conversation.runAll()
    }
    return conversation
}

// ---------- normalization and digests ----------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const MOCK_EXECUTION_RE = /mock-\d{10,}-[a-z0-9]+/g
const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g
// The Current DateTime tool's output, also inside JSON strings (escaped quotes)
const CURRENT_DATE_TIME_RE =
    /\{\\?"date\\?":\\?"[^"\\]*\\?",\\?"time\\?":\\?"[^"\\]*\\?",\\?"day\\?":\\?"[^"\\]*\\?",\\?"timezone\\?":\\?"[^"\\]*\\?",\\?"timezoneOffset\\?":\\?"[^"\\]*\\?",\\?"iso8601\\?":\\?"[^"\\]*\\?",\\?"unix_timestamp\\?":\d+\}/g
const VOLATILE_KEYS = new Set(['timeMetadata', 'createdDate', 'updatedDate', 'stoppedDate', 'durationMs'])

export function normalizeString(text: string): string {
    return text
        .replace(CURRENT_DATE_TIME_RE, '<current_date_time output>')
        .replace(MOCK_EXECUTION_RE, '<mock-execution-id>')
        .replace(UUID_RE, '<uuid>')
        .replace(ISO_DATETIME_RE, '<iso-datetime>')
}

export function normalizeValue(value: any): any {
    if (typeof value === 'string') return normalizeString(value)
    if (Array.isArray(value)) return value.map(normalizeValue)
    if (value && typeof value === 'object') {
        if ('iso8601' in value && 'unix_timestamp' in value) return '<current_date_time output>'
        const out: Record<string, any> = {}
        for (const key of Object.keys(value).sort()) {
            if (VOLATILE_KEYS.has(key)) continue
            out[key] = normalizeValue(value[key])
        }
        return out
    }
    return value
}

const shortHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

// System prompts are ~41 KB; snapshots keep their length, hash and sentinel instead
function foldText(text: string, maxLength = 300): string {
    if (text.length <= maxLength) return text
    const sentinels = Object.keys(countSentinels(text).bySentinel)
    return `<${text.length} chars sha256:${shortHash(text)}${sentinels.length ? ' ' + sentinels.join(' ') : ''}> ${text.slice(0, 60)}…`
}

export function modelMessages(call: Pick<ModelCall, 'messages'>) {
    return call.messages.map((m) => {
        const out: Record<string, any> = { role: m.role, content: m.content ?? null }
        if (m.tool_calls) out.tool_calls = m.tool_calls
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id
        if (m.name) out.name = m.name
        return out
    })
}

function compactMessage(message: OpenAIWireMessage): string {
    const raw = typeof message.content === 'string' ? message.content : message.content == null ? '' : JSON.stringify(message.content)
    const text = foldText(normalizeString(raw))
    if (message.tool_calls?.length) {
        const calls = message.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments}) [${tc.id}]`).join(', ')
        return `assistant -> ${calls}${text ? ` ${JSON.stringify(text)}` : ''}`
    }
    if (message.role === 'tool') return `tool [${message.tool_call_id}]: ${JSON.stringify(text)}`
    return `${message.role}: ${JSON.stringify(text)}`
}

// Per route: parallel branches interleave differently from run to run
export function compactModelCalls(turn: Pick<TurnResult, 'modelCallsByRoute'>) {
    const out: Record<string, Array<{ call: string; tools: string[]; messages: string[] }>> = {}
    for (const route of Object.keys(turn.modelCallsByRoute).sort()) {
        out[route] = turn.modelCallsByRoute[route].map((call) => ({
            call: `${call.callIndex} ${call.ruleId}${call.status !== 200 ? ` (HTTP ${call.status})` : ''}`,
            tools: call.tools,
            messages: call.messages.map(compactMessage)
        }))
    }
    return out
}

export function conversationMessages(call: Pick<ModelCall, 'messages'>): Array<{ role: string; content: string }> {
    return call.messages
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls?.length))
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
}

export function userFacingAction(action: any) {
    if (!action) return null
    return normalizeValue({
        id: action.id,
        mapping: action.mapping,
        elements: action.elements,
        nodeId: action.data?.nodeId,
        nodeLabel: action.data?.nodeLabel,
        humanInputEnableFeedback: action.data?.input?.humanInputEnableFeedback,
        extra: action.extra
    })
}

export const historyRolesCompact = (roles: string[]) =>
    roles.map((role) => (role === 'userMessage' ? 'u' : role === 'apiMessage' ? 'a' : '?')).join('')

// Node records are sorted: parallel branches commit in any order
export function turnFacts(turn: TurnResult) {
    const facts: Record<string, any> = {
        status: turn.status,
        text: turn.text,
        nodes: [...turn.nodeSequence].sort(),
        state: normalizeValue(turn.finalState ?? {}),
        calls: Object.fromEntries(
            Object.keys(turn.modelCallsByRoute)
                .sort()
                .map((route) => [route, turn.modelCallsByRoute[route].map((call) => call.ruleId)])
        ),
        history: turn.tokenSummary ? historyRolesCompact(turn.tokenSummary.historyRoles) : null
    }
    if (turn.action) facts.action = userFacingAction(turn.action)
    if (turn.error) facts.error = turn.error
    return facts
}

export function findNodeRecords(value: unknown): any[] {
    const found: any[] = []
    const walk = (node: any) => {
        if (typeof node === 'string') {
            const trimmed = node.trimStart()
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    walk(JSON.parse(node))
                } catch {
                    // not JSON
                }
            }
            return
        }
        if (Array.isArray(node)) return node.forEach(walk)
        if (node && typeof node === 'object') {
            if (typeof node.nodeId === 'string' && 'status' in node && 'data' in node) found.push(node)
            Object.values(node).forEach(walk)
        }
    }
    walk(value)
    return found
}

export function withReplyOverrides(script: ScenarioScript, overrides: Record<string, Partial<ReplyRule['reply']>>): ScenarioScript {
    return {
        ...script,
        llm: {
            ...script.llm,
            rules: script.llm.rules.map((rule) =>
                rule.id && overrides[rule.id] ? { ...rule, reply: { ...rule.reply, ...overrides[rule.id] } } : rule
            )
        }
    }
}

// ---------- before/ traces (Task 00b) ----------

export const BEFORE_TRACES_DIR = path.join(BASELINES_DIR, 'traces/before')

function inflateTrace(value: any, readBlob: (hash: string) => string): any {
    if (Array.isArray(value)) return value.map((item) => inflateTrace(item, readBlob))
    if (value && typeof value === 'object') {
        if (typeof value.$blob === 'string') return readBlob(value.$blob)
        if (Object.keys(value).length === 1 && '$json' in value) return JSON.stringify(inflateTrace(value.$json, readBlob))
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inflateTrace(v, readBlob)]))
    }
    return value
}

export interface BeforeRequest {
    route: string | null
    callIndex: number
    ruleId: string
    status: number
    body: any
}

export interface BeforeTurn {
    id: string
    status: string | null
    text: string | null
    nodeSequence: string[] | null
    finalState: ICommonObject | null
    action: any
    modelRequests: BeforeRequest[]
    token: any
}

export function beforeTraceExists(mode: string, scenarioSlug: string): boolean {
    return fs.existsSync(path.join(BEFORE_TRACES_DIR, mode, `${scenarioSlug}.json`))
}

export function loadBeforeTrace(mode: string, scenarioSlug: string): { turns: BeforeTurn[] } {
    const trace = readJson(path.join(BEFORE_TRACES_DIR, mode, `${scenarioSlug}.json`))
    const cache = new Map<string, string>()
    const readBlob = (hash: string) => {
        if (!cache.has(hash)) cache.set(hash, fs.readFileSync(path.join(BEFORE_TRACES_DIR, 'blobs', `${hash}.txt`), 'utf8'))
        return cache.get(hash) as string
    }
    return { turns: trace.turns.map((turn: any) => inflateTrace(turn, readBlob)) }
}

// The capture server retried failed model calls (LangChain, 6 times); the harness does not
export function withoutRetries<T extends { route: string | null; status: number; body: any }>(requests: T[]): T[] {
    return requests.filter((request, i) => {
        if (request.status < 500) return true
        const previous = requests
            .slice(0, i)
            .reverse()
            .find((r) => r.route === request.route)
        return !(previous && previous.status >= 500 && JSON.stringify(previous.body.messages) === JSON.stringify(request.body.messages))
    })
}

export function comparableRequests(requests: Array<{ route: string | null; body: any }>) {
    const out: Record<string, any[]> = {}
    for (const request of requests) {
        ;(out[request.route ?? '_noroute'] ??= []).push(
            normalizeValue({
                messages: modelMessages({ messages: request.body.messages ?? [] }),
                tools: request.body.tools ?? []
            })
        )
    }
    return Object.fromEntries(
        Object.keys(out)
            .sort()
            .map((route) => [route, out[route]])
    )
}
