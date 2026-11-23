import { pick } from 'lodash'
import { ICommonObject, IFileUpload, IMessage } from 'flowise-components'
import { ExecutionState, IAgentflowExecutedData, IChatMessage, IExecution, INodeDirectedGraph, IReactFlowNode } from '../../Interface'
import { trusted_state_from_string, trusted_state_to_string } from '../trustedStateHelper'
import logger from '../logger'

export const TRUSTED_STATE_VERSION = 2

export interface TrustedHistoryMessage {
    role: 'userMessage' | 'apiMessage'
    content: string
    fileUploads?: IFileUpload[]
    artifacts?: ICommonObject[]
}

export interface ChildFlowToken {
    flowId: string
    token: string
}

export interface SlimAction {
    id: string
    mapping: { approve: string; reject: string }
    elements: Array<{ type: string; label: string }>
    data: { nodeId: string; nodeLabel: string; input?: { humanInputEnableFeedback: boolean } }
}

export interface AgentCheckpoint {
    historyLength: number
    conversation: Array<{ history: [number, number] } | ICommonObject>
    toolCallMessage: ICommonObject
}

export interface PendingNode {
    nodeId: string
    status: ExecutionState
    conditions?: boolean[]
    loop?: { nodeID: string; maxLoopCount: number }
    output?: ICommonObject
    action?: SlimAction
    prompt?: string
    checkpoint?: AgentCheckpoint
    legacyMessages?: unknown[]
}

// The run skeleton has one entry per top-level record of the stopped run, in record order, because the resume replays them
export interface PendingResume {
    nodes: PendingNode[]
    executionId?: string
    stopMessageId?: string
}

export interface TrustedStateV2 {
    version: typeof TRUSTED_STATE_VERSION
    history: TrustedHistoryMessage[]
    flowState: ICommonObject
    formValues: ICommonObject
    childFlowTokens: Record<string, ChildFlowToken>
    pendingResume?: PendingResume
}

export interface TrustedStateV1 {
    pastChatHistory?: IChatMessage[]
    previousExecution?: IExecution
}

export type HistorySource = 'token' | 'client'

export interface TrustedTurnInput {
    history: TrustedHistoryMessage[]
    flowState: ICommonObject
    formValues: ICommonObject
    childFlowTokens: Record<string, ChildFlowToken>
    pendingResume?: PendingResume
    historySource: HistorySource
    incoming: { version: 0 | 1 | 2; base64Length: number; historyLength: number; hadPending: boolean }
}

export interface TurnRequest {
    trustedState?: string
    humanInput?: unknown
    history?: IMessage[]
    form?: ICommonObject
}

const isPlainObject = (value: unknown): value is ICommonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseFormStringToJson = (formString: string): Record<string, string> => {
    const result: Record<string, string> = {}
    const lines = formString.split('\n')

    for (const line of lines) {
        const [key, value] = line.split(': ').map((part) => part.trim())
        if (key && value) {
            result[key] = value
        }
    }

    return result
}

const toFormValues = (form: unknown): ICommonObject => {
    if (typeof form === 'string') return parseFormStringToJson(form)
    return form && typeof form === 'object' ? (form as ICommonObject) : {}
}

