import { IAgentflowExecutedData, ExecutionState, IReactFlowNode } from '../../Interface'
import { getErrorMessage } from '../../errors/utils'
import logger from '../logger'
import { compareNodesDeterministically } from './dependencyEngine'

export interface IExecutionAbortScope {
    abortController: AbortController
    signal: AbortSignal
    abortInternal: (reason?: unknown) => void
    isExternallyAborted: () => boolean
    isAborted: () => boolean
    cleanup: () => void
}

export interface IRootExecutionError {
    errorStatus: ExecutionState
    errorMessage: string
    isAbortError: boolean
    originalError: unknown
}

export interface IRecordedNodeFault {
    nodeStatus: ExecutionState
    nodeMessage: string
    isAbort: boolean
    rootError: IRootExecutionError
}

export interface IFaultRecorder {
    recordNodeError: (error: unknown) => IRecordedNodeFault
    getRootError: () => IRootExecutionError | undefined
    finalizeForExternalAbort: () => IRootExecutionError | undefined
}

export interface IPrimaryStoppedActionResult {
    action?: Record<string, any>
    primaryNodeId?: string
    stoppedNodeIds: string[]
}

export interface ISerializedTaskQueue {
    enqueue: <T>(task: () => Promise<T>) => Promise<T>
    drain: () => Promise<void>
}

function isNonEmptyPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length > 0)
}

function getHumanInputAction(entry?: IAgentflowExecutedData): Record<string, any> | undefined {
    const output = entry?.data?.output as unknown
    if (!isNonEmptyPlainObject(output)) {
        return undefined
    }
    const action = output.humanInputAction
    return isNonEmptyPlainObject(action) ? action : undefined
}

/**
 * Returns true if the error represents an abort/cancellation signal rather than a primary node failure.
 */
export function isAbortLikeError(error: unknown): boolean {
    if (error && typeof error === 'object') {
        const errObj = error as { name?: unknown; code?: unknown }
        if (errObj.name === 'AbortError' || errObj.code === 'ABORT_ERR') {
            return true
        }
    }
    return getErrorMessage(error).toLowerCase().includes('aborted')
}

/**
 * Creates a per-execution child `AbortController` linked to an optional caller `AbortController`.
 * External caller aborts propagate inward to the child controller, while `abortInternal()` never
 * mutates the caller's controller. Call `cleanup()` in `finally` to avoid abort listener leaks.
 */
export function createExecutionAbortScope(callerAbortController?: AbortController): IExecutionAbortScope {
    const executionAbortController = new AbortController()
    let externallyAborted = false
    const callerSignal = callerAbortController?.signal
    let onCallerAbort: (() => void) | undefined

    if (callerSignal) {
        if (callerSignal.aborted) {
            externallyAborted = true
            executionAbortController.abort(callerSignal.reason)
        } else {
            onCallerAbort = () => {
                externallyAborted = true
                if (!executionAbortController.signal.aborted) {
                    executionAbortController.abort(callerSignal.reason)
                }
            }
            callerSignal.addEventListener('abort', onCallerAbort, { once: true })
        }
    }

    return {
        abortController: executionAbortController,
        signal: executionAbortController.signal,
        abortInternal: (reason?: unknown) => {
            if (!executionAbortController.signal.aborted) {
                executionAbortController.abort(reason)
            }
        },
        isExternallyAborted: () => externallyAborted || Boolean(callerSignal?.aborted),
        isAborted: () => executionAbortController.signal.aborted,
        cleanup: () => {
            if (callerSignal && onCallerAbort) {
                callerSignal.removeEventListener('abort', onCallerAbort)
                onCallerAbort = undefined
            }
        }
    }
}

/**
 * Records node failures across concurrent branches while preserving the first non-abort root error
 * so secondary `AbortError`s from cancelled siblings never mask the true failure cause.
 */
export function createFaultRecorder(abortScope: IExecutionAbortScope): IFaultRecorder {
    let rootError: IRootExecutionError | undefined

    return {
        recordNodeError: (error: unknown): IRecordedNodeFault => {
            const matchesAbortReason =
                abortScope.isAborted() && abortScope.signal.reason !== undefined && error === abortScope.signal.reason
            const isAbort = abortScope.isAborted() && (isAbortLikeError(error) || matchesAbortReason)
            const nodeStatus: ExecutionState = isAbort ? 'TERMINATED' : 'ERROR'
            const nodeMessage = isAbort ? 'Flow execution was cancelled' : getErrorMessage(error)

            if (!rootError) {
                if (abortScope.isExternallyAborted()) {
                    rootError = {
                        errorStatus: 'TERMINATED',
                        errorMessage: 'Flow execution was cancelled',
                        isAbortError: true,
                        originalError: error
                    }
                } else {
                    rootError = {
                        errorStatus: nodeStatus,
                        errorMessage: nodeMessage,
                        isAbortError: isAbort,
                        originalError: error
                    }
                }
            } else if (rootError.isAbortError && !isAbort && !abortScope.isExternallyAborted()) {
                // Promote a genuine node failure if a sibling's internal AbortError arrived first
                rootError = {
                    errorStatus: nodeStatus,
                    errorMessage: nodeMessage,
                    isAbortError: false,
                    originalError: error
                }
            }

            return {
                nodeStatus,
                nodeMessage,
                isAbort,
                rootError
            }
        },
        getRootError: () => rootError,
        finalizeForExternalAbort: () => {
            if (!rootError && abortScope.isExternallyAborted()) {
                rootError = {
                    errorStatus: 'TERMINATED',
                    errorMessage: 'Flow execution was cancelled',
                    isAbortError: true,
                    originalError: new Error('Aborted')
                }
            }
            return rootError
        }
    }
}

