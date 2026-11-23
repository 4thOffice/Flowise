import { ICommonObject, IFileUpload, IMessage } from 'flowise-components'
import { ExecutionState, IAgentflowExecutedData, IChatMessage, IExecution } from '../../Interface'
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

/*
 * Interim pending data until the resume rework: the stopped run as the v1 token carried it, records included, and the
 * history message that announced the action (a resume saves no user message while that message is still in history).
 */
export interface PendingResume {
    legacyExecution: IExecution
    actionMessageIndex?: number
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

export interface TrustedTurnInput {
    history: TrustedHistoryMessage[]
    flowState: ICommonObject
    formValues: ICommonObject
    childFlowTokens: Record<string, ChildFlowToken>
    pendingResume?: PendingResume
    incoming: { version: 0 | 1 | 2; base64Length: number; historyLength: number; hadPending: boolean }
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

// A run can be resumed when it stopped, or when its last record failed right after a stopped one (the retry rule)
export function isResumableExecution(state: ExecutionState | undefined, records: IAgentflowExecutedData[]): boolean {
    if (state === 'STOPPED') return true
    if (state !== 'ERROR' || records.length < 2) return false
    return records[records.length - 1].status === 'ERROR' && records[records.length - 2].status === 'STOPPED'
}

function historyMessageFromV1(message: IChatMessage): TrustedHistoryMessage {
    const mapped: TrustedHistoryMessage = { role: message.role as TrustedHistoryMessage['role'], content: message.content }
    if (message.fileUploads) mapped.fileUploads = parseStoredJson(message.fileUploads)
    if (message.artifacts) mapped.artifacts = parseStoredJson(message.artifacts)
    return mapped
}

export function upgradeV1(v1: TrustedStateV1): TrustedStateV2 {
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
    if (execution && isResumableExecution(execution.state, records)) {
        const actionMessageIndex = pastChatHistory.findIndex((message) => message?.action)
        upgraded.pendingResume = {
            legacyExecution: execution,
            ...(actionMessageIndex >= 0 ? { actionMessageIndex } : {})
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
    if (isPlainObject(state.pendingResume) && isPlainObject(state.pendingResume.legacyExecution)) {
        normalized.pendingResume = state.pendingResume as PendingResume
    }
    return normalized
}

function decodedToV2(decoded: unknown): { state?: TrustedStateV2; version: 0 | 1 | 2 } {
    if (decoded === undefined || decoded === null) return { version: 0 }
    if (isPlainObject(decoded)) {
        if (decoded.version === TRUSTED_STATE_VERSION) return { state: normalizeV2(decoded), version: 2 }
        if (!('version' in decoded) && ('pastChatHistory' in decoded || 'previousExecution' in decoded)) {
            return { state: upgradeV1(decoded as TrustedStateV1), version: 1 }
        }
    }
    const version = isPlainObject(decoded) ? decoded.version : undefined
    logger.warn(`[agentflow]: Ignoring a trustedState of unknown format (version ${version}); starting a new conversation`)
    return { version: 0 }
}

export async function readTurnInput(incomingInput: { trustedState?: string; humanInput?: unknown }): Promise<TrustedTurnInput> {
    const raw = incomingInput.trustedState
    const { state, version } = decodedToV2(raw ? await trusted_state_from_string(raw) : undefined)
    return {
        history: state?.history ?? [],
        flowState: state?.flowState ?? {},
        formValues: state?.formValues ?? {},
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

export function logTurnTokens(chatId: string, turnInput: TrustedTurnInput, written?: { token: string; state: TrustedStateV2 }) {
    const { incoming } = turnInput
    const tokenIn = `in v${incoming.version} ${incoming.base64Length} chars, history ${incoming.historyLength}, pending ${incoming.hadPending}`
    const tokenOut = written
        ? `out ${written.token.length} chars, history ${written.state.history.length}, pending ${Boolean(written.state.pendingResume)}`
        : 'out none'
    logger.debug(`[agentflow]: trustedState chatId=${chatId}: ${tokenIn}; ${tokenOut}`)
}
