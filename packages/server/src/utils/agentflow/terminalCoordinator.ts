import { ICommonObject, IServerSideEventStreamer } from 'flowise-components'
import { IAgentflowExecutedData, INodeDirectedGraph, IReactFlowNode } from '../../Interface'
import { compareNodesDeterministically } from './dependencyEngine'

export type StreamMetadataKind = 'sourceDocuments' | 'usedTools' | 'artifacts' | 'fileAnnotations'

export interface ITerminalMetadata {
    sourceDocuments?: any[]
    usedTools?: any[]
    artifacts?: any[]
    fileAnnotations?: any[]
}

export interface IResolveTerminalContentParams {
    agentFlowExecutedData: IAgentflowExecutedData[]
    graph: INodeDirectedGraph
    nodes: IReactFlowNode[]
    levels?: Record<string, number>
    streamOrder?: readonly string[]
    excludedLoopNodeIds?: ReadonlySet<string>
    currentTurnNodeIds?: ReadonlySet<string>
}

export interface IResolvedTerminalContent {
    content: string
    terminalRecords: IAgentflowExecutedData[]
    terminalNodeIds: string[]
}

export interface IAggregateTerminalMetadataParams {
    agentFlowExecutedData: IAgentflowExecutedData[]
    graph: INodeDirectedGraph
    nodes: IReactFlowNode[]
    levels?: Record<string, number>
    streamOrder?: readonly string[]
    excludedLoopNodeIds?: ReadonlySet<string>
    currentTurnNodeIds?: ReadonlySet<string>
}

interface IBufferedToken {
    chatId: string
    token: string
}

interface IPendingMetadataItem {
    kind: StreamMetadataKind
    chatId: string
    data: any
}

/**
 * Coordinates SSE token and metadata emission across concurrent terminal Agentflow nodes so
 * consecutive streams never interleave on the wire and sections are separated by `\n\n`.
 */
export class StreamCoordinator {
    private readonly baseStreamer: IServerSideEventStreamer
    private activeStreamNodeId: string | null = null
    private activeStreamHasNonEmpty = false
    private readonly pendingStreamQueue: string[] = []
    private readonly pendingStreamSet = new Set<string>()
    private readonly tokenBuffers = new Map<string, IBufferedToken[]>()
    private readonly pendingStarts = new Map<string, { chatId: string; data: any }>()
    private readonly pendingMetadata = new Map<string, IPendingMetadataItem[]>()
    private readonly emittedMetadataByNode = new Map<string, Partial<Record<StreamMetadataKind, any[]>>>()
    private readonly emittedMetadataOrder: string[] = []
    private readonly runningNodes = new Set<string>()
    private readonly streamOrder: string[] = []
    private hasEmittedContent = false
    private hasEmittedStart = false

    constructor(baseStreamer: IServerSideEventStreamer) {
        this.baseStreamer = baseStreamer
    }

