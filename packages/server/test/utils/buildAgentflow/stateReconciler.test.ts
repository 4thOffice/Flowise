import {
    applyStateDelta,
    commitExecutedDataDelta,
    computeStateDelta,
    createNodeRuntimeSnapshot,
    reconcileRuntimeCommit
} from '../../../src/utils/agentflow/stateReconciler'
import { IAgentFlowRuntime } from '../../../src/utils/agentflow/types'
import { IAgentflowExecutedData } from '../../../src/Interface'
import {
    createEdge,
    createFlow,
    createMockDataSource,
    createMockNodeFactory,
    createNode,
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

describe('Agentflow V2 Task 02: stateReconciler unit tests', () => {
    it('computes and applies disjoint parallel writes without clobbering', () => {
        const startSnapshot = { shared: 'init' }
        const branchAEnd = { shared: 'init', a: 1 }
        const branchBEnd = { shared: 'init', b: 2 }

        const deltaA = computeStateDelta(startSnapshot, branchAEnd)
        const deltaB = computeStateDelta(startSnapshot, branchBEnd)

        expect(deltaA).toEqual({ upserted: { a: 1 }, deleted: [] })
        expect(deltaB).toEqual({ upserted: { b: 2 }, deleted: [] })

        let liveState: Record<string, any> = { ...startSnapshot }
        liveState = applyStateDelta(liveState, deltaA)
        liveState = applyStateDelta(liveState, deltaB)

        expect(liveState).toEqual({ shared: 'init', a: 1, b: 2 })
    })

    it('tracks key deletions and prevents a concurrent sibling from resurrecting a deleted key', () => {
        const startSnapshot = { keep: 'v0', dropMe: 'old' }
        const branchADeleted = { keep: 'v0' }
        const branchBAdded = { keep: 'v0', dropMe: 'old', added: 'new' }

        const deltaA = computeStateDelta(startSnapshot, branchADeleted)
        const deltaB = computeStateDelta(startSnapshot, branchBAdded)

        expect(deltaA).toEqual({ upserted: {}, deleted: ['dropMe'] })
        expect(deltaB).toEqual({ upserted: { added: 'new' }, deleted: [] })

        let liveState: Record<string, any> = { ...startSnapshot }
        liveState = applyStateDelta(liveState, deltaA)
        liveState = applyStateDelta(liveState, deltaB)

        expect(liveState).toEqual({ keep: 'v0', added: 'new' })
        expect('dropMe' in liveState).toBe(false)
    })

    it('distinguishes explicit undefined property values from deleted keys', () => {
        const startSnapshot = { a: 'x', b: 'y' }
        const endWithUndefined = { a: undefined }

        const delta = computeStateDelta(startSnapshot, endWithUndefined)
        expect(delta.deleted).toEqual(['b'])
        expect(Object.prototype.hasOwnProperty.call(delta.upserted, 'a')).toBe(true)
        expect(delta.upserted.a).toBeUndefined()

        const nextState = applyStateDelta(startSnapshot, delta)
        expect(Object.prototype.hasOwnProperty.call(nextState, 'a')).toBe(true)
        expect(nextState.a).toBeUndefined()
        expect(Object.prototype.hasOwnProperty.call(nextState, 'b')).toBe(false)
    })

    it('detects nested object and array modifications and isolates clones', () => {
        const startSnapshot = {
            user: { name: 'Alice', roles: ['reader'] },
            unchanged: { count: 1 }
        }
        const endState = {
            user: { name: 'Alice', roles: ['reader', 'editor'] },
            unchanged: { count: 1 }
        }

        const delta = computeStateDelta(startSnapshot, endState)
        expect(Object.keys(delta.upserted)).toEqual(['user'])
        expect(delta.upserted.user).toEqual({ name: 'Alice', roles: ['reader', 'editor'] })
        expect(delta.deleted).toEqual([])

        // Mutating endState or delta after apply must not corrupt liveState
        const liveState = applyStateDelta(startSnapshot, delta)
        endState.user.roles.push('mutated-after')
        delta.upserted.user.name = 'mutated-delta'
        expect(liveState.user).toEqual({ name: 'Alice', roles: ['reader', 'editor'] })
    })

    it('applies last-finisher-wins (LWW) when two deltas modify the same top-level key', () => {
        const startSnapshot = { shared: 'init' }
        const deltaA = computeStateDelta(startSnapshot, { shared: 'fromA' })
        const deltaB = computeStateDelta(startSnapshot, { shared: 'fromB' })

        let liveState: Record<string, any> = { ...startSnapshot }
        liveState = applyStateDelta(liveState, deltaA)
        liveState = applyStateDelta(liveState, deltaB)

        expect(liveState).toEqual({ shared: 'fromB' })
    })

    it('returns an empty delta when endState is undefined, null, or non-plain-object', () => {
        const startSnapshot = { keep: 'value' }
        expect(computeStateDelta(startSnapshot, undefined)).toEqual({ upserted: {}, deleted: [] })
        expect(computeStateDelta(startSnapshot, null)).toEqual({ upserted: {}, deleted: [] })
        expect(computeStateDelta(startSnapshot, [] as any)).toEqual({ upserted: {}, deleted: [] })
    })

    it('creates isolated runtime snapshots so in-place mutations do not affect startStateSnapshot or live runtime', () => {
        const liveRuntime: IAgentFlowRuntime = {
            state: { counter: 1, nested: { tags: ['a'] } },
            chatHistory: [{ message: 'hi', type: 'userMessage', role: 'userMessage', content: 'hi' }],
            form: { field: 'v1' }
        }

        const { startStateSnapshot, nodeRuntimeSnapshot } = createNodeRuntimeSnapshot(liveRuntime)
        expect(nodeRuntimeSnapshot.state).not.toBe(startStateSnapshot)
        expect(nodeRuntimeSnapshot.state).not.toBe(liveRuntime.state)

        // Mutate nodeRuntimeSnapshot in place
        nodeRuntimeSnapshot.state!.counter = 2
        nodeRuntimeSnapshot.state!.nested.tags.push('b')
        nodeRuntimeSnapshot.state!.added = 'in-place'
        nodeRuntimeSnapshot.chatHistory!.push({ message: 'mut', type: 'apiMessage', role: 'apiMessage', content: 'mut' })
        nodeRuntimeSnapshot.form!.field = 'mutated'

        // Neither startStateSnapshot nor liveRuntime saw the in-place mutations
        expect(startStateSnapshot).toEqual({ counter: 1, nested: { tags: ['a'] } })
        expect(liveRuntime.state).toEqual({ counter: 1, nested: { tags: ['a'] } })
        expect(liveRuntime.chatHistory).toHaveLength(1)
        expect(liveRuntime.form).toEqual({ field: 'v1' })

        // Delta accurately detects the in-place changes against untouched startStateSnapshot
        const delta = computeStateDelta(startStateSnapshot, nodeRuntimeSnapshot.state)
        expect(delta).toEqual({
            upserted: {
                counter: 2,
                nested: { tags: ['a', 'b'] },
                added: 'in-place'
            },
            deleted: []
        })
    })

    it('handles doNotIncludeFeedbackHistory cleanly before diffing and prevents leaking into live state', () => {
        const liveRuntime: IAgentFlowRuntime = {
            state: { keep: 'yes', doNotIncludeFeedbackHistory: 'stale' },
            chatHistory: [],
            form: {}
        }
        const { startStateSnapshot, nodeRuntimeSnapshot } = createNodeRuntimeSnapshot(liveRuntime)
        nodeRuntimeSnapshot.state!.doNotIncludeFeedbackHistory = 'true'
        nodeRuntimeSnapshot.state!.extra = 'ok'

        const pastChatHistory: any[] = [
            { message: 'orig question', content: 'orig question', type: 'userMessage' },
            { message: 'feedback prompt', content: 'feedback prompt', type: 'apiMessage' }
        ]
        const tokenHistory: any[] = [{ content: 'orig' }, { content: 'feedback' }]
        const incomingInput: { question?: string } = { question: 'initial' }

        const commitResult = reconcileRuntimeCommit({
            agentflowRuntime: liveRuntime,
            startStateSnapshot,
            nodeResult: { state: nodeRuntimeSnapshot.state },
            pastChatHistory,
            tokenHistory,
            incomingInput,
            question: 'initial'
        })

        expect(commitResult.hadDoNotIncludeFeedbackHistory).toBe(true)
        expect(commitResult.question).toBe('orig question')
        expect(incomingInput.question).toBe('orig question')
        expect(pastChatHistory).toHaveLength(0)
        expect(tokenHistory).toHaveLength(1)
        expect(liveRuntime.state).toEqual({ keep: 'yes', extra: 'ok' })
        expect('doNotIncludeFeedbackHistory' in (liveRuntime.state || {})).toBe(false)
    })

    it('reconciles parallel-branch simulation with in-place mutation, key deletion, and chatHistory appends', () => {
        const liveRuntime: IAgentFlowRuntime = {
            state: { keep: 'v0', dropMe: 'old', sharedObj: { n: 1 } },
            chatHistory: [{ message: 'seed', type: 'userMessage', role: 'userMessage', content: 'seed' }],
            form: {}
        }

        const snapA = createNodeRuntimeSnapshot(liveRuntime)
        const snapB = createNodeRuntimeSnapshot(liveRuntime)

        // Branch A mutates its snapshot in place and appends a message
        snapA.nodeRuntimeSnapshot.state!.a = 1
        const resultA = {
            state: snapA.nodeRuntimeSnapshot.state,
            chatHistory: [{ message: 'fromA', type: 'apiMessage', role: 'apiMessage', content: 'fromA' }]
        }

        // Branch B writes b = 2, deletes dropMe, and appends a message
        const stateB: Record<string, any> = { ...snapB.nodeRuntimeSnapshot.state!, b: 2 }
        delete stateB.dropMe
        const resultB = {
            state: stateB,
            chatHistory: [{ message: 'fromB', type: 'apiMessage', role: 'apiMessage', content: 'fromB' }]
        }

        const emptyHistory: any[] = []
        reconcileRuntimeCommit({
            agentflowRuntime: liveRuntime,
            startStateSnapshot: snapA.startStateSnapshot,
            nodeResult: resultA,
            pastChatHistory: emptyHistory,
            incomingInput: {}
        })
        reconcileRuntimeCommit({
            agentflowRuntime: liveRuntime,
            startStateSnapshot: snapB.startStateSnapshot,
            nodeResult: resultB,
            pastChatHistory: emptyHistory,
            incomingInput: {}
        })

        expect(liveRuntime.state).toEqual({
            keep: 'v0',
            sharedObj: { n: 1 },
            a: 1,
            b: 2
        })
        expect(liveRuntime.chatHistory?.map((m) => m.content)).toEqual(['seed', 'fromA', 'fromB'])
    })

    it('keeps the user input once when parallel nodes that both launched with empty chatHistory commit', () => {
        const liveRuntime: IAgentFlowRuntime = { state: {}, chatHistory: [], form: {} }
        const snapA = createNodeRuntimeSnapshot(liveRuntime)
        const snapB = createNodeRuntimeSnapshot(liveRuntime)
        expect(snapA.startChatHistoryLength).toBe(0)

        const commit = (snap: ReturnType<typeof createNodeRuntimeSnapshot>, chatHistory: any[]) =>
            reconcileRuntimeCommit({
                agentflowRuntime: liveRuntime,
                startStateSnapshot: snap.startStateSnapshot,
                startChatHistoryLength: snap.startChatHistoryLength,
                nodeResult: { chatHistory },
                pastChatHistory: [],
                incomingInput: {}
            })

        commit(snapA, [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'fromA', name: 'llm_a' }
        ])
        commit(snapB, [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'fromB', name: 'llm_b' }
        ])

        expect(liveRuntime.chatHistory).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'fromA', name: 'llm_a' },
            { role: 'assistant', content: 'fromB', name: 'llm_b' }
        ])
    })

    it('keeps a parallel node input that differs from what a sibling already committed', () => {
        const liveRuntime: IAgentFlowRuntime = { state: {}, chatHistory: [], form: {} }
        const snapA = createNodeRuntimeSnapshot(liveRuntime)
        const snapB = createNodeRuntimeSnapshot(liveRuntime)

        for (const [snap, input, answer] of [
            [snapA, 'hi', 'fromA'],
            [snapB, 'custom prompt', 'fromB']
        ] as const) {
            reconcileRuntimeCommit({
                agentflowRuntime: liveRuntime,
                startStateSnapshot: snap.startStateSnapshot,
                startChatHistoryLength: snap.startChatHistoryLength,
                nodeResult: {
                    chatHistory: [
                        { role: 'user', content: input },
                        { role: 'assistant', content: answer }
                    ]
                },
                pastChatHistory: [],
                incomingInput: {}
            })
        }

        expect(liveRuntime.chatHistory?.map((m) => m.content)).toEqual(['hi', 'fromA', 'custom prompt', 'fromB'])
    })

    it('does not drop a repeated message from a node that launched after history already existed', () => {
        const liveRuntime: IAgentFlowRuntime = {
            state: {},
            chatHistory: [{ role: 'user', content: 'hi' } as any],
            form: {}
        }
        const snap = createNodeRuntimeSnapshot(liveRuntime)
        expect(snap.startChatHistoryLength).toBe(1)

        reconcileRuntimeCommit({
            agentflowRuntime: liveRuntime,
            startStateSnapshot: snap.startStateSnapshot,
            startChatHistoryLength: snap.startChatHistoryLength,
            nodeResult: { chatHistory: [{ role: 'user', content: 'hi' }] },
            pastChatHistory: [],
            incomingInput: {}
        })

        expect(liveRuntime.chatHistory?.map((m) => m.content)).toEqual(['hi', 'hi'])
    })

    it('mutates canonical agentFlowExecutedData in place via commitExecutedDataDelta without dropping sibling entries', () => {
        const canonical: IAgentflowExecutedData[] = [
            { nodeId: 'start_0', nodeLabel: 'Start', previousNodeIds: [], status: 'FINISHED', data: {} as any },
            { nodeId: 'human_0', nodeLabel: 'Gate', previousNodeIds: ['start_0'], status: 'STOPPED', data: {} as any },
            { nodeId: 'sibling_0', nodeLabel: 'Sibling', previousNodeIds: ['start_0'], status: 'FINISHED', data: {} as any }
        ]
        const originalRef = canonical

        const subRecord: IAgentflowExecutedData = {
            nodeId: 'sub_0',
            nodeLabel: 'Sub',
            previousNodeIds: [],
            status: 'FINISHED',
            data: {} as any
        }
        const resumedRecord: IAgentflowExecutedData = {
            nodeId: 'human_0',
            nodeLabel: 'Gate',
            previousNodeIds: ['start_0'],
            status: 'FINISHED',
            data: {} as any
        }

        const returned = commitExecutedDataDelta(canonical, {
            removedNodeIds: ['human_0'],
            additionalRecords: [subRecord],
            nodeRecord: resumedRecord
        })

        expect(returned).toBe(originalRef)
        expect(canonical.map((d) => `${d.nodeId}:${d.status}`)).toEqual([
            'start_0:FINISHED',
            'sibling_0:FINISHED',
            'sub_0:FINISHED',
            'human_0:FINISHED'
        ])
    })
})

