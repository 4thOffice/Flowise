import { Response } from 'express'
import { SSEStreamer } from '../../../src/utils/SSEStreamer'
import { IAgentflowExecutedData } from '../../../src/Interface'
import { computeTopologicalLevels } from '../../../src/utils/agentflow/dependencyEngine'
import {
    aggregateTerminalMetadata,
    createStreamCoordinator,
    resolveTerminalContent
} from '../../../src/utils/agentflow/terminalCoordinator'
import {
    createBarrier,
    createChatflow,
    createDeferred,
    createEdge,
    createFlow,
    createMockDataSource,
    createMockNodeFactory,
    createMockSSEStreamer,
    createNode,
    loadBaselineFlow,
    loadRealComponentNodes,
    runTestAgentFlow,
    waitUntil
} from './testHelpers'

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => {
        throw new Error('getRunningExpressApp should not be called when appDataSource is injected')
    })
}))

function createRealSSERecorder(chatId: string) {
    const sseStreamer = new SSEStreamer()
    const rawChunks: string[] = []
    const mockRes = {
        write: (chunk: string) => {
            rawChunks.push(chunk)
            return true
        },
        end: (chunk?: string) => {
            if (chunk) rawChunks.push(chunk)
        }
    } as unknown as Response
    sseStreamer.addClient(chatId, mockRes)

    const getEvents = () => {
        const events: Array<{ event: string; data: any }> = []
        for (const frame of rawChunks.join('').split('\n\n')) {
            if (!frame.trim()) continue
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (payload) {
                    events.push(JSON.parse(payload))
                }
            }
        }
        return events
    }

    const getStreamedText = () =>
        getEvents()
            .filter((e) => e.event === 'token')
            .map((e) => e.data)
            .join('')

    return { sseStreamer, getEvents, getStreamedText }
}

