import {
    combineNodeInputs,
    determineNodesToIgnore,
    findConditionParent,
    getNodeInputConnections,
    hasReceivedRequiredInputs,
    processNodeOutputs,
    setupNodeDependencies
} from '../../../src/utils/agentflow/schedulerHelpers'
import { INodeQueue, IWaitingNode } from '../../../src/utils/agentflow/types'
import {
    ConcurrencyTracker,
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

describe('Agentflow V2 Task 01: schedulerHelpers unit seam', () => {
    it('sorts input connections by numeric sourceHandle index and setups conditional vs required dependencies', () => {
        const nodes = [
            createNode('start_0', 'startAgentflow'),
            createNode('cond_0', 'conditionAgentflow'),
            createNode('branchT', 'customFunctionAgentflow'),
            createNode('branchF', 'customFunctionAgentflow'),
            createNode('parallel_0', 'customFunctionAgentflow'),
            createNode('join_0', 'directReplyAgentflow')
        ]
        const edges = [
            createEdge('start_0', 'cond_0'),
            createEdge('start_0', 'parallel_0'),
            createEdge('cond_0', 'branchF', 'cond_0-output-1'),
            createEdge('cond_0', 'branchT', 'cond_0-output-0'),
            createEdge('branchF', 'join_0', 'branchF-output-1'),
            createEdge('branchT', 'join_0', 'branchT-output-0'),
            createEdge('parallel_0', 'join_0', 'parallel_0-output-0')
        ]

        const conns = getNodeInputConnections(edges, 'join_0')
        expect(conns.map((c) => c.source)).toEqual(['branchT', 'parallel_0', 'branchF'])

        expect(findConditionParent('branchT', edges, nodes)).toBe('cond_0')
        expect(findConditionParent('parallel_0', edges, nodes)).toBeNull()

        const waiting = setupNodeDependencies('join_0', edges, nodes)
        expect(waiting.isConditional).toBe(true)
        expect(Array.from(waiting.expectedInputs)).toEqual(['parallel_0'])
        expect(waiting.conditionalGroups.get('cond_0')).toEqual(['branchT', 'branchF'])

        expect(hasReceivedRequiredInputs(waiting)).toBe(false)
        waiting.receivedInputs.set('parallel_0', { text: 'p' })
        expect(hasReceivedRequiredInputs(waiting)).toBe(false)
        waiting.receivedInputs.set('branchT', { text: 't' })
        expect(hasReceivedRequiredInputs(waiting)).toBe(true)
    })

    it('identifies unfulfilled condition handles and enqueues ready children in processNodeOutputs', async () => {
        const nodes = [
            createNode('cond_0', 'conditionAgentflow'),
            createNode('yes_0', 'directReplyAgentflow'),
            createNode('no_0', 'directReplyAgentflow')
        ]
        const edges = [
            createEdge('cond_0', 'yes_0', 'cond_0-output-0'),
            createEdge('cond_0', 'no_0', 'cond_0-output-1')
        ]
        const result = {
            output: {
                conditions: [{ isFulfilled: true }, { isFulfilled: false }]
            }
        }

        const ignored = await determineNodesToIgnore(nodes[0], result, edges, 'cond_0')
        expect(ignored).toEqual(['no_0'])

        const queue: INodeQueue[] = []
        const waitingNodes = new Map<string, IWaitingNode>()
        const loopCounts = new Map<string, number>()

        await processNodeOutputs({
            nodeId: 'cond_0',
            nodeName: 'conditionAgentflow',
            result,
            graph: { cond_0: ['yes_0', 'no_0'], yes_0: [], no_0: [] },
            nodes,
            edges,
            nodeExecutionQueue: queue,
            waitingNodes,
            loopCounts,
            chatId: 'chat-1'
        })

        expect(queue.map((q) => q.nodeId)).toEqual(['yes_0'])
        expect(waitingNodes.size).toBe(0)
    })

    it('combines multiple received inputs deterministically by sorted source nodeId', () => {
        const inputs = new Map<string, any>([
            ['nodeB', { json: { b: 2 }, text: 'second' }],
            ['nodeA', { json: { a: 1 }, text: 'first' }]
        ])

        expect(combineNodeInputs(inputs)).toEqual({
            json: {
                nodeA: { a: 1 },
                nodeB: { b: 2 }
            },
            text: 'first\nsecond'
        })
        expect(combineNodeInputs(new Map())).toBeNull()
        expect(combineNodeInputs(new Map([['a', null], ['b', undefined]]))).toBeNull()
        expect(combineNodeInputs(new Map([['only', { text: 'solo' }]]))).toEqual({ text: 'solo' })
        expect(
            combineNodeInputs(
                new Map<string, any>([
                    ['b', { text: 'txtB', binary: { buf: 2 } }],
                    ['a', { text: 'txtA', error: new Error('e1') }]
                ])
            )
        ).toEqual({
            json: { text: 'txtA\ntxtB' },
            text: 'txtA\ntxtB',
            binary: { b: { buf: 2 } },
            error: new Error('e1')
        })
        expect(combineNodeInputs(new Map<string, any>([['n1', 'p1'], ['n2', 42]]))).toEqual({
            json: { n1: 'p1', n2: 42 }
        })
    })

    it('handles humanInputAgentflow/conditionAgentAgentflow/missing isFulfilled and loopAgentflow fallback in schedulerHelpers', async () => {
        const nodes = [
            createNode('human_0', 'humanInputAgentflow'),
            createNode('condAgent_0', 'conditionAgentAgentflow'),
            createNode('branchA', 'customFunctionAgentflow'),
            createNode('branchB', 'customFunctionAgentflow'),
            createNode('loop_0', 'loopAgentflow')
        ]
        const edges = [
            createEdge('human_0', 'branchA', 'human_0-output-0'),
            createEdge('human_0', 'branchB', 'human_0-output-1'),
            createEdge('condAgent_0', 'branchA', 'condAgent_0-output-0'),
            createEdge('condAgent_0', 'branchB', 'condAgent_0-output-1')
        ]

        expect(
            await determineNodesToIgnore(
                nodes[0],
                { output: { conditions: [{ isFulfilled: true }, {}] } },
                edges,
                'human_0'
            )
        ).toEqual(['branchB'])
        expect(
            await determineNodesToIgnore(
                nodes[1],
                { output: { conditions: [{ isFulfilled: false }, { isFulfilled: true }] } },
                edges,
                'condAgent_0'
            )
        ).toEqual(['branchA'])

        const queue: INodeQueue[] = []
        const waitingNodes = new Map<string, IWaitingNode>()
        const loopCounts = new Map<string, number>()
        const { sseStreamer, getEvents } = createMockSSEStreamer()

        const loopResult: any = { output: { nodeID: 'branchA', maxLoopCount: 2, fallbackMessage: 'hit max' } }
        await processNodeOutputs({
            nodeId: 'loop_0',
            nodeName: 'loopAgentflow',
            result: loopResult,
            graph: { loop_0: [] },
            nodes,
            edges,
            nodeExecutionQueue: queue,
            waitingNodes,
            loopCounts,
            sseStreamer,
            chatId: 'chat-loop-unit'
        })
        expect(loopCounts.get('loop_0')).toBe(1)
        expect(queue.map((q) => q.nodeId)).toEqual(['branchA'])

        await processNodeOutputs({
            nodeId: 'loop_0',
            nodeName: 'loopAgentflow',
            result: loopResult,
            graph: { loop_0: [] },
            nodes,
            edges,
            nodeExecutionQueue: queue,
            waitingNodes,
            loopCounts,
            sseStreamer,
            chatId: 'chat-loop-unit'
        })
        expect(loopResult.output.content).toBe('hit max')
        expect(getEvents('token').map((e) => e.data)).toEqual(['hit max'])
    })

    it('supports createDeferred, createBarrier timeout/release, and ConcurrencyTracker lifecycle', async () => {
        const d = createDeferred<string>()
        expect(d.isSettled()).toBe(false)
        d.resolve('ok')
        expect(d.isSettled()).toBe(true)
        await expect(d.promise).resolves.toBe('ok')

        const barrier = createBarrier(2)
        const p1 = barrier.arrive()
        expect(barrier.arrivedCount()).toBe(1)
        const p2 = barrier.arrive()
        await Promise.all([p1, p2])

        const timedBarrier = createBarrier(2, 15)
        await expect(timedBarrier.arrive()).rejects.toThrow(/Barrier timed out/)
        await expect(timedBarrier.arrive()).rejects.toThrow(/Barrier timed out/)

        const tracker = new ConcurrencyTracker()
        await tracker.track('n1', async () => 'done')
        expect(tracker.maxObserved).toBe(1)
        expect(tracker.active).toBe(0)
        expect(tracker.timings.get('n1')?.[0].endTime).toBeDefined()
    })
})

describe('Agentflow V2 Task 01: baseline scenarios via test harness', () => {
    const realComponentNodes = loadRealComponentNodes()

    it('1. executes a linear chain (Start -> A -> B)', async () => {
        const executedOrder: string[] = []
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('stepA', 'mockWorker', { label: 'Step A' }),
                createNode('stepB', 'mockReply', { label: 'Step B' })
            ],
            [createEdge('start_0', 'stepA'), createEdge('stepA', 'stepB')]
        )

        const nodeInstanceFactory = createMockNodeFactory({
            stepA: async (nodeData, input, options) => {
                executedOrder.push(nodeData.id)
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `A(${input})` },
                    state: { ...(options.agentflowRuntime?.state || {}), seenA: 'yes' }
                }
            },
            stepB: async (nodeData, _input, options) => {
                executedOrder.push(nodeData.id)
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `B(seenA=${options.agentflowRuntime?.state?.seenA})` },
                    state: options.agentflowRuntime?.state || {}
                }
            }
        })

        const result = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'ping' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(executedOrder).toEqual(['stepA', 'stepB'])
        expect(result.text).toBe('B(seenA=yes)')
        expect(result.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'stepA', 'stepB'])
    })

    it('2. executes a fork-join graph (Start -> [A, B] -> Join) with Join running once after both branches', async () => {
        const flow = createFlow(
            [
                createNode(
                    'start_0',
                    'startAgentflow',
                    {
                        inputs: {
                            startInputType: 'chatInput',
                            startState: [
                                { key: 'a', value: '' },
                                { key: 'b', value: '' }
                            ]
                        }
                    },
                    realComponentNodes
                ),
                createNode('branchA', 'mockBranch', { label: 'Branch A' }),
                createNode('branchB', 'mockBranch', { label: 'Branch B' }),
                createNode('join_0', 'mockJoin', { label: 'Join' })
            ],
            [
                createEdge('start_0', 'branchA'),
                createEdge('start_0', 'branchB'),
                createEdge('branchA', 'join_0'),
                createEdge('branchB', 'join_0')
            ]
        )

        const executedIds: string[] = []
        const tracker = new ConcurrencyTracker()
        const nodeInstanceFactory = createMockNodeFactory({
            branchA: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => {
                    executedIds.push(nodeData.id)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: 'fromA' },
                        state: { ...(options.agentflowRuntime?.state || {}), a: 'valA' }
                    }
                }),
            branchB: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => {
                    executedIds.push(nodeData.id)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: 'fromB' },
                        state: { ...(options.agentflowRuntime?.state || {}), b: 'valB' }
                    }
                }),
            join_0: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => {
                    executedIds.push(nodeData.id)
                    const s = options.agentflowRuntime?.state || {}
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `joined:${s.a}:${s.b}` },
                        state: s
                    }
                })
        })

        const result = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'fork' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(executedIds).toHaveLength(3)
        expect(executedIds).toContain('branchA')
        expect(executedIds).toContain('branchB')
        expect(executedIds[2]).toBe('join_0')
        expect(tracker.active).toBe(0)
        expect(tracker.maxObserved).toBeGreaterThanOrEqual(1)
        expect(result.text).toBe('joined:valA:valB')
    })

    it('3. routes simple conditional branch (Start -> Condition -> [TrueBranch, FalseBranch] -> Join)', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode(
                    'cond_0',
                    'conditionAgentflow',
                    {
                        inputs: {
                            conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: 'yes' }]
                        }
                    },
                    realComponentNodes
                ),
                createNode('trueBranch', 'mockBranch', { label: 'True' }),
                createNode('falseBranch', 'mockBranch', { label: 'False' }),
                createNode('join_0', 'mockJoin', { label: 'Join' })
            ],
            [
                createEdge('start_0', 'cond_0'),
                createEdge('cond_0', 'trueBranch', 'cond_0-output-0'),
                createEdge('cond_0', 'falseBranch', 'cond_0-output-1'),
                createEdge('trueBranch', 'join_0'),
                createEdge('falseBranch', 'join_0')
            ]
        )

        const nodeInstanceFactory = createMockNodeFactory({
            trueBranch: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'picked-true' },
                state: { ...(options.agentflowRuntime?.state || {}), picked: 'true' }
            }),
            falseBranch: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'picked-false' },
                state: { ...(options.agentflowRuntime?.state || {}), picked: 'false' }
            }),
            join_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: `join:${options.agentflowRuntime?.state?.picked}` },
                state: options.agentflowRuntime?.state || {}
            })
        })

        const trueRes = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'yes' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })
        expect(trueRes.text).toBe('join:true')
        expect(trueRes.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'cond_0', 'trueBranch', 'join_0'])

        const falseRes = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'no' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })
        expect(falseRes.text).toBe('join:false')
        expect(falseRes.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'cond_0', 'falseBranch', 'join_0'])
    })

    it('4. propagates state from SetA to ReadA', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('setA', 'mockSetter'),
                createNode('readA', 'directReplyAgentflow', { inputs: { directReplyMessage: 'val={{$flow.state.token}}' } }, realComponentNodes)
            ],
            [createEdge('start_0', 'setA'), createEdge('setA', 'readA')]
        )

        const nodeInstanceFactory = createMockNodeFactory({
            setA: async (nodeData) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'set' },
                state: { token: 'alpha-42' }
            })
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'read' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })
        expect(res.text).toBe('val=alpha-42')
    })

    it('5. executes loopAgentflow until maxLoopCount fallback termination', async () => {
        let count = 0
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('body_0', 'mockBody'),
                createNode(
                    'loop_0',
                    'loopAgentflow',
                    {
                        inputs: {
                            loopBackToNode: 'body_0-Body',
                            maxLoopCount: 3,
                            fallbackMessage: 'Stopped after 3'
                        }
                    },
                    realComponentNodes
                )
            ],
            [createEdge('start_0', 'body_0'), createEdge('body_0', 'loop_0')]
        )

        const nodeInstanceFactory = createMockNodeFactory({
            body_0: async (nodeData) => {
                count += 1
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `iter-${count}` },
                    state: { count }
                }
            }
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'loop' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })
        expect(count).toBe(3)
        expect(res.text).toBe('Stopped after 3')
    })

    it('6. pauses at humanInputAgentflow (STOPPED) and resumes on proceed/reject', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode(
                    'human_0',
                    'humanInputAgentflow',
                    {
                        inputs: {
                            humanInputDescriptionType: 'fixed',
                            humanInputDescription: 'Approve action?',
                            humanInputAcceptLabelText: 'Approve',
                            humanInputRejectLabelText: 'Reject'
                        }
                    },
                    realComponentNodes
                ),
                createNode('approved_0', 'directReplyAgentflow', { inputs: { directReplyMessage: 'Approved!' } }, realComponentNodes),
                createNode('rejected_0', 'directReplyAgentflow', { inputs: { directReplyMessage: 'Rejected!' } }, realComponentNodes)
            ],
            [
                createEdge('start_0', 'human_0'),
                createEdge('human_0', 'approved_0', 'human_0-output-0'),
                createEdge('human_0', 'rejected_0', 'human_0-output-1')
            ]
        )

        const { appDataSource, executions } = createMockDataSource()
        const { sseStreamer, getEvents } = createMockSSEStreamer()

        const paused = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'run', overrideConfig: { sessionId: 'sess-hitl' } },
            appDataSource,
            componentNodes: realComponentNodes,
            sseStreamer,
            chatId: 'chat-hitl-pause'
        })

        await waitUntil(() => executions[0]?.state === 'STOPPED')
        expect(paused.text).toContain('Approve action?')
        expect(executions[0].state).toBe('STOPPED')
        expect(getEvents('agentFlowEvent').map((e) => e.data)).toContain('STOPPED')
        expect(getEvents('action')).toHaveLength(1)

        const resumedProceed = await runTestAgentFlow({
            flow,
            incomingInput: {
                humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'ship it' },
                overrideConfig: { sessionId: 'sess-hitl' }
            },
            appDataSource,
            componentNodes: realComponentNodes,
            chatId: 'chat-hitl-resume'
        })

        await waitUntil(() => executions[0]?.state === 'FINISHED')
        expect(resumedProceed.text).toBe('Approved!')
        expect(executions[0].state).toBe('FINISHED')

        await runTestAgentFlow({
            flow,
            incomingInput: { question: 'run', overrideConfig: { sessionId: 'sess-hitl-reject' } },
            appDataSource,
            componentNodes: realComponentNodes,
            chatId: 'chat-hitl-reject-pause'
        })
        await waitUntil(() => executions[1]?.state === 'STOPPED')

        const resumedReject = await runTestAgentFlow({
            flow,
            incomingInput: {
                humanInput: { type: 'reject', startNodeId: 'human_0', feedback: 'cancel it' },
                overrideConfig: { sessionId: 'sess-hitl-reject' }
            },
            appDataSource,
            componentNodes: realComponentNodes,
            chatId: 'chat-hitl-reject-resume'
        })

        await waitUntil(() => executions[1]?.state === 'FINISHED')
        expect(resumedReject.text).toBe('Rejected!')
        expect(executions[1].state).toBe('FINISHED')
    })

    it('7. propagates node errors to ERROR execution state and SSE events', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('boom_0', 'mockBoom')
            ],
            [createEdge('start_0', 'boom_0')]
        )

        const { appDataSource, executions } = createMockDataSource()
        const { sseStreamer, getEvents } = createMockSSEStreamer()

        const nodeInstanceFactory = createMockNodeFactory({
            boom_0: async () => {
                throw new Error('simulated node failure')
            }
        })

        await expect(
            runTestAgentFlow({
                flow,
                incomingInput: { question: 'fail' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer,
                chatId: 'chat-err',
                nodeInstanceFactory
            })
        ).rejects.toThrow(/simulated node failure/)

        await waitUntil(() => executions[0]?.state === 'ERROR')
        expect(executions[0].state).toBe('ERROR')
        expect(getEvents('agentFlowEvent').map((e) => e.data)).toContain('ERROR')
    })

    it('8. loads and runs captured baseline flow 01-parallel-fork-join-timing-and-state.json with mock node seam', async () => {
        const baselineFlow = loadBaselineFlow('01-parallel-fork-join-timing-and-state.json')
        const executedBranches: string[] = []

        const nodeInstanceFactory = createMockNodeFactory({
            customFunctionAgentflow_0: async (nodeData, _input, options) => {
                executedBranches.push(nodeData.id)
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'A(mock)' },
                    state: { ...(options.agentflowRuntime?.state || {}), a: 'A(mock)' }
                }
            },
            customFunctionAgentflow_1: async (nodeData, _input, options) => {
                executedBranches.push(nodeData.id)
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B(mock)' },
                    state: { ...(options.agentflowRuntime?.state || {}), b: 'B(mock)' }
                }
            }
        })

        const res = await runTestAgentFlow({
            chatflow: createChatflow(baselineFlow),
            incomingInput: { question: 'baseline' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(executedBranches).toHaveLength(2)
        expect(executedBranches).toContain('customFunctionAgentflow_0')
        expect(executedBranches).toContain('customFunctionAgentflow_1')
        expect(res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'directReplyAgentflow_0')).toHaveLength(1)
        expect(res.text).toBe('State: a=A(mock) / b=B(mock)')
    })
})
