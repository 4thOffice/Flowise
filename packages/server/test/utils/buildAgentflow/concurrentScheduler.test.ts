import { determineNodesToIgnore, processNodeOutputs } from '../../../src/utils/agentflow/schedulerHelpers'
import { defaultSelectTerminalOutput, getMaxNodeConcurrency, runConcurrentNodeScheduler } from '../../../src/utils/agentflow/scheduler'
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
    tokenWithHistory,
    waitUntil
} from './testHelpers'

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => {
        throw new Error('getRunningExpressApp should not be called when appDataSource is injected')
    })
}))

async function flushMicrotasks(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve()
    }
}

describe('Agentflow V2 Task 03: Concurrent Scheduler & Sync Helpers', () => {
    const realComponentNodes = loadRealComponentNodes()
    const originalConcurrencyEnv = process.env.AGENTFLOW_MAX_NODE_CONCURRENCY

    afterEach(() => {
        if (originalConcurrencyEnv === undefined) {
            delete process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
        } else {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = originalConcurrencyEnv
        }
    })

    it('runs determineNodesToIgnore and processNodeOutputs strictly synchronously without returning Promises', () => {
        const nodes = [createNode('cond_0', 'conditionAgentflow'), createNode('yes_0', 'mockNode'), createNode('no_0', 'mockNode')]
        const edges = [createEdge('cond_0', 'yes_0', 'cond_0-output-0'), createEdge('cond_0', 'no_0', 'cond_0-output-1')]
        const result = { output: { conditions: [{ isFulfilled: true }, { isFulfilled: false }] } }

        const ignored = determineNodesToIgnore(nodes[0], result, edges, 'cond_0')
        expect(ignored).not.toBeInstanceOf(Promise)
        expect(typeof (ignored as any)?.then).not.toBe('function')
        expect(ignored).toEqual(['no_0'])

        const queue: INodeQueue[] = []
        const waitingNodes = new Map<string, IWaitingNode>()
        const loopCounts = new Map<string, number>()

        const processResult = processNodeOutputs({
            nodeId: 'cond_0',
            nodeName: 'conditionAgentflow',
            result,
            graph: { cond_0: ['yes_0', 'no_0'], yes_0: [], no_0: [] },
            nodes,
            edges,
            nodeExecutionQueue: queue,
            waitingNodes,
            loopCounts,
            chatId: 'chat-sync'
        })
        expect(processResult).not.toBeInstanceOf(Promise)
        expect(typeof (processResult as any)?.then).not.toBe('function')
        expect(queue.map((q) => q.nodeId)).toEqual(['yes_0'])
    })

    it('parses AGENTFLOW_MAX_NODE_CONCURRENCY with safe positive integer validation and default 10', () => {
        delete process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
        expect(getMaxNodeConcurrency()).toBe(10)

        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
        expect(getMaxNodeConcurrency()).toBe(4)

        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'
        expect(getMaxNodeConcurrency()).toBe(1)

        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '0'
        expect(getMaxNodeConcurrency()).toBe(10)

        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '-5'
        expect(getMaxNodeConcurrency()).toBe(10)

        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = 'not-a-number'
        expect(getMaxNodeConcurrency()).toBe(10)

        expect(getMaxNodeConcurrency(3)).toBe(3)
        expect(getMaxNodeConcurrency(0)).toBe(10)
        expect(getMaxNodeConcurrency(0.5)).toBe(10)
        expect(getMaxNodeConcurrency(Number.NaN)).toBe(10)
        expect(getMaxNodeConcurrency(Number.POSITIVE_INFINITY)).toBe(10)

        expect(defaultSelectTerminalOutput([])).toBeUndefined()
    })

    it('proves true concurrency with a 2-party mutual barrier (Start -> [A, B] -> Join) when concurrency >= 2', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('branchA', 'mockBranch'),
                createNode('branchB', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'branchA'),
                createEdge('start_0', 'branchB'),
                createEdge('branchA', 'join_0'),
                createEdge('branchB', 'join_0')
            ]
        )

        const barrier = createBarrier(2, 1000)
        const tracker = new ConcurrencyTracker()
        const joinCalls: string[] = []

        const nodeInstanceFactory = createMockNodeFactory({
            branchA: (nodeData) =>
                tracker.track(nodeData.id, async () => {
                    await barrier.arrive()
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: 'A-done' },
                        state: { a: 'valA' }
                    }
                }),
            branchB: (nodeData) =>
                tracker.track(nodeData.id, async () => {
                    await barrier.arrive()
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: 'B-done' },
                        state: { b: 'valB' }
                    }
                }),
            join_0: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => {
                    joinCalls.push(nodeData.id)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `joined:${options.agentflowRuntime.state.a}:${options.agentflowRuntime.state.b}` },
                        state: options.agentflowRuntime.state
                    }
                })
        })

        const result = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'barrier' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(tracker.maxObserved).toBe(2)
        expect(tracker.active).toBe(0)
        expect(joinCalls).toEqual(['join_0'])
        expect(result.text).toBe('joined:valA:valB')
    })

    it('enforces max concurrency bound (Start -> [A, B, C, D] -> Join with AGENTFLOW_MAX_NODE_CONCURRENCY=2)', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('A', 'mockBranch'),
                createNode('B', 'mockBranch'),
                createNode('C', 'mockBranch'),
                createNode('D', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'A'),
                createEdge('start_0', 'B'),
                createEdge('start_0', 'C'),
                createEdge('start_0', 'D'),
                createEdge('A', 'join_0'),
                createEdge('B', 'join_0'),
                createEdge('C', 'join_0'),
                createEdge('D', 'join_0')
            ]
        )

        const tracker = new ConcurrencyTracker()
        const deferreds: Record<string, ReturnType<typeof createDeferred<void>>> = {
            A: createDeferred(),
            B: createDeferred(),
            C: createDeferred(),
            D: createDeferred()
        }

        const makeBranch = (id: string) => (nodeData: any, _input: any, options: any) =>
            tracker.track(nodeData.id, async () => {
                await deferreds[id].promise
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: id },
                    state: { ...(options.agentflowRuntime?.state || {}), [id]: `done-${id}` }
                }
            })

        const nodeInstanceFactory = createMockNodeFactory({
            A: makeBranch('A'),
            B: makeBranch('B'),
            C: makeBranch('C'),
            D: makeBranch('D'),
            join_0: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => {
                    const s = options.agentflowRuntime.state
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `${s.A}|${s.B}|${s.C}|${s.D}` },
                        state: s
                    }
                })
        })

        const runPromise = runTestAgentFlow({
            flow,
            incomingInput: { question: 'bound' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        await waitUntil(() => tracker.active === 2)
        await flushMicrotasks()
        expect(tracker.active).toBe(2)
        expect(tracker.maxObserved).toBe(2)

        deferreds.A.resolve()
        await waitUntil(() => tracker.events.some((e) => e.nodeId === 'C' && e.type === 'start'))
        await flushMicrotasks()
        expect(tracker.active).toBe(2)
        expect(tracker.maxObserved).toBe(2)

        deferreds.B.resolve()
        await waitUntil(() => tracker.events.some((e) => e.nodeId === 'D' && e.type === 'start'))
        await flushMicrotasks()
        expect(tracker.active).toBe(2)
        expect(tracker.maxObserved).toBe(2)

        deferreds.C.resolve()
        deferreds.D.resolve()

        const res = await runPromise
        expect(tracker.maxObserved).toBe(2)
        expect(tracker.active).toBe(0)
        expect(res.text).toBe('done-A|done-B|done-C|done-D')
    })

    it('falls back deterministically to sequential execution when AGENTFLOW_MAX_NODE_CONCURRENCY=1', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('A', 'mockBranch'),
                createNode('B', 'mockBranch'),
                createNode('C', 'mockBranch'),
                createNode('D', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'A'),
                createEdge('start_0', 'B'),
                createEdge('start_0', 'C'),
                createEdge('start_0', 'D'),
                createEdge('A', 'join_0'),
                createEdge('B', 'join_0'),
                createEdge('C', 'join_0'),
                createEdge('D', 'join_0')
            ]
        )

        const tracker = new ConcurrencyTracker()
        const makeBranch = (id: string) => (nodeData: any, _input: any, options: any) =>
            tracker.track(nodeData.id, async () => {
                await Promise.resolve()
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: id },
                    state: { ...(options.agentflowRuntime?.state || {}), [id]: 'ok' }
                }
            })

        const nodeInstanceFactory = createMockNodeFactory({
            A: makeBranch('A'),
            B: makeBranch('B'),
            C: makeBranch('C'),
            D: makeBranch('D'),
            join_0: (nodeData, _input, options) =>
                tracker.track(nodeData.id, async () => ({
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: Object.keys(options.agentflowRuntime.state).sort().join(',') },
                    state: options.agentflowRuntime.state
                }))
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'seq' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(tracker.maxObserved).toBe(1)
        expect(res.text).toBe('A,B,C,D')

        // Baseline flow 01 executes sequentially with =1 (Branch B reads Branch A's committed state)
        const baselineFlow = loadBaselineFlow('01-parallel-fork-join-timing-and-state.json')
        const sequentialRes = await runTestAgentFlow({
            chatflow: createChatflow(baselineFlow),
            incomingInput: { question: 'seq-baseline' },
            componentNodes: realComponentNodes
        })
        expect(sequentialRes.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=A(saw_b=empty))')

        // Same baseline flow 01 executes concurrently when AGENTFLOW_MAX_NODE_CONCURRENCY=2
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'
        const concurrentRes = await runTestAgentFlow({
            chatflow: createChatflow(baselineFlow),
            incomingInput: { question: 'conc-baseline' },
            componentNodes: realComponentNodes
        })
        expect(concurrentRes.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=empty)')
    })

    it('captures fresh startStateSnapshot at actual node launch time instead of enqueue time', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('A', 'mockBranch'),
                createNode('B', 'mockBranch'),
                createNode('C', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'A'),
                createEdge('start_0', 'B'),
                createEdge('start_0', 'C'),
                createEdge('A', 'join_0'),
                createEdge('B', 'join_0'),
                createEdge('C', 'join_0')
            ]
        )

        const deferredA = createDeferred<void>()
        const deferredB = createDeferred<void>()
        const started = new Set<string>()
        let observedByC: any

        const nodeInstanceFactory = createMockNodeFactory({
            A: async (nodeData) => {
                started.add('A')
                await deferredA.promise
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'A' },
                    state: { fromA: 'committed' }
                }
            },
            B: async (nodeData) => {
                started.add('B')
                await deferredB.promise
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B' },
                    state: { fromB: 'committed' }
                }
            },
            C: async (nodeData, _input, options) => {
                started.add('C')
                observedByC = options.agentflowRuntime.state.fromA
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'C' },
                    state: { fromC: observedByC }
                }
            },
            join_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: `C-saw:${options.agentflowRuntime.state.fromC}` },
                state: options.agentflowRuntime.state
            })
        })

        const runPromise = runTestAgentFlow({
            flow,
            incomingInput: { question: 'fresh-snapshot' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        await waitUntil(() => started.has('A') && started.has('B'))
        // A and B occupy both slots; C has not launched or snapshotted yet
        expect(started.has('C')).toBe(false)
        expect(observedByC).toBeUndefined()

        // Resolving A frees a slot and commits { fromA: 'committed' } BEFORE C snapshots state
        deferredA.resolve()
        await waitUntil(() => started.has('C'))
        expect(observedByC).toBe('committed')

        deferredB.resolve()
        const res = await runPromise
        expect(res.text).toBe('C-saw:committed')

        // With concurrency=1, B also observes A's committed state
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'
        let observedByBSeq: any
        const seqFactory = createMockNodeFactory({
            A: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'A' },
                state: { ...(options.agentflowRuntime?.state || {}), fromA: 'seq-committed' }
            }),
            B: async (nodeData, _input, options) => {
                observedByBSeq = options.agentflowRuntime.state.fromA
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B' },
                    state: { ...(options.agentflowRuntime?.state || {}), fromB: observedByBSeq }
                }
            },
            C: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'C' },
                state: { ...(options.agentflowRuntime?.state || {}) }
            }),
            join_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: String(options.agentflowRuntime.state.fromB) },
                state: options.agentflowRuntime.state
            })
        })
        const seqRes = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'fresh-snapshot-seq' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory: seqFactory
        })
        expect(observedByBSeq).toBe('seq-committed')
        expect(seqRes.text).toBe('seq-committed')
    })

    it('merges disjoint parallel state writes and isolates in-place mutations under true concurrency', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode(
                    'start_0',
                    'startAgentflow',
                    {
                        inputs: {
                            startInputType: 'chatInput',
                            startState: [
                                { key: 'shared', value: 'seed' },
                                { key: 'removeMe', value: 'old' }
                            ]
                        }
                    },
                    realComponentNodes
                ),
                createNode('branchA', 'mockBranch'),
                createNode('branchB', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'branchA'),
                createEdge('start_0', 'branchB'),
                createEdge('branchA', 'join_0'),
                createEdge('branchB', 'join_0')
            ]
        )

        const barrier = createBarrier(2, 1000)
        let aSawB: any = 'unset'
        let bSawA: any = 'unset'

        const nodeInstanceFactory = createMockNodeFactory({
            branchA: async (nodeData, _input, options) => {
                options.agentflowRuntime.state.a = 'fromA'
                options.agentflowRuntime.state.branchAData = { nested: 1 }
                delete options.agentflowRuntime.state.removeMe
                await barrier.arrive()
                aSawB = options.agentflowRuntime.state.b
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'A' },
                    state: options.agentflowRuntime.state
                }
            },
            branchB: async (nodeData, _input, options) => {
                options.agentflowRuntime.state.b = 'fromB'
                options.agentflowRuntime.state.branchBData = { nested: 2 }
                await barrier.arrive()
                bSawA = options.agentflowRuntime.state.a
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B' },
                    state: options.agentflowRuntime.state
                }
            },
            join_0: async (nodeData, _input, options) => {
                const s = options.agentflowRuntime.state
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: {
                        content: JSON.stringify({
                            shared: s.shared,
                            a: s.a,
                            b: s.b,
                            nestedA: s.branchAData?.nested,
                            nestedB: s.branchBData?.nested,
                            hasRemoved: 'removeMe' in s
                        })
                    },
                    state: s
                }
            }
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'isolation' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(aSawB).toBeUndefined()
        expect(bSawA).toBeUndefined()
        expect(JSON.parse(res.text)).toEqual({
            shared: 'seed',
            a: 'fromA',
            b: 'fromB',
            nestedA: 1,
            nestedB: 2,
            hasRemoved: false
        })
    })

    it('adds the user input to runtime chatHistory once when parallel first nodes each return it', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('branchA', 'mockBranch'),
                createNode('branchB', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'branchA'),
                createEdge('start_0', 'branchB'),
                createEdge('branchA', 'join_0'),
                createEdge('branchB', 'join_0')
            ]
        )

        const barrier = createBarrier(2, 1000)
        const firstNodeLikeBranch = (answer: string) => async (nodeData: any, input: any, options: any) => {
            const runtimeChatHistory = options.agentflowRuntime.chatHistory ?? []
            const inputMessages = runtimeChatHistory.length ? [] : [{ role: 'user', content: input }]
            await barrier.arrive()
            return {
                id: nodeData.id,
                name: nodeData.name,
                output: { content: answer },
                chatHistory: [...inputMessages, { role: 'assistant', content: answer, name: nodeData.id }]
            }
        }

        const nodeInstanceFactory = createMockNodeFactory({
            branchA: firstNodeLikeBranch('A'),
            branchB: firstNodeLikeBranch('B'),
            join_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: JSON.stringify(options.agentflowRuntime.chatHistory.map((m: any) => `${m.role}:${m.content}`)) }
            })
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'hi' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        const history: string[] = JSON.parse(res.text)
        expect(history.filter((entry) => entry === 'user:hi')).toHaveLength(1)
        expect([...history].sort()).toEqual(['assistant:A', 'assistant:B', 'user:hi'])
    })

    it('waits for all in-flight tasks to settle on error before rejecting (zero orphaned promises)', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('branchA', 'mockBranch'),
                createNode('branchB', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'branchA'),
                createEdge('start_0', 'branchB'),
                createEdge('branchA', 'join_0'),
                createEdge('branchB', 'join_0')
            ]
        )

        const bothStarted = createBarrier(2, 1000)
        const deferredB = createDeferred<void>()
        let branchBFinished = false
        let joinRan = false
        const { appDataSource, executions } = createMockDataSource()
        const { sseStreamer, getEvents } = createMockSSEStreamer()

        const nodeInstanceFactory = createMockNodeFactory({
            branchA: async () => {
                await bothStarted.arrive()
                throw new Error('branch-A-failed')
            },
            branchB: async (nodeData) => {
                await bothStarted.arrive()
                await deferredB.promise
                branchBFinished = true
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B-finished' },
                    state: { b: 'done' }
                }
            },
            join_0: async (nodeData) => {
                joinRan = true
                return { id: nodeData.id, name: nodeData.name, output: { content: 'join' }, state: {} }
            }
        })

        let settled = false
        const flowPromise = runTestAgentFlow({
            flow,
            incomingInput: { question: 'err-drain' },
            appDataSource,
            componentNodes: realComponentNodes,
            sseStreamer,
            chatId: 'chat-err-drain',
            nodeInstanceFactory
        }).then(
            () => {
                settled = true
                return { status: 'resolved' as const }
            },
            (err) => {
                settled = true
                return { status: 'rejected' as const, err }
            }
        )

        await waitUntil(() => bothStarted.arrivedCount() === 2)
        await flushMicrotasks(12)
        // branchA already rejected, but branchB is still pending -> executeAgentFlow MUST NOT settle yet
        expect(settled).toBe(false)
        expect(branchBFinished).toBe(false)

        deferredB.resolve()
        const outcome = await flowPromise

        expect(outcome.status).toBe('rejected')
        expect((outcome as any).err.message).toMatch(/branch-A-failed/)
        expect(branchBFinished).toBe(true)
        expect(joinRan).toBe(false)
        expect(executions[0].state).toBe('ERROR')
        expect(getEvents('agentFlowEvent').filter((e) => e.data === 'ERROR')).toHaveLength(1)
    })

    it('waits for in-flight sibling tasks to settle when a node returns shouldStop (zero orphaned promises)', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode(
                    'human_0',
                    'humanInputAgentflow',
                    { inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Approve?' } },
                    realComponentNodes
                ),
                createNode('afterHuman', 'mockAfter'),
                createNode('branchB', 'mockBranch')
            ],
            [createEdge('start_0', 'human_0'), createEdge('start_0', 'branchB'), createEdge('human_0', 'afterHuman', 'human_0-output-0')]
        )

        const bothStarted = createBarrier(2, 1000)
        const deferredB = createDeferred<void>()
        let branchBFinished = false
        let afterHumanRan = false
        const { appDataSource, executions } = createMockDataSource()

        const nodeInstanceFactory = createMockNodeFactory({
            human_0: async (nodeData) => {
                await bothStarted.arrive()
                return {
                    id: nodeData.id,
                    name: 'humanInputAgentflow',
                    input: {},
                    output: { content: 'Approve?' },
                    state: {}
                }
            },
            branchB: async (nodeData) => {
                await bothStarted.arrive()
                await deferredB.promise
                branchBFinished = true
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B-done' },
                    state: { b: 'ok' }
                }
            },
            afterHuman: async (nodeData) => {
                afterHumanRan = true
                return { id: nodeData.id, name: nodeData.name, output: { content: 'after' }, state: {} }
            }
        })

        let settled = false
        const flowPromise = runTestAgentFlow({
            flow,
            incomingInput: { question: 'stop-drain' },
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        }).finally(() => {
            settled = true
        })

        await waitUntil(() => bothStarted.arrivedCount() === 2)
        await flushMicrotasks(12)
        expect(settled).toBe(false)
        expect(branchBFinished).toBe(false)

        deferredB.resolve()
        await flowPromise

        expect(branchBFinished).toBe(true)
        expect(afterHumanRan).toBe(false)
        expect(executions[0].state).toBe('STOPPED')
    })

    it('enforces synchronous maxIterations accounting and prevents duplicate concurrent launch of same nodeId', async () => {
        // 1. maxIterations stops runaway queue while draining already in-flight task
        const d1 = createDeferred<void>()
        const n1Started = createDeferred<void>()
        let inFlightFinished = false
        let n3Started = false
        const queue: INodeQueue[] = [
            { nodeId: 'n1', data: {}, inputs: {} },
            { nodeId: 'n2', data: {}, inputs: {} }
        ]

        let schedulerSettled = false
        const schedPromise = runConcurrentNodeScheduler({
            nodeExecutionQueue: queue,
            maxNodeConcurrency: 2,
            maxIterations: 1,
            canScheduleMore: () => true,
            executeNodeTask: async (node) => {
                if (node.nodeId === 'n1') {
                    n1Started.resolve()
                    await d1.promise
                    inFlightFinished = true
                }
                if (node.nodeId === 'n3') {
                    n3Started = true
                }
                return node.nodeId
            },
            onNodeComplete: (node) => {
                if (node.nodeId === 'n2') {
                    queue.push({ nodeId: 'n3', data: {}, inputs: {} })
                }
            },
            handleNodeError: () => {}
        }).then(
            () => {
                schedulerSettled = true
                return 'resolved' as const
            },
            (err) => {
                schedulerSettled = true
                return err as Error
            }
        )

        await n1Started.promise
        await flushMicrotasks()
        // n2 already finished and queued n3 -> n3 tripped maxIterations=1, while n1 is still pending
        expect(n3Started).toBe(false)
        expect(schedulerSettled).toBe(false)
        d1.resolve()
        const schedRes = await schedPromise
        expect(schedRes).toBeInstanceOf(Error)
        expect((schedRes as Error).message).toMatch(/Maximum iteration limit reached/)
        expect(inFlightFinished).toBe(true)

        // 2. Duplicate queued nodeId is deferred until prior instance completes while non-duplicate siblings run
        const a1 = createDeferred<void>()
        const b1 = createDeferred<void>()
        const launchSequence: string[] = []
        let activeA = 0
        let maxActiveA = 0
        let countA = 0

        const dupQueue: INodeQueue[] = [
            { nodeId: 'A', data: {}, inputs: {} },
            { nodeId: 'A', data: {}, inputs: {} },
            { nodeId: 'B', data: {}, inputs: {} }
        ]

        const dupPromise = runConcurrentNodeScheduler({
            nodeExecutionQueue: dupQueue,
            maxNodeConcurrency: 3,
            maxIterations: 10,
            canScheduleMore: () => true,
            executeNodeTask: async (node) => {
                launchSequence.push(node.nodeId)
                if (node.nodeId === 'A') {
                    activeA += 1
                    maxActiveA = Math.max(maxActiveA, activeA)
                    countA += 1
                    if (countA === 1) {
                        await a1.promise
                    }
                    activeA -= 1
                } else {
                    await b1.promise
                }
                return node.nodeId
            },
            onNodeComplete: () => {},
            handleNodeError: () => {}
        })

        await flushMicrotasks()
        // First A and B launched concurrently; duplicate A did not launch concurrently with first A
        expect(launchSequence).toEqual(['A', 'B'])
        expect(maxActiveA).toBe(1)

        a1.resolve()
        await flushMicrotasks()
        expect(launchSequence).toEqual(['A', 'B', 'A'])
        expect(maxActiveA).toBe(1)

        b1.resolve()
        await dupPromise

        // 3. Throwing hook inside schedule() drains in-flight tasks without unhandled rejection
        const dInFlight = createDeferred<void>()
        const startedInFlight = createDeferred<void>()
        let inFlightCleaned = false
        let shouldThrow = false
        const throwQueue: INodeQueue[] = [
            { nodeId: 't1', data: {}, inputs: {} },
            { nodeId: 't2', data: {}, inputs: {} }
        ]
        const hookThrowPromise = runConcurrentNodeScheduler({
            nodeExecutionQueue: throwQueue,
            maxNodeConcurrency: 1,
            maxIterations: 10,
            canScheduleMore: () => {
                if (shouldThrow) throw new Error('hook-boom')
                return true
            },
            executeNodeTask: async () => {
                startedInFlight.resolve()
                await dInFlight.promise
                inFlightCleaned = true
                shouldThrow = true
                return 'done'
            },
            onNodeComplete: () => {},
            handleNodeError: () => {}
        })
        await startedInFlight.promise
        dInFlight.resolve()
        await expect(hookThrowPromise).rejects.toThrow(/hook-boom/)
        expect(inFlightCleaned).toBe(true)
    })

    it('snapshots pastChatHistory and incomingInput per launch so concurrent ephemeralMemory commits cannot corrupt siblings mid-flight', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('fastClearing', 'mockBranch'),
                createNode('slowReader', 'mockBranch'),
                createNode('join_0', 'mockJoin')
            ],
            [
                createEdge('start_0', 'fastClearing'),
                createEdge('start_0', 'slowReader'),
                createEdge('fastClearing', 'join_0'),
                createEdge('slowReader', 'join_0')
            ]
        )

        const { appDataSource } = createMockDataSource()
        const { sseStreamer, getEvents } = createMockSSEStreamer()
        const trustedState = await tokenWithHistory([{ role: 'userMessage', content: 'seed-chat-message' }])

        const slowEntered = createDeferred<void>()
        const fastCommitted = createDeferred<void>()
        let slowObservedHistoryLen = -1

        const nodeInstanceFactory = createMockNodeFactory({
            fastClearing: async (nodeData, _input, options) => {
                await slowEntered.promise
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'cleared', ephemeralMemory: true },
                    state: options.agentflowRuntime.state
                }
            },
            slowReader: async (nodeData, _input, options) => {
                slowEntered.resolve()
                await fastCommitted.promise
                slowObservedHistoryLen = options.pastChatHistory.length
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'read' },
                    state: options.agentflowRuntime.state
                }
            },
            join_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: `slowSaw=${slowObservedHistoryLen}` },
                state: options.agentflowRuntime.state
            })
        })

        const runPromise = runTestAgentFlow({
            flow,
            incomingInput: { question: 'check-history', trustedState },
            appDataSource,
            sseStreamer,
            chatId: 'chat-midflight-iso',
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        await slowEntered.promise
        // Wait deterministically until fastClearing finishes and commits reconcileRuntimeCommit (ephemeralMemory clears shared pastChatHistory)
        await waitUntil(() => getEvents('nextAgentFlow').some((e) => e.data?.nodeId === 'fastClearing' && e.data?.status === 'FINISHED'))
        fastCommitted.resolve()

        const res = await runPromise
        expect(res.text).toBe('slowSaw=1')
    })

    it('keeps outer iterationAgentflow sequential while executing inner parallel subflow branches concurrently', async () => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '2'

        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('iter_0', 'iterationAgentflow', { inputs: { iterationInput: '["item0","item1"]' } }, realComponentNodes),
                createNode(
                    'subStart',
                    'startAgentflow',
                    { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                    realComponentNodes
                ),
                createNode('subA', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                createNode('subB', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                createNode('subJoin', 'mockJoin', { parentNode: 'iter_0', extent: 'parent' })
            ],
            [
                createEdge('start_0', 'iter_0'),
                createEdge('subStart', 'subA'),
                createEdge('subStart', 'subB'),
                createEdge('subA', 'subJoin'),
                createEdge('subB', 'subJoin')
            ]
        )

        const barriers = [createBarrier(2, 1000), createBarrier(2, 1000)]
        const tracker = new ConcurrencyTracker()
        const phaseEvents: string[] = []

        const nodeInstanceFactory = createMockNodeFactory({
            subA: (nodeData, _input, options) => {
                const idx = options.iterationContext?.index as number
                return tracker.track(`subA:${idx}`, async () => {
                    phaseEvents.push(`start:A:${idx}`)
                    await barriers[idx].arrive()
                    phaseEvents.push(`end:A:${idx}`)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `A${idx}` },
                        state: { [`a${idx}`]: 'ok' }
                    }
                })
            },
            subB: (nodeData, _input, options) => {
                const idx = options.iterationContext?.index as number
                return tracker.track(`subB:${idx}`, async () => {
                    phaseEvents.push(`start:B:${idx}`)
                    await barriers[idx].arrive()
                    phaseEvents.push(`end:B:${idx}`)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `B${idx}` },
                        state: { [`b${idx}`]: 'ok' }
                    }
                })
            },
            subJoin: async (nodeData, _input, options) => {
                const idx = options.iterationContext?.index as number
                phaseEvents.push(`join:${idx}`)
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `iter-${idx}-done` },
                    state: options.agentflowRuntime.state
                }
            }
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'iter-concurrent' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(tracker.maxObserved).toBe(2)
        expect(res.text).toBe('iter-0-done\niter-1-done')
        // Iteration 0 completely finishes (join:0) BEFORE iteration 1 starts
        const join0Idx = phaseEvents.indexOf('join:0')
        const startA1Idx = phaseEvents.indexOf('start:A:1')
        const startB1Idx = phaseEvents.indexOf('start:B:1')
        expect(join0Idx).toBeGreaterThan(-1)
        expect(startA1Idx).toBeGreaterThan(join0Idx)
        expect(startB1Idx).toBeGreaterThan(join0Idx)
    })
})