describe('Agentflow V2 Task 05: Multiple Terminal Nodes & Stream Coordinator', () => {
    const realComponentNodes = loadRealComponentNodes()
    const originalConcurrencyEnv = process.env.AGENTFLOW_MAX_NODE_CONCURRENCY

    afterEach(() => {
        if (originalConcurrencyEnv === undefined) {
            delete process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
        } else {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = originalConcurrencyEnv
        }
    })

    describe('1. StreamCoordinator unit contract', () => {
        it('serializes interleaved concurrent streams via lock + FIFO queue with \\n\\n separator', () => {
            const { sseStreamer, getEvents } = createMockSSEStreamer()
            const coordinator = createStreamCoordinator(sseStreamer)
            const chatId = 'chat-unit-interleave'

            const streamA = coordinator.createNodeStreamer('nodeA')
            const streamB = coordinator.createNodeStreamer('nodeB')
            const streamC = coordinator.createNodeStreamer('nodeC')

            streamA.streamTokenEvent(chatId, 'A1')
            expect(coordinator.getActiveStreamNodeId()).toBe('nodeA')

            streamB.streamTokenEvent(chatId, 'B1')
            streamC.streamTokenEvent(chatId, 'C1')
            streamA.streamTokenEvent(chatId, 'A2')
            streamB.streamTokenEvent(chatId, 'B2')

            expect(coordinator.getPendingQueue()).toEqual(['nodeB', 'nodeC'])
            expect(getEvents('token').map((e) => e.data)).toEqual(['A1', 'A2'])

            // Node B finishes while still queued behind A; Node C remains in-flight
            coordinator.releaseStream('nodeB')
            expect(getEvents('token').map((e) => e.data)).toEqual(['A1', 'A2'])

            // Node A finishes: flushes B completely (with \n\n), then hands live lock to running C (with \n\n)
            coordinator.releaseStream('nodeA')
            expect(coordinator.getActiveStreamNodeId()).toBe('nodeC')
            expect(getEvents('token').map((e) => e.data)).toEqual(['A1', 'A2', '\n\n', 'B1', 'B2', '\n\n', 'C1'])

            // Node C emits its remaining live token directly, then releases
            streamC.streamTokenEvent(chatId, 'C2')
            coordinator.releaseStream('nodeC')

            expect(coordinator.getActiveStreamNodeId()).toBeNull()
            expect(coordinator.getStreamOrder()).toEqual(['nodeA', 'nodeB', 'nodeC'])
            expect(
                getEvents('token')
                    .map((e) => e.data)
                    .join('')
            ).toBe('A1A2\n\nB1B2\n\nC1C2')
        })

        it('ignores empty string tokens without acquiring lock or emitting stray \\n\\n while preserving whitespace tokens', () => {
            const { sseStreamer, getEvents } = createMockSSEStreamer()
            const coordinator = createStreamCoordinator(sseStreamer)
            const chatId = 'chat-unit-empty'

            const sEmptyFirst = coordinator.createNodeStreamer('emptyFirst')
            const sA = coordinator.createNodeStreamer('nodeA')
            const sEmptySecond = coordinator.createNodeStreamer('emptySecond')
            const sB = coordinator.createNodeStreamer('nodeB')

            // Leading empty tokens must not acquire lock or trigger separator
            sEmptyFirst.streamTokenEvent(chatId, '')
            expect(coordinator.getActiveStreamNodeId()).toBeNull()
            expect(coordinator.hasEmitted()).toBe(false)

            sA.streamTokenEvent(chatId, 'Hello')
            sA.streamTokenEvent(chatId, ' ')
            sA.streamTokenEvent(chatId, 'world')
            sEmptySecond.streamTokenEvent(chatId, '')
            sEmptySecond.streamTokenEvent(chatId, '')
            sB.streamTokenEvent(chatId, 'Next')

            coordinator.releaseStream('emptyFirst')
            coordinator.releaseStream('emptySecond')
            coordinator.releaseStream('nodeA')
            coordinator.releaseStream('nodeB')

            expect(coordinator.getStreamOrder()).toEqual(['nodeA', 'nodeB'])
            expect(
                getEvents('token')
                    .map((e) => e.data)
                    .join('')
            ).toBe('Hello world\n\nNext')
            expect(getEvents('token').filter((e) => e.data === '\n\n')).toHaveLength(1)
        })

        it('emits streamStartEvent at most once across contending streamers and releases locks cleanly on error', () => {
            const { sseStreamer, getEvents } = createMockSSEStreamer()
            const coordinator = createStreamCoordinator(sseStreamer)
            const chatId = 'chat-unit-err'

            const sA = coordinator.createNodeStreamer('nodeA')
            const sB = coordinator.createNodeStreamer('nodeB')
            const sC = coordinator.createNodeStreamer('nodeC')

            sA.streamStartEvent(chatId, 'start-A')
            sB.streamStartEvent(chatId, 'start-B')
            sA.streamTokenEvent(chatId, 'partialA')
            sB.streamTokenEvent(chatId, 'bufferedFailB')
            sC.streamTokenEvent(chatId, 'goodC')

            // Queued node B fails -> buffered tokens discarded and dequeued
            coordinator.releaseStream('nodeB', { discardBuffered: true })
            // Active node A fails -> lock released cleanly so node C flushes with separator
            coordinator.releaseStream('nodeA', { discardBuffered: true })
            coordinator.releaseStream('nodeC')

            expect(getEvents('start')).toHaveLength(1)
            expect(getEvents('start')[0].data).toBe('start-A')
            expect(coordinator.getActiveStreamNodeId()).toBeNull()
            expect(coordinator.getStreamOrder()).toEqual(['nodeC'])
            expect(
                getEvents('token')
                    .map((e) => e.data)
                    .join('')
            ).toBe('partialA\n\ngoodC')

            // Stale epoch discard also clears prior emitted metadata and streamOrder before re-execution
            const staleSse = createMockSSEStreamer()
            const staleCoord = createStreamCoordinator(staleSse.sseStreamer)
            const staleA = staleCoord.createNodeStreamer('nodeA')
            const freshB = staleCoord.createNodeStreamer('nodeB')
            staleA.streamTokenEvent(chatId, 'staleA')
            staleA.streamUsedToolsEvent(chatId, [{ tool: 'staleTool' }])
            staleCoord.releaseStream('nodeA', { discardBuffered: true })
            expect(staleCoord.getStreamOrder()).toEqual([])

            freshB.streamTokenEvent(chatId, 'freshB')
            freshB.streamUsedToolsEvent(chatId, [{ tool: 'freshToolB' }])
            staleCoord.releaseStream('nodeB')

            const rerunA = staleCoord.createNodeStreamer('nodeA')
            rerunA.streamTokenEvent(chatId, 'freshA')
            rerunA.streamUsedToolsEvent(chatId, [{ tool: 'freshToolA' }])
            staleCoord.releaseStream('nodeA')

            expect(staleCoord.getStreamOrder()).toEqual(['nodeB', 'nodeA'])
            expect(staleSse.getEvents('usedTools').pop()?.data).toEqual([{ tool: 'freshToolB' }, { tool: 'freshToolA' }])
        })

        it('merges cumulative metadata SSE events across concurrent nodes without duplicates or clobbering', () => {
            const { sseStreamer, getEvents } = createMockSSEStreamer()
            const coordinator = createStreamCoordinator(sseStreamer)
            const chatId = 'chat-unit-meta'

            const sA = coordinator.createNodeStreamer('nodeA')
            const sB = coordinator.createNodeStreamer('nodeB')

            sA.streamTokenEvent(chatId, 'A')
            sA.streamUsedToolsEvent(chatId, [{ tool: 't1' }])
            // Repeated update from same node replaces its own list rather than duplicating t1
            sA.streamUsedToolsEvent(chatId, [{ tool: 't1' }, { tool: 't2' }])
            sA.streamSourceDocumentsEvent(chatId, [{ pageContent: 'docA' }])

            sB.streamTokenEvent(chatId, 'B')
            sB.streamUsedToolsEvent(chatId, [{ tool: 't3' }])
            sB.streamSourceDocumentsEvent(chatId, [{ pageContent: 'docB' }])
            sB.streamArtifactsEvent(chatId, [{ type: 'png', data: 'a.png' }])
            sB.streamFileAnnotationsEvent(chatId, [{ fileName: 'out.txt' }])

            coordinator.releaseStream('nodeA')
            coordinator.releaseStream('nodeB')
            coordinator.flushAll()

            const usedToolsEvents = getEvents('usedTools')
            expect(usedToolsEvents[usedToolsEvents.length - 1].data).toEqual([{ tool: 't1' }, { tool: 't2' }, { tool: 't3' }])
            const docEvents = getEvents('sourceDocuments')
            expect(docEvents[docEvents.length - 1].data).toEqual([{ pageContent: 'docA' }, { pageContent: 'docB' }])
            expect(getEvents('artifacts')[0].data).toEqual([{ type: 'png', data: 'a.png' }])
            expect(getEvents('fileAnnotations')[0].data).toEqual([{ fileName: 'out.txt' }])
        })
    })

    describe('2. resolveTerminalContent & aggregateTerminalMetadata unit contract', () => {
        it('orders by streamOrder when streamed, falls back to deterministic canvas order, and ignores silent/excluded/child records', () => {
            const nodes = [
                createNode('start_0', 'startAgentflow', { position: { x: 0, y: 100 } }),
                createNode('leafTop', 'directReplyAgentflow', { position: { x: 300, y: 10 } }),
                createNode('leafBottom', 'directReplyAgentflow', { position: { x: 300, y: 200 } }),
                createNode('silentLeaf', 'customFunctionAgentflow', { position: { x: 300, y: 300 } }),
                createNode('loop_0', 'loopAgentflow', { position: { x: 300, y: 400 } }),
                createNode('child_0', 'directReplyAgentflow', { parentNode: 'leafBottom', extent: 'parent' })
            ]
            const graph = {
                start_0: ['leafTop', 'leafBottom', 'silentLeaf', 'loop_0'],
                leafTop: [],
                leafBottom: [],
                silentLeaf: [],
                loop_0: []
            }
            const levels = computeTopologicalLevels(nodes, [
                createEdge('start_0', 'leafTop'),
                createEdge('start_0', 'leafBottom'),
                createEdge('start_0', 'silentLeaf'),
                createEdge('start_0', 'loop_0')
            ])

            const executedData: IAgentflowExecutedData[] = [
                { nodeId: 'start_0', nodeLabel: 'Start', previousNodeIds: [], status: 'FINISHED', data: { output: { question: 'q' } } },
                {
                    nodeId: 'child_0',
                    nodeLabel: 'Child',
                    previousNodeIds: [],
                    status: 'FINISHED',
                    data: { parentNodeId: 'leafBottom', output: { content: 'child-skip' } }
                },
                {
                    nodeId: 'leafBottom',
                    nodeLabel: 'Bottom',
                    previousNodeIds: ['start_0'],
                    status: 'FINISHED',
                    data: {
                        output: {
                            content: 'Bottom text',
                            sourceDocuments: [{ id: 'docB' }],
                            usedTools: [{ tool: 'toolB' }]
                        }
                    }
                },
                {
                    nodeId: 'leafTop',
                    nodeLabel: 'Top',
                    previousNodeIds: ['start_0'],
                    status: 'FINISHED',
                    data: {
                        output: {
                            content: 'Top text',
                            sourceDocuments: [{ id: 'docT' }],
                            artifacts: [{ type: 'txt', data: 'aT' }]
                        }
                    }
                },
                {
                    nodeId: 'loop_0',
                    nodeLabel: 'Loop',
                    previousNodeIds: ['start_0'],
                    status: 'FINISHED',
                    data: { output: { content: 'Loop back to start_0', nodeID: 'start_0' } }
                },
                {
                    nodeId: 'silentLeaf',
                    nodeLabel: 'Silent',
                    previousNodeIds: ['start_0'],
                    status: 'FINISHED',
                    data: { output: { content: '' } }
                }
            ]

            // Streaming run: bottom acquired stream before top
            const streamed = resolveTerminalContent({
                agentFlowExecutedData: executedData,
                graph,
                nodes,
                levels,
                streamOrder: ['leafBottom', 'leafTop'],
                excludedLoopNodeIds: new Set(['loop_0'])
            })
            expect(streamed.content).toBe('Bottom text\n\nTop text')
            expect(streamed.terminalNodeIds).toEqual(['leafBottom', 'leafTop'])

            // Non-streaming run: deterministic canvas order (top y=10 before bottom y=200)
            const nonStreamed = resolveTerminalContent({
                agentFlowExecutedData: executedData,
                graph,
                nodes,
                levels,
                excludedLoopNodeIds: new Set(['loop_0'])
            })
            expect(nonStreamed.content).toBe('Top text\n\nBottom text')
            expect(nonStreamed.terminalNodeIds).toEqual(['leafTop', 'leafBottom'])

            const meta = aggregateTerminalMetadata({
                agentFlowExecutedData: executedData,
                graph,
                nodes,
                levels,
                excludedLoopNodeIds: new Set(['loop_0'])
            })
            expect(meta).toEqual({
                sourceDocuments: [{ id: 'docT' }, { id: 'docB' }],
                usedTools: [{ tool: 'toolB' }],
                artifacts: [{ type: 'txt', data: 'aT' }],
                fileAnnotations: undefined
            })

            // Only silent leaves -> falls back to ' '
            const silentOnly = resolveTerminalContent({
                agentFlowExecutedData: [
                    {
                        nodeId: 'silentLeaf',
                        nodeLabel: 'Silent',
                        previousNodeIds: ['start_0'],
                        status: 'FINISHED',
                        data: { output: { content: '' } }
                    }
                ],
                graph,
                nodes,
                levels
            })
            expect(silentOnly.content).toBe(' ')
        })
    })

    describe('3. End-to-end execution integration (Task 05 verification matrix)', () => {
        it('reproduces baseline Flow 04 (fast DirectReply + slow DirectReply + slow silent leaf) in streaming and non-streaming modes', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow04 = loadBaselineFlow('04-multi-terminal-streaming-and-silent-leaf.json')
            const chatflow = createChatflow(flow04)

            // Non-streaming run
            const nonStreamDs = createMockDataSource()
            const nonStreamRes = await runTestAgentFlow({
                chatflow,
                incomingInput: { question: 'lookup data' },
                appDataSource: nonStreamDs.appDataSource,
                componentNodes: realComponentNodes
            })
            expect(nonStreamRes.text).toBe("I'm looking up the data...\n\nHere is the result.")
            expect(nonStreamDs.chatMessages.find((m) => m.role === 'apiMessage')?.content).toBe(
                "I'm looking up the data...\n\nHere is the result."
            )

            // Streaming run via real SSEStreamer
            const streamDs = createMockDataSource()
            const chatId = 'chat-flow04-sse'
            const recorder = createRealSSERecorder(chatId)
            const streamRes = await runTestAgentFlow({
                chatflow,
                incomingInput: { question: 'lookup data', streaming: true },
                appDataSource: streamDs.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId
            })
            recorder.sseStreamer.removeClient(chatId)

            const events = recorder.getEvents()
            const tokenChunks = events.filter((e) => e.event === 'token').map((e) => e.data)
            expect(tokenChunks).toEqual(["I'm looking up the data...", '\n\n', 'Here is the result.'])
            expect(recorder.getStreamedText()).toBe("I'm looking up the data...\n\nHere is the result.")
            expect(streamRes.text).toBe("I'm looking up the data...\n\nHere is the result.")
            expect(streamDs.chatMessages.find((m) => m.role === 'apiMessage')?.content).toBe(streamRes.text)

            // Fast Ack token emits BEFORE Lookup Worker (300ms) finishes
            const fastTokenIdx = events.findIndex((e) => e.event === 'token' && e.data === "I'm looking up the data...")
            const slowWorkerDoneIdx = events.findIndex(
                (e) => e.event === 'nextAgentFlow' && e.data?.nodeId === 'customFunctionAgentflow_0' && e.data?.status === 'FINISHED'
            )
            expect(fastTokenIdx).toBeGreaterThan(-1)
            expect(slowWorkerDoneIdx).toBeGreaterThan(fastTokenIdx)
        })

        it('serializes interleaved multi-chunk LLM leaves so wire text matches saved apiMessage.content verbatim', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('llmA', 'llmAgentflow', { position: { x: 200, y: 200 } }),
                    createNode('llmB', 'llmAgentflow', { position: { x: 200, y: 50 } })
                ],
                [createEdge('start_0', 'llmA'), createEdge('start_0', 'llmB')]
            )

            const a1Emitted = createDeferred<void>()
            const b1Emitted = createDeferred<void>()
            const a2Emitted = createDeferred<void>()

            const { appDataSource, chatMessages } = createMockDataSource()
            const chatId = 'chat-interleaved-llms'
            const recorder = createRealSSERecorder(chatId)

            const factory = createMockNodeFactory({
                llmA: async (nd, _inp, opts) => {
                    opts.sseStreamer.streamTokenEvent(opts.chatId, 'A1')
                    a1Emitted.resolve()
                    await b1Emitted.promise
                    opts.sseStreamer.streamTokenEvent(opts.chatId, 'A2')
                    a2Emitted.resolve()
                    return { id: nd.id, name: nd.name, output: { content: 'A1A2' }, state: {} }
                },
                llmB: async (nd, _inp, opts) => {
                    await a1Emitted.promise
                    opts.sseStreamer.streamTokenEvent(opts.chatId, 'B1')
                    b1Emitted.resolve()
                    await a2Emitted.promise
                    opts.sseStreamer.streamTokenEvent(opts.chatId, 'B2')
                    return { id: nd.id, name: nd.name, output: { content: 'B1B2' }, state: {} }
                }
            })

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'stream both' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: factory
            })
            recorder.sseStreamer.removeClient(chatId)

            expect(recorder.getStreamedText()).toBe('A1A2\n\nB1B2')
            expect(res.text).toBe('A1A2\n\nB1B2')
            expect(chatMessages.find((m) => m.role === 'apiMessage')?.content).toBe('A1A2\n\nB1B2')
        })

        it('does not emit stray \\n\\n when an overlapping concurrent node emits only empty string tokens', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('emptyNode', 'mockSilent', { position: { x: 200, y: 0 } }),
                    createNode('replyNode', 'mockReply', { position: { x: 200, y: 100 } }),
                    createNode('lateSilent', 'mockSilent', { position: { x: 200, y: 200 } })
                ],
                [createEdge('start_0', 'emptyNode'), createEdge('start_0', 'replyNode'), createEdge('start_0', 'lateSilent')]
            )

            const barrier = createBarrier(2, 1000)
            const delayedSilent = createDeferred<void>()
            const { appDataSource } = createMockDataSource()
            const chatId = 'chat-empty-tok'
            const recorder = createRealSSERecorder(chatId)

            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'empty' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: createMockNodeFactory({
                    emptyNode: async (nd, _inp, opts) => {
                        await barrier.arrive()
                        opts.sseStreamer.streamTokenEvent(opts.chatId, '')
                        return { id: nd.id, name: nd.name, output: { content: '' }, state: {} }
                    },
                    replyNode: async (nd, _inp, opts) => {
                        await barrier.arrive()
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'Real answer')
                        return { id: nd.id, name: nd.name, output: { content: 'Real answer' }, state: {} }
                    },
                    lateSilent: async (nd, _inp, opts) => {
                        await delayedSilent.promise
                        opts.sseStreamer.streamTokenEvent(opts.chatId, '')
                        return { id: nd.id, name: nd.name, output: {}, state: {} }
                    }
                })
            })

            await waitUntil(() => recorder.getStreamedText() === 'Real answer')
            delayedSilent.resolve()

            const res = await runPromise
            recorder.sseStreamer.removeClient(chatId)
            expect(recorder.getStreamedText()).toBe('Real answer')
            expect(res.text).toBe('Real answer')
            expect(recorder.getEvents().filter((e) => e.event === 'token' && e.data === '\n\n')).toHaveLength(0)
        })

        it('orders non-streaming terminal leaves deterministically by (executionOrder ?? position.y, level, nodeId) regardless of finish order', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const orderedSecondNode = createNode('leafFastTop', 'directReplyAgentflow', {
                position: { x: 200, y: 10 },
                inputs: { directReplyMessage: 'Second by order' }
            })
            ;(orderedSecondNode.data as any).executionOrder = 2

            const orderedFirstNode = createNode('leafSlowBottom', 'directReplyAgentflow', {
                position: { x: 200, y: 500 },
                inputs: { directReplyMessage: 'First by order' }
            })
            ;(orderedFirstNode.data as any).executionOrder = 1

            const deeperNode = createNode('leafDeeper', 'directReplyAgentflow', {
                position: { x: 400, y: 500 },
                inputs: { directReplyMessage: 'Third by level' }
            })
            const stepMid = createNode('stepMid', 'mockMid', { position: { x: 200, y: 500 } })

            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    orderedSecondNode,
                    orderedFirstNode,
                    stepMid,
                    deeperNode
                ],
                [
                    createEdge('start_0', 'leafFastTop'),
                    createEdge('start_0', 'leafSlowBottom'),
                    createEdge('start_0', 'stepMid'),
                    createEdge('stepMid', 'leafDeeper')
                ]
            )

            const fastDone = createDeferred<void>()
            const { appDataSource } = createMockDataSource()

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'non-streaming-order' },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    leafFastTop: async (nd) => {
                        fastDone.resolve()
                        return { id: nd.id, name: nd.name, output: { content: 'Second by order' }, state: {} }
                    },
                    leafSlowBottom: async (nd) => {
                        await fastDone.promise
                        await new Promise((r) => setTimeout(r, 20))
                        return { id: nd.id, name: nd.name, output: { content: 'First by order' }, state: {} }
                    },
                    stepMid: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'intermediate' }, state: {} }),
                    leafDeeper: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'Third by level' }, state: {} })
                })
            })

            expect(res.text).toBe('First by order\n\nSecond by order\n\nThird by level')
        })

        it('aggregates sourceDocuments, usedTools, artifacts, and fileAnnotations across multiple terminal nodes into SSE and DB', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('fastMeta', 'mockMeta', { position: { x: 200, y: 0 } }),
                    createNode('slowMeta', 'mockMeta', { position: { x: 200, y: 200 } })
                ],
                [createEdge('start_0', 'fastMeta'), createEdge('start_0', 'slowMeta')]
            )

            const fastDone = createDeferred<void>()
            const { appDataSource, chatMessages } = createMockDataSource()
            const chatId = 'chat-meta-agg'
            const recorder = createRealSSERecorder(chatId)

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'meta' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: createMockNodeFactory({
                    fastMeta: async (nd, _inp, opts) => {
                        const docs = [{ pageContent: 'doc-fast' }]
                        const tools = [{ tool: 'search' }]
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'Fast')
                        opts.sseStreamer.streamSourceDocumentsEvent(opts.chatId, docs)
                        opts.sseStreamer.streamUsedToolsEvent(opts.chatId, tools)
                        fastDone.resolve()
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: {
                                content: 'Fast',
                                sourceDocuments: docs,
                                usedTools: tools
                            },
                            state: {}
                        }
                    },
                    slowMeta: async (nd, _inp, opts) => {
                        await fastDone.promise
                        await new Promise((r) => setTimeout(r, 15))
                        const docs = [{ pageContent: 'doc-slow' }]
                        const tools = [{ tool: 'calc' }]
                        const artifacts = [{ type: 'png', data: 'chart.png' }]
                        const annotations = [{ fileName: 'report.pdf' }]
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'Slow')
                        opts.sseStreamer.streamSourceDocumentsEvent(opts.chatId, docs)
                        opts.sseStreamer.streamUsedToolsEvent(opts.chatId, tools)
                        opts.sseStreamer.streamArtifactsEvent(opts.chatId, artifacts)
                        opts.sseStreamer.streamFileAnnotationsEvent(opts.chatId, annotations)
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: {
                                content: 'Slow',
                                sourceDocuments: docs,
                                usedTools: tools,
                                artifacts,
                                fileAnnotations: annotations
                            },
                            state: {}
                        }
                    }
                })
            })
            recorder.sseStreamer.removeClient(chatId)

            expect(res.text).toBe('Fast\n\nSlow')
            const apiMsg = chatMessages.find((m) => m.role === 'apiMessage')
            expect(JSON.parse(apiMsg.sourceDocuments)).toEqual([{ pageContent: 'doc-fast' }, { pageContent: 'doc-slow' }])
            expect(JSON.parse(apiMsg.usedTools)).toEqual([{ tool: 'search' }, { tool: 'calc' }])
            expect(JSON.parse(apiMsg.artifacts)).toEqual([{ type: 'png', data: 'chart.png' }])
            expect(JSON.parse(apiMsg.fileAnnotations)).toEqual([{ fileName: 'report.pdf' }])

            const events = recorder.getEvents()
            const lastDocs = events.filter((e) => e.event === 'sourceDocuments').pop()
            const lastTools = events.filter((e) => e.event === 'usedTools').pop()
            expect(lastDocs?.data).toEqual([{ pageContent: 'doc-fast' }, { pageContent: 'doc-slow' }])
            expect(lastTools?.data).toEqual([{ tool: 'search' }, { tool: 'calc' }])
        })

        it('never leaks tokens from recursive iterationAgentflow subflows (including loop fallback and direct sseStreamer calls)', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('iter_0', 'iterationAgentflow', { inputs: { iterationInput: '["one","two"]' } }, realComponentNodes),
                    createNode(
                        'subStart',
                        'startAgentflow',
                        { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                        realComponentNodes
                    ),
                    createNode(
                        'subReply',
                        'directReplyAgentflow',
                        {
                            parentNode: 'iter_0',
                            extent: 'parent',
                            position: { x: 100, y: 10 },
                            inputs: { directReplyMessage: 'item:{{ $iteration }}' }
                        },
                        realComponentNodes
                    ),
                    createNode('subBody', 'mockSubBody', { parentNode: 'iter_0', extent: 'parent', position: { x: 100, y: 50 } }),
                    createNode(
                        'subLoop',
                        'loopAgentflow',
                        {
                            parentNode: 'iter_0',
                            extent: 'parent',
                            position: { x: 200, y: 50 },
                            inputs: { loopBackToNode: 'subBody-Body', maxLoopCount: 1, fallbackMessage: 'loop-done' }
                        },
                        realComponentNodes
                    ),
                    createNode(
                        'afterIter',
                        'directReplyAgentflow',
                        { inputs: { directReplyMessage: 'Parent done: {{iter_0}}' } },
                        realComponentNodes
                    )
                ],
                [
                    createEdge('start_0', 'iter_0'),
                    createEdge('iter_0', 'afterIter'),
                    createEdge('subStart', 'subReply'),
                    createEdge('subStart', 'subBody'),
                    createEdge('subBody', 'subLoop')
                ]
            )

            let subSeenStreamer = false
            const { appDataSource } = createMockDataSource()
            const chatId = 'chat-recursive-no-leak'
            const recorder = createRealSSERecorder(chatId)

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'iter' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: createMockNodeFactory({
                    subBody: async (nd, _inp, opts) => {
                        if (opts.sseStreamer) {
                            subSeenStreamer = true
                            opts.sseStreamer.streamTokenEvent(opts.chatId, 'LEAK')
                        }
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: `body:${opts.iterationContext?.value}` },
                            state: opts.agentflowRuntime?.state || {}
                        }
                    }
                })
            })
            recorder.sseStreamer.removeClient(chatId)

            expect(subSeenStreamer).toBe(false)
            expect(recorder.getStreamedText()).toBe('Parent done: item:one\n\nloop-done\nitem:two\n\nloop-done')
            expect(res.text).toBe('Parent done: item:one\n\nloop-done\nitem:two\n\nloop-done')
        })

        it('releases stream lock cleanly when active holder throws so buffered sibling stream flushes before rejection', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('failHolder', 'llmAgentflow', { position: { x: 200, y: 0 } }),
                    createNode('siblingReply', 'llmAgentflow', { position: { x: 200, y: 200 } })
                ],
                [createEdge('start_0', 'failHolder'), createEdge('start_0', 'siblingReply')]
            )

            const holderStarted = createDeferred<void>()
            const siblingBuffered = createDeferred<void>()
            const siblingCanFinish = createDeferred<void>()
            const { appDataSource } = createMockDataSource()
            const chatId = 'chat-stream-error-release'
            const recorder = createRealSSERecorder(chatId)

            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'err-stream' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: createMockNodeFactory({
                    failHolder: async (_nd, _inp, opts) => {
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'partial-')
                        holderStarted.resolve()
                        await siblingBuffered.promise
                        throw new Error('stream-holder-crashed')
                    },
                    siblingReply: async (nd, _inp, opts) => {
                        await holderStarted.promise
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'sibling-1 ')
                        siblingBuffered.resolve()
                        await siblingCanFinish.promise
                        opts.sseStreamer.streamTokenEvent(opts.chatId, 'sibling-2')
                        return { id: nd.id, name: nd.name, output: { content: 'sibling-1 sibling-2' }, state: {} }
                    }
                })
            })

            await waitUntil(() => recorder.getStreamedText().includes('sibling-1 '))
            siblingCanFinish.resolve()

            await expect(runPromise).rejects.toThrow(/stream-holder-crashed/)
            recorder.sseStreamer.removeClient(chatId)
            expect(recorder.getStreamedText()).toBe('partial-\n\nsibling-1 sibling-2')
        })
    })
})