const parseStoredJson = (value: unknown): any => {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

const parseRecords = (executionData: unknown): IAgentflowExecutedData[] => {
    const records = parseStoredJson(executionData)
    return Array.isArray(records) ? records : []
}

// Paths of each node's output that nodes of the flow reference: {{id}} reads content or http.data, {{id.output.<path>}} that path
export type OutputReferences = Map<string, Set<string>>

const VARIABLE_RE = /{{(.*?)}}/g

export function findOutputReferences(nodes: IReactFlowNode[]): OutputReferences {
    const nodeIds = new Set(nodes.map((node) => node.id))
    const references: OutputReferences = new Map()
    const add = (nodeId: string, paths: string[]) => {
        if (!nodeIds.has(nodeId)) return
        const set = references.get(nodeId) ?? new Set<string>()
        paths.forEach((path) => set.add(path))
        references.set(nodeId, set)
    }
    const text = JSON.stringify(nodes.map((node) => node.data?.inputs ?? {}))
    for (const [, inner] of text.matchAll(VARIABLE_RE)) {
        const reference = inner.replace(/\\/g, '').trim()
        const outputPath = reference.match(/^(.*?)\.output\.(.+)$/)
        if (outputPath) add(outputPath[1], [outputPath[2]])
        else add(reference, ['content', 'http.data'])
    }
    return references
}

export function toSlimAction(action: ICommonObject): SlimAction {
    const slim: SlimAction = {
        id: action.id,
        mapping: action.mapping,
        elements: action.elements,
        data: { nodeId: action.data?.nodeId, nodeLabel: action.data?.nodeLabel }
    }
    const feedback = action.data?.input?.humanInputEnableFeedback
    if (feedback !== undefined) slim.data.input = { humanInputEnableFeedback: feedback }
    return slim
}

function toPendingNode(record: IAgentflowExecutedData, references: OutputReferences, { legacy = false } = {}): PendingNode {
    const output: ICommonObject = isPlainObject(record.data?.output) ? (record.data.output as ICommonObject) : {}
    const entry: PendingNode = { nodeId: record.nodeId, status: record.status as ExecutionState }
    if (Array.isArray(output.conditions)) entry.conditions = output.conditions.map((condition: any) => condition?.isFulfilled === true)
    if (output.nodeID !== undefined) entry.loop = { nodeID: output.nodeID, maxLoopCount: output.maxLoopCount }
    const paths = references.get(record.nodeId)
    if (paths) {
        const referenced = pick(output, [...paths])
        if (Object.keys(referenced).length) entry.output = referenced
    }
    if (record.status !== 'STOPPED') return entry
    if (isPlainObject(output.humanInputAction)) entry.action = toSlimAction(output.humanInputAction)
    if (typeof output.content === 'string') entry.prompt = output.content
    if (isPlainObject(output.resumeCheckpoint)) entry.checkpoint = output.resumeCheckpoint as AgentCheckpoint
    const legacyMessages = output.humanInputAction?.data?.input?.messages
    if (legacy && record.data?.name === 'agentAgentflow' && Array.isArray(legacyMessages)) entry.legacyMessages = legacyMessages
    return entry
}

/**
 * The pending data of a run that ends stopped. Records rehydrated from the incoming pending data and still present
 * (nodes stopped in an earlier turn, finished nodes of the run) carry their entry over unchanged.
 */
export function buildPendingResume(
    records: IAgentflowExecutedData[],
    {
        references,
        carried,
        executionId,
        stopMessageId
    }: { references: OutputReferences; carried: Map<IAgentflowExecutedData, PendingNode>; executionId?: string; stopMessageId?: string }
): PendingResume {
    const nodes = records
        .filter((record) => !record.data?.parentNodeId)
        .map((record) => carried.get(record) ?? toPendingNode(record, references))
    return { nodes, ...(executionId ? { executionId } : {}), ...(stopMessageId ? { stopMessageId } : {}) }
}

// Records that start a resume turn's executed data, so the replay and node references see the stopped run as before
export function rehydratePendingResume(
    pending: PendingResume,
    nodes: IReactFlowNode[],
    reversedGraph: INodeDirectedGraph
): Map<IAgentflowExecutedData, PendingNode> {
    const rehydrated = new Map<IAgentflowExecutedData, PendingNode>()
    for (const entry of pending.nodes) {
        const node = nodes.find((n) => n.id === entry.nodeId)
        const output: ICommonObject = {}
        if (entry.conditions) output.conditions = entry.conditions.map((isFulfilled) => ({ isFulfilled }))
        if (entry.loop) Object.assign(output, entry.loop)
        if (entry.prompt !== undefined) output.content = entry.prompt
        Object.assign(output, entry.output)
        if (entry.action) {
            output.humanInputAction = entry.legacyMessages
                ? { ...entry.action, data: { ...entry.action.data, input: { ...entry.action.data.input, messages: entry.legacyMessages } } }
                : entry.action
        }
        if (entry.checkpoint) output.resumeCheckpoint = entry.checkpoint
        const record: IAgentflowExecutedData = {
            nodeId: entry.nodeId,
            nodeLabel: node?.data.label ?? entry.nodeId,
            status: entry.status,
            previousNodeIds: reversedGraph[entry.nodeId] ?? [],
            data: { id: entry.nodeId, name: node?.data.name, output } as any
        }
        rehydrated.set(record, entry)
    }
    return rehydrated
}

// A v1 run can be resumed when it stopped, or when its last record failed right after a stopped one (the retry rule)
function resumableV1Records(state: ExecutionState | undefined, records: IAgentflowExecutedData[]): IAgentflowExecutedData[] | undefined {
    if (state === 'STOPPED') return records
    if (state !== 'ERROR' || records.length < 2) return undefined
    const [beforeLast, last] = records.slice(-2)
    return last.status === 'ERROR' && beforeLast.status === 'STOPPED' ? records.slice(0, -1) : undefined
}

function historyMessageFromV1(message: IChatMessage): TrustedHistoryMessage {
    const mapped: TrustedHistoryMessage = { role: message.role as TrustedHistoryMessage['role'], content: message.content }
    if (message.fileUploads) mapped.fileUploads = parseStoredJson(message.fileUploads)
    if (message.artifacts) mapped.artifacts = parseStoredJson(message.artifacts)
    return mapped
}

export function upgradeV1(v1: TrustedStateV1, references: OutputReferences = new Map()): TrustedStateV2 {
    const pastChatHistory = Array.isArray(v1.pastChatHistory) ? v1.pastChatHistory : []
    const execution = isPlainObject(v1.previousExecution) ? (v1.previousExecution as IExecution) : undefined
    const records = parseRecords(execution?.executionData)

    let flowState: ICommonObject = {}
    for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i]?.data?.state) {
            flowState = records[i].data.state as ICommonObject
            break
        }
    }

    const startOutput = records.find((record) => record?.data?.name === 'startAgentflow')?.data?.output
    const formValues = startOutput && typeof startOutput === 'object' && 'form' in startOutput ? toFormValues(startOutput.form) : {}

    const upgraded: TrustedStateV2 = {
        version: TRUSTED_STATE_VERSION,
        history: pastChatHistory.map(historyMessageFromV1),
        flowState,
        formValues,
        childFlowTokens: {}
    }
    const resumable = execution ? resumableV1Records(execution.state, records) : undefined
    if (execution && resumable) {
        const stopMessage = [...pastChatHistory].reverse().find((message) => message?.action)
        upgraded.pendingResume = {
            nodes: resumable
                .filter((record) => !record.data?.parentNodeId)
                .map((record) => toPendingNode(record, references, { legacy: true })),
            ...(execution.id && !String(execution.id).startsWith('mock-') ? { executionId: execution.id } : {}),
            ...(stopMessage?.id ? { stopMessageId: stopMessage.id } : {})
        }
    }
    return upgraded
}