describe('Agentflow V2 Task 02: executeAgentFlow runtime isolation & delta merge integration', () => {
    const realComponentNodes = loadRealComponentNodes()

    it('isolates in-place mutations on options.agentflowRuntime.state and merges disjoint branch writes', async () => {
        const flow = createFlow(
            [
                createNode(
                    'start_0',
                    'startAgentflow',
                    {
                        inputs: {
                            startInputType: 'chatInput',
                            startState: [
                                { key: 'keep', value: 'v0' },
                                { key: 'dropMe', value: 'old' }
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

        const seenRuntimes: any[] = []
        const nodeInstanceFactory = createMockNodeFactory({
            branchA: async (nodeData, _input, options) => {
                seenRuntimes.push(options.agentflowRuntime)
                // Mutate state in place and return it
                options.agentflowRuntime.state.a = 'fromA'
                delete options.agentflowRuntime.state.dropMe
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'A' },
                    state: options.agentflowRuntime.state
                }
            },
            branchB: async (nodeData, _input, options) => {
                seenRuntimes.push(options.agentflowRuntime)
                // Mutate state in place for disjoint key b
                options.agentflowRuntime.state.b = 'fromB'
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'B' },
                    state: options.agentflowRuntime.state
                }
            },
            join_0: async (nodeData, _input, options) => {
                seenRuntimes.push(options.agentflowRuntime)
                const s = options.agentflowRuntime.state
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `keep=${s.keep}|a=${s.a}|b=${s.b}|drop=${String(s.dropMe)}` },
                    state: s
                }
            }
        })

        const result = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'go' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(seenRuntimes[0]).not.toBe(seenRuntimes[1])
        expect(seenRuntimes[1]).not.toBe(seenRuntimes[2])
        expect(result.text).toBe('keep=v0|a=fromA|b=fromB|drop=undefined')
    })

    it('preserves sequential iterationAgentflow state propagation and subflow agentFlowExecutedData records', async () => {
        const flow = createFlow(
            [
                createNode(
                    'start_0',
                    'startAgentflow',
                    {
                        inputs: {
                            startInputType: 'chatInput',
                            startState: [{ key: 'parentKey', value: 'root' }]
                        }
                    },
                    realComponentNodes
                ),
                createNode(
                    'iter_0',
                    'iterationAgentflow',
                    {
                        inputs: {
                            iterationInput: '["x","y"]'
                        }
                    },
                    realComponentNodes
                ),
                createNode('child_0', 'mockChild', { parentNode: 'iter_0', extent: 'parent' }),
                createNode('after_0', 'mockAfter')
            ],
            [createEdge('start_0', 'iter_0'), createEdge('iter_0', 'after_0')]
        )

        const observedContextStates: any[] = []
        const nodeInstanceFactory = createMockNodeFactory({
            child_0: async (nodeData, _input, options) => {
                observedContextStates.push({
                    index: options.iterationContext?.index,
                    parentKey: options.iterationContext?.agentflowRuntime?.state?.parentKey,
                    acc: options.iterationContext?.agentflowRuntime?.state?.acc
                })
                const prevAcc = options.iterationContext?.agentflowRuntime?.state?.acc || ''
                const nextAcc = prevAcc ? `${prevAcc},${options.iterationContext?.value}` : `${options.iterationContext?.value}`
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `item:${options.iterationContext?.value}` },
                    state: { acc: nextAcc }
                }
            },
            after_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: {
                    content: `parent=${options.agentflowRuntime.state.parentKey}|acc=${options.agentflowRuntime.state.acc}`
                },
                state: options.agentflowRuntime.state
            })
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'iterate' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(observedContextStates).toEqual([
            { index: 0, parentKey: 'root', acc: undefined },
            { index: 1, parentKey: 'root', acc: 'x' }
        ])
        expect(res.text).toBe('parent=root|acc=x,y')
        const childRecords = res.agentFlowExecutedData.filter((d: any) => d.nodeId === 'child_0')
        expect(childRecords).toHaveLength(2)
        expect(childRecords.map((d: any) => d.data.iterationIndex)).toEqual([0, 1])
        expect(res.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual(['start_0', 'child_0', 'child_0', 'iter_0', 'after_0'])
    })

    it('preserves prior agentFlowExecutedData entries when resuming humanInputAgentflow', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('prep_0', 'mockPrep'),
                createNode(
                    'human_0',
                    'humanInputAgentflow',
                    {
                        inputs: {
                            humanInputDescriptionType: 'fixed',
                            humanInputDescription: 'Confirm?'
                        }
                    },
                    realComponentNodes
                ),
                createNode('done_0', 'directReplyAgentflow', { inputs: { directReplyMessage: 'done' } }, realComponentNodes)
            ],
            [createEdge('start_0', 'prep_0'), createEdge('prep_0', 'human_0'), createEdge('human_0', 'done_0', 'human_0-output-0')]
        )

        const { appDataSource, executions } = createMockDataSource()
        const nodeInstanceFactory = createMockNodeFactory({
            prep_0: async (nodeData) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'prepped' },
                state: { prepped: 'yes' }
            })
        })

        const paused = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'start', overrideConfig: { sessionId: 'hitl-execdata-1' } },
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory,
            chatId: 'chat-h1'
        })
        await waitUntil(() => executions[0]?.state === 'STOPPED')

        const resumed = await runTestAgentFlow({
            flow,
            incomingInput: {
                humanInput: { type: 'proceed', startNodeId: 'human_0', feedback: 'go' },
                overrideConfig: { sessionId: 'hitl-execdata-1' },
                trustedState: paused.trustedState
            },
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory,
            chatId: 'chat-h2'
        })
        await waitUntil(() => executions[0]?.state === 'FINISHED')

        expect(resumed.text).toBe('done')
        expect(resumed.agentFlowExecutedData.map((d: any) => `${d.nodeId}:${d.status}`)).toEqual([
            'start_0:FINISHED',
            'prep_0:FINISHED',
            'human_0:FINISHED',
            'done_0:FINISHED'
        ])
    })

    it('isolates in-place mutations to iterationContext.agentflowRuntime and pastChatHistory across iterations and failures', async () => {
        const flow = createFlow(
            [
                createNode(
                    'start_0',
                    'startAgentflow',
                    {
                        inputs: {
                            startInputType: 'chatInput',
                            startState: [{ key: 'parentNested', value: 'clean' }]
                        }
                    },
                    realComponentNodes
                ),
                createNode(
                    'iter_0',
                    'iterationAgentflow',
                    { inputs: { iterationInput: '["fail-first","ok-second"]' } },
                    realComponentNodes
                ),
                createNode('child_0', 'mockChild', { parentNode: 'iter_0', extent: 'parent' }),
                createNode('after_0', 'mockAfter')
            ],
            [createEdge('start_0', 'iter_0'), createEdge('iter_0', 'after_0')]
        )

        const { appDataSource } = createMockDataSource()
        const trustedState = await tokenWithHistory([{ role: 'userMessage', content: 'original-past-history' }])
        const observedChildInputs: any[] = []

        const nodeInstanceFactory = createMockNodeFactory({
            child_0: async (nodeData, _input, options) => {
                observedChildInputs.push({
                    idx: options.iterationContext?.index,
                    parentNested: options.iterationContext?.agentflowRuntime?.state?.parentNested,
                    leakedFlag: options.iterationContext?.agentflowRuntime?.state?.leaked,
                    pastHistoryContent: options.pastChatHistory?.[0]?.content
                })
                // Mutate iterationContext.agentflowRuntime and pastChatHistory in place before succeeding or throwing
                options.iterationContext.agentflowRuntime.state.parentNested = 'corrupted-in-place'
                options.iterationContext.agentflowRuntime.state.leaked = 'dirty'
                if (options.pastChatHistory[0]) {
                    options.pastChatHistory[0].content = 'corrupted-past-history'
                }
                if (options.iterationContext?.index === 0) {
                    throw new Error('iteration-0-boom')
                }
                return {
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: 'second-ok' },
                    state: { survived: 'yes' }
                }
            },
            after_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: {
                    content: `${options.agentflowRuntime.state.parentNested}|${String(options.agentflowRuntime.state.leaked)}|${
                        options.agentflowRuntime.state.survived
                    }|${options.pastChatHistory[0]?.content}`
                },
                state: options.agentflowRuntime.state
            })
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'run', trustedState },
            appDataSource,
            chatId: 'chat-iter-iso',
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(observedChildInputs).toEqual([
            {
                idx: 0,
                parentNested: 'clean',
                leakedFlag: undefined,
                pastHistoryContent: 'original-past-history'
            },
            {
                idx: 1,
                parentNested: 'clean',
                leakedFlag: undefined,
                pastHistoryContent: 'original-past-history'
            }
        ])
        expect(res.text).toBe('clean|undefined|yes|original-past-history')
    })

    it('preserves loopAgentflow maxLoopCount fallbackMessage in agentFlowExecutedData and result.text', async () => {
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
                            maxLoopCount: 2,
                            fallbackMessage: 'Fallback content preserved'
                        }
                    },
                    realComponentNodes
                )
            ],
            [createEdge('start_0', 'body_0'), createEdge('body_0', 'loop_0')]
        )

        const nodeInstanceFactory = createMockNodeFactory({
            body_0: async (nodeData) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: 'tick' },
                state: {}
            })
        })

        const res = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'loop' },
            componentNodes: realComponentNodes,
            nodeInstanceFactory
        })

        expect(res.text).toBe('Fallback content preserved')
        const lastRecord = res.agentFlowExecutedData[res.agentFlowExecutedData.length - 1]
        expect(lastRecord.nodeId).toBe('loop_0')
        expect(lastRecord.data.output.content).toBe('Fallback content preserved')
    })

    it('supports agentAgentflow isWaitingForHumanInput STOPPED checkpoint and resume without dropping prior records', async () => {
        const flow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('agent_0', 'agentAgentflow', { label: 'Tool Agent' }),
                createNode('after_0', 'mockAfter')
            ],
            [createEdge('start_0', 'agent_0'), createEdge('agent_0', 'after_0')]
        )

        const { appDataSource, executions } = createMockDataSource()
        let resumeSeen = false
        const nodeInstanceFactory = createMockNodeFactory({
            agent_0: async (nodeData) => {
                if (!resumeSeen) {
                    resumeSeen = true
                    return {
                        id: nodeData.id,
                        name: 'agentAgentflow',
                        input: { messages: [] },
                        output: { content: 'Approve tool call?', isWaitingForHumanInput: true },
                        state: { pendingTool: 'search' }
                    }
                }
                return {
                    id: nodeData.id,
                    name: 'agentAgentflow',
                    input: { messages: [] },
                    output: { content: 'Tool executed' },
                    state: { pendingTool: 'done' }
                }
            },
            after_0: async (nodeData, _input, options) => ({
                id: nodeData.id,
                name: nodeData.name,
                output: { content: `after:${options.agentflowRuntime.state.pendingTool}` },
                state: options.agentflowRuntime.state
            })
        })

        const paused = await runTestAgentFlow({
            flow,
            incomingInput: { question: 'call tool', overrideConfig: { sessionId: 'agent-hitl-1' } },
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory,
            chatId: 'chat-a1'
        })
        await waitUntil(() => executions[0]?.state === 'STOPPED')
        expect(paused.agentFlowExecutedData.map((d: any) => `${d.nodeId}:${d.status}`)).toEqual(['start_0:FINISHED', 'agent_0:STOPPED'])

        const resumed = await runTestAgentFlow({
            flow,
            incomingInput: {
                humanInput: { type: 'proceed', startNodeId: 'agent_0' },
                overrideConfig: { sessionId: 'agent-hitl-1' },
                trustedState: paused.trustedState
            },
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory,
            chatId: 'chat-a2'
        })
        await waitUntil(() => executions[0]?.state === 'FINISHED')

        expect(resumed.text).toBe('after:done')
        expect(resumed.agentFlowExecutedData.map((d: any) => `${d.nodeId}:${d.status}`)).toEqual([
            'start_0:FINISHED',
            'agent_0:FINISHED',
            'after_0:FINISHED'
        ])
    })
})
