import { IAgentflowExecutedData, IReactFlowEdge, IReactFlowNode } from '../../../src/Interface'
import {
    classifyDecisionOutgoingEdges,
    compareNodesDeterministically,
    computeTopologicalLevels,
    createDependencyEngine
} from '../../../src/utils/agentflow/dependencyEngine'
import { determineNodesToIgnore } from '../../../src/utils/agentflow/schedulerHelpers'
import {
    ConcurrencyTracker,
    createBarrier,
    createChatflow,
    createDeferred,
    createEdge,
    createFlow,
    createMockDataSource,
    createMockNodeFactory,
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

function createMulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

describe('Agentflow V2 Task 04: DAG Joins, Condition Pruning, & Loop Semantics', () => {
    const realComponentNodes = loadRealComponentNodes()
    const originalConcurrencyEnv = process.env.AGENTFLOW_MAX_NODE_CONCURRENCY

    afterEach(() => {
        if (originalConcurrencyEnv === undefined) {
            delete process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
        } else {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = originalConcurrencyEnv
        }
    })

    describe('1. Topology A: Multi-hop skipped branch merging with parallel branch', () => {
        const buildTopologyAFlow = (conditionMatches: boolean) =>
            createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'cond_0',
                        'conditionAgentflow',
                        {
                            inputs: {
                                conditions: [
                                    {
                                        type: 'string',
                                        value1: '{{ question }}',
                                        operation: 'equal',
                                        value2: conditionMatches ? 'go' : 'never'
                                    }
                                ]
                            }
                        },
                        realComponentNodes
                    ),
                    createNode('T1', 'mockWorker'),
                    createNode('F1', 'mockWorker'),
                    createNode('F2', 'mockWorker'),
                    createNode('F3', 'mockWorker'),
                    createNode('par_0', 'mockWorker'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('start_0', 'par_0'),
                    createEdge('cond_0', 'T1', 'cond_0-output-0'),
                    createEdge('cond_0', 'F1', 'cond_0-output-1'),
                    createEdge('T1', 'join_0'),
                    createEdge('F1', 'F2'),
                    createEdge('F2', 'F3'),
                    createEdge('F3', 'join_0'),
                    createEdge('par_0', 'join_0')
                ]
            )

        it.each([1, 4])(
            'cascades multi-hop DPE without deadlocking whether Parallel finishes first or Condition finishes first (concurrency=%i)',
            async (concurrency) => {
                process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = String(concurrency)

                // Case 1: Condition takes True -> F1, F2, F3 are multi-hop skipped; par_0 finishes fast before T1
                const executedTrue: string[] = []
                let joinInputsTrue: Record<string, any> = {}
                const factoryTrue = createMockNodeFactory({
                    T1: async (nd, _inp, options) => {
                        executedTrue.push(nd.id)
                        await new Promise((r) => setTimeout(r, 15))
                        return { id: nd.id, name: nd.name, output: { content: 'T1' }, state: { ...options.agentflowRuntime.state, branch: 'T1' } }
                    },
                    F1: async (nd) => {
                        executedTrue.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F1' } }
                    },
                    F2: async (nd) => {
                        executedTrue.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F2' } }
                    },
                    F3: async (nd) => {
                        executedTrue.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F3' } }
                    },
                    par_0: async (nd, _inp, options) => {
                        executedTrue.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'PAR' }, state: { ...options.agentflowRuntime.state, par: 'ok' } }
                    },
                    join_0: async (nd, input, options) => {
                        executedTrue.push(nd.id)
                        joinInputsTrue = { input, state: options.agentflowRuntime.state }
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: `${options.agentflowRuntime.state.par}+${options.agentflowRuntime.state.branch}` },
                            state: options.agentflowRuntime.state
                        }
                    }
                })

                const resTrue = await runTestAgentFlow({
                    flow: buildTopologyAFlow(true),
                    incomingInput: { question: 'go' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: factoryTrue
                })
                expect(resTrue.text).toBe('ok+T1')
                expect(executedTrue.filter((id) => id === 'join_0')).toHaveLength(1)
                expect(executedTrue).not.toContain('F1')
                expect(executedTrue).not.toContain('F2')
                expect(executedTrue).not.toContain('F3')
                expect(joinInputsTrue.state).toEqual({ par: 'ok', branch: 'T1' })

                // Case 2: Condition takes False -> T1 skipped, F1->F2->F3 runs while par_0 is slow
                const executedFalse: string[] = []
                const factoryFalse = createMockNodeFactory({
                    T1: async (nd) => {
                        executedFalse.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'T1' } }
                    },
                    F1: async (nd) => {
                        executedFalse.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F1' } }
                    },
                    F2: async (nd) => {
                        executedFalse.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F2' } }
                    },
                    F3: async (nd, _inp, options) => {
                        executedFalse.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'F3' }, state: { ...options.agentflowRuntime.state, branch: 'F3' } }
                    },
                    par_0: async (nd, _inp, options) => {
                        await new Promise((r) => setTimeout(r, 20))
                        executedFalse.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'PAR' }, state: { ...options.agentflowRuntime.state, par: 'slow' } }
                    },
                    join_0: async (nd, _input, options) => {
                        executedFalse.push(nd.id)
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: `${options.agentflowRuntime.state.par}+${options.agentflowRuntime.state.branch}` },
                            state: options.agentflowRuntime.state
                        }
                    }
                })

                const resFalse = await runTestAgentFlow({
                    flow: buildTopologyAFlow(true),
                    incomingInput: { question: 'no-match' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: factoryFalse
                })
                expect(resFalse.text).toBe('slow+F3')
                expect(executedFalse.filter((id) => id === 'join_0')).toHaveLength(1)
                expect(executedFalse).not.toContain('T1')
                expect(executedFalse).toContain('F1')
                expect(executedFalse).toContain('F2')
                expect(executedFalse).toContain('F3')
            }
        )
    })

    describe('2. Topology B: Multi-parent merge node inside conditional branch (edge-order independent)', () => {
        const buildTopologyBEdges = (unconditionalFirst: boolean): IReactFlowEdge[] => {
            const mergeEdges = unconditionalFirst
                ? [createEdge('A', 'M'), createEdge('B', 'M')]
                : [createEdge('B', 'M'), createEdge('A', 'M')]
            return [
                createEdge('start_0', 'A'),
                createEdge('start_0', 'cond_0'),
                createEdge('cond_0', 'B', 'cond_0-output-0'),
                createEdge('cond_0', 'C', 'cond_0-output-1'),
                ...mergeEdges,
                createEdge('M', 'join_0'),
                createEdge('C', 'join_0')
            ]
        }

        it.each([true, false])(
            'handles both True and False paths without deadlock regardless of edges ordering (unconditionalFirst=%s)',
            async (unconditionalFirst) => {
                process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
                const flow = createFlow(
                    [
                        createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                        createNode(
                            'cond_0',
                            'conditionAgentflow',
                            { inputs: { conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: 'yes' }] } },
                            realComponentNodes
                        ),
                        createNode('A', 'mockWorker'),
                        createNode('B', 'mockWorker'),
                        createNode('M', 'mockMerge'),
                        createNode('C', 'mockWorker'),
                        createNode('join_0', 'mockJoin')
                    ],
                    buildTopologyBEdges(unconditionalFirst)
                )

                const makeFactory = (executed: string[]) =>
                    createMockNodeFactory({
                        A: async (nd, _inp, options) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'A' }, state: { ...options.agentflowRuntime.state, a: 'A' } }
                        },
                        B: async (nd, _inp, options) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'B' }, state: { ...options.agentflowRuntime.state, b: 'B' } }
                        },
                        M: async (nd, _input, options) => {
                            executed.push(nd.id)
                            const s = options.agentflowRuntime.state
                            return {
                                id: nd.id,
                                name: nd.name,
                                output: { content: `M(${s.a},${s.b})` },
                                state: { ...s, m: `M(${s.a},${s.b})` }
                            }
                        },
                        C: async (nd, _inp, options) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'C' }, state: { ...options.agentflowRuntime.state, c: 'C' } }
                        },
                        join_0: async (nd, _input, options) => {
                            executed.push(nd.id)
                            const s = options.agentflowRuntime.state
                            return { id: nd.id, name: nd.name, output: { content: `join:${s.m ?? 'noM'}:${s.c ?? 'noC'}` }, state: s }
                        }
                    })

                const execYes: string[] = []
                const resYes = await runTestAgentFlow({
                    flow,
                    incomingInput: { question: 'yes' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: makeFactory(execYes)
                })
                expect(resYes.text).toBe('join:M(A,B):noC')
                expect(execYes.filter((id) => id === 'M')).toHaveLength(1)
                expect(execYes.filter((id) => id === 'join_0')).toHaveLength(1)
                expect(execYes).not.toContain('C')

                const execNo: string[] = []
                const resNo = await runTestAgentFlow({
                    flow,
                    incomingInput: { question: 'no' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: makeFactory(execNo)
                })
                expect(resNo.text).toBe('join:M(A,undefined):C')
                expect(execNo).toContain('A')
                expect(execNo).toContain('M')
                expect(execNo).toContain('C')
                expect(execNo).not.toContain('B')
                expect(execNo.filter((id) => id === 'join_0')).toHaveLength(1)
            }
        )
    })

    describe('3. Topology C: 0 fulfilled handles, >1 fulfilled handles, & multi-handle same-pair', () => {
        it('completes gracefully via DPE when conditionAgentflow fulfills 0 outputs (pure conditional & mixed parallel join)', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // Pure conditional flow: 0 fulfilled outputs -> neither branch nor join executes
            const pureFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('cond_0', 'conditionAgentflow'),
                    createNode('b0', 'mockBranch'),
                    createNode('b1', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('cond_0', 'b0', 'cond_0-output-0'),
                    createEdge('cond_0', 'b1', 'cond_0-output-1'),
                    createEdge('b0', 'join_0'),
                    createEdge('b1', 'join_0')
                ]
            )

            const executedPure: string[] = []
            const pureRes = await runTestAgentFlow({
                flow: pureFlow,
                incomingInput: { question: 'zero' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    cond_0: async (nd) => {
                        executedPure.push(nd.id)
                        return {
                            id: nd.id,
                            name: 'conditionAgentflow',
                            output: { conditions: [{ isFulfilled: false }, {}] },
                            state: {}
                        }
                    },
                    b0: async (nd) => {
                        executedPure.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'b0' }, state: {} }
                    },
                    b1: async (nd) => {
                        executedPure.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'b1' }, state: {} }
                    },
                    join_0: async (nd) => {
                        executedPure.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'join' }, state: {} }
                    }
                })
            })
            expect(executedPure).toEqual(['cond_0'])
            expect(pureRes.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'cond_0'])

            // Mixed parallel + 0-fulfilled conditional join: Join runs once with parallel branch input
            const mixedFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('cond_0', 'conditionAgentflow'),
                    createNode('par_0', 'mockPar'),
                    createNode('b0', 'mockBranch'),
                    createNode('b1', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('start_0', 'par_0'),
                    createEdge('cond_0', 'b0', 'cond_0-output-0'),
                    createEdge('cond_0', 'b1', 'cond_0-output-1'),
                    createEdge('b0', 'join_0'),
                    createEdge('b1', 'join_0'),
                    createEdge('par_0', 'join_0')
                ]
            )

            const executedMixed: string[] = []
            const mixedRes = await runTestAgentFlow({
                flow: mixedFlow,
                incomingInput: { question: 'mixed' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    cond_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: { conditions: [{ isFulfilled: false }, { isFulfilled: false }] },
                        state: {}
                    }),
                    par_0: async (nd) => {
                        executedMixed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'par-only' }, state: { p: 'yes' } }
                    },
                    b0: async (nd) => {
                        executedMixed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'b0' }, state: {} }
                    },
                    b1: async (nd) => {
                        executedMixed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'b1' }, state: {} }
                    },
                    join_0: async (nd, _inp, options) => {
                        executedMixed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: `mixed:${options.agentflowRuntime.state.p}` }, state: {} }
                    }
                })
            })
            expect(mixedRes.text).toBe('mixed:yes')
            expect(executedMixed).toEqual(['par_0', 'join_0'])
        })

        it('fires join ONCE with BOTH inputs when conditionAgentflow fulfills multiple handles simultaneously', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('cond_0', 'conditionAgentflow'),
                    createNode('b0', 'mockBranch'),
                    createNode('b1', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('cond_0', 'b0', 'cond_0-output-0'),
                    createEdge('cond_0', 'b1', 'cond_0-output-1'),
                    createEdge('b0', 'join_0'),
                    createEdge('b1', 'join_0')
                ]
            )

            const barrier = createBarrier(2, 1000)
            const tracker = new ConcurrencyTracker()
            let joinCalls = 0

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'both' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    cond_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: { conditions: [{ isFulfilled: true }, { isFulfilled: true }] },
                        state: {}
                    }),
                    b0: (nd) =>
                        tracker.track(nd.id, async () => {
                            await barrier.arrive()
                            return { id: nd.id, name: nd.name, output: { content: 'B0' }, state: { b0: 'val0' } }
                        }),
                    b1: (nd) =>
                        tracker.track(nd.id, async () => {
                            await barrier.arrive()
                            return { id: nd.id, name: nd.name, output: { content: 'B1' }, state: { b1: 'val1' } }
                        }),
                    join_0: async (nd, _inp, options) => {
                        joinCalls += 1
                        const s = options.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `${s.b0}+${s.b1}` }, state: s }
                    }
                })
            })

            expect(tracker.maxObserved).toBe(2)
            expect(joinCalls).toBe(1)
            expect(res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'join_0')).toHaveLength(1)
            expect(res.text).toBe('val0+val1')
        })

        it('tracks parallel edges between the same (source, target) across distinct condition handles without edge.id', async () => {
            const nodes = [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('cond_0', 'conditionAgentflow'),
                createNode('join_0', 'mockJoin')
            ]
            const e0: IReactFlowEdge = { ...createEdge('cond_0', 'join_0', 'cond_0-output-0'), id: '' }
            const e1: IReactFlowEdge = { ...createEdge('cond_0', 'join_0', 'cond_0-output-1'), id: '' }
            const flow = createFlow(nodes, [createEdge('start_0', 'cond_0'), e0, e1])

            for (const conds of [
                [{ isFulfilled: true }, { isFulfilled: false }],
                [{ isFulfilled: true }, { isFulfilled: true }]
            ]) {
                let joinCount = 0
                await runTestAgentFlow({
                    flow,
                    incomingInput: { question: 'same-pair' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: createMockNodeFactory({
                        cond_0: async (nd) => ({
                            id: nd.id,
                            name: 'conditionAgentflow',
                            output: { conditions: conds },
                            state: {}
                        }),
                        join_0: async (nd) => {
                            joinCount += 1
                            return { id: nd.id, name: nd.name, output: { content: 'ok' }, state: {} }
                        }
                    })
                })
                expect(joinCount).toBe(1)
            }
        })
    })

    describe('4. Multi-edge fan-out per condition handle (edges.filter regression)', () => {
        it('skips and activates ALL targets wired to the same condition handle and fixes legacy determineNodesToIgnore', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'cond_0',
                        'conditionAgentflow',
                        { inputs: { conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: 'go-true' }] } },
                        realComponentNodes
                    ),
                    createNode('trueTarget', 'mockTarget'),
                    createNode('elseA', 'mockTarget'),
                    createNode('elseB', 'mockTarget'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('cond_0', 'trueTarget', 'cond_0-output-0'),
                    createEdge('cond_0', 'elseA', 'cond_0-output-1'),
                    createEdge('cond_0', 'elseB', 'cond_0-output-1'),
                    createEdge('trueTarget', 'join_0'),
                    createEdge('elseA', 'join_0'),
                    createEdge('elseB', 'join_0')
                ]
            )

            // Also verify legacy helper uses filter instead of find
            expect(
                determineNodesToIgnore(
                    flow.nodes[1],
                    { output: { conditions: [{ isFulfilled: true }, { isFulfilled: false }] } },
                    flow.edges,
                    'cond_0'
                )
            ).toEqual(['elseA', 'elseB'])

            const makeFactory = (executed: string[]) =>
                createMockNodeFactory({
                    trueTarget: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'T' }, state: { res: 'T' } }
                    },
                    elseA: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'EA' }, state: { ea: 'yes' } }
                    },
                    elseB: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'EB' }, state: { eb: 'yes' } }
                    },
                    join_0: async (nd, _inp, options) => {
                        executed.push(nd.id)
                        const s = options.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `${s.res ?? ''}:${s.ea ?? ''}:${s.eb ?? ''}` }, state: s }
                    }
                })

            const execTrue: string[] = []
            const resTrue = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'go-true' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: makeFactory(execTrue)
            })
            expect(resTrue.text).toBe('T::')
            expect(execTrue).not.toContain('elseA')
            expect(execTrue).not.toContain('elseB')

            const execElse: string[] = []
            const resElse = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'go-else' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: makeFactory(execElse)
            })
            expect(resElse.text).toBe(':yes:yes')
            expect(execElse).not.toContain('trueTarget')
            expect(execElse).toContain('elseA')
            expect(execElse).toContain('elseB')
        })

        it('executes captured baseline flow 03-condition-multi-edge-fanout.json skipping BOTH Else targets', async () => {
            const baselineFlow = loadBaselineFlow('03-condition-multi-edge-fanout.json')
            const res = await runTestAgentFlow({
                chatflow: createChatflow(baselineFlow),
                incomingInput: { question: 'go-true' },
                componentNodes: realComponentNodes
            })

            const executedIds = res.agentFlowExecutedData.map((d: any) => d.nodeId)
            expect(executedIds).toEqual(['startAgentflow_0', 'conditionAgentflow_0', 'directReplyAgentflow_0'])
            expect(executedIds).not.toContain('directReplyAgentflow_1')
            expect(executedIds).not.toContain('directReplyAgentflow_2')
            expect(res.text).toBe('True branch executed cleanly.')
        })
    })

    describe('5. Topology D: Nested conditions & diamond joins', () => {
        it('executes all 3 branch paths in nested Cond1 -> Cond2 -> [A, B], Cond1 -> D -> Join without deadlock', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'cond1',
                        'conditionAgentflow',
                        { inputs: { conditions: [{ type: 'string', value1: '{{ question }}', operation: 'startsWith', value2: 'c1T' }] } },
                        realComponentNodes
                    ),
                    createNode(
                        'cond2',
                        'conditionAgentflow',
                        { inputs: { conditions: [{ type: 'string', value1: '{{ question }}', operation: 'contains', value2: 'c2T' }] } },
                        realComponentNodes
                    ),
                    createNode('A', 'mockLeaf'),
                    createNode('B', 'mockLeaf'),
                    createNode('D', 'mockLeaf'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond1'),
                    createEdge('cond1', 'cond2', 'cond1-output-0'),
                    createEdge('cond1', 'D', 'cond1-output-1'),
                    createEdge('cond2', 'A', 'cond2-output-0'),
                    createEdge('cond2', 'B', 'cond2-output-1'),
                    createEdge('A', 'join_0'),
                    createEdge('B', 'join_0'),
                    createEdge('D', 'join_0')
                ]
            )

            const runPath = async (question: string) => {
                const executed: string[] = []
                const res = await runTestAgentFlow({
                    flow,
                    incomingInput: { question },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: createMockNodeFactory({
                        A: async (nd) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'A' }, state: { picked: 'A' } }
                        },
                        B: async (nd) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'B' }, state: { picked: 'B' } }
                        },
                        D: async (nd) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: 'D' }, state: { picked: 'D' } }
                        },
                        join_0: async (nd, _inp, options) => {
                            executed.push(nd.id)
                            return { id: nd.id, name: nd.name, output: { content: `J:${options.agentflowRuntime.state.picked}` }, state: {} }
                        }
                    })
                })
                return { res, executed }
            }

            const p1 = await runPath('c1T-c2T')
            expect(p1.res.text).toBe('J:A')
            expect(p1.executed).toEqual(['A', 'join_0'])

            const p2 = await runPath('c1T-c2F')
            expect(p2.res.text).toBe('J:B')
            expect(p2.executed).toEqual(['B', 'join_0'])

            const p3 = await runPath('c1F')
            expect(p3.res.text).toBe('J:D')
            expect(p3.executed).toEqual(['D', 'join_0'])
        })

        it('executes captured baseline flow 02-multi-hop-and-nested-conditions.json across all 3 paths concurrently', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const baselineFlow = loadBaselineFlow('02-multi-hop-and-nested-conditions.json')

            const r1 = await runTestAgentFlow({
                chatflow: createChatflow(baselineFlow),
                incomingInput: { question: 'true branchA' },
                componentNodes: realComponentNodes
            })
            expect(r1.text).toBe('Join reached: parallel=parallel-ok, branch=cond1-true-cond2-A')
            expect(r1.agentFlowExecutedData.filter((d: any) => d.nodeId === 'directReplyAgentflow_0')).toHaveLength(1)

            const r2 = await runTestAgentFlow({
                chatflow: createChatflow(baselineFlow),
                incomingInput: { question: 'true other' },
                componentNodes: realComponentNodes
            })
            expect(r2.text).toBe('Join reached: parallel=parallel-ok, branch=cond1-true-cond2-B')

            const r3 = await runTestAgentFlow({
                chatflow: createChatflow(baselineFlow),
                incomingInput: { question: 'false' },
                componentNodes: realComponentNodes
            })
            expect(r3.text).toBe('Join reached: parallel=parallel-ok, branch=cond1-false-F1-F2')
        })
    })

    describe('6. Topology E: loopAgentflow subgraph reset, external settled inputs, & race defenses', () => {
        it('resets loop body over parallel branches & conditions while preserving external settled inputs', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // Start -> ExtPre (runs ONCE) -> BodyJoin
            // Start -> Entry -> [WorkerA, CondInner --(T)-> InnerT / --(F)-> InnerF -> BodyJoin]
            // BodyJoin -> LoopCheck --(0)-> Loop(to Entry) / --(1)-> ExitReply
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('extPre', 'mockExt'),
                    createNode('entry', 'mockEntry'),
                    createNode('workerA', 'mockWorker'),
                    createNode('condInner', 'conditionAgentflow'),
                    createNode('innerT', 'mockInner'),
                    createNode('innerF', 'mockInner'),
                    createNode('bodyJoin', 'mockJoin'),
                    createNode('loopCheck', 'conditionAgentflow'),
                    createNode(
                        'loop_0',
                        'loopAgentflow',
                        { inputs: { loopBackToNode: 'entry-Entry', maxLoopCount: 5 } },
                        realComponentNodes
                    ),
                    createNode('exitReply', 'mockExit')
                ],
                [
                    createEdge('start_0', 'extPre'),
                    createEdge('start_0', 'entry'),
                    createEdge('extPre', 'bodyJoin'),
                    createEdge('entry', 'workerA'),
                    createEdge('entry', 'condInner'),
                    createEdge('condInner', 'innerT', 'condInner-output-0'),
                    createEdge('condInner', 'innerF', 'condInner-output-1'),
                    createEdge('innerT', 'bodyJoin'),
                    createEdge('innerF', 'bodyJoin'),
                    createEdge('workerA', 'bodyJoin'),
                    createEdge('bodyJoin', 'loopCheck'),
                    createEdge('loopCheck', 'loop_0', 'loopCheck-output-0'),
                    createEdge('loopCheck', 'exitReply', 'loopCheck-output-1')
                ]
            )

            let extCount = 0
            let iterCount = 0
            const joinSnapshots: Array<Record<string, any>> = []

            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'loop-ext' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    extPre: async (nd, _inp, options) => {
                        extCount += 1
                        return { id: nd.id, name: nd.name, output: { content: 'ext-val' }, state: { ...options.agentflowRuntime.state, ext: 'settled' } }
                    },
                    entry: async (nd) => {
                        iterCount += 1
                        return { id: nd.id, name: nd.name, output: { content: `iter-${iterCount}` } }
                    },
                    workerA: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `w-${iterCount}` },
                        state: { ...options.agentflowRuntime.state, worker: `w-${iterCount}` }
                    }),
                    condInner: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: {
                            conditions: iterCount === 1 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                        }
                    }),
                    innerT: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: 'T' },
                        state: { ...options.agentflowRuntime.state, inner: 'T' }
                    }),
                    innerF: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: 'F' },
                        state: { ...options.agentflowRuntime.state, inner: 'F' }
                    }),
                    bodyJoin: async (nd, _input, options) => {
                        joinSnapshots.push({
                            hasExt: options.agentflowRuntime.state.ext === 'settled',
                            extInput: options.agentflowRuntime.state.ext,
                            inner: options.agentflowRuntime.state.inner,
                            worker: options.agentflowRuntime.state.worker
                        })
                        return { id: nd.id, name: nd.name, output: { content: 'joined' } }
                    },
                    loopCheck: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: {
                            conditions: iterCount < 2 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                        }
                    }),
                    exitReply: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `done:${iterCount}:${options.agentflowRuntime.state.ext}:${options.agentflowRuntime.state.inner}` }
                    })
                })
            })

            expect(extCount).toBe(1)
            expect(iterCount).toBe(2)
            expect(joinSnapshots).toEqual([
                { hasExt: true, extInput: 'settled', inner: 'T', worker: 'w-1' },
                { hasExt: true, extInput: 'settled', inner: 'F', worker: 'w-2' }
            ])
            expect(res.text).toBe('done:2:settled:F')

            // Also verify DependencyEngine queue inputs preserve external settled input across loop resets
            const unitEngine = createDependencyEngine({ nodes: flow.nodes, edges: flow.edges, startingNodeIds: ['start_0'] })
            const unitQueue = unitEngine.getInitialQueue()
            const unitLoops = new Map<string, number>()
            unitQueue.shift()
            unitEngine.processNodeCompletion({
                nodeId: 'start_0',
                nodeName: 'startAgentflow',
                result: { output: { content: 's' } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'extPre',
                nodeName: 'mockExt',
                result: { output: { content: 'ext-val' }, text: 'ext-val' },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'entry',
                nodeName: 'mockEntry',
                result: { output: { content: 'e1' } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'workerA',
                nodeName: 'mockWorker',
                result: { output: { content: 'w1' } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'condInner',
                nodeName: 'conditionAgentflow',
                result: { output: { conditions: [{ isFulfilled: true }, { isFulfilled: false }] } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            const iter1Join = unitEngine.processNodeCompletion({
                nodeId: 'innerT',
                nodeName: 'mockInner',
                result: { output: { content: 't1' } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            expect(Object.keys(iter1Join.newlyReadyNodes.find((n) => n.nodeId === 'bodyJoin')!.inputs).sort()).toEqual([
                'extPre',
                'innerT',
                'workerA'
            ])
            unitEngine.processNodeCompletion({
                nodeId: 'bodyJoin',
                nodeName: 'mockJoin',
                result: { output: { content: 'j1' } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'loopCheck',
                nodeName: 'conditionAgentflow',
                result: { output: { conditions: [{ isFulfilled: true }, { isFulfilled: false }] } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'loop_0',
                nodeName: 'loopAgentflow',
                result: { output: { nodeID: 'entry', maxLoopCount: 5 } },
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            // Re-run iter 2 without re-running extPre; bodyJoin must still receive extPre in inputs
            unitEngine.processNodeCompletion({
                nodeId: 'entry',
                nodeName: 'mockEntry',
                result: { output: { content: 'e2' } },
                epoch: 1,
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'workerA',
                nodeName: 'mockWorker',
                result: { output: { content: 'w2' } },
                epoch: 1,
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            unitEngine.processNodeCompletion({
                nodeId: 'condInner',
                nodeName: 'conditionAgentflow',
                result: { output: { conditions: [{ isFulfilled: false }, { isFulfilled: true }] } },
                epoch: 1,
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            const iter2Join = unitEngine.processNodeCompletion({
                nodeId: 'innerF',
                nodeName: 'mockInner',
                result: { output: { content: 'f2' } },
                epoch: 1,
                nodeExecutionQueue: unitQueue,
                loopCounts: unitLoops,
                chatId: 'c-unit'
            })
            expect(Object.keys(iter2Join.newlyReadyNodes.find((n) => n.nodeId === 'bodyJoin')!.inputs).sort()).toEqual([
                'extPre',
                'innerF',
                'workerA'
            ])
        })

        it('respects explicit maxLoopCount=0 and maxLoopCount=2 on parallel loop body', async () => {
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('bodyA', 'mockBody'),
                    createNode('bodyB', 'mockBody'),
                    createNode('loop_0', 'loopAgentflow')
                ],
                [
                    createEdge('start_0', 'bodyA'),
                    createEdge('start_0', 'bodyB'),
                    createEdge('bodyA', 'loop_0'),
                    createEdge('bodyB', 'loop_0')
                ]
            )

            // maxLoopCount: 0 -> hits limit on iteration 1 immediately
            let count0 = 0
            const res0 = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'zero-max' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    bodyA: async (nd) => {
                        count0 += 1
                        return { id: nd.id, name: nd.name, output: { content: 'A' }, state: {} }
                    },
                    bodyB: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'B' }, state: {} }),
                    loop_0: async (nd) => ({
                        id: nd.id,
                        name: 'loopAgentflow',
                        output: { nodeID: 'bodyA', maxLoopCount: 0, fallbackMessage: 'stopped-at-0' },
                        state: {}
                    })
                })
            })
            expect(count0).toBe(1)
            expect(res0.text).toBe('stopped-at-0')
            expect(res0.agentFlowExecutedData[res0.agentFlowExecutedData.length - 1].data.output.content).toBe('stopped-at-0')

            // maxLoopCount: 2 with target bodyA -> bodyA re-runs twice while external sibling bodyB stays settled at 1 run
            let countAOnly = 0
            let countBOnce = 0
            const resPartial = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'partial-max-2' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    bodyA: async (nd) => {
                        countAOnly += 1
                        return { id: nd.id, name: nd.name, output: { content: `A${countAOnly}` } }
                    },
                    bodyB: async (nd) => {
                        countBOnce += 1
                        return { id: nd.id, name: nd.name, output: { content: `B${countBOnce}` } }
                    },
                    loop_0: async (nd) => ({
                        id: nd.id,
                        name: 'loopAgentflow',
                        output: { nodeID: 'bodyA', maxLoopCount: 2, fallbackMessage: 'stopped-partial-2' }
                    })
                })
            })
            expect(countAOnly).toBe(2)
            expect(countBOnce).toBe(1)
            expect(resPartial.text).toBe('stopped-partial-2')

            // maxLoopCount: 2 targeting forkEntry -> both parallel body nodes execute 2 times before fallback
            const parallelBodyFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('forkEntry', 'mockFork'),
                    createNode('bodyA', 'mockBody'),
                    createNode('bodyB', 'mockBody'),
                    createNode('loop_0', 'loopAgentflow')
                ],
                [
                    createEdge('start_0', 'forkEntry'),
                    createEdge('forkEntry', 'bodyA'),
                    createEdge('forkEntry', 'bodyB'),
                    createEdge('bodyA', 'loop_0'),
                    createEdge('bodyB', 'loop_0')
                ]
            )
            let countA2 = 0
            let countB2 = 0
            const res2 = await runTestAgentFlow({
                flow: parallelBodyFlow,
                incomingInput: { question: 'two-max' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    forkEntry: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'fork' } }),
                    bodyA: async (nd) => {
                        countA2 += 1
                        return { id: nd.id, name: nd.name, output: { content: `A${countA2}` } }
                    },
                    bodyB: async (nd) => {
                        countB2 += 1
                        return { id: nd.id, name: nd.name, output: { content: `B${countB2}` } }
                    },
                    loop_0: async (nd) => ({
                        id: nd.id,
                        name: 'loopAgentflow',
                        output: { nodeID: 'forkEntry', maxLoopCount: 2, fallbackMessage: 'stopped-at-2' }
                    })
                })
            })
            expect(countA2).toBe(2)
            expect(countB2).toBe(2)
            expect(res2.text).toBe('stopped-at-2')
        })

        it('handles nested loops and two parallel loops converging at a downstream join', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // Nested loops: outerEntry -> innerEntry -> innerCond --(0)-> innerLoop(to innerEntry)
            //                                                     \--(1)-> outerCond --(0)-> outerLoop(to outerEntry)
            //                                                                       \--(1)-> finalReply
            const nestedFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('outerEntry', 'mockOuter'),
                    createNode('innerEntry', 'mockInner'),
                    createNode('innerCond', 'conditionAgentflow'),
                    createNode('innerLoop', 'loopAgentflow', { inputs: { loopBackToNode: 'innerEntry-Inner', maxLoopCount: 10 } }, realComponentNodes),
                    createNode('outerCond', 'conditionAgentflow'),
                    createNode('outerLoop', 'loopAgentflow', { inputs: { loopBackToNode: 'outerEntry-Outer', maxLoopCount: 10 } }, realComponentNodes),
                    createNode('finalReply', 'mockFinal')
                ],
                [
                    createEdge('start_0', 'outerEntry'),
                    createEdge('outerEntry', 'innerEntry'),
                    createEdge('innerEntry', 'innerCond'),
                    createEdge('innerCond', 'innerLoop', 'innerCond-output-0'),
                    createEdge('innerCond', 'outerCond', 'innerCond-output-1'),
                    createEdge('outerCond', 'outerLoop', 'outerCond-output-0'),
                    createEdge('outerCond', 'finalReply', 'outerCond-output-1')
                ]
            )

            let outerRuns = 0
            let innerRunsThisOuter = 0
            let totalInnerRuns = 0
            const nestedRes = await runTestAgentFlow({
                flow: nestedFlow,
                incomingInput: { question: 'nested' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    outerEntry: async (nd, _inp, options) => {
                        outerRuns += 1
                        innerRunsThisOuter = 0
                        return { id: nd.id, name: nd.name, output: { content: 'o' }, state: options.agentflowRuntime.state }
                    },
                    innerEntry: async (nd, _inp, options) => {
                        innerRunsThisOuter += 1
                        totalInnerRuns += 1
                        return { id: nd.id, name: nd.name, output: { content: 'i' }, state: options.agentflowRuntime.state }
                    },
                    innerCond: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: {
                            conditions: innerRunsThisOuter < 2 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                        }
                    }),
                    outerCond: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: {
                            conditions: outerRuns < 2 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                        }
                    }),
                    finalReply: async (nd) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `outer=${outerRuns};inner=${totalInnerRuns}` }
                    })
                })
            })
            expect(nestedRes.text).toBe('outer=2;inner=4')

            // Parallel independent loops merging at downstream Join
            const parLoopsFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('body1', 'mockB1'),
                    createNode('cond1', 'conditionAgentflow'),
                    createNode('loop1', 'loopAgentflow', { inputs: { loopBackToNode: 'body1-B1', maxLoopCount: 5 } }, realComponentNodes),
                    createNode('body2', 'mockB2'),
                    createNode('cond2', 'conditionAgentflow'),
                    createNode('loop2', 'loopAgentflow', { inputs: { loopBackToNode: 'body2-B2', maxLoopCount: 5 } }, realComponentNodes),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'body1'),
                    createEdge('start_0', 'body2'),
                    createEdge('body1', 'cond1'),
                    createEdge('cond1', 'loop1', 'cond1-output-0'),
                    createEdge('cond1', 'join_0', 'cond1-output-1'),
                    createEdge('body2', 'cond2'),
                    createEdge('cond2', 'loop2', 'cond2-output-0'),
                    createEdge('cond2', 'join_0', 'cond2-output-1')
                ]
            )

            let b1Count = 0
            let b2Count = 0
            let joinCount = 0
            const parLoopsRes = await runTestAgentFlow({
                flow: parLoopsFlow,
                incomingInput: { question: 'par-loops' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    body1: async (nd, _inp, options) => {
                        b1Count += 1
                        return { id: nd.id, name: nd.name, output: { content: `b1-${b1Count}` }, state: { ...options.agentflowRuntime.state, b1: b1Count } }
                    },
                    cond1: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: { conditions: b1Count < 2 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }] }
                    }),
                    body2: async (nd, _inp, options) => {
                        b2Count += 1
                        return { id: nd.id, name: nd.name, output: { content: `b2-${b2Count}` }, state: { ...options.agentflowRuntime.state, b2: b2Count } }
                    },
                    cond2: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: { conditions: b2Count < 3 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }] }
                    }),
                    join_0: async (nd, _inp, options) => {
                        joinCount += 1
                        const s = options.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `joined:${s.b1}:${s.b2}` }, state: s }
                    }
                })
            })
            expect(joinCount).toBe(1)
            expect(parLoopsRes.text).toBe('joined:2:3')
        })

        it('defers loop-exit joins merging external or side branches so ExitReply does not fire prematurely before Loop resets', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // Counterexample A & B combined:
            // Start -> FastExt -> ExitReply (y=0 so ExitReply sorts before Loop!)
            // Start -> Entry -> [Side -> ExitReply, Cond --(0)-> Loop(to Entry), Cond --(1)-> ExitReply]
            const makeFlow = (withStaticTarget: boolean) =>
                createFlow(
                    [
                        createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                        createNode('fastExt', 'mockExt', { position: { x: 100, y: 0 } }),
                        createNode('entry', 'mockEntry', { position: { x: 100, y: 100 } }),
                        createNode('side', 'mockSide', { position: { x: 200, y: 100 } }),
                        createNode('cond_0', 'conditionAgentflow', { position: { x: 200, y: 200 } }),
                        createNode(
                            'loop_0',
                            'loopAgentflow',
                            {
                                position: { x: 300, y: 300 },
                                inputs: withStaticTarget ? { loopBackToNode: 'entry-Entry', maxLoopCount: 5 } : {}
                            },
                            realComponentNodes
                        ),
                        createNode('exitReply', 'mockExit', { position: { x: 300, y: -50 } })
                    ],
                    [
                        createEdge('start_0', 'fastExt'),
                        createEdge('start_0', 'entry'),
                        createEdge('fastExt', 'exitReply'),
                        createEdge('entry', 'side'),
                        createEdge('entry', 'cond_0'),
                        createEdge('side', 'exitReply'),
                        createEdge('cond_0', 'loop_0', 'cond_0-output-0'),
                        createEdge('cond_0', 'exitReply', 'cond_0-output-1')
                    ]
                )

            for (const withStaticTarget of [true, false]) {
                let iter = 0
                let exitRuns = 0
                const res = await runTestAgentFlow({
                    flow: makeFlow(withStaticTarget),
                    incomingInput: { question: 'no-early-exit' },
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: createMockNodeFactory({
                        fastExt: async (nd, _inp, options) => ({
                            id: nd.id,
                            name: nd.name,
                            output: { content: 'ext' },
                            state: { ...options.agentflowRuntime.state, ext: 'ok' }
                        }),
                        entry: async (nd) => {
                            iter += 1
                            return { id: nd.id, name: nd.name, output: { content: `e-${iter}` } }
                        },
                        side: async (nd, _inp, options) => ({
                            id: nd.id,
                            name: nd.name,
                            output: { content: `s-${iter}` },
                            state: { ...options.agentflowRuntime.state, side: `s-${iter}` }
                        }),
                        cond_0: async (nd) => ({
                            id: nd.id,
                            name: 'conditionAgentflow',
                            output: {
                                conditions: iter === 1 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                            }
                        }),
                        loop_0: async (nd) => ({
                            id: nd.id,
                            name: 'loopAgentflow',
                            output: { nodeID: 'entry', maxLoopCount: 4, content: 'looping' }
                        }),
                        exitReply: async (nd, _inp, options) => {
                            exitRuns += 1
                            const s = options.agentflowRuntime.state
                            return { id: nd.id, name: nd.name, output: { content: `exit:${exitRuns}:${s.ext}:${s.side}` } }
                        }
                    })
                })

                expect(iter).toBe(2)
                expect(exitRuns).toBe(1)
                expect(res.text).toBe('exit:1:ok:s-2')
            }

            // Also verify ExitReply releases once if Loop hits maxLoopCount while FastExt activated ExitReply
            let hitMaxExitRuns = 0
            const maxRes = await runTestAgentFlow({
                flow: makeFlow(true),
                incomingInput: { question: 'max-exit' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    fastExt: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'ext' }, state: { ext: 'ok' } }),
                    entry: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'e' }, state: {} }),
                    side: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 's' }, state: {} }),
                    cond_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: { conditions: [{ isFulfilled: true }, { isFulfilled: false }] },
                        state: {}
                    }),
                    loop_0: async (nd) => ({
                        id: nd.id,
                        name: 'loopAgentflow',
                        output: { nodeID: 'entry', maxLoopCount: 2, fallbackMessage: 'maxed' },
                        state: {}
                    }),
                    exitReply: async (nd) => {
                        hitMaxExitRuns += 1
                        return { id: nd.id, name: nd.name, output: { content: `released:${hitMaxExitRuns}` }, state: {} }
                    }
                })
            })
            expect(hitMaxExitRuns).toBe(1)
            // Task 05 (D4): both content-bearing terminal leaves (exitReply at y=-50 and loop_0 fallback at y=300) are joined
            expect(maxRes.text).toBe('released:1\n\nmaxed')
        })

        it('waits for PENDING external incoming edges into loop target before launching loop re-entry', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            // Start -> SlowExt -> Target -> Body -> LoopCheck --(0)-> Loop(to Target) / --(1)-> Done
            // Start -> FastSetup -> LoopCheck (external loop trigger on iter 1, Wait: make Loop triggered by FastSetup on iter 1 while SlowExt -> Target is PENDING!)
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('slowExt', 'mockSlow'),
                    createNode('fastTrigger', 'mockFast'),
                    createNode('target_0', 'mockTarget'),
                    createNode('loop_0', 'loopAgentflow', { inputs: { loopBackToNode: 'target_0-Target', maxLoopCount: 2 } }, realComponentNodes)
                ],
                [
                    createEdge('start_0', 'slowExt'),
                    createEdge('start_0', 'fastTrigger'),
                    createEdge('slowExt', 'target_0'),
                    createEdge('fastTrigger', 'loop_0')
                ]
            )

            const fastRan = createDeferred<void>()
            const slowFinishGate = createDeferred<void>()
            const order: string[] = []
            let targetObservedSlowState: any

            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'pending-ext-target' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    fastTrigger: async (nd) => {
                        order.push('fastTrigger')
                        return { id: nd.id, name: nd.name, output: { content: 'fast' }, state: {} }
                    },
                    loop_0: async (nd) => {
                        order.push('loop_0')
                        fastRan.resolve()
                        return {
                            id: nd.id,
                            name: 'loopAgentflow',
                            output: { nodeID: 'target_0', maxLoopCount: 2, content: 'looping' },
                            state: {}
                        }
                    },
                    slowExt: async (nd) => {
                        await slowFinishGate.promise
                        order.push('slowExt')
                        return { id: nd.id, name: nd.name, output: { content: 'slow-done' }, state: { fromSlow: 'arrived' } }
                    },
                    target_0: async (nd, _inp, options) => {
                        order.push('target_0')
                        targetObservedSlowState = options.agentflowRuntime.state.fromSlow
                        return { id: nd.id, name: nd.name, output: { content: `saw:${targetObservedSlowState}` }, state: {} }
                    }
                })
            })

            await fastRan.promise
            await new Promise((r) => setTimeout(r, 20))
            // Loop already ran while slowExt is pending -> target_0 MUST NOT have launched yet
            expect(order).not.toContain('target_0')

            slowFinishGate.resolve()
            const res = await runPromise
            expect(order).toEqual(['fastTrigger', 'loop_0', 'slowExt', 'target_0'])
            expect(targetObservedSlowState).toBe('arrived')
            expect(res.text).toBe('saw:arrived')
        })

        it('ignores stale epoch completions from in-flight loop-body siblings without corrupting state or executedData', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            // Entry -> Fast -> Cond --(0)-> Loop(to Entry) / --(1)-> Exit
            // Entry -> SlowSide (not joined to Loop; finishes late in epoch 0 after Loop already moved to epoch 1)
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('entry', 'mockEntry'),
                    createNode('fast', 'mockFast'),
                    createNode('slowSide', 'mockSlow'),
                    createNode('cond_0', 'conditionAgentflow'),
                    createNode('loop_0', 'loopAgentflow', { inputs: { loopBackToNode: 'entry-Entry', maxLoopCount: 3 } }, realComponentNodes),
                    createNode('exitReply', 'mockExit')
                ],
                [
                    createEdge('start_0', 'entry'),
                    createEdge('entry', 'fast'),
                    createEdge('entry', 'slowSide'),
                    createEdge('fast', 'cond_0'),
                    createEdge('cond_0', 'loop_0', 'cond_0-output-0'),
                    createEdge('cond_0', 'exitReply', 'cond_0-output-1')
                ]
            )

            let entryIter = 0
            const slow0Entered = createDeferred<void>()
            const releaseSlow0 = createDeferred<void>()
            const iter2Started = createDeferred<void>()

            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'stale-epoch' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    entry: async (nd, _inp, options) => {
                        entryIter += 1
                        if (entryIter === 2) iter2Started.resolve()
                        return { id: nd.id, name: nd.name, output: { content: `iter-${entryIter}` }, state: { ...options.agentflowRuntime.state, iter: entryIter } }
                    },
                    fast: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'fast' } }),
                    slowSide: async (nd, _inp, options) => {
                        const myIter = entryIter
                        if (myIter === 1) {
                            slow0Entered.resolve()
                            await releaseSlow0.promise
                            return {
                                id: nd.id,
                                name: nd.name,
                                output: { content: 'STALE-EPOCH-0' },
                                state: { ...options.agentflowRuntime.state, corruptedByStale: true }
                            }
                        }
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: 'FRESH-EPOCH-1' },
                            state: { ...options.agentflowRuntime.state, corruptedByStale: false }
                        }
                    },
                    cond_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentflow',
                        output: {
                            conditions: entryIter === 1 ? [{ isFulfilled: true }, { isFulfilled: false }] : [{ isFulfilled: false }, { isFulfilled: true }]
                        }
                    }),
                    exitReply: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `stale=${String(options.agentflowRuntime.state.corruptedByStale)}` },
                        state: options.agentflowRuntime.state
                    })
                })
            })

            await slow0Entered.promise
            await iter2Started.promise
            // Release epoch 0 slowSide AFTER epoch 1 already began
            releaseSlow0.resolve()

            const res = await runPromise
            const slowRecords = res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'slowSide')
            expect(slowRecords.map((r: any) => r.data.output.content)).toEqual(['FRESH-EPOCH-1'])
            // Task 05 (D4): slowSide (level=2) and exitReply (level=4) are both content-bearing terminal leaves
            expect(res.text).toBe('FRESH-EPOCH-1\n\nstale=false')
        })

        it('executes captured baseline flow 06-loop-over-parallel-subgraph.json concurrently and exits with exact counts', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const baselineFlow = loadBaselineFlow('06-loop-over-parallel-subgraph.json')
            const res = await runTestAgentFlow({
                chatflow: createChatflow(baselineFlow),
                incomingInput: { question: 'loop-baseline' },
                componentNodes: realComponentNodes
            })

            expect(res.text).toBe('Loop exited at loop_count=2; iterA=A,A,A; iterB=B,B,B')
            expect(res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'customFunctionAgentflow_1')).toHaveLength(3)
            expect(res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'customFunctionAgentflow_2')).toHaveLength(3)
            expect(res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'directReplyAgentflow_0')).toHaveLength(1)
        })
    })

    describe('7. Disconnected unused canvas nodes & multi-start validation', () => {
        it('pre-skips isolated nodes and disconnected chains wired into active joins without skewing topological levels', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('activeA', 'mockActive'),
                    createNode('join_0', 'mockJoin'),
                    createNode('isolated_0', 'mockUnused'),
                    createNode('dead_0', 'mockDead'),
                    createNode('dead_1', 'mockDead'),
                    createNode('dead_2', 'mockDead')
                ],
                [
                    createEdge('start_0', 'activeA'),
                    createEdge('activeA', 'join_0'),
                    createEdge('dead_0', 'dead_1'),
                    createEdge('dead_1', 'dead_2'),
                    createEdge('dead_2', 'join_0')
                ]
            )

            // DependencyEngine scopes levels to reachable subgraph -> join_0 level is 2 (not 3 from dead_0..dead_2)
            const engine = createDependencyEngine({
                nodes: flow.nodes,
                edges: flow.edges,
                startingNodeIds: ['start_0']
            })
            expect(engine.getLevels()).toEqual({ start_0: 0, activeA: 1, join_0: 2 })
            expect(engine.getNodeState('isolated_0')).toBe('SKIPPED')
            expect(engine.getNodeState('dead_2')).toBe('SKIPPED')

            const executed: string[] = []
            const res = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'disconnected' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    activeA: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'active' }, state: {} }
                    },
                    join_0: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'joined-clean' }, state: {} }
                    },
                    isolated_0: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'bad' }, state: {} }
                    },
                    dead_0: async (nd) => {
                        executed.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'bad' }, state: {} }
                    }
                })
            })

            expect(executed).toEqual(['activeA', 'join_0'])
            expect(res.text).toBe('joined-clean')
        })
    })

    describe('8. Mid-graph HumanInput resumption (startNodeId !== startAgentflow)', () => {
        it('pre-settles completed parallel branch, upstream conditions, and joins cleanly on proceed & reject', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'cond_0',
                        'conditionAgentflow',
                        { inputs: { conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: 'routeA' }] } },
                        realComponentNodes
                    ),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Approve?' } },
                        realComponentNodes
                    ),
                    createNode('skippedRoute', 'mockSkip'),
                    createNode('parSibling', 'mockPar'),
                    createNode('approved_0', 'mockBranch'),
                    createNode('rejected_0', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'cond_0'),
                    createEdge('start_0', 'parSibling'),
                    createEdge('cond_0', 'human_0', 'cond_0-output-0'),
                    createEdge('cond_0', 'skippedRoute', 'cond_0-output-1'),
                    createEdge('human_0', 'approved_0', 'human_0-output-0'),
                    createEdge('human_0', 'rejected_0', 'human_0-output-1'),
                    createEdge('approved_0', 'join_0'),
                    createEdge('rejected_0', 'join_0'),
                    createEdge('skippedRoute', 'join_0'),
                    createEdge('parSibling', 'join_0')
                ]
            )

            const { appDataSource, executions } = createMockDataSource()
            let parRuns = 0
            let joinObservedState: Record<string, any> = {}
            const factory = createMockNodeFactory({
                parSibling: async (nd, _inp, options) => {
                    parRuns += 1
                    return { id: nd.id, name: nd.name, output: { content: 'par-data' }, state: { ...options.agentflowRuntime.state, par: 'fromPar' } }
                },
                skippedRoute: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'bad' } }),
                approved_0: async (nd, _inp, options) => ({
                    id: nd.id,
                    name: nd.name,
                    output: { content: 'app-data' },
                    state: { ...options.agentflowRuntime.state, choice: 'approved' }
                }),
                rejected_0: async (nd, _inp, options) => ({
                    id: nd.id,
                    name: nd.name,
                    output: { content: 'rej-data' },
                    state: { ...options.agentflowRuntime.state, choice: 'rejected' }
                }),
                join_0: async (nd, _inp, options) => {
                    const s = options.agentflowRuntime.state
                    joinObservedState = { ...s }
                    return { id: nd.id, name: nd.name, output: { content: `${s.par}:${s.choice}` }, state: s }
                }
            })

            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'routeA', overrideConfig: { sessionId: 'sess-mid-join' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[0]?.state === 'STOPPED')
            expect(parRuns).toBe(1)

            const resumed = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'ok' },
                    overrideConfig: { sessionId: 'sess-mid-join' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })

            expect(parRuns).toBe(1) // Must NOT re-execute parSibling on resume!
            expect(joinObservedState).toEqual({ par: 'fromPar', choice: 'approved' })
            expect(resumed.text).toBe('fromPar:approved')
            expect(executions[0].state).toBe('FINISHED')

            // Also verify reject resume path on a fresh session
            parRuns = 0
            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'routeA', overrideConfig: { sessionId: 'sess-mid-join-reject' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[1]?.state === 'STOPPED')
            expect(parRuns).toBe(1)

            const resumedReject = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'reject', startNodeId: 'human_0', feedback: 'no' },
                    overrideConfig: { sessionId: 'sess-mid-join-reject' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })

            expect(parRuns).toBe(1)
            expect(resumedReject.text).toBe('fromPar:rejected')
            expect(executions[1].state).toBe('FINISHED')
        })

        it('schedules unexecuted ready sibling branches when Run 1 stopped early at concurrency=1', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { position: { x: 200, y: 0 }, inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Gate?' } },
                        realComponentNodes
                    ),
                    createNode('parSibling', 'mockPar', { position: { x: 200, y: 200 } }),
                    createNode('afterHuman', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'human_0'),
                    createEdge('start_0', 'parSibling'),
                    createEdge('human_0', 'afterHuman', 'human_0-output-0'),
                    createEdge('afterHuman', 'join_0'),
                    createEdge('parSibling', 'join_0')
                ]
            )

            const { appDataSource, executions } = createMockDataSource()
            const ranOnResume: string[] = []
            let parRan = 0

            const factory = createMockNodeFactory({
                parSibling: async (nd, _inp, options) => {
                    parRan += 1
                    ranOnResume.push(nd.id)
                    return { id: nd.id, name: nd.name, output: { content: 'par' }, state: { ...options.agentflowRuntime.state, par: 'ran' } }
                },
                afterHuman: async (nd, _inp, options) => {
                    ranOnResume.push(nd.id)
                    return { id: nd.id, name: nd.name, output: { content: 'aft' }, state: { ...options.agentflowRuntime.state, aft: 'ran' } }
                },
                join_0: async (nd, _inp, options) => {
                    ranOnResume.push(nd.id)
                    const s = options.agentflowRuntime.state
                    return { id: nd.id, name: nd.name, output: { content: `${s.aft}+${s.par}` }, state: s }
                }
            })

            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'seq-stop', overrideConfig: { sessionId: 'sess-seq-stop' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[0]?.state === 'STOPPED')
            expect(parRan).toBe(0) // human_0 stopped before parSibling ran

            ranOnResume.length = 0
            const res = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'go' },
                    overrideConfig: { sessionId: 'sess-seq-stop' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })

            expect(parRan).toBe(1)
            expect(ranOnResume).toContain('parSibling')
            expect(ranOnResume).toContain('afterHuman')
            expect(ranOnResume[ranOnResume.length - 1]).toBe('join_0')
            expect(res.text).toBe('ran+ran')
        })

        it('handles multi-turn HumanInput inside loopAgentflow and ignores iteration child records during replay', async () => {
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('body_0', 'mockBody'),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Accept?' } },
                        realComponentNodes
                    ),
                    createNode('exit_0', 'mockExit'),
                    createNode('loop_0', 'loopAgentflow', { inputs: { loopBackToNode: 'body_0-Body', maxLoopCount: 4 } }, realComponentNodes),
                    createNode('iterChild', 'mockIterChild', { parentNode: 'body_0', extent: 'parent' })
                ],
                [
                    createEdge('start_0', 'body_0'),
                    createEdge('body_0', 'human_0'),
                    createEdge('human_0', 'exit_0', 'human_0-output-0'),
                    createEdge('human_0', 'loop_0', 'human_0-output-1')
                ]
            )

            // Unit check: parentNodeId and extent:'parent' records in executedData must not leak into outer reachability/levels
            const executedWithChild: IAgentflowExecutedData[] = [
                { nodeId: 'start_0', nodeLabel: 'Start', previousNodeIds: [], data: { output: {} } as any, status: 'FINISHED' },
                {
                    nodeId: 'iterChild',
                    nodeLabel: 'IterChild',
                    previousNodeIds: [],
                    data: { parentNodeId: 'body_0', output: {} } as any,
                    status: 'FINISHED'
                },
                { nodeId: 'body_0', nodeLabel: 'Body', previousNodeIds: ['start_0'], data: { output: {} } as any, status: 'FINISHED' },
                { nodeId: 'human_0', nodeLabel: 'Human', previousNodeIds: ['body_0'], data: { output: {} } as any, status: 'STOPPED' }
            ]
            const engineCheck = createDependencyEngine({
                nodes: flow.nodes,
                edges: flow.edges,
                startingNodeIds: ['human_0'],
                executedData: executedWithChild,
                isResuming: true
            })
            expect(engineCheck.getNodeState('iterChild')).toBe('SKIPPED')
            expect(engineCheck.getLevels().iterChild).toBeUndefined()

            // End-to-end 3-turn HumanInput + Loop: Turn 1 stops -> Turn 2 rejects & loops -> Turn 3 proceeds -> exit
            const { appDataSource, executions } = createMockDataSource()
            let bodyCount = 0
            const factory = createMockNodeFactory({
                body_0: async (nd) => {
                    bodyCount += 1
                    return { id: nd.id, name: nd.name, output: { content: `b-${bodyCount}` }, state: { tries: bodyCount } }
                },
                exit_0: async (nd, _inp, options) => ({
                    id: nd.id,
                    name: nd.name,
                    output: { content: `accepted-after-${options.agentflowRuntime.state.tries}` },
                    state: {}
                })
            })

            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'start', overrideConfig: { sessionId: 'sess-loop-hitl' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[0]?.state === 'STOPPED')
            expect(bodyCount).toBe(1)

            // Reject -> loops back to body_0 -> stops again at human_0
            await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'reject', startNodeId: 'human_0', feedback: 'retry' },
                    overrideConfig: { sessionId: 'sess-loop-hitl' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[0]?.state === 'STOPPED' && bodyCount === 2)
            expect(bodyCount).toBe(2)

            // Proceed -> exits loop cleanly
            const finalRes = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'looks good' },
                    overrideConfig: { sessionId: 'sess-loop-hitl' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            expect(finalRes.text).toBe('accepted-after-2')
            expect(executions[0].state).toBe('FINISHED')
        })

        it('does not resurrect currentHumanInput or bypass downstream humanInputAgentflow pause during concurrent mid-graph resume (Reviewer #2 Finding #1)', async () => {
            // Start -> [human_0, parSibling -> human_1] -> afterH0/afterH1 -> join_0
            // Turn 1 (concurrency=1): stops at human_0 (parSibling unexecuted)
            // Turn 2 (concurrency=4): resumes human_0 concurrently with parSibling -> human_1; human_1 MUST pause (STOPPED) regardless of completion order!
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { position: { x: 200, y: 0 }, inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Gate 0?' } },
                        realComponentNodes
                    ),
                    createNode('parSibling', 'mockPar', { position: { x: 200, y: 200 } }),
                    createNode(
                        'human_1',
                        'humanInputAgentflow',
                        { position: { x: 400, y: 200 }, inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Gate 1?' } },
                        realComponentNodes
                    ),
                    createNode('afterH0', 'mockAfter'),
                    createNode('afterH1', 'mockAfter'),
                    createNode('rejectH1', 'mockReject'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'human_0'),
                    createEdge('start_0', 'parSibling'),
                    createEdge('human_0', 'afterH0', 'human_0-output-0'),
                    createEdge('parSibling', 'human_1'),
                    createEdge('human_1', 'afterH1', 'human_1-output-0'),
                    createEdge('human_1', 'rejectH1', 'human_1-output-1'),
                    createEdge('afterH0', 'join_0'),
                    createEdge('afterH1', 'join_0'),
                    createEdge('rejectH1', 'join_0')
                ]
            )

            for (const mode of ['human0First', 'parFirstBeforeHuman0Finishes'] as const) {
                process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'
                const { appDataSource, executions } = createMockDataSource()

                const h0CanFinish = createDeferred<void>()
                const parCanFinish = createDeferred<void>()
                let afterH1Runs = 0
                let rejectH1Runs = 0

                const factory = createMockNodeFactory({
                    parSibling: async (nd, _inp, options) => {
                        if (mode === 'human0First') {
                            await parCanFinish.promise
                        }
                        return { id: nd.id, name: nd.name, output: { content: 'par' }, state: { ...options.agentflowRuntime.state, par: 'done' } }
                    },
                    afterH0: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: 'h0-ok' },
                        state: { ...options.agentflowRuntime.state, h0: 'yes' }
                    }),
                    afterH1: async (nd, _inp, options) => {
                        afterH1Runs += 1
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: 'h1-ok' },
                            state: { ...options.agentflowRuntime.state, h1: 'yes' }
                        }
                    },
                    rejectH1: async (nd) => {
                        rejectH1Runs += 1
                        return { id: nd.id, name: nd.name, output: { content: 'h1-rej' } }
                    },
                    join_0: async (nd, _inp, options) => {
                        const s = options.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `${s.par}:${s.h0}:${s.h1}` }, state: s }
                    }
                })

                await runTestAgentFlow({
                    flow,
                    incomingInput: { question: 'multi-gate', overrideConfig: { sessionId: `sess-${mode}` } },
                    appDataSource,
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: factory
                })
                await waitUntil(() => executions[0]?.state === 'STOPPED')

                process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
                if (mode === 'human0First') {
                    // human_0 finishes immediately, THEN parSibling finishes (must NOT resurrect humanInput) -> human_1 pauses
                    setTimeout(() => parCanFinish.resolve(), 15)
                } else {
                    // parSibling finishes fast and launches human_1 while human_0 is still running
                    setTimeout(() => h0CanFinish.resolve(), 15)
                }

                await runTestAgentFlow({
                    flow,
                    incomingInput: {
                        humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'go0' },
                        overrideConfig: { sessionId: `sess-${mode}` }
                    },
                    appDataSource,
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: createMockNodeFactory({
                        human_0: async (nd, inp, opts) => {
                            if (mode === 'parFirstBeforeHuman0Finishes') await h0CanFinish.promise
                            return (realComponentNodes.humanInputAgentflow as any).run(nd, inp, opts)
                        },
                        parSibling: async (nd, _inp, options) => {
                            if (mode === 'human0First') await parCanFinish.promise
                            return { id: nd.id, name: nd.name, output: { content: 'par' }, state: { ...options.agentflowRuntime.state, par: 'done' } }
                        },
                        afterH0: async (nd, _inp, options) => ({
                            id: nd.id,
                            name: nd.name,
                            output: { content: 'h0-ok' },
                            state: { ...options.agentflowRuntime.state, h0: 'yes' }
                        }),
                        afterH1: async (nd, _inp, options) => {
                            afterH1Runs += 1
                            return {
                                id: nd.id,
                                name: nd.name,
                                output: { content: 'h1-ok' },
                                state: { ...options.agentflowRuntime.state, h1: 'yes' }
                            }
                        },
                        rejectH1: async (nd) => {
                            rejectH1Runs += 1
                            return { id: nd.id, name: nd.name, output: { content: 'h1-rej' } }
                        },
                        join_0: async (nd, _inp, options) => {
                            const s = options.agentflowRuntime.state
                            return { id: nd.id, name: nd.name, output: { content: `${s.par}:${s.h0}:${s.h1}` }, state: s }
                        }
                    })
                })

                // Turn 2 MUST stop at human_1 and MUST NOT bypass into afterH1/rejectH1!
                await waitUntil(() => executions[0]?.state === 'STOPPED')
                expect(executions[0].state).toBe('STOPPED')
                expect(afterH1Runs).toBe(0)
                expect(rejectH1Runs).toBe(0)

                // Turn 3: resume human_1 cleanly (also testing omitted startNodeId auto-detection!)
                const finalRes = await runTestAgentFlow({
                    flow,
                    incomingInput: {
                        humanInput: { type: 'proceed', feedback: 'go1' } as any,
                        overrideConfig: { sessionId: `sess-${mode}` }
                    },
                    appDataSource,
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: factory
                })
                expect(afterH1Runs).toBe(1)
                expect(rejectH1Runs).toBe(0)
                expect(finalRes.text).toBe('done:yes:yes')
                expect(executions[0].state).toBe('FINISHED')
            }
        })

        it('preserves sibling state before STOPPED and ignores post-STOPPED sibling loop_0 reset on resume (Reviewer #2 Finding #2)', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            // Finding #2a + #2b:
            // Start -> branch_0 -> human_0 -> afterH0
            // Start -> parSibling -> join_0 (afterH0 -> join_0)
            // Start -> fastLoop -> loop_0 (loopBackToNode: 'branch_0', finishes AFTER human_0 stops!)
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('branch_0', 'mockBranch'),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Gate?' } },
                        realComponentNodes
                    ),
                    createNode('parSibling', 'mockPar'),
                    createNode('fastLoop', 'mockFast'),
                    createNode('loop_0', 'loopAgentflow', { inputs: { loopBackToNode: 'branch_0-Branch', maxLoopCount: 3 } }, realComponentNodes),
                    createNode('afterH0', 'mockAfter'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'branch_0'),
                    createEdge('branch_0', 'human_0'),
                    createEdge('human_0', 'afterH0', 'human_0-output-0'),
                    createEdge('start_0', 'parSibling'),
                    createEdge('parSibling', 'join_0'),
                    createEdge('afterH0', 'join_0'),
                    createEdge('start_0', 'fastLoop'),
                    createEdge('fastLoop', 'loop_0')
                ]
            )

            const { appDataSource, executions } = createMockDataSource()
            const parDone = createDeferred<void>()
            const humanStopped = createDeferred<void>()
            let branchRuns = 0

            const factory = createMockNodeFactory({
                branch_0: async (nd, _inp, options) => {
                    branchRuns += 1
                    return { id: nd.id, name: nd.name, output: { content: 'br' }, state: options.agentflowRuntime.state }
                },
                parSibling: async (nd, _inp, options) => {
                    const out = {
                        id: nd.id,
                        name: nd.name,
                        output: { content: 'par-ok' },
                        state: { ...options.agentflowRuntime.state, par: 'preserved' }
                    }
                    setTimeout(() => parDone.resolve(), 0)
                    return out
                },
                human_0: async (nd, inp, opts) => {
                    // Finish AFTER parSibling commits state, so human_0 runs with stale snapshot {} and stops!
                    await parDone.promise
                    const res = await (realComponentNodes.humanInputAgentflow as any).run(nd, inp, opts)
                    setTimeout(() => humanStopped.resolve(), 5)
                    return res
                },
                fastLoop: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'fl' } }),
                loop_0: async (nd) => {
                    // Finishes AFTER human_0 already stopped Turn 1
                    await humanStopped.promise
                    return { id: nd.id, name: 'loopAgentflow', output: { nodeID: 'branch_0', maxLoopCount: 3, content: 'loop' } }
                },
                afterH0: async (nd, _inp, options) => ({
                    id: nd.id,
                    name: nd.name,
                    output: { content: 'aft' },
                    state: { ...options.agentflowRuntime.state, aft: 'done' }
                }),
                join_0: async (nd, _inp, options) => {
                    const s = options.agentflowRuntime.state
                    return { id: nd.id, name: nd.name, output: { content: `${s.par}:${s.aft}` }, state: s }
                }
            })

            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'race-stop-loop', overrideConfig: { sessionId: 'sess-stop-loop' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            await waitUntil(() => executions[0]?.state === 'STOPPED')
            expect(branchRuns).toBe(1)

            // Resume omitting startNodeId (tests auto-detection too) -> branch_0 must NOT re-run and par='preserved' must survive!
            const resumed = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', feedback: 'ok' } as any,
                    overrideConfig: { sessionId: 'sess-stop-loop' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    branch_0: async (nd) => {
                        branchRuns += 1
                        return { id: nd.id, name: nd.name, output: { content: 'br-dup' } }
                    },
                    afterH0: async (nd, _inp, options) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: 'aft' },
                        state: { ...options.agentflowRuntime.state, aft: 'done' }
                    }),
                    join_0: async (nd, _inp, options) => {
                        const s = options.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `${s.par}:${s.aft}` }, state: s }
                    }
                })
            })
            expect(branchRuns).toBe(1)
            expect(resumed.text).toBe('preserved:done')
            expect(executions[0].state).toBe('FINISHED')
        })

        it('routes conditionAgentAgentflow handles (multi-edge fan-out, 0 fulfilled, and 2 fulfilled)', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('condAgent_0', 'conditionAgentAgentflow' as any),
                    createNode('b0A', 'mockBranch'),
                    createNode('b0B', 'mockBranch'),
                    createNode('b1', 'mockBranch'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'condAgent_0'),
                    createEdge('condAgent_0', 'b0A', 'condAgent_0-output-0'),
                    createEdge('condAgent_0', 'b0B', 'condAgent_0-output-0'),
                    createEdge('condAgent_0', 'b1', 'condAgent_0-output-1'),
                    createEdge('b0A', 'join_0'),
                    createEdge('b0B', 'join_0'),
                    createEdge('b1', 'join_0')
                ]
            )

            // 2 fulfilled handles -> b0A, b0B, and b1 all run; join_0 fires ONCE
            let joinCount = 0
            const bothRes = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'both' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    condAgent_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentAgentflow',
                        output: { conditions: [{ isFulfilled: true }, { isFulfilled: true }] }
                    }),
                    b0A: async (nd, _i, o) => ({ id: nd.id, name: nd.name, output: { content: '0A' }, state: { ...o.agentflowRuntime.state, a: 1 } }),
                    b0B: async (nd, _i, o) => ({ id: nd.id, name: nd.name, output: { content: '0B' }, state: { ...o.agentflowRuntime.state, b: 1 } }),
                    b1: async (nd, _i, o) => ({ id: nd.id, name: nd.name, output: { content: '1' }, state: { ...o.agentflowRuntime.state, c: 1 } }),
                    join_0: async (nd, _i, o) => {
                        joinCount += 1
                        const s = o.agentflowRuntime.state
                        return { id: nd.id, name: nd.name, output: { content: `${s.a}:${s.b}:${s.c}` }, state: s }
                    }
                })
            })
            expect(joinCount).toBe(1)
            expect(bothRes.text).toBe('1:1:1')

            // 0 fulfilled handles -> none of b0A, b0B, b1, join_0 execute
            const zeroRes = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'none' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    condAgent_0: async (nd) => ({
                        id: nd.id,
                        name: 'conditionAgentAgentflow',
                        output: { conditions: [{ isFulfilled: false }, { isFulfilled: false }] }
                    }),
                    b0A: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'bad' } }),
                    b0B: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'bad' } }),
                    b1: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'bad' } }),
                    join_0: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'bad' } })
                })
            })
            expect(zeroRes.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'condAgent_0'])
        })
    })

    describe('9. computeTopologicalLevels, compareNodesDeterministically, & edge-key safety', () => {
        it('computes max(parent)+1 on unequal diamonds, ignores sticky notes, scopes startingNodeIds, and survives cycles', () => {
            const nodes = [
                createNode('A', 'startAgentflow'),
                createNode('B', 'customFunctionAgentflow'),
                createNode('C', 'directReplyAgentflow'),
                createNode('D', 'directReplyAgentflow'),
                createNode('sticky', 'stickyNoteAgentflow'),
                createNode('disconnected', 'customFunctionAgentflow')
            ]
            const edges = [
                createEdge('A', 'B'),
                createEdge('A', 'C'),
                createEdge('B', 'C'),
                createEdge('C', 'D'),
                createEdge('sticky', 'D'),
                createEdge('disconnected', 'D')
            ]

            // Full graph without startingNodeIds: disconnected has level 0, D gets max(C+1=3, disconnected+1=1)=3
            expect(computeTopologicalLevels(nodes, edges)).toEqual({
                A: 0,
                B: 1,
                C: 2,
                D: 3,
                disconnected: 0
            })

            // Scoped to ['A']: disconnected excluded, C = 2, D = 3
            expect(computeTopologicalLevels(nodes, edges, ['A'])).toEqual({
                A: 0,
                B: 1,
                C: 2,
                D: 3
            })

            // Malformed cyclic graph terminates cleanly without hanging or NaN
            const cyclicNodes = [createNode('X', 'mock'), createNode('Y', 'mock')]
            const cyclicEdges = [createEdge('X', 'Y'), createEdge('Y', 'X')]
            const cyclicLevels = computeTopologicalLevels(cyclicNodes, cyclicEdges)
            expect(cyclicLevels).toEqual({})
        })

        it('breaks ties deterministically via (executionOrder ?? position.y, level, id) and drives sequential launch order', async () => {
            const nodeZeroOrder = {
                ...createNode('zNode', 'mock', { position: { x: 0, y: 500 } }),
                data: { ...createNode('zNode', 'mock').data, executionOrder: 0 }
            }
            const nodeNegativeY = createNode('negY', 'mock', { position: { x: 0, y: -50 } })
            const nodeSameYA = createNode('aId', 'mock', { position: { x: 0, y: 100 } })
            const nodeSameYB = createNode('bId', 'mock', { position: { x: 0, y: 100 } })
            const levels = { zNode: 5, negY: 2, aId: 2, bId: 1 }

            const sorted = [nodeZeroOrder, nodeSameYA, nodeSameYB, nodeNegativeY].sort((a, b) =>
                compareNodesDeterministically(a, b, levels)
            )
            expect(sorted.map((n) => n.id)).toEqual(['negY', 'zNode', 'bId', 'aId'])

            // End-to-end sequential execution respects explicit executionOrder over position.y
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '1'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    {
                        ...createNode('firstByOrder', 'mock', { position: { x: 0, y: 900 } }),
                        data: { ...createNode('firstByOrder', 'mock').data, executionOrder: 1 } as any
                    },
                    {
                        ...createNode('secondByOrder', 'mock', { position: { x: 0, y: 10 } }),
                        data: { ...createNode('secondByOrder', 'mock').data, executionOrder: 2 } as any
                    },
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'secondByOrder'),
                    createEdge('start_0', 'firstByOrder'),
                    createEdge('firstByOrder', 'join_0'),
                    createEdge('secondByOrder', 'join_0')
                ]
            )

            const order: string[] = []
            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'order' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    firstByOrder: async (nd) => {
                        order.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: '1' }, state: {} }
                    },
                    secondByOrder: async (nd) => {
                        order.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: '2' }, state: {} }
                    },
                    join_0: async (nd) => {
                        order.push(nd.id)
                        return { id: nd.id, name: nd.name, output: { content: 'done' }, state: {} }
                    }
                })
            })
            expect(order).toEqual(['firstByOrder', 'secondByOrder', 'join_0'])
        })

        it('handles edge-ID #idx collisions and duplicate edge object references without deadlocking', () => {
            const nodes = [
                createNode('A', 'startAgentflow'),
                createNode('B', 'mock'),
                createNode('C', 'mock'),
                createNode('D', 'mock')
            ]
            const dupEdge = createEdge('A', 'C', 'A-output', 'e')
            const edges: IReactFlowEdge[] = [
                createEdge('A', 'B', 'A-output', 'e#2_1'),
                createEdge('A', 'B', 'A-output', 'e#2'),
                dupEdge,
                dupEdge,
                createEdge('A', 'D', 'A-output', 'e')
            ]

            // Verify classifyDecisionOutgoingEdges handles multi-edge fan-out, missing isFulfilled, and 0 fulfilled handles
            const fanOutClassified = classifyDecisionOutgoingEdges(
                'cond_0',
                'conditionAgentflow',
                { output: { conditions: [{ isFulfilled: true }, {}] } },
                [
                    createEdge('cond_0', 'T1', 'cond_0-output-0', 'f0'),
                    createEdge('cond_0', 'F1', 'cond_0-output-1', 'f1'),
                    createEdge('cond_0', 'F2', 'cond_0-output-1', 'f2')
                ]
            )
            expect(fanOutClassified.activatedEdges.map((e) => e.target)).toEqual(['T1'])
            expect(fanOutClassified.skippedEdges.map((e) => e.target)).toEqual(['F1', 'F2'])

            const engine = createDependencyEngine({ nodes, edges, startingNodeIds: ['A'] })
            const queue = engine.getInitialQueue()
            expect(queue.map((q) => q.nodeId)).toEqual(['A'])

            const completion = engine.processNodeCompletion({
                nodeId: 'A',
                nodeName: 'startAgentflow',
                result: { output: { content: 'ok' } },
                nodeExecutionQueue: [],
                loopCounts: new Map(),
                chatId: 'c1'
            })
            expect(completion.newlyReadyNodes.map((n) => n.nodeId).sort()).toEqual(['B', 'C', 'D'])
        })
    })

    describe('10. Seeded Randomized DAG Stress Tests (vs Independent Ground-Truth Oracle)', () => {
        interface RandomDagSpec {
            nodes: IReactFlowNode[]
            edges: IReactFlowEdge[]
            conditionResults: Record<string, boolean[]>
            delaysMs: Record<string, number>
            oracleExecuted: Set<string>
            oracleParents: Map<string, Set<string>>
        }

        function generateRandomDag(seed: number): RandomDagSpec {
            const rand = createMulberry32(seed)
            const layerCount = 3 + Math.floor(rand() * 3) // 3..5 hidden layers
            const nodes: IReactFlowNode[] = [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes)
            ]
            const edges: IReactFlowEdge[] = []
            const conditionResults: Record<string, boolean[]> = {}
            const delaysMs: Record<string, number> = {}
            const layers: string[][] = [['start_0']]

            let nodeCounter = 0
            for (let l = 1; l <= layerCount; l += 1) {
                const width = 2 + Math.floor(rand() * 3)
                const layerIds: string[] = []
                for (let w = 0; w < width; w += 1) {
                    const id = `n_${l}_${w}_${nodeCounter++}`
                    const isCond = l < layerCount && rand() < 0.4
                    const node = createNode(id, isCond ? 'conditionAgentflow' : 'mockWorker', {
                        position: { x: l * 150, y: w * 100 }
                    })
                    nodes.push(node)
                    layerIds.push(id)
                    delaysMs[id] = Math.floor(rand() * 5)

                    if (isCond) {
                        const outCount = 2 + Math.floor(rand() * 2) // 2 or 3 handles
                        const flags: boolean[] = []
                        for (let h = 0; h < outCount; h += 1) {
                            // Cover 0-fulfilled, 1-fulfilled, and multi-fulfilled conditions
                            flags.push(rand() < 0.45)
                        }
                        conditionResults[id] = flags
                    }
                }
                layers.push(layerIds)
            }

            // Connect forward DAG edges (including multi-edge fan-out per condition handle)
            for (let l = 0; l < layers.length - 1; l += 1) {
                for (const srcId of layers[l]) {
                    const isCond = srcId in conditionResults
                    const candidateTargets: string[] = []
                    for (let tl = l + 1; tl < layers.length; tl += 1) {
                        candidateTargets.push(...layers[tl])
                    }

                    if (isCond) {
                        const numHandles = conditionResults[srcId].length
                        for (let h = 0; h < numHandles; h += 1) {
                            const fanOut = 1 + (rand() < 0.35 ? 1 : 0)
                            for (let f = 0; f < fanOut; f += 1) {
                                const tgt = candidateTargets[Math.floor(rand() * candidateTargets.length)]
                                edges.push(createEdge(srcId, tgt, `${srcId}-output-${h}`, `e_${edges.length}`))
                            }
                        }
                    } else {
                        const outDegree = 1 + Math.floor(rand() * 2)
                        for (let o = 0; o < outDegree; o += 1) {
                            const tgt = candidateTargets[Math.floor(rand() * candidateTargets.length)]
                            edges.push(createEdge(srcId, tgt, `${srcId}-output`, `e_${edges.length}`))
                        }
                    }
                }
            }

            // Ensure every non-root active node has >= 1 incoming edge from an earlier layer
            for (let l = 1; l < layers.length; l += 1) {
                for (const tgtId of layers[l]) {
                    if (!edges.some((e) => e.target === tgtId)) {
                        const prevPool = layers.slice(0, l).flat()
                        const srcId = prevPool[Math.floor(rand() * prevPool.length)]
                        const srcHandle = srcId in conditionResults ? `${srcId}-output-0` : `${srcId}-output`
                        edges.push(createEdge(srcId, tgtId, srcHandle, `e_${edges.length}`))
                    }
                }
            }

            // Add disconnected noise chain wired into an active node
            const noiseA = createNode('noise_0', 'mockNoise')
            const noiseB = createNode('noise_1', 'mockNoise')
            nodes.push(noiseA, noiseB)
            const activeSink = layers[layers.length - 1][0]
            edges.push(createEdge('noise_0', 'noise_1', 'noise_0-output', `e_${edges.length}`))
            edges.push(createEdge('noise_1', activeSink, 'noise_1-output', `e_${edges.length}`))

            // Independent topological ground-truth oracle
            const activeEdges = edges.filter((e) => e.source !== 'noise_0' && e.source !== 'noise_1')
            const oracleExecuted = new Set<string>(['start_0'])
            const oracleParents = new Map<string, Set<string>>()

            for (let l = 1; l < layers.length; l += 1) {
                for (const nid of layers[l]) {
                    oracleParents.set(nid, new Set())
                }
            }

            for (let l = 0; l < layers.length; l += 1) {
                for (const srcId of layers[l]) {
                    if (!oracleExecuted.has(srcId)) continue
                    for (const edge of activeEdges) {
                        if (edge.source !== srcId) continue
                        let edgeActive = true
                        if (srcId in conditionResults) {
                            const match = /-output-(\d+)$/.exec(edge.sourceHandle)
                            const idx = match ? Number.parseInt(match[1], 10) : -1
                            edgeActive = Boolean(conditionResults[srcId][idx])
                        }
                        if (edgeActive) {
                            oracleExecuted.add(edge.target)
                            oracleParents.get(edge.target)?.add(srcId)
                        }
                    }
                }
            }

            return { nodes, edges, conditionResults, delaysMs, oracleExecuted, oracleParents }
        }

        it('matches independent oracle across 60 seeded random DAGs at concurrency=1 and concurrency=4 (no deadlocks or double-fires)', async () => {
            for (let i = 0; i < 60; i += 1) {
                const spec = generateRandomDag(1000 + i)
                const flow = createFlow(spec.nodes, spec.edges)

                // Verify DependencyEngine pure queue inputs match oracle parents
                const unitEngine = createDependencyEngine({ nodes: spec.nodes, edges: spec.edges, startingNodeIds: ['start_0'] })
                const unitQueue = unitEngine.getInitialQueue()
                const unitLoops = new Map<string, number>()
                const unitObservedInputs = new Map<string, string[]>()
                while (unitQueue.length > 0) {
                    const item = unitQueue.shift()!
                    if (item.nodeId !== 'start_0') {
                        unitObservedInputs.set(item.nodeId, Object.keys(item.inputs).sort())
                    }
                    const nodeResult =
                        item.nodeId in spec.conditionResults
                            ? {
                                  id: item.nodeId,
                                  name: 'conditionAgentflow',
                                  output: { conditions: spec.conditionResults[item.nodeId].map((flag) => ({ isFulfilled: flag })) }
                              }
                            : { id: item.nodeId, name: item.nodeId === 'start_0' ? 'startAgentflow' : 'mockWorker', output: { content: item.nodeId } }
                    unitEngine.processNodeCompletion({
                        nodeId: item.nodeId,
                        nodeName: item.nodeId === 'start_0' ? 'startAgentflow' : item.nodeId in spec.conditionResults ? 'conditionAgentflow' : 'mockWorker',
                        result: nodeResult,
                        epoch: item.epoch,
                        nodeExecutionQueue: unitQueue,
                        loopCounts: unitLoops,
                        chatId: `unit-${i}`
                    })
                }
                expect(new Set(['start_0', ...unitObservedInputs.keys()])).toEqual(spec.oracleExecuted)
                for (const [nid, gotInputs] of unitObservedInputs.entries()) {
                    expect(gotInputs).toEqual(Array.from(spec.oracleParents.get(nid) || []).sort())
                }

                for (const concurrency of [1, 4]) {
                    process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = String(concurrency)
                    const executionCounts = new Map<string, number>()
                    const completionOrder: string[] = []
                    const startOrder: string[] = []

                    const handlers: Record<string, any> = {}
                    for (const node of spec.nodes) {
                        if (node.id === 'start_0') continue
                        handlers[node.id] = async (nd: any) => {
                            startOrder.push(nd.id)
                            executionCounts.set(nd.id, (executionCounts.get(nd.id) ?? 0) + 1)
                            const delay = spec.delaysMs[nd.id] ?? 0
                            if (delay > 0) {
                                await new Promise((r) => setTimeout(r, delay))
                            }
                            completionOrder.push(nd.id)
                            if (nd.id in spec.conditionResults) {
                                return {
                                    id: nd.id,
                                    name: 'conditionAgentflow',
                                    output: {
                                        conditions: spec.conditionResults[nd.id].map((flag) => ({ isFulfilled: flag }))
                                    },
                                    state: {}
                                }
                            }
                            return {
                                id: nd.id,
                                name: nd.name,
                                output: { json: { from: nd.id }, content: nd.id },
                                state: {}
                            }
                        }
                    }

                    const res = await runTestAgentFlow({
                        flow,
                        incomingInput: { question: `seed-${i}-c${concurrency}` },
                        componentNodes: realComponentNodes,
                        nodeInstanceFactory: createMockNodeFactory(handlers)
                    })

                    const executedSet = new Set(res.agentFlowExecutedData.map((d: any) => d.nodeId))
                    expect(executedSet).toEqual(spec.oracleExecuted)

                    for (const nid of spec.oracleExecuted) {
                        if (nid === 'start_0') continue
                        expect(executionCounts.get(nid)).toBe(1)

                        const expectedParents = Array.from(spec.oracleParents.get(nid) || []).sort()
                        const startIdx = startOrder.indexOf(nid)
                        for (const parentId of expectedParents) {
                            if (parentId === 'start_0') continue
                            const parentCompleteIdx = completionOrder.indexOf(parentId)
                            expect(parentCompleteIdx).toBeGreaterThan(-1)
                            expect(startIdx).toBeGreaterThan(parentCompleteIdx)
                        }
                    }
                }
            }
        }, 30000)
    })
})