    /**
     * Creates a node-scoped `IServerSideEventStreamer` adapter that acquires or buffers tokens
     * under this execution's stream lock.
     */
    createNodeStreamer(nodeId: string): IServerSideEventStreamer {
        this.runningNodes.add(nodeId)

        return {
            streamStartEvent: (chatId: string, data: any) => {
                if (this.hasEmittedStart) return
                if (this.activeStreamNodeId === null || this.activeStreamNodeId === nodeId) {
                    this.hasEmittedStart = true
                    this.baseStreamer.streamStartEvent(chatId, data)
                } else if (!this.pendingStarts.has(nodeId)) {
                    this.pendingStarts.set(nodeId, { chatId, data })
                }
            },
            streamTokenEvent: (chatId: string, data: string) => {
                // Only truly empty strings are ignored; whitespace chunks (e.g. " ") are meaningful LLM tokens.
                if (typeof data !== 'string' || data.length === 0) {
                    return
                }

                if (this.activeStreamNodeId === null || this.activeStreamNodeId === nodeId) {
                    if (this.activeStreamNodeId === null) {
                        this.activeStreamNodeId = nodeId
                        this.activeStreamHasNonEmpty = false
                        const pendingStart = this.pendingStarts.get(nodeId)
                        this.pendingStarts.delete(nodeId)
                        if (pendingStart && !this.hasEmittedStart) {
                            this.hasEmittedStart = true
                            this.baseStreamer.streamStartEvent(pendingStart.chatId, pendingStart.data)
                        }
                    }
                    this.emitTokenDirect(nodeId, chatId, data)
                    return
                }

                if (!this.pendingStreamSet.has(nodeId)) {
                    this.pendingStreamSet.add(nodeId)
                    this.pendingStreamQueue.push(nodeId)
                }
                let buffer = this.tokenBuffers.get(nodeId)
                if (!buffer) {
                    buffer = []
                    this.tokenBuffers.set(nodeId, buffer)
                }
                buffer.push({ chatId, token: data })
            },
            streamSourceDocumentsEvent: (chatId: string, data: any) => {
                this.handleMetadataEvent(nodeId, 'sourceDocuments', chatId, data)
            },
            streamUsedToolsEvent: (chatId: string, data: any) => {
                this.handleMetadataEvent(nodeId, 'usedTools', chatId, data)
            },
            streamArtifactsEvent: (chatId: string, data: any) => {
                this.handleMetadataEvent(nodeId, 'artifacts', chatId, data)
            },
            streamFileAnnotationsEvent: (chatId: string, data: any) => {
                this.handleMetadataEvent(nodeId, 'fileAnnotations', chatId, data)
            },
            streamCustomEvent: (chatId: string, eventType: string, data: any) =>
                this.baseStreamer.streamCustomEvent(chatId, eventType, data),
            streamCalledToolsEvent: (chatId: string, data: any) => this.baseStreamer.streamCalledToolsEvent(chatId, data),
            streamToolEvent: (chatId: string, data: any) => this.baseStreamer.streamToolEvent(chatId, data),
            streamAgentReasoningEvent: (chatId: string, data: any) => this.baseStreamer.streamAgentReasoningEvent(chatId, data),
            streamAgentFlowExecutedDataEvent: (chatId: string, data: any) =>
                this.baseStreamer.streamAgentFlowExecutedDataEvent(chatId, data),
            streamTrustedStateDataEvent: (chatId: string, data: any) => this.baseStreamer.streamTrustedStateDataEvent(chatId, data),
            streamAgentFlowEvent: (chatId: string, data: any) => this.baseStreamer.streamAgentFlowEvent(chatId, data),
            streamNextAgentEvent: (chatId: string, data: any) => this.baseStreamer.streamNextAgentEvent(chatId, data),
            streamNextAgentFlowEvent: (chatId: string, data: any) => this.baseStreamer.streamNextAgentFlowEvent(chatId, data),
            streamActionEvent: (chatId: string, data: any) => this.baseStreamer.streamActionEvent(chatId, data),
            streamAbortEvent: (chatId: string) => this.baseStreamer.streamAbortEvent(chatId),
            streamEndEvent: (chatId: string) => this.baseStreamer.streamEndEvent(chatId),
            streamUsageMetadataEvent: (chatId: string, data: any) => this.baseStreamer.streamUsageMetadataEvent(chatId, data),
            streamTTSStartEvent: (chatId: string, chatMessageId: string, format: string) =>
                this.baseStreamer.streamTTSStartEvent(chatId, chatMessageId, format),
            streamTTSDataEvent: (chatId: string, chatMessageId: string, audioChunk: string) =>
                this.baseStreamer.streamTTSDataEvent(chatId, chatMessageId, audioChunk),
            streamTTSEndEvent: (chatId: string, chatMessageId: string) => this.baseStreamer.streamTTSEndEvent(chatId, chatMessageId)
        }
    }

