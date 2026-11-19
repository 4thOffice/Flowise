import { cloneDeep, isEqual } from 'lodash'
import { ICommonObject, IMessage } from 'flowise-components'
import { IAgentflowExecutedData, TrustedState } from '../../Interface'
import { IAgentFlowRuntime } from './types'

export interface IStateDelta {
    upserted: Record<string, any>
    deleted: string[]
}

export interface INodeRuntimeSnapshot {
    startStateSnapshot: ICommonObject
    nodeRuntimeSnapshot: IAgentFlowRuntime
}

export interface IExecutedDataDelta {
    removedNodeIds?: string[]
    additionalRecords?: IAgentflowExecutedData[]
    nodeRecord?: IAgentflowExecutedData
}

export interface IReconcileRuntimeCommitParams {
    agentflowRuntime: IAgentFlowRuntime
    startStateSnapshot: ICommonObject
    nodeResult: any
    pastChatHistory: IMessage[]
    trustedData?: TrustedState
    incomingInput: { question?: string }
    question?: string
}

export interface IReconcileRuntimeCommitResult {
    delta: IStateDelta
    question?: string
    hadDoNotIncludeFeedbackHistory: boolean
}

function isPlainStateObject(value: unknown): value is ICommonObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Captures an immutable start snapshot and a distinct isolated runtime clone for a node invocation.
 * In-place mutations on `nodeRuntimeSnapshot` will not affect `startStateSnapshot` or live `agentflowRuntime`.
 */
export function createNodeRuntimeSnapshot(agentflowRuntime: IAgentFlowRuntime): INodeRuntimeSnapshot {
    const startStateSnapshot = cloneDeep(agentflowRuntime.state ?? {})
    const nodeRuntimeSnapshot: IAgentFlowRuntime = {
        state: cloneDeep(startStateSnapshot),
        chatHistory: cloneDeep(agentflowRuntime.chatHistory ?? []),
        form: cloneDeep(agentflowRuntime.form ?? {})
    }

    return {
        startStateSnapshot,
        nodeRuntimeSnapshot
    }
}

/**
 * Computes top-level added/modified (`upserted`) and removed (`deleted`) keys
 * between a node's launch snapshot and its returned state.
 * Conflict granularity is per top-level state key (last-finisher-wins).
 */
export function computeStateDelta(startSnapshot: ICommonObject, endState: ICommonObject | undefined | null): IStateDelta {
    if (!isPlainStateObject(endState)) {
        return { upserted: {}, deleted: [] }
    }

    const safeStart = isPlainStateObject(startSnapshot) ? startSnapshot : {}
    const upserted: Record<string, any> = {}
    const deleted: string[] = []

    for (const key of Object.keys(endState)) {
        const existedInStart = Object.prototype.hasOwnProperty.call(safeStart, key)
        if (!existedInStart || !isEqual(safeStart[key], endState[key])) {
            upserted[key] = cloneDeep(endState[key])
        }
    }

    for (const key of Object.keys(safeStart)) {
        if (!Object.prototype.hasOwnProperty.call(endState, key)) {
            deleted.push(key)
        }
    }

    return { upserted, deleted }
}

/**
 * Applies a state delta onto `liveState`, returning the merged state object without mutating `liveState`.
 */
export function applyStateDelta(liveState: ICommonObject, delta: IStateDelta): ICommonObject {
    const nextState: ICommonObject = isPlainStateObject(liveState) ? { ...liveState } : {}

    for (const key of delta.deleted) {
        delete nextState[key]
    }

    for (const [key, value] of Object.entries(delta.upserted)) {
        nextState[key] = cloneDeep(value)
    }

    return nextState
}

/**
 * Mutates `canonicalExecutedData` synchronously in place to remove stale entries (e.g. resumed STOPPED records)
 * and append subflow/node records without replacing the canonical array reference.
 */
export function commitExecutedDataDelta(
    canonicalExecutedData: IAgentflowExecutedData[],
    delta: IExecutedDataDelta
): IAgentflowExecutedData[] {
    if (delta.removedNodeIds && delta.removedNodeIds.length > 0) {
        const removedSet = new Set(delta.removedNodeIds)
        for (let i = canonicalExecutedData.length - 1; i >= 0; i--) {
            if (removedSet.has(canonicalExecutedData[i].nodeId)) {
                canonicalExecutedData.splice(i, 1)
            }
        }
    }

    if (delta.additionalRecords && delta.additionalRecords.length > 0) {
        canonicalExecutedData.push(...delta.additionalRecords)
    }

    if (delta.nodeRecord) {
        canonicalExecutedData.push(delta.nodeRecord)
    }

    return canonicalExecutedData
}

/**
 * Synchronously reconciles a completed node's runtime outputs (`state` delta, `chatHistory`, `form`,
 * `ephemeralMemory`, and `doNotIncludeFeedbackHistory`) onto live execution state.
 */
export function reconcileRuntimeCommit({
    agentflowRuntime,
    startStateSnapshot,
    nodeResult,
    pastChatHistory,
    trustedData,
    incomingInput,
    question
}: IReconcileRuntimeCommitParams): IReconcileRuntimeCommitResult {
    let updatedQuestion = question

    if (nodeResult && nodeResult.chatHistory) {
        agentflowRuntime.chatHistory = [...(agentflowRuntime.chatHistory ?? []), ...cloneDeep(nodeResult.chatHistory)]
    }

    if (nodeResult && nodeResult.output && nodeResult.output.form) {
        agentflowRuntime.form = cloneDeep(nodeResult.output.form)
    }

    if (nodeResult && nodeResult.output && nodeResult.output.ephemeralMemory) {
        pastChatHistory.length = 0
        if (trustedData?.pastChatHistory) {
            trustedData.pastChatHistory.length = 0
        }
    }

    let hadDoNotIncludeFeedbackHistory = false
    if (nodeResult && isPlainStateObject(nodeResult.state) && nodeResult.state.doNotIncludeFeedbackHistory) {
        hadDoNotIncludeFeedbackHistory = true
        pastChatHistory.length = Math.max(0, pastChatHistory.length - 1)
        if (trustedData?.pastChatHistory) {
            trustedData.pastChatHistory.length = Math.max(0, trustedData.pastChatHistory.length - 1)
        }
        if (pastChatHistory.length) {
            updatedQuestion = pastChatHistory[pastChatHistory.length - 1].message || pastChatHistory[pastChatHistory.length - 1].content
            incomingInput.question = updatedQuestion
            pastChatHistory.length = pastChatHistory.length - 1 // run original input
        }
        delete nodeResult.state.doNotIncludeFeedbackHistory
    }

    const delta = computeStateDelta(startStateSnapshot, nodeResult?.state)
    if (nodeResult && isPlainStateObject(nodeResult.state)) {
        const nextState = applyStateDelta(agentflowRuntime.state ?? {}, delta)
        if (hadDoNotIncludeFeedbackHistory) {
            delete nextState.doNotIncludeFeedbackHistory
        }
        agentflowRuntime.state = nextState
    }

    return {
        delta,
        question: updatedQuestion,
        hadDoNotIncludeFeedbackHistory
    }
}
