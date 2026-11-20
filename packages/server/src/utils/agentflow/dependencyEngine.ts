import { ICommonObject, IHumanInput, IServerSideEventStreamer } from 'flowise-components'
import { IAgentflowExecutedData, IReactFlowEdge, IReactFlowNode } from '../../Interface'
import logger from '../logger'
import { combineNodeInputs, MAX_LOOP_COUNT } from './schedulerHelpers'
import { INodeQueue } from './types'

export type EdgeStatus = 'PENDING' | 'ACTIVATED' | 'SKIPPED'

export type DependencyNodeState = 'PENDING' | 'READY' | 'EXECUTED' | 'SKIPPED' | 'STOPPED'

export const DECISION_NODE_NAMES = new Set<string>(['conditionAgentflow', 'conditionAgentAgentflow', 'humanInputAgentflow'])

export interface IIndexedEdge {
    key: string
    edge: IReactFlowEdge
}

export interface IEdgeSettlementItem {
    edgeKey: string
    status: 'ACTIVATED' | 'SKIPPED'
    sourceResult?: any
}

export interface IDependencyEngineInitParams {
    nodes: IReactFlowNode[]
    edges: IReactFlowEdge[]
    startingNodeIds: string[]
    executedData?: IAgentflowExecutedData[]
    isResuming?: boolean
}

export interface ILoopSubgraphResetResult {
    loopSubgraphNodes: Set<string>
    resetEdgeKeys: string[]
    preservedExternalEdgeKeys: string[]
    targetNodeEntry: INodeQueue | null
}

export interface IProcessNodeCompletionParams {
    nodeId: string
    nodeName: string
    result: any
    epoch?: number
    humanInput?: IHumanInput
    nodeExecutionQueue: INodeQueue[]
    loopCounts: Map<string, number>
    sseStreamer?: IServerSideEventStreamer
    chatId: string
}

export interface IProcessNodeCompletionResult {
    newlyReadyNodes: INodeQueue[]
    skippedNodeIds: string[]
    loopedToNodeId?: string
    loopHitMaxCount: boolean
    fallbackMessage?: string
    humanInput?: IHumanInput
}

/**
 * Returns true if the node type evaluates conditional output handles (`isFulfilled` branches).
 */
export function isDecisionNode(nodeName: string): boolean {
    return DECISION_NODE_NAMES.has(nodeName)
}

/**
 * Resolves numeric `maxLoopCount` safely while preserving explicit `0`.
 */
export function resolveMaxLoopCount(rawMaxLoop: unknown, fallback: number = MAX_LOOP_COUNT): number {
    if (rawMaxLoop !== undefined && rawMaxLoop !== null && rawMaxLoop !== '') {
        const parsed = Number(rawMaxLoop)
        if (Number.isFinite(parsed)) {
            return parsed
        }
    }
    return fallback
}

/**
 * Builds a deterministic identifier for an edge so parallel edges and multiple condition handles
 * between the same `(source, target)` pair are tracked independently.
 */
export function getEdgeKey(edge: IReactFlowEdge): string {
    return edge.id || `${edge.source}:${edge.sourceHandle || ''}:${edge.target}:${edge.targetHandle || ''}`
}

/**
 * Extracts the numeric output handle index from `<nodeId>-output-<index>` (or `output-<index>`) if present.
 */
export function parseDecisionOutputIndex(nodeId: string, sourceHandle?: string): number | null {
    if (!sourceHandle) {
        return null
    }
    const prefixed = `${nodeId}-output-`
    if (sourceHandle.startsWith(prefixed)) {
        const suffix = sourceHandle.slice(prefixed.length)
        return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : null
    }
    const bareMatch = /^output-(\d+)$/.exec(sourceHandle)
    return bareMatch ? Number.parseInt(bareMatch[1], 10) : null
}

/**
 * Splits a completed node's outgoing edges into `ACTIVATED` and `SKIPPED` sets.
 * Uses full edge iteration (never `.find()`) so multi-edge fan-out per handle works uniformly.
 */
export function classifyDecisionOutgoingEdges(
    nodeId: string,
    nodeName: string,
    result: any,
    outgoingEdges: IReactFlowEdge[]
): { activatedEdges: IReactFlowEdge[]; skippedEdges: IReactFlowEdge[] } {
    if (!isDecisionNode(nodeName) || !Array.isArray(result?.output?.conditions)) {
        return { activatedEdges: [...outgoingEdges], skippedEdges: [] }
    }

    const conditions: any[] = result.output.conditions
    const fulfilledIndexes = new Set<number>()
    for (let i = 0; i < conditions.length; i += 1) {
        if (conditions[i]?.isFulfilled === true) {
            fulfilledIndexes.add(i)
        }
    }

    const activatedEdges: IReactFlowEdge[] = []
    const skippedEdges: IReactFlowEdge[] = []

    for (const edge of outgoingEdges) {
        const outputIndex = parseDecisionOutputIndex(nodeId, edge.sourceHandle)
        if (outputIndex !== null) {
            if (fulfilledIndexes.has(outputIndex)) {
                activatedEdges.push(edge)
            } else {
                skippedEdges.push(edge)
            }
        } else if (fulfilledIndexes.size > 0) {
            activatedEdges.push(edge)
        } else {
            skippedEdges.push(edge)
        }
    }

    return { activatedEdges, skippedEdges }
}