    /**
     * Releases the stream lock held by `nodeId` (or removes it on failure) and drains queued nodes
     * until either the queue is empty or a still-running node acquires live streaming.
     */
    releaseStream(nodeId: string, options?: { discardBuffered?: boolean }): void {
        const discard = Boolean(options?.discardBuffered)
        this.runningNodes.delete(nodeId)

        if (discard) {
            this.tokenBuffers.delete(nodeId)
            this.pendingStarts.delete(nodeId)
            this.pendingMetadata.delete(nodeId)
            this.emittedMetadataByNode.delete(nodeId)
            const metaOrderIdx = this.emittedMetadataOrder.indexOf(nodeId)
            if (metaOrderIdx !== -1) {
                this.emittedMetadataOrder.splice(metaOrderIdx, 1)
            }
            const streamOrderIdx = this.streamOrder.indexOf(nodeId)
            if (streamOrderIdx !== -1) {
                this.streamOrder.splice(streamOrderIdx, 1)
            }
            if (this.pendingStreamSet.delete(nodeId)) {
                const idx = this.pendingStreamQueue.indexOf(nodeId)
                if (idx !== -1) {
                    this.pendingStreamQueue.splice(idx, 1)
                }
            }
        }

        if (this.activeStreamNodeId !== nodeId) {
            if (!this.pendingStreamSet.has(nodeId)) {
                this.pendingStarts.delete(nodeId)
                this.tokenBuffers.delete(nodeId)
                if (!discard && this.activeStreamNodeId === null) {
                    this.flushNodeMetadata(nodeId)
                }
            }
            return
        }

        if (!discard) {
            this.flushNodeMetadata(nodeId)
        }
        this.pendingStarts.delete(nodeId)
        this.activeStreamNodeId = null
        this.activeStreamHasNonEmpty = false

        while (this.pendingStreamQueue.length > 0) {
            const nextNodeId = this.pendingStreamQueue.shift()!
            this.pendingStreamSet.delete(nextNodeId)
            const buffered = this.tokenBuffers.get(nextNodeId) ?? []
            this.tokenBuffers.delete(nextNodeId)
            const isStillRunning = this.runningNodes.has(nextNodeId)

            if (buffered.length === 0 && !isStillRunning) {
                this.pendingStarts.delete(nextNodeId)
                this.flushNodeMetadata(nextNodeId)
                continue
            }

            this.activeStreamNodeId = nextNodeId
            this.activeStreamHasNonEmpty = false

            const pendingStart = this.pendingStarts.get(nextNodeId)
            this.pendingStarts.delete(nextNodeId)
            if (pendingStart && !this.hasEmittedStart) {
                this.hasEmittedStart = true
                this.baseStreamer.streamStartEvent(pendingStart.chatId, pendingStart.data)
            }

            for (const item of buffered) {
                this.emitTokenDirect(nextNodeId, item.chatId, item.token)
            }

            this.flushNodeMetadata(nextNodeId)

            if (isStillRunning) {
                return
            }

            this.activeStreamNodeId = null
            this.activeStreamHasNonEmpty = false
        }

        this.flushOrphanedCompletedMetadata()
    }

    /**
     * Flushes any remaining buffered streams and metadata at the end of execution.
     */
    flushAll(): void {
        this.runningNodes.clear()
        if (this.activeStreamNodeId !== null) {
            this.releaseStream(this.activeStreamNodeId)
        } else {
            while (this.pendingStreamQueue.length > 0) {
                const nextNodeId = this.pendingStreamQueue.shift()!
                this.pendingStreamSet.delete(nextNodeId)
                const buffered = this.tokenBuffers.get(nextNodeId) ?? []
                this.tokenBuffers.delete(nextNodeId)

                if (buffered.length > 0) {
                    this.activeStreamNodeId = nextNodeId
                    this.activeStreamHasNonEmpty = false
                    const pendingStart = this.pendingStarts.get(nextNodeId)
                    this.pendingStarts.delete(nextNodeId)
                    if (pendingStart && !this.hasEmittedStart) {
                        this.hasEmittedStart = true
                        this.baseStreamer.streamStartEvent(pendingStart.chatId, pendingStart.data)
                    }
                    for (const item of buffered) {
                        this.emitTokenDirect(nextNodeId, item.chatId, item.token)
                    }
                    this.flushNodeMetadata(nextNodeId)
                    this.activeStreamNodeId = null
                    this.activeStreamHasNonEmpty = false
                } else {
                    this.pendingStarts.delete(nextNodeId)
                    this.flushNodeMetadata(nextNodeId)
                }
            }
            this.flushOrphanedCompletedMetadata()
        }

        for (const nodeId of Array.from(this.pendingMetadata.keys())) {
            this.flushNodeMetadata(nodeId)
        }
        this.pendingStarts.clear()
        this.tokenBuffers.clear()
    }

    /** Returns the chronological order of `nodeId`s that emitted non-empty tokens onto the wire. */
    getStreamOrder(): string[] {
        return [...this.streamOrder]
    }