function normalizeV2(state: ICommonObject): TrustedStateV2 {
    const normalized: TrustedStateV2 = {
        version: TRUSTED_STATE_VERSION,
        history: Array.isArray(state.history) ? state.history : [],
        flowState: isPlainObject(state.flowState) ? state.flowState : {},
        formValues: isPlainObject(state.formValues) ? state.formValues : {},
        childFlowTokens: isPlainObject(state.childFlowTokens) ? state.childFlowTokens : {}
    }
    if (isPlainObject(state.pendingResume) && Array.isArray(state.pendingResume.nodes)) {
        normalized.pendingResume = state.pendingResume as PendingResume
    }
    return normalized
}

function decodedToV2(decoded: unknown, references: OutputReferences): { state?: TrustedStateV2; version: 0 | 1 | 2 } {
    if (decoded === undefined || decoded === null) return { version: 0 }
    if (isPlainObject(decoded)) {
        if (decoded.version === TRUSTED_STATE_VERSION) return { state: normalizeV2(decoded), version: 2 }
        if (!('version' in decoded) && ('pastChatHistory' in decoded || 'previousExecution' in decoded)) {
            return { state: upgradeV1(decoded as TrustedStateV1, references), version: 1 }
        }
    }
    const version = isPlainObject(decoded) ? decoded.version : undefined
    logger.warn(`[agentflow]: Ignoring a trustedState of unknown format (version ${version}); starting a new conversation`)
    return { version: 0 }
}

const sameMessage = (a: TrustedHistoryMessage, b: TrustedHistoryMessage) =>
    a.role === b.role && String(a.content ?? '').trim() === String(b.content ?? '').trim()