/**
 * Computes the forward-reachable node set from `rootNodeIds` via iterative BFS.
 */
export function computeReachableNodes(
    rootNodeIds: Iterable<string>,
    outgoingAdjacency: Map<string, string[]>,
    validNodeIds?: Set<string>
): Set<string> {
    const visited = new Set<string>()
    const queue: string[] = []

    for (const rootId of rootNodeIds) {
        if (validNodeIds && !validNodeIds.has(rootId)) continue
        if (visited.has(rootId)) continue
        visited.add(rootId)
        queue.push(rootId)
    }

    let head = 0
    while (head < queue.length) {
        const currentId = queue[head++]
        const neighbors = outgoingAdjacency.get(currentId) || []
        for (const nextId of neighbors) {
            if (validNodeIds && !validNodeIds.has(nextId)) continue
            if (visited.has(nextId)) continue
            visited.add(nextId)
            queue.push(nextId)
        }
    }

    return visited
}

/**
 * Computes longest-path topological levels (`level(v) = max_{u -> v}(level(u) + 1)`) using Kahn's algorithm.
 * Sticky notes are ignored. When `startingNodeIds` is provided, only nodes reachable from those roots are leveled.
 */
export function computeTopologicalLevels(
    nodes: IReactFlowNode[],
    edges: IReactFlowEdge[],
    startingNodeIds?: string[]
): Record<string, number> {
    const activeNodes = (nodes || []).filter((n) => n.data?.name !== 'stickyNoteAgentflow')
    const allNodeIds = new Set(activeNodes.map((n) => n.id))

    const adjacency = new Map<string, string[]>()
    for (const id of allNodeIds) {
        adjacency.set(id, [])
    }

    const validEdges = (edges || []).filter((e) => allNodeIds.has(e.source) && allNodeIds.has(e.target))
    for (const edge of validEdges) {
        adjacency.get(edge.source)!.push(edge.target)
    }

    const activeNodeIds =
        startingNodeIds !== undefined ? computeReachableNodes(startingNodeIds, adjacency, allNodeIds) : allNodeIds

    const inDegree = new Map<string, number>()
    const activeAdjacency = new Map<string, string[]>()
    for (const id of activeNodeIds) {
        inDegree.set(id, 0)
        activeAdjacency.set(id, [])
    }

    for (const edge of validEdges) {
        if (!activeNodeIds.has(edge.source) || !activeNodeIds.has(edge.target)) continue
        activeAdjacency.get(edge.source)!.push(edge.target)
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const levels: Record<string, number> = {}
    const queue: string[] = []
    for (const [id, deg] of inDegree.entries()) {
        if (deg === 0) {
            levels[id] = 0
            queue.push(id)
        }
    }

    let head = 0
    while (head < queue.length) {
        const u = queue[head++]
        const uLevel = levels[u] ?? 0
        for (const v of activeAdjacency.get(u) || []) {
            levels[v] = Math.max(levels[v] ?? 0, uLevel + 1)
            const nextDeg = (inDegree.get(v) ?? 0) - 1
            inDegree.set(v, nextDeg)
            if (nextDeg === 0) {
                queue.push(v)
            }
        }
    }

    return levels
}

function getExplicitOrCanvasOrder(node: IReactFlowNode): number {
    const explicitOrder = (node.data as { executionOrder?: unknown } | undefined)?.executionOrder
    if (typeof explicitOrder === 'number' && Number.isFinite(explicitOrder)) {
        return explicitOrder
    }
    const posY = node.position?.y
    if (typeof posY === 'number' && Number.isFinite(posY)) {
        return posY
    }
    return 0
}

function compareNodeIdsCodePoint(aId: string, bId: string): number {
    if (aId < bId) return -1
    if (aId > bId) return 1
    return 0
}

/**
 * Deterministic comparator: `(executionOrder ?? position.y ?? 0)`, then topological `level`, then code-point `node.id`.
 */
export function compareNodesDeterministically(
    a: IReactFlowNode,
    b: IReactFlowNode,
    levels: Record<string, number> = {}
): number {
    const orderDiff = getExplicitOrCanvasOrder(a) - getExplicitOrCanvasOrder(b)
    if (orderDiff !== 0) {
        return orderDiff
    }

    const levelA = levels[a.id] ?? Number.MAX_SAFE_INTEGER
    const levelB = levels[b.id] ?? Number.MAX_SAFE_INTEGER
    if (levelA !== levelB) {
        return levelA - levelB
    }

    return compareNodeIdsCodePoint(a.id, b.id)
}

/**
 * Stateful per-execution DAG dependency engine implementing Kahn's topological readiness,
 * iterative 3-state Dead-Path Elimination (`PENDING | ACTIVATED | SKIPPED`), mid-graph resumption,
 * and `loopAgentflow` forward-subgraph reset.
 */
export class AgentflowDependencyEngine {
    private readonly nodeById = new Map<string, IReactFlowNode>()
    private readonly nodeIdSet = new Set<string>()
    private readonly indexedEdges: IIndexedEdge[] = []
    private readonly edgeByKey = new Map<string, IIndexedEdge>()
    private readonly outgoingEdges = new Map<string, IIndexedEdge[]>()
    private readonly incomingEdges = new Map<string, IIndexedEdge[]>()
    private readonly forwardAdjacency = new Map<string, string[]>()
    private readonly forwardReachCache = new Map<string, Set<string>>()
    private readonly levels: Record<string, number>

    private readonly edgeStatus = new Map<string, EdgeStatus>()
    private readonly nodeState = new Map<string, DependencyNodeState>()
    private readonly pendingInCount = new Map<string, number>()
    private readonly activatedInCount = new Map<string, number>()
    private readonly receivedByNode = new Map<string, Map<string, any>>()
    private readonly nodeEpoch = new Map<string, number>()

    private readonly loopNodeIds: string[] = []
    private readonly knownLoopTargets = new Map<string, string>()
    private readonly pendingLoopPayloads = new Map<string, any>()
    private readonly deferredReadyNodes = new Set<string>()

    private readonly reachableNodes: Set<string>
    private readonly replayLoopCounts = new Map<string, number>()
    private readonly initialReadyNodes: INodeQueue[] = []

    constructor({ nodes, edges, startingNodeIds, executedData, isResuming }: IDependencyEngineInitParams) {
        const activeNodes = (nodes || []).filter((node) => node.data?.name !== 'stickyNoteAgentflow')
        for (const node of activeNodes) {
            this.nodeById.set(node.id, node)
            this.nodeIdSet.add(node.id)
            this.outgoingEdges.set(node.id, [])
            this.incomingEdges.set(node.id, [])
            this.forwardAdjacency.set(node.id, [])
            this.pendingInCount.set(node.id, 0)
            this.activatedInCount.set(node.id, 0)
            this.receivedByNode.set(node.id, new Map())
            this.nodeEpoch.set(node.id, 0)
            if (node.data?.name === 'loopAgentflow') {
                this.loopNodeIds.push(node.id)
            }
        }

        const validEdges: IReactFlowEdge[] = []
        ;(edges || []).forEach((edge, idx) => {
            if (!this.nodeIdSet.has(edge.source) || !this.nodeIdSet.has(edge.target)) {
                return
            }
            validEdges.push(edge)
            const baseKey = getEdgeKey(edge)
            let uniqueKey = baseKey
            let collisionCounter = 1
            while (this.edgeByKey.has(uniqueKey)) {
                uniqueKey = `${baseKey}#${idx}_${collisionCounter++}`
            }
            const indexed: IIndexedEdge = { key: uniqueKey, edge }
            this.indexedEdges.push(indexed)
            this.edgeByKey.set(uniqueKey, indexed)
            this.outgoingEdges.get(edge.source)!.push(indexed)
            this.incomingEdges.get(edge.target)!.push(indexed)
            this.forwardAdjacency.get(edge.source)!.push(edge.target)
        })

        for (const loopId of this.loopNodeIds) {
            const configuredTarget = this.resolveConfiguredLoopTarget(this.nodeById.get(loopId)!)
            if (configuredTarget) {
                this.knownLoopTargets.set(loopId, configuredTarget)
            }
        }

        // Initial BFS reachability pre-pass
        const isMidGraphResume = Boolean(isResuming || (executedData && executedData.length > 0))
        const startingNodeSet = new Set(startingNodeIds)
        const reachabilityRoots: string[] = []

        for (const id of startingNodeIds) {
            if (this.nodeIdSet.has(id)) {
                reachabilityRoots.push(id)
            }
        }

        if (isMidGraphResume && executedData) {
            for (const record of executedData) {
                if (record.data?.parentNodeId) continue
                const node = this.nodeById.get(record.nodeId)
                if (!node) continue
                // Exclude iteration subflow child nodes unless explicitly listed in startingNodeIds
                if (node.extent === 'parent' && !startingNodeSet.has(record.nodeId)) continue
                reachabilityRoots.push(record.nodeId)
            }
        }

        this.reachableNodes = computeReachableNodes(reachabilityRoots, this.forwardAdjacency, this.nodeIdSet)
        this.levels = computeTopologicalLevels(activeNodes, validEdges, reachabilityRoots)

        for (const id of this.nodeIdSet) {
            this.nodeState.set(id, this.reachableNodes.has(id) ? 'PENDING' : 'SKIPPED')
        }

        for (const indexed of this.indexedEdges) {
            const isReachableEdge =
                this.reachableNodes.has(indexed.edge.source) && this.reachableNodes.has(indexed.edge.target)
            if (isReachableEdge) {
                this.edgeStatus.set(indexed.key, 'PENDING')
                this.pendingInCount.set(indexed.edge.target, (this.pendingInCount.get(indexed.edge.target) ?? 0) + 1)
            } else {
                this.edgeStatus.set(indexed.key, 'SKIPPED')
            }
        }

        // Mid-graph HumanInput resumption replay
        const replayReadySet = new Set<string>()
        const replayLoopEntryPayloads = new Map<string, INodeQueue>()
        if (isMidGraphResume && executedData && executedData.length > 0) {
            for (let recordIdx = 0; recordIdx < executedData.length; recordIdx += 1) {
                const record = executedData[recordIdx]
                if (record.data?.parentNodeId) continue
                const node = this.nodeById.get(record.nodeId)
                if (!node || !this.reachableNodes.has(record.nodeId)) continue

                if (record.status === 'STOPPED') {
                    replayReadySet.delete(record.nodeId)
                    replayLoopEntryPayloads.delete(record.nodeId)
                    this.pendingLoopPayloads.delete(record.nodeId)
                    this.nodeState.set(record.nodeId, 'STOPPED')
                    continue
                }

                if (record.status === 'FINISHED') {
                    replayReadySet.delete(record.nodeId)
                    replayLoopEntryPayloads.delete(record.nodeId)
                    this.pendingLoopPayloads.delete(record.nodeId)
                    this.nodeState.set(record.nodeId, 'EXECUTED')

                    const { settlementItems } = this.classifyNodeOutgoingSettlement(
                        record.nodeId,
                        node.data?.name || '',
                        record.data
                    )
                    const { newlyReadyNodeIds } = this.settleWorklist(settlementItems)
                    for (const readyId of newlyReadyNodeIds) {
                        replayReadySet.add(readyId)
                    }

                    const loopOutput =
                        record.data?.output && typeof record.data.output === 'object' && !Array.isArray(record.data.output)
                            ? (record.data.output as ICommonObject)
                            : undefined
                    if (node.data?.name === 'loopAgentflow' && loopOutput?.nodeID) {
                        const targetNodeId = String(loopOutput.nodeID)
                        if (this.nodeIdSet.has(targetNodeId)) {
                            this.knownLoopTargets.set(record.nodeId, targetNodeId)
                            const targetReach = this.getForwardReach(targetNodeId)
                            // Guard against a sibling loop that drained AFTER a STOPPED target in the prior run:
                            // if the loop target subgraph includes a resumed STOPPED node with no later execution record,
                            // skip replaying that un-taken loop reset over the resumed checkpoint.
                            const overlapsPendingStoppedResume = Array.from(startingNodeSet).some(
                                (startId) =>
                                    targetReach.has(startId) &&
                                    this.nodeState.get(startId) === 'STOPPED' &&
                                    !executedData.slice(recordIdx + 1).some((later) => !later.data?.parentNodeId && later.nodeId === startId)
                            )
                            if (!overlapsPendingStoppedResume) {
                                const loopCount = (this.replayLoopCounts.get(record.nodeId) || 0) + 1
                                const maxLoop = resolveMaxLoopCount(loopOutput.maxLoopCount, MAX_LOOP_COUNT)
                                if (loopCount < maxLoop) {
                                    this.replayLoopCounts.set(record.nodeId, loopCount)
                                    const resetResult = this.resetLoopSubgraph(targetNodeId, loopOutput)
                                    for (const resetId of resetResult.loopSubgraphNodes) {
                                        replayReadySet.delete(resetId)
                                        replayLoopEntryPayloads.delete(resetId)
                                    }
                                    if (resetResult.targetNodeEntry) {
                                        replayReadySet.add(targetNodeId)
                                        replayLoopEntryPayloads.set(targetNodeId, resetResult.targetNodeEntry)
                                    }
                                } else {
                                    this.nodeState.set(record.nodeId, 'EXECUTED')
                                }
                            }
                        }
                    }

                    for (const releasedId of this.releaseEligibleDeferredNodes()) {
                        replayReadySet.add(releasedId)
                    }
                    continue
                }

                replayReadySet.delete(record.nodeId)
                replayLoopEntryPayloads.delete(record.nodeId)
            }
        }

        // Materialize initial ready queue (preserving deduplicated startingNodeIds)
        const queuedNodeIds = new Set<string>()
        const validStartingIds = startingNodeIds.filter((id) => this.nodeIdSet.has(id))
        for (const startId of validStartingIds) {
            if (queuedNodeIds.has(startId)) continue
            // If another explicit starting node has an unsettled forward path to startId in a fresh run,
            // let Kahn readiness schedule startId once upstream starting nodes complete.
            const hasUnsettledStartAncestor =
                !isMidGraphResume &&
                (this.pendingInCount.get(startId) ?? 0) > 0 &&
                validStartingIds.some((otherId) => otherId !== startId && this.getForwardReach(otherId).has(startId))
            if (hasUnsettledStartAncestor) continue

            queuedNodeIds.add(startId)
            replayReadySet.delete(startId)
            const preservedLoopEntry = replayLoopEntryPayloads.get(startId)
            replayLoopEntryPayloads.delete(startId)
            this.deferredReadyNodes.delete(startId)

            const currentState = this.nodeState.get(startId)
            if (currentState === 'EXECUTED' || currentState === 'SKIPPED') {
                this.resetLoopSubgraph(startId)
            }
            this.nodeState.set(startId, 'READY')
            this.initialReadyNodes.push(preservedLoopEntry ?? this.buildQueueEntry(startId))
        }

        for (const readyId of replayReadySet) {
            if (queuedNodeIds.has(readyId)) continue
            if (this.nodeState.get(readyId) !== 'READY') continue
            queuedNodeIds.add(readyId)
            const preservedLoopEntry = replayLoopEntryPayloads.get(readyId)
            replayLoopEntryPayloads.delete(readyId)
            this.initialReadyNodes.push(preservedLoopEntry ?? this.buildQueueEntry(readyId))
        }

        this.initialReadyNodes.sort((a, b) => this.compareQueueItems(a, b))
    }

    /** Returns a shallow copy of the initial ready nodes sorted deterministically. */
    getInitialQueue(): INodeQueue[] {
        return [...this.initialReadyNodes]
    }

    /** Returns loop counts reconstructed during mid-graph resumption replay. */
    getReplayLoopCounts(): Map<string, number> {
        return new Map(this.replayLoopCounts)
    }

    /** Returns the current loop epoch counter for a node (0 for un-reset nodes). */
    getNodeEpoch(nodeId: string): number {
        return this.nodeEpoch.get(nodeId) ?? 0
    }

    /** Returns the current 3-state status for an edge key (`PENDING | ACTIVATED | SKIPPED`). */
    getEdgeStatus(edgeKey: string): EdgeStatus | undefined {
        return this.edgeStatus.get(edgeKey)
    }

    /** Returns a snapshot map of all edge statuses keyed by unique edge key. */
    getAllEdgeStatuses(): Map<string, EdgeStatus> {
        return new Map(this.edgeStatus)
    }

    /** Returns the current node lifecycle state. */
    getNodeState(nodeId: string): DependencyNodeState | undefined {
        return this.nodeState.get(nodeId)
    }

    /** Returns the computed longest-path topological levels for active nodes. */
    getLevels(): Record<string, number> {
        return { ...this.levels }
    }

    /** Comparator for sorting `INodeQueue` entries using `(executionOrder ?? position.y, level, nodeId)`. */
    compareQueueItems(a: INodeQueue, b: INodeQueue): number {
        const nodeA = this.nodeById.get(a.nodeId)
        const nodeB = this.nodeById.get(b.nodeId)
        if (!nodeA && !nodeB) return compareNodeIdsCodePoint(a.nodeId, b.nodeId)
        if (!nodeA) return 1
        if (!nodeB) return -1
        return compareNodesDeterministically(nodeA, nodeB, this.levels)
    }

    /** Marks a node as `STOPPED` without settling its outgoing edges (used for HumanInput pauses). */
    markNodeStopped(nodeId: string, epoch?: number): void {
        if (epoch !== undefined && epoch !== this.getNodeEpoch(nodeId)) {
            return
        }
        if (this.nodeIdSet.has(nodeId)) {
            this.nodeState.set(nodeId, 'STOPPED')
        }
    }

    /**
     * Synchronously processes a finished node's outputs, settles outgoing edges with iterative DPE,
     * handles `loopAgentflow` forward-subgraph resets, and updates `nodeExecutionQueue` in place.
     */
    processNodeCompletion({
        nodeId,
        nodeName,
        result,
        epoch,
        humanInput,
        nodeExecutionQueue,
        loopCounts,
        sseStreamer,
        chatId
    }: IProcessNodeCompletionParams): IProcessNodeCompletionResult {
        let updatedHumanInput = humanInput

        if (epoch !== undefined && epoch !== this.getNodeEpoch(nodeId)) {
            logger.debug(`  ⏭️  Ignoring stale completion from node ${nodeId} (epoch ${epoch} !== ${this.getNodeEpoch(nodeId)})`)
            return {
                newlyReadyNodes: [],
                skippedNodeIds: [],
                loopHitMaxCount: false,
                humanInput: updatedHumanInput
            }
        }

        if (!this.nodeById.has(nodeId)) {
            return {
                newlyReadyNodes: [],
                skippedNodeIds: [],
                loopHitMaxCount: false,
                humanInput: updatedHumanInput
            }
        }

        this.nodeState.set(nodeId, 'EXECUTED')

        const { settlementItems } = this.classifyNodeOutgoingSettlement(nodeId, nodeName, result)
        const { newlyReadyNodeIds, skippedNodeIds } = this.settleWorklist(settlementItems)

        let loopedToNodeId: string | undefined
        let loopHitMaxCount = false
        let fallbackMessage: string | undefined
        let loopTargetEntry: INodeQueue | null = null
        let resetNodes: Set<string> | undefined

        if (nodeName === 'loopAgentflow' && result?.output?.nodeID) {
            const targetNodeId = String(result.output.nodeID)
            if (!this.nodeIdSet.has(targetNodeId)) {
                logger.warn(`[agentflow]: loopAgentflow node "${nodeId}" requested jump to unknown target "${targetNodeId}"`)
            } else {
                this.knownLoopTargets.set(nodeId, targetNodeId)
                const loopCount = (loopCounts.get(nodeId) || 0) + 1
                const maxLoop = resolveMaxLoopCount(result.output.maxLoopCount, MAX_LOOP_COUNT)

                if (loopCount < maxLoop) {
                    loopCounts.set(nodeId, loopCount)
                    loopedToNodeId = targetNodeId

                    const resetResult = this.resetLoopSubgraph(targetNodeId, result.output)
                    resetNodes = resetResult.loopSubgraphNodes
                    loopTargetEntry = resetResult.targetNodeEntry

                    // Purge any queued items belonging to the reset loop subgraph from the previous iteration
                    for (let i = nodeExecutionQueue.length - 1; i >= 0; i -= 1) {
                        if (resetResult.loopSubgraphNodes.has(nodeExecutionQueue[i].nodeId)) {
                            nodeExecutionQueue.splice(i, 1)
                        }
                    }

                    if (loopTargetEntry) {
                        nodeExecutionQueue.push(loopTargetEntry)
                    }

                    if (updatedHumanInput) {
                        updatedHumanInput = undefined
                    }
                } else {
                    loopHitMaxCount = true
                    const resolvedFallback: string =
                        result.output.fallbackMessage || `Loop completed after reaching maximum iteration count of ${maxLoop}.`
                    fallbackMessage = resolvedFallback
                    if (sseStreamer) {
                        sseStreamer.streamTokenEvent(chatId, resolvedFallback)
                    }
                    result.output = { ...result.output, content: resolvedFallback }
                }
            }
        }

        const readyQueueEntries: INodeQueue[] = []
        for (const readyId of newlyReadyNodeIds) {
            if (resetNodes && resetNodes.has(readyId)) continue
            if (this.nodeState.get(readyId) !== 'READY') continue
            readyQueueEntries.push(this.buildQueueEntry(readyId))
        }

        const releasedDeferredIds = this.releaseEligibleDeferredNodes()
        for (const releasedId of releasedDeferredIds) {
            if (resetNodes && resetNodes.has(releasedId)) continue
            if (this.nodeState.get(releasedId) !== 'READY') continue
            readyQueueEntries.push(this.buildQueueEntry(releasedId))
        }

        if (readyQueueEntries.length > 0) {
            nodeExecutionQueue.push(...readyQueueEntries)
        }

        const returnedReadyNodes = loopTargetEntry ? [...readyQueueEntries, loopTargetEntry] : [...readyQueueEntries]
        returnedReadyNodes.sort((a, b) => this.compareQueueItems(a, b))
        nodeExecutionQueue.sort((a, b) => this.compareQueueItems(a, b))

        return {
            newlyReadyNodes: returnedReadyNodes,
            skippedNodeIds,
            loopedToNodeId,
            loopHitMaxCount,
            fallbackMessage,
            humanInput: updatedHumanInput
        }
    }

    /**
     * Resets edges and node readiness inside the forward-reachable subgraph rooted at `targetNodeId`
     * while preserving already-settled external incoming edges (`u ∉ loopSubgraphNodes`).
     */
    resetLoopSubgraph(targetNodeId: string, loopOutput?: any): ILoopSubgraphResetResult {
        if (!this.nodeIdSet.has(targetNodeId)) {
            return {
                loopSubgraphNodes: new Set(),
                resetEdgeKeys: [],
                preservedExternalEdgeKeys: [],
                targetNodeEntry: null
            }
        }

        const loopSubgraphNodes = this.getForwardReach(targetNodeId)
        const resetEdgeKeys: string[] = []
        const preservedExternalEdgeKeys: string[] = []

        for (const v of loopSubgraphNodes) {
            this.deferredReadyNodes.delete(v)
            this.pendingLoopPayloads.delete(v)

            for (const incoming of this.incomingEdges.get(v) || []) {
                if (loopSubgraphNodes.has(incoming.edge.source)) {
                    this.edgeStatus.set(incoming.key, 'PENDING')
                    resetEdgeKeys.push(incoming.key)
                } else {
                    preservedExternalEdgeKeys.push(incoming.key)
                }
            }
        }

        for (const v of loopSubgraphNodes) {
            this.nodeEpoch.set(v, (this.nodeEpoch.get(v) ?? 0) + 1)

            const received = this.receivedByNode.get(v)!
            for (const sourceId of Array.from(received.keys())) {
                if (loopSubgraphNodes.has(sourceId)) {
                    received.delete(sourceId)
                }
            }

            let pendingCount = 0
            let activatedCount = 0
            for (const incoming of this.incomingEdges.get(v) || []) {
                const st = this.edgeStatus.get(incoming.key)
                if (st === 'PENDING') pendingCount += 1
                else if (st === 'ACTIVATED') activatedCount += 1
            }

            this.pendingInCount.set(v, pendingCount)
            this.activatedInCount.set(v, activatedCount)
            this.nodeState.set(v, v === targetNodeId && pendingCount === 0 ? 'READY' : 'PENDING')
        }

        const targetPending = this.pendingInCount.get(targetNodeId) ?? 0
        let targetNodeEntry: INodeQueue | null = null
        if (targetPending === 0) {
            targetNodeEntry = {
                nodeId: targetNodeId,
                data: loopOutput ?? {},
                inputs: {},
                epoch: this.getNodeEpoch(targetNodeId)
            }
        } else {
            // Hold loop payload until unsettled external incoming edges into targetNodeId finish
            this.pendingLoopPayloads.set(targetNodeId, loopOutput ?? {})
        }

        return {
            loopSubgraphNodes,
            resetEdgeKeys,
            preservedExternalEdgeKeys,
            targetNodeEntry
        }
    }

    private resolveConfiguredLoopTarget(loopNode: IReactFlowNode): string | undefined {
        const raw = loopNode.data?.inputs?.loopBackToNode
        if (typeof raw !== 'string' || !raw.trim()) {
            return undefined
        }
        const trimmed = raw.trim()
        if (this.nodeIdSet.has(trimmed)) {
            return trimmed
        }
        let bestMatch: string | undefined
        for (const id of this.nodeIdSet) {
            if (trimmed.startsWith(`${id}-`) && (!bestMatch || id.length > bestMatch.length)) {
                bestMatch = id
            }
        }
        return bestMatch
    }

    private getForwardReach(nodeId: string): Set<string> {
        let cached = this.forwardReachCache.get(nodeId)
        if (!cached) {
            cached = computeReachableNodes([nodeId], this.forwardAdjacency, this.nodeIdSet)
            this.forwardReachCache.set(nodeId, cached)
        }
        return cached
    }

    private classifyNodeOutgoingSettlement(
        nodeId: string,
        nodeName: string,
        result: any
    ): { settlementItems: IEdgeSettlementItem[] } {
        const indexedOutgoing = this.outgoingEdges.get(nodeId) || []
        const { activatedEdges } = classifyDecisionOutgoingEdges(
            nodeId,
            nodeName,
            result,
            indexedOutgoing.map((item) => item.edge)
        )
        const activatedEdgeSet = new Set(activatedEdges)

        const settlementItems: IEdgeSettlementItem[] = indexedOutgoing.map((item) =>
            activatedEdgeSet.has(item.edge)
                ? { edgeKey: item.key, status: 'ACTIVATED', sourceResult: result }
                : { edgeKey: item.key, status: 'SKIPPED' }
        )

        return { settlementItems }
    }

    private settleWorklist(initialItems: IEdgeSettlementItem[]): {
        newlyReadyNodeIds: string[]
        skippedNodeIds: string[]
    } {
        const worklist: IEdgeSettlementItem[] = [...initialItems]
        const candidateReadyNodeIds: string[] = []
        const skippedNodeIds: string[] = []
        let head = 0

        while (head < worklist.length) {
            const item = worklist[head++]
            if (this.edgeStatus.get(item.edgeKey) !== 'PENDING') {
                continue
            }

            const indexed = this.edgeByKey.get(item.edgeKey)
            if (!indexed) continue

            this.edgeStatus.set(item.edgeKey, item.status)
            const targetId = indexed.edge.target
            const sourceId = indexed.edge.source

            const nextPending = Math.max(0, (this.pendingInCount.get(targetId) ?? 0) - 1)
            this.pendingInCount.set(targetId, nextPending)

            if (item.status === 'ACTIVATED') {
                this.activatedInCount.set(targetId, (this.activatedInCount.get(targetId) ?? 0) + 1)
                this.receivedByNode.get(targetId)!.set(sourceId, item.sourceResult)
            }

            if (nextPending === 0 && this.nodeState.get(targetId) === 'PENDING') {
                const isActivated = (this.activatedInCount.get(targetId) ?? 0) > 0 || this.pendingLoopPayloads.has(targetId)
                if (isActivated) {
                    this.nodeState.set(targetId, 'READY')
                    candidateReadyNodeIds.push(targetId)
                } else {
                    this.nodeState.set(targetId, 'SKIPPED')
                    skippedNodeIds.push(targetId)
                    for (const outgoing of this.outgoingEdges.get(targetId) || []) {
                        if (this.edgeStatus.get(outgoing.key) === 'PENDING') {
                            worklist.push({ edgeKey: outgoing.key, status: 'SKIPPED' })
                        }
                    }
                }
            }
        }

        // Defer nodes inside an active loop's exit path that only became ready because a conditional exit edge
        // was pruned while the loop node itself has not settled yet.
        const newlyReadyNodeIds: string[] = []
        for (const targetId of candidateReadyNodeIds) {
            if (this.shouldDeferForActiveLoop(targetId)) {
                this.deferredReadyNodes.add(targetId)
            } else {
                newlyReadyNodeIds.push(targetId)
            }
        }

        return { newlyReadyNodeIds, skippedNodeIds }
    }

    private shouldDeferForActiveLoop(nodeId: string): boolean {
        if (this.loopNodeIds.length === 0) {
            return false
        }
        if (this.nodeById.get(nodeId)?.data?.name === 'loopAgentflow') {
            return false
        }

        const skippedReachableSources: string[] = []
        for (const incoming of this.incomingEdges.get(nodeId) || []) {
            if (this.edgeStatus.get(incoming.key) === 'SKIPPED' && this.reachableNodes.has(incoming.edge.source)) {
                skippedReachableSources.push(incoming.edge.source)
            }
        }
        if (skippedReachableSources.length === 0) {
            return false
        }

        for (const loopId of this.loopNodeIds) {
            const loopState = this.nodeState.get(loopId)
            if (loopState !== 'PENDING' && loopState !== 'READY') {
                continue
            }
            // If nodeId can reach loopId in the forward DAG, nodeId must execute before loopId
            if (this.getForwardReach(nodeId).has(loopId)) {
                continue
            }

            const knownTarget = this.knownLoopTargets.get(loopId)
            if (knownTarget) {
                const scope = this.getForwardReach(knownTarget)
                if (scope.has(nodeId) && scope.has(loopId) && skippedReachableSources.some((src) => scope.has(src))) {
                    return true
                }
            } else {
                // Target not configured statically (e.g., mock loop node): check if an executed decision node
                // that pruned a branch toward nodeId also reaches this active loop node.
                const hasCommonPruningAncestor = this.hasDecisionAncestorReachingBoth(loopId, skippedReachableSources)
                if (hasCommonPruningAncestor) {
                    return true
                }
            }
        }

        return false
    }

    private hasDecisionAncestorReachingBoth(loopId: string, skippedSources: string[]): boolean {
        for (const candidateId of this.reachableNodes) {
            if (candidateId === loopId) continue
            if (this.nodeState.get(candidateId) !== 'EXECUTED') continue
            const hasSkippedOutgoing = (this.outgoingEdges.get(candidateId) || []).some(
                (out) => this.edgeStatus.get(out.key) === 'SKIPPED'
            )
            if (!hasSkippedOutgoing) continue
            const candidateReach = this.getForwardReach(candidateId)
            if (candidateReach.has(loopId) && skippedSources.some((src) => candidateReach.has(src))) {
                return true
            }
        }
        return false
    }

    private releaseEligibleDeferredNodes(): string[] {
        if (this.deferredReadyNodes.size === 0) {
            return []
        }
        const released: string[] = []
        for (const nodeId of Array.from(this.deferredReadyNodes)) {
            if (!this.shouldDeferForActiveLoop(nodeId)) {
                this.deferredReadyNodes.delete(nodeId)
                if (
                    this.nodeState.get(nodeId) === 'READY' &&
                    (this.pendingInCount.get(nodeId) ?? 0) === 0 &&
                    ((this.activatedInCount.get(nodeId) ?? 0) > 0 || this.pendingLoopPayloads.has(nodeId))
                ) {
                    released.push(nodeId)
                }
            }
        }
        return released
    }

    private buildQueueEntry(nodeId: string): INodeQueue {
        const received = this.receivedByNode.get(nodeId) ?? new Map<string, any>()
        const loopPayload = this.pendingLoopPayloads.get(nodeId)
        this.pendingLoopPayloads.delete(nodeId)
        return {
            nodeId,
            data: received.size > 0 ? combineNodeInputs(received) : loopPayload ?? {},
            inputs: Object.fromEntries(received),
            epoch: this.getNodeEpoch(nodeId)
        }
    }
}

export function createDependencyEngine(params: IDependencyEngineInitParams): AgentflowDependencyEngine {
    return new AgentflowDependencyEngine(params)
}
