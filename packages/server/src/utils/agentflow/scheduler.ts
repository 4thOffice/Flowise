import pLimit from 'p-limit'
import { ICommonObject } from 'flowise-components'
import { IAgentflowExecutedData } from '../../Interface'
import logger from '../logger'
import { INodeErrorContext, INodeQueue, NodeErrorPolicy, NodeErrorPolicyHook } from './types'

export const DEFAULT_MAX_NODE_CONCURRENCY = 10

/**
 * Resolves the per-flow Agentflow node concurrency limit from an explicit override or
 * `process.env.AGENTFLOW_MAX_NODE_CONCURRENCY`, defaulting to 10.
 */
export function getMaxNodeConcurrency(override?: number): number {
    if (override !== undefined) {
        const floored = Math.floor(override)
        return Number.isFinite(floored) && floored > 0 ? floored : DEFAULT_MAX_NODE_CONCURRENCY
    }
    const rawLimit = Number.parseInt(process.env.AGENTFLOW_MAX_NODE_CONCURRENCY || '', 10)
    return Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_MAX_NODE_CONCURRENCY
}

/**
 * Default terminal output selector reading the last recorded execution entry (replaced by Task 05).
 */
export function defaultSelectTerminalOutput(agentFlowExecutedData: IAgentflowExecutedData[]): ICommonObject | undefined {
    if (!agentFlowExecutedData || agentFlowExecutedData.length === 0) {
        return undefined
    }
    return agentFlowExecutedData[agentFlowExecutedData.length - 1]?.data?.output as ICommonObject | undefined
}

export interface IConcurrentSchedulerOptions<TResult = any> {
    nodeExecutionQueue: INodeQueue[]
    maxNodeConcurrency: number
    maxIterations: number
    canScheduleMore: () => boolean
    shouldLaunchNode?: (node: INodeQueue) => boolean
    compareQueuedNodes?: (a: INodeQueue, b: INodeQueue) => number
    executeNodeTask: (node: INodeQueue) => Promise<TResult>
    onNodeComplete: (node: INodeQueue, result: TResult) => { shouldStop?: boolean } | void
    handleNodeStopped?: (node: INodeQueue, result: TResult) => void
    onNodeError?: NodeErrorPolicyHook
    handleNodeError: (node: INodeQueue, error: unknown, policy?: NodeErrorPolicy) => void
    onBeforeFirstLaunch?: () => void
    selectTerminalOutput?: () => any
}

export interface IConcurrentSchedulerResult {
    iterations: number
    maxObservedConcurrency: number
    terminalOutput?: any
}

/**
 * Runs ready DAG nodes concurrently up to `maxNodeConcurrency` while performing all queue,
 * dependency, and state commits synchronously on the JS event loop when tasks settle.
 */