function selectTurnHistory(
    tokenHistory: TrustedHistoryMessage[],
    request: TurnRequest,
    acceptClientHistory: boolean
): { history: TrustedHistoryMessage[]; historySource: HistorySource } {
    const fromToken = { history: tokenHistory, historySource: 'token' as const }
    if (!Array.isArray(request.history) || !request.history.length) return fromToken
    if (request.humanInput) {
        logger.warn('[agentflow]: Ignoring the request history on a resume turn: the paused run continues on the token history')
        return fromToken
    }
    if (!acceptClientHistory) {
        logger.warn('[agentflow]: Ignoring the request history: "Accept conversation history from the client" is off for this flow')
        return fromToken
    }
    const history = request.history.map((message) => ({ role: message.role, content: message.content } as TrustedHistoryMessage))
    const lastTokenMessage = tokenHistory[tokenHistory.length - 1]
    if (lastTokenMessage && !history.some((message) => sameMessage(message, lastTokenMessage))) {
        logger.warn('[agentflow]: The request history lacks the last message of the token history; continuing with the request history')
    }
    return { history, historySource: 'client' }
}

export async function readTurnInput(
    incomingInput: TurnRequest,
    { acceptClientHistory = false, references = new Map() }: { acceptClientHistory?: boolean; references?: OutputReferences } = {}
): Promise<TrustedTurnInput> {
    const raw = incomingInput.trustedState
    const { state, version } = decodedToV2(raw ? await trusted_state_from_string(raw) : undefined, references)
    return {
        ...selectTurnHistory(state?.history ?? [], incomingInput, acceptClientHistory),
        flowState: state?.flowState ?? {},
        formValues: incomingInput.form ?? state?.formValues ?? {},
        childFlowTokens: state?.childFlowTokens ?? {},
        pendingResume: incomingInput.humanInput ? state?.pendingResume : undefined,
        incoming: {
            version,
            base64Length: raw?.length ?? 0,
            historyLength: state?.history.length ?? 0,
            hadPending: Boolean(state?.pendingResume)
        }
    }
}

export function toNodeMessage(message: TrustedHistoryMessage): IMessage {
    const mapped: ICommonObject = {
        content: message.content,
        role: message.role === 'userMessage' ? 'user' : 'assistant'
    }
    if (message.fileUploads !== undefined || message.artifacts !== undefined) {
        mapped.additional_kwargs = {}
        if (message.fileUploads !== undefined) mapped.additional_kwargs.fileUploads = message.fileUploads
        if (message.artifacts !== undefined) mapped.additional_kwargs.artifacts = message.artifacts
    }
    return mapped as IMessage
}

export interface TrustedStateBuildInput {
    history: TrustedHistoryMessage[]
    flowState?: ICommonObject
    form?: unknown
    childFlowTokens: Record<string, ChildFlowToken>
    flowNodeIds: Set<string>
    pendingResume?: PendingResume
}

export function buildTrustedState({
    history,
    flowState,
    form,
    childFlowTokens,
    flowNodeIds,
    pendingResume
}: TrustedStateBuildInput): TrustedStateV2 {
    const state: TrustedStateV2 = {
        version: TRUSTED_STATE_VERSION,
        history,
        flowState: flowState ?? {},
        formValues: toFormValues(form),
        childFlowTokens: Object.fromEntries(Object.entries(childFlowTokens).filter(([nodeId]) => flowNodeIds.has(nodeId)))
    }
    if (pendingResume) state.pendingResume = pendingResume
    return state
}

export const writeToken = (state: TrustedStateV2): Promise<string> => trusted_state_to_string(state)

export function logTurnTokens(
    chatId: string,
    turnInput: TrustedTurnInput,
    written?: { token: string; historyLength: number; pending: boolean }
) {
    const { incoming } = turnInput
    const tokenIn = `in v${incoming.version} ${incoming.base64Length} chars, history ${incoming.historyLength}, pending ${incoming.hadPending}`
    const tokenOut = written
        ? `out ${written.token.length} chars, history ${written.historyLength}, pending ${written.pending}`
        : 'out none'
    logger.debug(`[agentflow]: trustedState chatId=${chatId}: ${tokenIn}; ${tokenOut}`)
}