    /** Returns the currently active lock-holding `nodeId`, or `null` if free. */
    getActiveStreamNodeId(): string | null {
        return this.activeStreamNodeId
    }

    /** Returns the current FIFO queue of waiting `nodeId`s. */
    getPendingQueue(): string[] {
        return [...this.pendingStreamQueue]
    }

    /** Returns whether any non-empty token content has been emitted onto the wire. */
    hasEmitted(): boolean {
        return this.hasEmittedContent
    }

    private emitTokenDirect(nodeId: string, chatId: string, token: string): void {
        if (!this.activeStreamHasNonEmpty) {
            if (this.hasEmittedContent) {
                this.baseStreamer.streamTokenEvent(chatId, '\n\n')
            }
            this.activeStreamHasNonEmpty = true
            this.hasEmittedContent = true
            if (!this.streamOrder.includes(nodeId)) {
                this.streamOrder.push(nodeId)
            }
        }
        this.baseStreamer.streamTokenEvent(chatId, token)
    }

    private handleMetadataEvent(nodeId: string, kind: StreamMetadataKind, chatId: string, data: any): void {
        if (this.activeStreamNodeId === null || this.activeStreamNodeId === nodeId) {
            this.flushNodeMetadata(nodeId)
            this.emitMetadataDirect(nodeId, kind, chatId, data)
            return
        }

        let items = this.pendingMetadata.get(nodeId)
        if (!items) {
            items = []
            this.pendingMetadata.set(nodeId, items)
        }
        items.push({ kind, chatId, data })
    }

    private flushNodeMetadata(nodeId: string): void {
        const items = this.pendingMetadata.get(nodeId)
        if (!items || items.length === 0) {
            this.pendingMetadata.delete(nodeId)
            return
        }
        this.pendingMetadata.delete(nodeId)
        for (const item of items) {
            this.emitMetadataDirect(nodeId, item.kind, item.chatId, item.data)
        }
    }

    private flushOrphanedCompletedMetadata(): void {
        if (this.activeStreamNodeId !== null || this.pendingStreamQueue.length > 0) {
            return
        }
        for (const nodeId of Array.from(this.pendingMetadata.keys())) {
            if (!this.runningNodes.has(nodeId)) {
                this.flushNodeMetadata(nodeId)
            }
        }
    }

    private emitMetadataDirect(nodeId: string, kind: StreamMetadataKind, chatId: string, data: any): void {
        if (!Array.isArray(data)) {
            this.forwardMetadataToBase(kind, chatId, data)
            return
        }

        let nodeMeta = this.emittedMetadataByNode.get(nodeId)
        if (!nodeMeta) {
            nodeMeta = {}
            this.emittedMetadataByNode.set(nodeId, nodeMeta)
        }
        nodeMeta[kind] = [...data]
        if (!this.emittedMetadataOrder.includes(nodeId)) {
            this.emittedMetadataOrder.push(nodeId)
        }

        const merged: any[] = []
        for (const orderedNodeId of this.emittedMetadataOrder) {
            const items = this.emittedMetadataByNode.get(orderedNodeId)?.[kind]
            if (items && items.length > 0) {
                merged.push(...items)
            }
        }
        this.forwardMetadataToBase(kind, chatId, merged)
    }

    private forwardMetadataToBase(kind: StreamMetadataKind, chatId: string, data: any): void {
        switch (kind) {
            case 'sourceDocuments':
                this.baseStreamer.streamSourceDocumentsEvent(chatId, data)
                break
            case 'usedTools':
                this.baseStreamer.streamUsedToolsEvent(chatId, data)
                break
            case 'artifacts':
                this.baseStreamer.streamArtifactsEvent(chatId, data)
                break
            case 'fileAnnotations':
                this.baseStreamer.streamFileAnnotationsEvent(chatId, data)
                break
        }
    }
}

export function createStreamCoordinator(baseStreamer: IServerSideEventStreamer): StreamCoordinator {
    return new StreamCoordinator(baseStreamer)
}