export async function runConcurrentNodeScheduler<TResult = any>({
    nodeExecutionQueue,
    maxNodeConcurrency,
    maxIterations,
    canScheduleMore,
    shouldLaunchNode,
    compareQueuedNodes,
    executeNodeTask,
    onNodeComplete,
    handleNodeStopped,
    onNodeError,
    handleNodeError,
    onBeforeFirstLaunch,
    selectTerminalOutput
}: IConcurrentSchedulerOptions<TResult>): Promise<IConcurrentSchedulerResult> {
    const effectiveConcurrency = getMaxNodeConcurrency(maxNodeConcurrency)
    const limit = pLimit(effectiveConcurrency)
    const inFlightTasks = new Set<Promise<void>>()
    const inFlightNodeIds = new Set<string>()
    const warnedDuplicateNodeIds = new Set<string>()

    let iterations = 0
    let maxObservedConcurrency = 0
    let hasNotifiedFirstLaunch = false
    let schedulerFatalError: Error | undefined
    let stoppedByErrorPolicy = false
    let settled = false

    const isSchedulingActive = () => !schedulerFatalError && !stoppedByErrorPolicy && canScheduleMore()

    return new Promise<IConcurrentSchedulerResult>((resolve, reject) => {
        const finish = () => {
            if (settled) return
            settled = true
            if (schedulerFatalError) {
                reject(schedulerFatalError)
                return
            }
            let terminalOutput: any
            if (selectTerminalOutput) {
                try {
                    terminalOutput = selectTerminalOutput()
                } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)))
                    return
                }
            }
            resolve({ iterations, maxObservedConcurrency, terminalOutput })
        }

        const launchNode = (currentNode: INodeQueue) => {
            inFlightNodeIds.add(currentNode.nodeId)
            warnedDuplicateNodeIds.delete(currentNode.nodeId)

            const task: Promise<void> = limit(async () => {
                // Re-check scheduling state in case a sibling failed or stopped before this slot began
                if (!isSchedulingActive()) {
                    return
                }
                const result = await executeNodeTask(currentNode)
                const completion = onNodeComplete(currentNode, result)
                if (completion?.shouldStop && handleNodeStopped) {
                    handleNodeStopped(currentNode, result)
                }
            })
                .catch((err) => {
                    try {
                        let policy: NodeErrorPolicy = 'abort'
                        if (onNodeError && isSchedulingActive()) {
                            const context: INodeErrorContext = {
                                inFlightCount: Math.max(0, inFlightTasks.size - 1),
                                queuedCount: nodeExecutionQueue.length
                            }
                            policy = onNodeError(currentNode, err, context)
                        }
                        if (policy !== 'skip-branch') {
                            stoppedByErrorPolicy = true
                        }
                        handleNodeError(currentNode, err, policy)
                    } catch (handlerError) {
                        if (!schedulerFatalError) {
                            schedulerFatalError = handlerError instanceof Error ? handlerError : new Error(String(handlerError))
                        }
                    }
                })
                .finally(() => {
                    inFlightTasks.delete(task)
                    inFlightNodeIds.delete(currentNode.nodeId)
                    schedule()
                })

            inFlightTasks.add(task)
            if (inFlightTasks.size > maxObservedConcurrency) {
                maxObservedConcurrency = inFlightTasks.size
            }
        }

        const schedule = () => {
            try {
                if (compareQueuedNodes && nodeExecutionQueue.length > 1) {
                    nodeExecutionQueue.sort(compareQueuedNodes)
                }
                while (isSchedulingActive() && nodeExecutionQueue.length > 0 && inFlightTasks.size < effectiveConcurrency) {
                    const nextIndex = nodeExecutionQueue.findIndex((item) => !inFlightNodeIds.has(item.nodeId))
                    if (nextIndex === -1) {
                        const blockedNodeId = nodeExecutionQueue[0]?.nodeId
                        if (blockedNodeId && !warnedDuplicateNodeIds.has(blockedNodeId)) {
                            warnedDuplicateNodeIds.add(blockedNodeId)
                            logger.warn(
                                `[agentflow]: Deferring duplicate queued launch for node "${blockedNodeId}" while prior instance is still in-flight`
                            )
                        }
                        break
                    }

                    if (iterations++ > maxIterations) {
                        schedulerFatalError = new Error('Maximum iteration limit reached')
                        break
                    }

                    const [currentNode] = nodeExecutionQueue.splice(nextIndex, 1)
                    if (!currentNode) continue
                    if (shouldLaunchNode && !shouldLaunchNode(currentNode)) continue

                    if (!hasNotifiedFirstLaunch) {
                        hasNotifiedFirstLaunch = true
                        onBeforeFirstLaunch?.()
                    }

                    launchNode(currentNode)
                }
            } catch (scheduleErr) {
                if (!schedulerFatalError) {
                    schedulerFatalError = scheduleErr instanceof Error ? scheduleErr : new Error(String(scheduleErr))
                }
            }

            if (inFlightTasks.size === 0 && (nodeExecutionQueue.length === 0 || !isSchedulingActive())) {
                finish()
            }
        }

        schedule()
    })
}