/**
 * Looks up the prior `STOPPED` `humanInputAction` checkpoint for a resumed node without relying on
 * `agentFlowExecutedData[length - 1]`. Ignores recursive iteration child records (`parentNodeId`).
 */
export function findResumedHumanInputAction(
    executedData: IAgentflowExecutedData[],
    targetNodeId?: string
): Record<string, any> | undefined {
    if (!executedData || executedData.length === 0) {
        return undefined
    }

    if (targetNodeId) {
        for (let i = executedData.length - 1; i >= 0; i -= 1) {
            const entry = executedData[i]
            if (entry.data?.parentNodeId) continue
            const action = getHumanInputAction(entry)
            if (entry.nodeId === targetNodeId && entry.status === 'STOPPED' && action) {
                return action
            }
        }
        for (let i = executedData.length - 1; i >= 0; i -= 1) {
            const entry = executedData[i]
            if (entry.data?.parentNodeId) continue
            const action = getHumanInputAction(entry)
            if (entry.nodeId === targetNodeId && action) {
                return action
            }
        }
    }

    for (let i = executedData.length - 1; i >= 0; i -= 1) {
        const entry = executedData[i]
        if (entry.data?.parentNodeId) continue
        const action = getHumanInputAction(entry)
        if (entry.status === 'STOPPED' && action) {
            return action
        }
    }

    return undefined
}

function collectOrderedStoppedRecords(
    executedData: IAgentflowExecutedData[],
    nodes: IReactFlowNode[],
    levels: Record<string, number> = {}
): IAgentflowExecutedData[] {
    if (!executedData || executedData.length === 0) {
        return []
    }

    const nodeById = new Map<string, IReactFlowNode>()
    for (const node of nodes || []) {
        if (node.data?.name !== 'stickyNoteAgentflow') {
            nodeById.set(node.id, node)
        }
    }

    const latestByNodeId = new Map<string, IAgentflowExecutedData>()
    for (const entry of executedData) {
        if (entry.data?.parentNodeId) continue
        if (entry.status === 'STOPPED') {
            latestByNodeId.set(entry.nodeId, entry)
        } else {
            latestByNodeId.delete(entry.nodeId)
        }
    }

    const stoppedRecords = Array.from(latestByNodeId.values())
    stoppedRecords.sort((a, b) => {
        const nodeA = nodeById.get(a.nodeId)
        const nodeB = nodeById.get(b.nodeId)
        if (nodeA && nodeB) {
            return compareNodesDeterministically(nodeA, nodeB, levels)
        }
        if (nodeA) return -1
        if (nodeB) return 1
        if (a.nodeId < b.nodeId) return -1
        if (a.nodeId > b.nodeId) return 1
        return 0
    })

    return stoppedRecords
}

/**
 * Deterministically selects the primary `STOPPED` record using `(executionOrder ?? position.y, level, nodeId)`
 * when `humanInput.startNodeId` is omitted on resume.
 */
export function selectPrimaryStoppedNode(
    executedData: IAgentflowExecutedData[],
    nodes: IReactFlowNode[],
    levels: Record<string, number> = {}
): IAgentflowExecutedData | undefined {
    const ordered = collectOrderedStoppedRecords(executedData, nodes, levels)
    return ordered[0]
}

/**
 * Selects the primary `humanInputAction` from active `STOPPED` entries using deterministic
 * topological/canvas ordering and logs a warning if multiple concurrent branches stopped.
 */
export function selectPrimaryStoppedAction(
    executedData: IAgentflowExecutedData[],
    nodes: IReactFlowNode[],
    levels: Record<string, number> = {}
): IPrimaryStoppedActionResult {
    const orderedStopped = collectOrderedStoppedRecords(executedData, nodes, levels)
    if (orderedStopped.length === 0) {
        return { stoppedNodeIds: [] }
    }

    const stoppedWithAction = orderedStopped.filter((entry) => Boolean(getHumanInputAction(entry)))
    const primary = stoppedWithAction[0] ?? orderedStopped[0]
    const action = getHumanInputAction(primary)
    const stoppedNodeIds = orderedStopped.map((entry) => entry.nodeId)

    if (orderedStopped.length > 1) {
        logger.warn(
            `[agentflow]: Multiple concurrent branches stopped (${stoppedNodeIds.join(', ')}); selecting "${
                primary.nodeId
            }" as primary ChatMessage.action while preserving all STOPPED checkpoints`
        )
    }

    return {
        action,
        primaryNodeId: primary?.nodeId,
        stoppedNodeIds
    }
}

/**
 * Lightweight per-execution FIFO async promise queue for serializing checkpoint DB updates.
 * Rejections propagate to the enqueuing caller without poisoning subsequent queued tasks.
 */
export function createSerializedTaskQueue(): ISerializedTaskQueue {
    let tail: Promise<void> = Promise.resolve()

    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const run = tail.then(() => task())
        tail = run.then(
            () => undefined,
            () => undefined
        )
        return run
    }

    const drain = async (): Promise<void> => {
        let currentTail: Promise<void>
        do {
            currentTail = tail
            await currentTail
        } while (currentTail !== tail)
    }

    return { enqueue, drain }
}