function collectExecutedTerminalRecords({
    agentFlowExecutedData,
    graph,
    nodes,
    levels = {},
    streamOrder,
    excludedLoopNodeIds,
    currentTurnNodeIds
}: IAggregateTerminalMetadataParams): IAgentflowExecutedData[] {
    if (!agentFlowExecutedData || agentFlowExecutedData.length === 0) {
        return []
    }

    const nodeById = new Map<string, IReactFlowNode>()
    for (const node of nodes || []) {
        if (node.data?.name !== 'stickyNoteAgentflow') {
            nodeById.set(node.id, node)
        }
    }

    const latestByNodeId = new Map<string, IAgentflowExecutedData>()
    for (const record of agentFlowExecutedData) {
        if (record.data?.parentNodeId) continue
        if (currentTurnNodeIds && !currentTurnNodeIds.has(record.nodeId)) continue
        latestByNodeId.set(record.nodeId, record)
    }

    const candidates: IAgentflowExecutedData[] = []
    for (const [nodeId, record] of latestByNodeId.entries()) {
        const isLeaf = !graph[nodeId] || graph[nodeId].length === 0
        const isFinishedLeaf = record.status === 'FINISHED' && isLeaf && !excludedLoopNodeIds?.has(nodeId)
        const isStoppedTerminal = record.status === 'STOPPED'
        if (isFinishedLeaf || isStoppedTerminal) {
            candidates.push(record)
        }
    }

    const streamIndex = new Map<string, number>()
    if (streamOrder) {
        streamOrder.forEach((nodeId, idx) => {
            if (!streamIndex.has(nodeId)) {
                streamIndex.set(nodeId, idx)
            }
        })
    }

    candidates.sort((a, b) => {
        const idxA = streamIndex.get(a.nodeId)
        const idxB = streamIndex.get(b.nodeId)
        if (idxA !== undefined && idxB !== undefined) {
            return idxA - idxB
        }
        if (idxA !== undefined) return -1
        if (idxB !== undefined) return 1

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

    return candidates
}

/**
 * Resolves final response text across executed terminal leaves (`out-degree === 0` or `STOPPED`),
 * ignoring silent leaves without non-empty string `output.content` and ordering segments by
 * `streamOrder` (when streamed) or `compareNodesDeterministically`.
 */
export function resolveTerminalContent(params: IResolveTerminalContentParams): IResolvedTerminalContent {
    const orderedTerminals = collectExecutedTerminalRecords(params)
    const contentTerminals: IAgentflowExecutedData[] = []
    const segments: string[] = []

    for (const record of orderedTerminals) {
        const output = record.data?.output as ICommonObject | undefined
        const content = output?.content
        if (typeof content === 'string' && content.length > 0) {
            contentTerminals.push(record)
            segments.push(content)
        }
    }

    return {
        content: segments.length > 0 ? segments.join('\n\n') : ' ',
        terminalRecords: contentTerminals,
        terminalNodeIds: contentTerminals.map((record) => record.nodeId)
    }
}

/**
 * Merges `sourceDocuments`, `usedTools`, `artifacts`, and `fileAnnotations` across executed
 * terminal records in deterministic order, keeping unused fields `undefined`.
 */
export function aggregateTerminalMetadata(params: IAggregateTerminalMetadataParams): ITerminalMetadata {
    const orderedTerminals = collectExecutedTerminalRecords(params)
    const sourceDocuments: any[] = []
    const usedTools: any[] = []
    const artifacts: any[] = []
    const fileAnnotations: any[] = []

    for (const record of orderedTerminals) {
        const output = record.data?.output as ICommonObject | undefined
        if (!output) continue

        if (Array.isArray(output.sourceDocuments) && output.sourceDocuments.length > 0) {
            sourceDocuments.push(...output.sourceDocuments)
        }
        if (Array.isArray(output.usedTools) && output.usedTools.length > 0) {
            usedTools.push(...output.usedTools)
        }
        if (Array.isArray(output.artifacts) && output.artifacts.length > 0) {
            artifacts.push(...output.artifacts)
        }
        if (Array.isArray(output.fileAnnotations) && output.fileAnnotations.length > 0) {
            fileAnnotations.push(...output.fileAnnotations)
        }
    }

    return {
        sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : undefined,
        usedTools: usedTools.length > 0 ? usedTools : undefined,
        artifacts: artifacts.length > 0 ? artifacts : undefined,
        fileAnnotations: fileAnnotations.length > 0 ? fileAnnotations : undefined
    }
}
