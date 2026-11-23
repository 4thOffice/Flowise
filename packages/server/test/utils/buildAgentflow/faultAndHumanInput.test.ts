import { Response } from 'express'
import { SSEStreamer } from '../../../src/utils/SSEStreamer'
import { Compression, Execution } from '../../../src/database/entities/Execution'
import { IAgentflowExecutedData } from '../../../src/Interface'
import { executeAgentFlow } from '../../../src/utils/buildAgentflow'
import { computeTopologicalLevels } from '../../../src/utils/agentflow/dependencyEngine'
import {
    createExecutionAbortScope,
    createFaultRecorder,
    createSerializedTaskQueue,
    findResumedHumanInputAction,
    isAbortLikeError,
    selectPrimaryStoppedAction,
    selectPrimaryStoppedNode
} from '../../../src/utils/agentflow/faultCoordinator'
import executionsWorker from '../../../src/utils/executionsWorker'
import logger from '../../../src/utils/logger'
import { trusted_state_from_string } from '../../../src/utils/trustedStateHelper'
import { CachePool } from '../../../src/CachePool'
import { UsageCacheManager } from '../../../src/UsageCacheManager'
import { Telemetry } from '../../../src/utils/telemetry'
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

const mockExecutionsUpdaterRun = jest.fn()
let mockWorkerDataSourceRef: any

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => {
        throw new Error('getRunningExpressApp should not be called when appDataSource is injected')
    })
}))

jest.mock('../../../src/DataSource', () => ({
    executionsUpdater: {
        run: (...args: any[]) => mockExecutionsUpdaterRun(...args)
    },
    getDataSource: () => mockWorkerDataSourceRef
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

describe('Agentflow V2 Task 06: Fault Handling & Non-Interrupting HumanInput Semantics', () => {
    const realComponentNodes = loadRealComponentNodes()
    const originalConcurrencyEnv = process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
    const originalDbThreadEnv = process.env.EXECUTIONS_DB_THREAD
    const originalMaxIterationsEnv = process.env.MAX_ITERATIONS

    afterEach(() => {
        if (originalConcurrencyEnv === undefined) {
            delete process.env.AGENTFLOW_MAX_NODE_CONCURRENCY
        } else {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = originalConcurrencyEnv
        }
        if (originalDbThreadEnv === undefined) {
            delete process.env.EXECUTIONS_DB_THREAD
        } else {
            process.env.EXECUTIONS_DB_THREAD = originalDbThreadEnv
        }
        if (originalMaxIterationsEnv === undefined) {
            delete process.env.MAX_ITERATIONS
        } else {
            process.env.MAX_ITERATIONS = originalMaxIterationsEnv
        }
        mockExecutionsUpdaterRun.mockReset()
        mockWorkerDataSourceRef = undefined
        jest.restoreAllMocks()
    })

    describe('1. Fault & Abort Coordinator unit contracts', () => {
        it('isolates internal child abort from caller AbortController and cleans up abort listeners without leaks', () => {
            const callerCtrl = new AbortController()
            const addSpy = jest.spyOn(callerCtrl.signal, 'addEventListener')
            const removeSpy = jest.spyOn(callerCtrl.signal, 'removeEventListener')

            const scope1 = createExecutionAbortScope(callerCtrl)
            expect(addSpy).toHaveBeenCalledTimes(1)
            expect(scope1.isAborted()).toBe(false)
            expect(scope1.isExternallyAborted()).toBe(false)

            // Internal fail-fast abort must NEVER mutate callerCtrl
            scope1.abortInternal(new Error('internal-fail'))
            expect(scope1.isAborted()).toBe(true)
            expect(scope1.isExternallyAborted()).toBe(false)
            expect(callerCtrl.signal.aborted).toBe(false)

            scope1.cleanup()
            expect(removeSpy).toHaveBeenCalledTimes(1)

            // External abort propagates into fresh scope and still cleans up cleanly
            const scope2 = createExecutionAbortScope(callerCtrl)
            expect(addSpy).toHaveBeenCalledTimes(2)
            callerCtrl.abort('client-disconnected')
            expect(scope2.isAborted()).toBe(true)
            expect(scope2.isExternallyAborted()).toBe(true)
            scope2.cleanup()
            expect(removeSpy).toHaveBeenCalledTimes(2)

            // Pre-aborted caller controller sets flags immediately without registering a listener
            const scope3 = createExecutionAbortScope(callerCtrl)
            expect(scope3.isAborted()).toBe(true)
            expect(scope3.isExternallyAborted()).toBe(true)
            scope3.cleanup()
            expect(addSpy).toHaveBeenCalledTimes(2)
        })

        it('preserves first non-abort root error even when secondary AbortErrors race ahead or behind', () => {
            expect(isAbortLikeError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(true)
            expect(isAbortLikeError(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }))).toBe(true)
            expect(isAbortLikeError(new Error('Request aborted by signal'))).toBe(true)
            expect(isAbortLikeError(new Error('Database timeout'))).toBe(false)

            // Case A: root error arrives first, secondary AbortError arrives second -> root error kept
            const scopeA = createExecutionAbortScope()
            const recorderA = createFaultRecorder(scopeA)
            recorderA.recordNodeError(new Error('root-boom'))
            recorderA.recordNodeError(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            expect(recorderA.getRootError()?.errorStatus).toBe('ERROR')
            expect(recorderA.getRootError()?.errorMessage).toBe('root-boom')
            scopeA.cleanup()

            // Case B: internal AbortError arrives first, genuine non-abort error arrives second -> promoted!
            const scopeB = createExecutionAbortScope()
            const recorderB = createFaultRecorder(scopeB)
            scopeB.abortInternal()
            recorderB.recordNodeError(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            recorderB.recordNodeError(new Error('real-cause'))
            expect(recorderB.getRootError()?.errorStatus).toBe('ERROR')
            expect(recorderB.getRootError()?.errorMessage).toBe('real-cause')
            scopeB.cleanup()

            // Case C: external caller abort prevents non-abort cleanup error from masking TERMINATED
            const externalCtrl = new AbortController()
            const scopeC = createExecutionAbortScope(externalCtrl)
            const recorderC = createFaultRecorder(scopeC)
            externalCtrl.abort()
            recorderC.recordNodeError(new Error('Aborted'))
            recorderC.recordNodeError(new Error('cleanup-side-effect'))
            expect(recorderC.finalizeForExternalAbort()?.errorStatus).toBe('TERMINATED')
            scopeC.cleanup()

            // Case D: external abort fires without any node error throwing -> finalizeForExternalAbort returns TERMINATED
            const ext2 = new AbortController()
            const scopeD = createExecutionAbortScope(ext2)
            const recorderD = createFaultRecorder(scopeD)
            ext2.abort()
            expect(recorderD.finalizeForExternalAbort()?.errorStatus).toBe('TERMINATED')
            scopeD.cleanup()

            // Case E: genuine non-abort node error containing "aborted" substring when no abort fired -> ERROR
            const scopeE = createExecutionAbortScope()
            const recorderE = createFaultRecorder(scopeE)
            const pgFault = recorderE.recordNodeError(new Error('current transaction is aborted'))
            expect(pgFault.isAbort).toBe(false)
            expect(pgFault.nodeStatus).toBe('ERROR')
            expect(pgFault.rootError.errorStatus).toBe('ERROR')
            expect(pgFault.rootError.errorMessage).toBe('current transaction is aborted')
            scopeE.cleanup()

            // Case F: external caller abort with custom non-AbortError reason -> TERMINATED
            const extCustom = new AbortController()
            const scopeF = createExecutionAbortScope(extCustom)
            const recorderF = createFaultRecorder(scopeF)
            extCustom.abort('client-disconnected')
            const customReasonFault = recorderF.recordNodeError('client-disconnected')
            expect(customReasonFault.isAbort).toBe(true)
            expect(customReasonFault.nodeStatus).toBe('TERMINATED')
            expect(customReasonFault.rootError.errorStatus).toBe('TERMINATED')
            recorderF.recordNodeError(new Error('cleanup-side-effect'))
            expect(recorderF.finalizeForExternalAbort()?.errorStatus).toBe('TERMINATED')
            scopeF.cleanup()
        })

        it('finds STOPPED humanInputAction by nodeId and selects deterministic primary action across multiple STOPPED nodes', () => {
            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
            const nodes = [
                createNode('start_0', 'startAgentflow', { position: { x: 0, y: 100 } }),
                createNode('humanTop', 'humanInputAgentflow', { position: { x: 200, y: 20 } }),
                createNode('humanBottom', 'humanInputAgentflow', { position: { x: 200, y: 300 } }),
                createNode('companion_0', 'directReplyAgentflow', { position: { x: 200, y: 150 } })
            ]
            const edges = [createEdge('start_0', 'humanTop'), createEdge('start_0', 'humanBottom'), createEdge('start_0', 'companion_0')]
            const levels = computeTopologicalLevels(nodes, edges)

            const executedData: IAgentflowExecutedData[] = [
                { nodeId: 'start_0', nodeLabel: 'Start', previousNodeIds: [], status: 'FINISHED', data: { output: {} } },
                {
                    nodeId: 'humanBottom',
                    nodeLabel: 'Bottom Gate',
                    previousNodeIds: ['start_0'],
                    status: 'STOPPED',
                    data: { output: { content: 'B?', humanInputAction: { id: 'act-bottom' } } }
                },
                {
                    nodeId: 'humanTop',
                    nodeLabel: 'Top Gate',
                    previousNodeIds: ['start_0'],
                    status: 'STOPPED',
                    data: { output: { content: 'T?', humanInputAction: { id: 'act-top' } } }
                },
                // Subflow child STOPPED record must be ignored
                {
                    nodeId: 'childGate',
                    nodeLabel: 'Child Gate',
                    previousNodeIds: [],
                    status: 'STOPPED',
                    data: { parentNodeId: 'iter_0', output: { content: 'C?', humanInputAction: { id: 'act-child' } } }
                },
                // Companion leaf finished LAST (would break length - 1 lookups)
                {
                    nodeId: 'companion_0',
                    nodeLabel: 'Companion',
                    previousNodeIds: ['start_0'],
                    status: 'FINISHED',
                    data: { output: { content: 'Companion summary' } }
                }
            ]

            expect(findResumedHumanInputAction(executedData, 'humanBottom')).toEqual({ id: 'act-bottom' })
            expect(findResumedHumanInputAction(executedData, 'humanTop')).toEqual({ id: 'act-top' })
            expect(findResumedHumanInputAction(executedData, 'childGate')).toEqual({ id: 'act-top' })

            expect(selectPrimaryStoppedNode(executedData, nodes, levels)?.nodeId).toBe('humanTop')

            const selected = selectPrimaryStoppedAction(executedData, nodes, levels)
            expect(selected.primaryNodeId).toBe('humanTop')
            expect(selected.action).toEqual({ id: 'act-top' })
            expect(selected.stoppedNodeIds).toEqual(['humanTop', 'humanBottom'])
            expect(warnSpy).toHaveBeenCalledTimes(1)
            expect(warnSpy.mock.calls[0][0]).toContain('Multiple concurrent branches stopped')
        })

        it('executes serialized task queue strictly FIFO despite inverse latencies and does not poison after rejection', async () => {
            const queue = createSerializedTaskQueue()
            const events: string[] = []
            let activeCount = 0
            let maxActive = 0

            const p1 = queue.enqueue(async () => {
                activeCount += 1
                maxActive = Math.max(maxActive, activeCount)
                events.push('start-1')
                await new Promise((r) => setTimeout(r, 40))
                events.push('end-1')
                activeCount -= 1
                return 'r1'
            })
            const p2 = queue.enqueue(async () => {
                activeCount += 1
                maxActive = Math.max(maxActive, activeCount)
                events.push('start-2-fail')
                await new Promise((r) => setTimeout(r, 15))
                activeCount -= 1
                throw new Error('task-2-err')
            })
            const p3 = queue.enqueue(async () => {
                activeCount += 1
                maxActive = Math.max(maxActive, activeCount)
                events.push('start-3')
                await new Promise((r) => setTimeout(r, 5))
                events.push('end-3')
                activeCount -= 1
                return 'r3'
            })

            await expect(p1).resolves.toBe('r1')
            await expect(p2).rejects.toThrow('task-2-err')
            await expect(p3).resolves.toBe('r3')
            await queue.drain()

            expect(maxActive).toBe(1)
            expect(events).toEqual(['start-1', 'end-1', 'start-2-fail', 'start-3', 'end-3'])
        })

        it('preserves pre-compressed executionDataBlob inside executionsWorker without overwriting with empty array', async () => {
            const ds = createMockDataSource()
            mockWorkerDataSourceRef = ds.appDataSource as any
            Object.assign(mockWorkerDataSourceRef, { isInitialized: true })

            const seeded = await ds.appDataSource.getRepository(Execution).save(
                ds.appDataSource.getRepository(Execution).create({
                    agentflowId: 'cf-worker',
                    sessionId: 'sess-worker',
                    workspaceId: 'ws-1',
                    state: 'INPROGRESS',
                    executionData: '[]'
                })
            )

            const compressedBlob = await Compression.compress(JSON.stringify([{ nodeId: 'n1', status: 'FINISHED' }]))
            // Pass plain Uint8Array simulating worker_threads / Piscina structured clone
            const structuredCloneBlob = Uint8Array.from(compressedBlob)
            expect(Buffer.isBuffer(structuredCloneBlob)).toBe(false)
            await executionsWorker({
                executionId: seeded.id,
                workspaceId: 'ws-1',
                data: {
                    executionDataBlob: structuredCloneBlob as unknown as Buffer,
                    executionData: '[]',
                    state: 'FINISHED'
                }
            })

            expect(ds.executions[0].state).toBe('FINISHED')
            expect(Buffer.isBuffer(ds.executions[0].executionDataBlob)).toBe(true)
            expect(ds.executions[0].executionDataBlob).toEqual(compressedBlob)
            expect(JSON.parse(await Compression.decompress(ds.executions[0].executionDataBlob))).toEqual([
                { nodeId: 'n1', status: 'FINISHED' }
            ])
        })
    })

    describe('2. Non-interrupting HumanInput drain & resume (Flow 05 + concurrent STOPPED)', () => {
        it('reproduces Flow 05 (HumanInput + slow companion text): emits STOPPED once post-drain, saves action + companion text, and resumes cleanly', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow05 = loadBaselineFlow('05-human-input-with-companion-text.json')
            const chatflow = createChatflow(flow05)

            // Streaming Turn 1 + Turn 2 Proceed
            const streamDs = createMockDataSource()
            const chatId = 'chat-flow05-sse'
            const recorder = createRealSSERecorder(chatId)
            const sessionSse = 'sess-flow05-sse'

            const turn1Sse = await runTestAgentFlow({
                chatflow,
                incomingInput: { question: 'please review', streaming: true, overrideConfig: { sessionId: sessionSse } },
                appDataSource: streamDs.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId
            })
            recorder.sseStreamer.removeClient(chatId)

            const events = recorder.getEvents()
            const agentFlowEvents = events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)
            expect(agentFlowEvents).toEqual(['INPROGRESS', 'STOPPED'])

            const companionFinishIdx = events.findIndex(
                (e) => e.event === 'nextAgentFlow' && e.data?.nodeId === 'directReplyAgentflow_0' && e.data?.status === 'FINISHED'
            )
            const companionTokenIdx = events.findIndex((e) => e.event === 'token' && e.data === 'Review summary: All pre-checks passed')
            const actionIdx = events.findIndex((e) => e.event === 'action')
            const stoppedEventIdx = events.findIndex((e) => e.event === 'agentFlowEvent' && e.data === 'STOPPED')

            expect(companionFinishIdx).toBeGreaterThan(-1)
            expect(companionTokenIdx).toBeGreaterThan(-1)
            expect(actionIdx).toBeGreaterThan(companionFinishIdx)
            expect(stoppedEventIdx).toBeGreaterThan(companionTokenIdx)
            expect(stoppedEventIdx).toBeGreaterThan(companionFinishIdx)
            expect(events.filter((e) => e.event === 'action')).toHaveLength(1)

            expect(streamDs.executions[0].state).toBe('STOPPED')
            const apiMsg = streamDs.chatMessages.find((m) => m.role === 'apiMessage')
            expect(apiMsg?.action).toBeTruthy()
            expect(JSON.parse(apiMsg.action).data.nodeId).toBe('humanInputAgentflow_0')
            expect(turn1Sse.text).toBe(recorder.getStreamedText())
            expect(apiMsg.content).toBe(turn1Sse.text)
            expect(turn1Sse.text).toContain('Review summary: All pre-checks passed')
            expect(turn1Sse.text).toContain('Approve?')

            // Turn 2 Proceed must NOT re-execute companion branch and returns only Approved!
            const turn2Sse = await runTestAgentFlow({
                chatflow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'looks good' },
                    overrideConfig: { sessionId: sessionSse },
                    trustedState: turn1Sse.trustedState
                },
                appDataSource: streamDs.appDataSource,
                componentNodes: realComponentNodes,
                chatId: 'chat-flow05-sse-turn2'
            })
            expect(turn2Sse.text).toBe('Approved!')
            expect(streamDs.executions[0].state).toBe('FINISHED')
            expect(turn2Sse.agentFlowExecutedData.filter((d: any) => d.nodeId === 'customFunctionAgentflow_0')).toHaveLength(1)
            expect(turn2Sse.agentFlowExecutedData.filter((d: any) => d.nodeId === 'directReplyAgentflow_0')).toHaveLength(1)
            // Task 07 (D11) clears the recorded stop message's action by its id; until then the row keeps it
            expect(streamDs.chatMessages.filter((m) => Boolean(m.action))).toHaveLength(1)

            // Non-streaming Turn 1 + Turn 2 Reject
            const restDs = createMockDataSource()
            const sessionRest = 'sess-flow05-rest'
            const turn1Rest = await runTestAgentFlow({
                chatflow,
                incomingInput: { question: 'please review', streaming: false, overrideConfig: { sessionId: sessionRest } },
                appDataSource: restDs.appDataSource,
                componentNodes: realComponentNodes
            })
            expect(turn1Rest.text).toBe('Review summary: All pre-checks passed\n\n\n\nApprove?')
            expect(restDs.executions[0].state).toBe('STOPPED')
            expect(restDs.chatMessages.find((m) => m.role === 'apiMessage')?.action).toBeTruthy()

            const turn2Reject = await runTestAgentFlow({
                chatflow,
                incomingInput: {
                    humanInput: { type: 'reject', startNodeId: 'humanInputAgentflow_0', feedback: 'no' },
                    overrideConfig: { sessionId: sessionRest },
                    trustedState: turn1Rest.trustedState
                },
                appDataSource: restDs.appDataSource,
                componentNodes: realComponentNodes
            })
            expect(turn2Reject.text).toBe('Rejected.')
            expect(restDs.executions[0].state).toBe('FINISHED')
        })

        it('passes the STOPPED node humanInputAction into resumed executeNode even when a slower sibling finishes last', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('agent_0', 'agentAgentflow', { label: 'Tool Agent', position: { x: 200, y: 0 } }),
                    createNode('slowSibling', 'directReplyAgentflow', {
                        position: { x: 200, y: 200 },
                        inputs: { directReplyMessage: 'Companion note' }
                    }),
                    createNode('afterAgent', 'mockAfter')
                ],
                [createEdge('start_0', 'agent_0'), createEdge('start_0', 'slowSibling'), createEdge('agent_0', 'afterAgent')]
            )

            const agentStopped = createDeferred<void>()
            let observedActionOnResume: any
            let observedAfterAgentAction: any = 'uninitialized'
            const { appDataSource, executions, chatMessages } = createMockDataSource()

            const factory = createMockNodeFactory({
                agent_0: async (nd, _inp, opts) => {
                    if (!opts.humanInputAction) {
                        agentStopped.resolve()
                        return {
                            id: nd.id,
                            name: 'agentAgentflow',
                            input: { messages: [{ role: 'assistant', content: 'Run tool?' }] },
                            output: { content: 'Need approval', isWaitingForHumanInput: true },
                            state: {}
                        }
                    }
                    observedActionOnResume = opts.humanInputAction
                    return {
                        id: nd.id,
                        name: 'agentAgentflow',
                        input: { messages: [] },
                        output: { content: 'Tool finished' },
                        state: { toolDone: true }
                    }
                },
                slowSibling: async (nd, inp, opts) => {
                    await agentStopped.promise
                    await new Promise((r) => setTimeout(r, 20))
                    return (realComponentNodes.directReplyAgentflow as any).run(nd, inp, opts)
                },
                afterAgent: async (nd, _inp, opts) => {
                    observedAfterAgentAction = opts.humanInputAction
                    return {
                        id: nd.id,
                        name: nd.name,
                        output: { content: `done:${opts.agentflowRuntime.state.toolDone}` },
                        state: opts.agentflowRuntime.state
                    }
                }
            })

            const turn1 = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'run tool', overrideConfig: { sessionId: 'sess-agent-sibling' } },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            expect(executions[0].state).toBe('STOPPED')
            expect(turn1.agentFlowExecutedData[turn1.agentFlowExecutedData.length - 1].nodeId).toBe('slowSibling')
            const storedApiMsg = chatMessages.find((m) => m.role === 'apiMessage')
            expect(JSON.parse(storedApiMsg.action).data.nodeId).toBe('agent_0')

            const turn2 = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'agent_0', feedback: 'go' },
                    overrideConfig: { sessionId: 'sess-agent-sibling' },
                    trustedState: turn1.trustedState
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            expect(observedActionOnResume?.data?.nodeId).toBe('agent_0')
            expect(observedAfterAgentAction).toBeUndefined()
            expect(turn2.text).toBe('done:true')
            expect(executions[0].state).toBe('FINISHED')
        })

        it('warns and selects deterministic primary action across multiple concurrent STOPPED branches while keeping both resumable', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger)

            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'humanTop',
                        'humanInputAgentflow',
                        { position: { x: 200, y: 10 }, inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Top Gate?' } },
                        realComponentNodes
                    ),
                    createNode(
                        'humanBottom',
                        'humanInputAgentflow',
                        {
                            position: { x: 200, y: 300 },
                            inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Bottom Gate?' }
                        },
                        realComponentNodes
                    ),
                    createNode(
                        'afterTop',
                        'directReplyAgentflow',
                        { position: { x: 400, y: 10 }, inputs: { directReplyMessage: 'Top approved' } },
                        realComponentNodes
                    ),
                    createNode(
                        'afterBottom',
                        'directReplyAgentflow',
                        { position: { x: 400, y: 300 }, inputs: { directReplyMessage: 'Bottom approved' } },
                        realComponentNodes
                    )
                ],
                [
                    createEdge('start_0', 'humanTop'),
                    createEdge('start_0', 'humanBottom'),
                    createEdge('humanTop', 'afterTop', 'humanTop-output-0'),
                    createEdge('humanBottom', 'afterBottom', 'humanBottom-output-0')
                ]
            )

            const bottomDone = createDeferred<void>()
            const { appDataSource, executions, chatMessages } = createMockDataSource()
            const chatId = 'chat-multi-stop'
            const recorder = createRealSSERecorder(chatId)

            const factory = createMockNodeFactory({
                humanBottom: async (nd, inp, opts) => {
                    const out = await (realComponentNodes.humanInputAgentflow as any).run(nd, inp, opts)
                    bottomDone.resolve()
                    return out
                },
                humanTop: async (nd, inp, opts) => {
                    await bottomDone.promise
                    await new Promise((r) => setTimeout(r, 15))
                    return (realComponentNodes.humanInputAgentflow as any).run(nd, inp, opts)
                }
            })

            const turn1 = await runTestAgentFlow({
                flow,
                incomingInput: { question: 'dual gates', overrideConfig: { sessionId: 'sess-dual-gates' } },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId,
                nodeInstanceFactory: factory
            })
            recorder.sseStreamer.removeClient(chatId)

            expect(executions[0].state).toBe('STOPPED')
            expect(warnSpy).toHaveBeenCalled()
            const stoppedEntries = turn1.agentFlowExecutedData.filter((d: any) => d.status === 'STOPPED')
            expect(stoppedEntries.map((d: any) => d.nodeId).sort()).toEqual(['humanBottom', 'humanTop'])

            const sseActions = recorder.getEvents().filter((e) => e.event === 'action')
            expect(sseActions).toHaveLength(1)
            expect(sseActions[0].data.data.nodeId).toBe('humanTop')
            const apiMsg = chatMessages.find((m) => m.role === 'apiMessage')
            expect(JSON.parse(apiMsg.action).data.nodeId).toBe('humanTop')

            // Turn 2a: explicitly resume bottom gate first; top gate remains STOPPED
            const turn2a = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'humanBottom', feedback: 'b-ok' },
                    overrideConfig: { sessionId: 'sess-dual-gates' },
                    trustedState: turn1.trustedState
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            expect(turn2a.text).toBe('Bottom approved')
            expect(executions[0].state).toBe('STOPPED')

            // Turn 2b: resume remaining gate without explicit startNodeId
            const turn2b = await runTestAgentFlow({
                flow,
                incomingInput: {
                    humanInput: { type: 'proceed', feedback: 't-ok' } as any,
                    overrideConfig: { sessionId: 'sess-dual-gates' },
                    trustedState: turn2a.trustedState
                },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })
            expect(turn2b.text).toBe('Top approved')
            expect(executions[0].state).toBe('FINISHED')
        })
    })

    describe('3. Fail-fast Abort, Root-Error Preservation, & onNodeError Policy Hook', () => {
        it('aborts in-flight siblings on node error, awaits full settlement before rejecting with root error, and leaves caller signal untouched', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('failingBranch', 'mockFail'),
                    createNode('hangingSibling', 'mockHang'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'failingBranch'),
                    createEdge('start_0', 'hangingSibling'),
                    createEdge('failingBranch', 'join_0'),
                    createEdge('hangingSibling', 'join_0')
                ]
            )

            const bothStarted = createBarrier(2, 1000)
            const siblingAborted = createDeferred<void>()
            const siblingMaySettle = createDeferred<void>()
            let siblingSettled = false
            let joinRan = false
            const callerCtrl = new AbortController()
            const { appDataSource, executions } = createMockDataSource()
            const { sseStreamer, getEvents } = createMockSSEStreamer()

            const factory = createMockNodeFactory({
                failingBranch: async () => {
                    await bothStarted.arrive()
                    throw new Error('root-db-failure')
                },
                hangingSibling: async (_nd, _inp, opts) => {
                    const signal: AbortSignal = opts.abortController.signal
                    await bothStarted.arrive()
                    await new Promise<void>((_resolve, reject) => {
                        const onAbort = () => {
                            siblingAborted.resolve()
                            siblingMaySettle.promise.then(() => {
                                siblingSettled = true
                                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
                            })
                        }
                        if (signal.aborted) {
                            onAbort()
                        } else {
                            signal.addEventListener('abort', onAbort, { once: true })
                        }
                    })
                },
                join_0: async (nd) => {
                    joinRan = true
                    return { id: nd.id, name: nd.name, output: { content: 'join' }, state: {} }
                }
            })

            let flowSettled = false
            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'fail-fast' },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer,
                chatId: 'chat-fail-fast',
                signal: callerCtrl,
                nodeInstanceFactory: factory
            }).then(
                () => {
                    flowSettled = true
                    return { ok: true as const }
                },
                (err) => {
                    flowSettled = true
                    return { ok: false as const, err }
                }
            )

            // Wait for sibling to receive child AbortController signal while still settling
            await siblingAborted.promise
            await new Promise((r) => setTimeout(r, 15))
            expect(callerCtrl.signal.aborted).toBe(false)
            expect(siblingSettled).toBe(false)
            expect(flowSettled).toBe(false)

            // Allow sibling to reject with AbortError; root error must still win
            siblingMaySettle.resolve()
            const outcome = await runPromise

            expect(outcome.ok).toBe(false)
            expect((outcome as any).err.message).toBe('root-db-failure')
            expect(siblingSettled).toBe(true)
            expect(joinRan).toBe(false)
            expect(callerCtrl.signal.aborted).toBe(false)
            expect(executions[0].state).toBe('ERROR')
            expect(getEvents('agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'ERROR'])
        })

        it('cancels all in-flight tasks cleanly on external caller abort and removes event listeners without leaks across repeated runs', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('waitA', 'mockWait'),
                    createNode('waitB', 'mockWait')
                ],
                [createEdge('start_0', 'waitA'), createEdge('start_0', 'waitB')]
            )

            const reusableCtrl = new AbortController()
            const addSpy = jest.spyOn(reusableCtrl.signal, 'addEventListener')
            const removeSpy = jest.spyOn(reusableCtrl.signal, 'removeEventListener')

            // Run 1: clean completion should leave 0 active listeners
            const ds1 = createMockDataSource()
            await runTestAgentFlow({
                flow,
                incomingInput: { question: 'ok' },
                appDataSource: ds1.appDataSource,
                componentNodes: realComponentNodes,
                signal: reusableCtrl,
                nodeInstanceFactory: createMockNodeFactory({
                    waitA: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'A' }, state: {} }),
                    waitB: async (nd) => ({ id: nd.id, name: nd.name, output: { content: 'B' }, state: {} })
                })
            })
            expect(addSpy).toHaveBeenCalledTimes(1)
            expect(removeSpy).toHaveBeenCalledTimes(1)

            // Run 2: external abort mid-flight cancels both nodes, sets TERMINATED, and cleans up listener
            const started = createBarrier(2, 1000)
            const ds2 = createMockDataSource()
            const { sseStreamer, getEvents } = createMockSSEStreamer()

            const waitHandler = async (_nd: any, _inp: any, opts: any) => {
                await started.arrive()
                return new Promise((_resolve, reject) => {
                    const sig: AbortSignal = opts.abortController.signal
                    const abortNow = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
                    if (sig.aborted) abortNow()
                    else sig.addEventListener('abort', abortNow, { once: true })
                })
            }

            const runPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'cancel-me' },
                appDataSource: ds2.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer,
                chatId: 'chat-ext-abort',
                signal: reusableCtrl,
                nodeInstanceFactory: createMockNodeFactory({ waitA: waitHandler, waitB: waitHandler })
            })

            await waitUntil(() => started.arrivedCount() === 2)
            reusableCtrl.abort()

            await expect(runPromise).rejects.toThrow(/cancelled/i)
            expect(ds2.executions[0].state).toBe('TERMINATED')
            expect(getEvents('agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'TERMINATED'])
            expect(addSpy).toHaveBeenCalledTimes(2)
            expect(removeSpy).toHaveBeenCalledTimes(2)
        })

        it('supports extensible onNodeError skip-branch policy hook so healthy sibling paths complete', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'
            const flow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('badBranch', 'mockBad'),
                    createNode('goodBranch', 'mockGood'),
                    createNode('join_0', 'mockJoin')
                ],
                [
                    createEdge('start_0', 'badBranch'),
                    createEdge('start_0', 'goodBranch'),
                    createEdge('badBranch', 'join_0'),
                    createEdge('goodBranch', 'join_0')
                ]
            )

            const { appDataSource, executions } = createMockDataSource()
            const telemetry = { sendTelemetry: jest.fn().mockResolvedValue(undefined) } as unknown as Telemetry
            let goodFinished = false

            const res = await executeAgentFlow({
                componentNodes: realComponentNodes,
                incomingInput: { question: 'skip-branch' },
                chatflow: createChatflow(flow),
                chatId: 'chat-skip-branch',
                appDataSource,
                telemetry,
                usageCacheManager: {} as UsageCacheManager,
                cachePool: {} as CachePool,
                sseStreamer: undefined as any,
                baseURL: 'http://localhost:3000',
                isInternal: false,
                orgId: 'org-1',
                workspaceId: 'ws-1',
                subscriptionId: '',
                productId: '',
                onNodeError: () => 'skip-branch',
                nodeInstanceFactory: createMockNodeFactory({
                    badBranch: async () => {
                        throw new Error('non-fatal-branch-error')
                    },
                    goodBranch: async (nd, _inp, opts) => {
                        await new Promise((r) => setTimeout(r, 15))
                        goodFinished = true
                        return {
                            id: nd.id,
                            name: nd.name,
                            output: { content: 'good' },
                            state: { ...opts.agentflowRuntime.state, good: 'yes' }
                        }
                    },
                    join_0: async (nd, _inp, opts) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `join:${opts.agentflowRuntime.state.good}` },
                        state: opts.agentflowRuntime.state
                    })
                })
            })

            expect(goodFinished).toBe(true)
            expect(executions[0].state).toBe('FINISHED')
            expect(res.text).toBe('join:yes')
            expect(res.agentFlowExecutedData.find((d: any) => d.nodeId === 'badBranch')?.status).toBe('ERROR')
            expect(res.agentFlowExecutedData.find((d: any) => d.nodeId === 'join_0')?.status).toBe('FINISHED')
        })

        it('aborts iterationAgentflow immediately on sibling fail-fast, bypasses skip-branch on external abort, and persists scheduler maxIterations ERROR', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // 1. iterationAgentflow stops immediately on fail-fast abort without executing remaining iterations or committing FINISHED
            const iterFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('iter_0', 'iterationAgentflow', { inputs: { iterationInput: '["a","b","c"]' } }, realComponentNodes),
                    createNode(
                        'subStart',
                        'startAgentflow',
                        { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                        realComponentNodes
                    ),
                    createNode('subLeaf', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                    createNode('failSibling', 'mockFail')
                ],
                [createEdge('start_0', 'iter_0'), createEdge('start_0', 'failSibling'), createEdge('subStart', 'subLeaf')]
            )
            const iterStarted = createDeferred<void>()
            const { appDataSource: iterDs, executions: iterExecs } = createMockDataSource()
            let subRuns = 0
            await expect(
                runTestAgentFlow({
                    flow: iterFlow,
                    incomingInput: { question: 'iter-abort' },
                    appDataSource: iterDs,
                    componentNodes: realComponentNodes,
                    nodeInstanceFactory: createMockNodeFactory({
                        subLeaf: async (nd, _inp, opts) => {
                            subRuns += 1
                            iterStarted.resolve()
                            await new Promise<void>((_resolve, reject) => {
                                const sig: AbortSignal = opts.abortController.signal
                                const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
                                if (sig.aborted) onAbort()
                                else sig.addEventListener('abort', onAbort, { once: true })
                            })
                            return { id: nd.id, name: nd.name, output: { content: 'never' }, state: {} }
                        },
                        failSibling: async () => {
                            await iterStarted.promise
                            throw new Error('sibling-boom-stopped-iter')
                        }
                    })
                })
            ).rejects.toThrow('sibling-boom-stopped-iter')
            expect(subRuns).toBe(1)
            expect(iterExecs[0].state).toBe('ERROR')
            const storedIterData = JSON.parse(await Compression.decompress(iterExecs[0].executionDataBlob))
            expect(storedIterData.find((d: any) => d.nodeId === 'iter_0')?.status).not.toBe('FINISHED')

            // 2. External abort bypasses skip-branch policy and resolves to TERMINATED
            const extCtrl = new AbortController()
            const skipFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('slowNode', 'mockSlow')
                ],
                [createEdge('start_0', 'slowNode')]
            )
            const slowStarted = createDeferred<void>()
            const { appDataSource: extDs, executions: extExecs } = createMockDataSource()
            const { sseStreamer: extSse, getEvents: extEvents } = createMockSSEStreamer()
            const extPromise = executeAgentFlow({
                componentNodes: realComponentNodes,
                incomingInput: { question: 'ext-skip' },
                chatflow: createChatflow(skipFlow),
                chatId: 'chat-ext-skip',
                appDataSource: extDs,
                telemetry: { sendTelemetry: jest.fn().mockResolvedValue(undefined) } as unknown as Telemetry,
                usageCacheManager: {} as UsageCacheManager,
                cachePool: {} as CachePool,
                sseStreamer: extSse,
                baseURL: 'http://localhost:3000',
                isInternal: false,
                signal: extCtrl,
                orgId: 'org-1',
                workspaceId: 'ws-1',
                subscriptionId: '',
                productId: '',
                onNodeError: () => 'skip-branch',
                nodeInstanceFactory: createMockNodeFactory({
                    slowNode: async (nd, _inp, opts) => {
                        slowStarted.resolve()
                        await new Promise<void>((_resolve, reject) => {
                            const sig: AbortSignal = opts.abortController.signal
                            const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
                            if (sig.aborted) onAbort()
                            else sig.addEventListener('abort', onAbort, { once: true })
                        })
                        return { id: nd.id, name: nd.name, output: { content: 'never' }, state: {} }
                    }
                })
            })
            await slowStarted.promise
            extCtrl.abort()
            await expect(extPromise).rejects.toThrow(/cancelled/i)
            expect(extExecs[0].state).toBe('TERMINATED')
            expect(extEvents('agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'TERMINATED'])

            // 3. Scheduler-level fatal error (MAX_ITERATIONS exceeded) persists ERROR in DB and SSE instead of INPROGRESS
            process.env.MAX_ITERATIONS = '1'
            const chainFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode('step_1', 'directReplyAgentflow', { inputs: { directReplyMessage: '1' } }, realComponentNodes),
                    createNode('step_2', 'directReplyAgentflow', { inputs: { directReplyMessage: '2' } }, realComponentNodes)
                ],
                [createEdge('start_0', 'step_1'), createEdge('step_1', 'step_2')]
            )
            const { appDataSource: maxDs, executions: maxExecs } = createMockDataSource()
            const { sseStreamer: maxSse, getEvents: maxEvents } = createMockSSEStreamer()
            await expect(
                runTestAgentFlow({
                    flow: chainFlow,
                    incomingInput: { question: 'max-iter' },
                    appDataSource: maxDs,
                    componentNodes: realComponentNodes,
                    sseStreamer: maxSse,
                    chatId: 'chat-max-iter'
                })
            ).rejects.toThrow('Maximum iteration limit reached')
            expect(maxExecs[0].state).toBe('ERROR')
            expect(maxEvents('agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'ERROR'])
        })
    })

    describe('4. Serialized EXECUTIONS_DB_THREAD persistence & TrustedState parity', () => {
        it('serializes overlapping iterationAgentflow and final updateExecution calls FIFO under EXECUTIONS_DB_THREAD=1', async () => {
            process.env.EXECUTIONS_DB_THREAD = '1'
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
                    createNode('subLeaf', 'mockSub', { parentNode: 'iter_0', extent: 'parent' })
                ],
                [createEdge('start_0', 'iter_0'), createEdge('subStart', 'subLeaf')]
            )

            const observedCalls: Array<{ state?: string; count: number }> = []
            let inFlightWorkers = 0
            let maxInFlightWorkers = 0
            const firstGate = createDeferred<void>()
            let callIndex = 0

            mockExecutionsUpdaterRun.mockImplementation(async ({ data }: any) => {
                callIndex += 1
                const idx = callIndex
                inFlightWorkers += 1
                maxInFlightWorkers = Math.max(maxInFlightWorkers, inFlightWorkers)
                const parsed = data?.executionDataBlob
                    ? JSON.parse(await Compression.decompress(data.executionDataBlob))
                    : JSON.parse(data?.executionData || '[]')
                observedCalls.push({ state: data?.state, count: parsed.length })

                if (idx === 1) {
                    // Slow down first checkpoint deliberately; later checkpoints must wait for it
                    await firstGate.promise
                }
                inFlightWorkers -= 1
            })

            const { appDataSource } = createMockDataSource()
            let finished = false
            const flowPromise = runTestAgentFlow({
                flow,
                incomingInput: { question: 'serialize-db' },
                appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: createMockNodeFactory({
                    subLeaf: async (nd, _inp, opts) => ({
                        id: nd.id,
                        name: nd.name,
                        output: { content: `item:${opts.iterationContext?.value}` },
                        state: opts.agentflowRuntime.state
                    })
                })
            }).finally(() => {
                finished = true
            })

            await waitUntil(() => observedCalls.length === 1)
            await new Promise((r) => setTimeout(r, 20))
            // Second checkpoint must NOT begin in parallel, and executeAgentFlow must await full drain
            expect(observedCalls).toHaveLength(1)
            expect(finished).toBe(false)

            firstGate.resolve()
            const res = await flowPromise

            expect(maxInFlightWorkers).toBe(1)
            expect(res.text).toBe('item:one\nitem:two')
            // Iter 1 checkpoint -> Iter 2 checkpoint -> Final checkpoint (FINISHED); a checkpoint serializes the records committed when it runs,
            // so the gated Iter 2 write already sees the finished iteration and matches the final record count
            expect(observedCalls.map((c) => c.state)).toEqual([undefined, undefined, 'FINISHED'])
            expect(observedCalls[0].count).toBeLessThan(observedCalls[1].count)
            expect(observedCalls[1].count).toBeLessThanOrEqual(observedCalls[2].count)
            expect(observedCalls[2].count).toBe(res.agentFlowExecutedData.length)
        })

        it('preserves trustedState parity across parallel STOPPED (plus stateless resume), ERROR, and TERMINATED', async () => {
            process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = '4'

            // 1. Parallel STOPPED + companion text with useTrustedState=true & zeroRetention=true
            const hitlFlow = createFlow(
                [
                    createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                    createNode(
                        'human_0',
                        'humanInputAgentflow',
                        { position: { x: 200, y: 200 }, inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Confirm?' } },
                        realComponentNodes
                    ),
                    createNode(
                        'companion_0',
                        'directReplyAgentflow',
                        { position: { x: 200, y: 20 }, inputs: { directReplyMessage: 'Summary ready' } },
                        realComponentNodes
                    ),
                    createNode(
                        'approved_0',
                        'directReplyAgentflow',
                        { position: { x: 400, y: 200 }, inputs: { directReplyMessage: 'Confirmed!' } },
                        realComponentNodes
                    )
                ],
                [
                    createEdge('start_0', 'human_0'),
                    createEdge('start_0', 'companion_0'),
                    createEdge('human_0', 'approved_0', 'human_0-output-0')
                ]
            )
            const trustedChatflow = createChatflow(hitlFlow, {
                chatbotConfig: JSON.stringify({ clientState: { enabled: true, enabledFull: true } })
            })

            const { appDataSource, executions, chatMessages } = createMockDataSource()
            const humanDone = createDeferred<void>()
            const trustedFactory = createMockNodeFactory({
                human_0: async (nd, inp, opts) => {
                    const out = await (realComponentNodes.humanInputAgentflow as any).run(nd, inp, opts)
                    humanDone.resolve()
                    return out
                },
                companion_0: async (nd, inp, opts) => {
                    await humanDone.promise
                    await new Promise((r) => setTimeout(r, 15))
                    return (realComponentNodes.directReplyAgentflow as any).run(nd, inp, opts)
                }
            })

            const sse1 = createRealSSERecorder('chat-trusted-stop')
            await runTestAgentFlow({
                chatflow: trustedChatflow,
                incomingInput: { question: 'trusted stop', overrideConfig: { sessionId: 'ts-stop-1' } },
                appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: sse1.sseStreamer,
                chatId: 'chat-trusted-stop',
                nodeInstanceFactory: trustedFactory
            })
            sse1.sseStreamer.removeClient('chat-trusted-stop')

            expect(executions).toHaveLength(0)
            expect(chatMessages).toHaveLength(0)
            const trustedStopEvt = sse1.getEvents().find((e) => e.event === 'trustedStateData')
            const decodedStop = (await trusted_state_from_string(trustedStopEvt!.data)) as any
            expect(decodedStop.version).toBe(2)
            expect(decodedStop.pendingResume.legacyExecution.state).toBe('STOPPED')
            const decodedStopData = JSON.parse(decodedStop.pendingResume.legacyExecution.executionData)
            expect(decodedStopData.some((d: any) => d.nodeId === 'companion_0' && d.status === 'FINISHED')).toBe(true)
            expect(decodedStopData.some((d: any) => d.nodeId === 'human_0' && d.status === 'STOPPED')).toBe(true)

            const turn2 = await runTestAgentFlow({
                chatflow: trustedChatflow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'human_0' },
                    trustedState: trustedStopEvt!.data,
                    overrideConfig: { sessionId: 'ts-stop-1' }
                },
                appDataSource,
                componentNodes: realComponentNodes,
                chatId: 'chat-trusted-resume'
            })
            expect(turn2.text).toBe('Confirmed!')
            expect(executions).toHaveLength(0)

            // 2. Fail-fast ERROR trustedState parity
            const errFlow = createChatflow(
                createFlow(
                    [
                        createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                        createNode('boom_0', 'mockBoom')
                    ],
                    [createEdge('start_0', 'boom_0')]
                ),
                { chatbotConfig: JSON.stringify({ clientState: { enabled: true, enabledFull: true } }) }
            )
            const sseErr = createRealSSERecorder('chat-trusted-err')
            await expect(
                runTestAgentFlow({
                    chatflow: errFlow,
                    incomingInput: { question: 'err' },
                    appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: sseErr.sseStreamer,
                    chatId: 'chat-trusted-err',
                    nodeInstanceFactory: createMockNodeFactory({
                        boom_0: async () => {
                            throw new Error('trusted-boom')
                        }
                    })
                })
            ).rejects.toThrow('trusted-boom')
            sseErr.sseStreamer.removeClient('chat-trusted-err')
            const errTrustedEvt = sseErr.getEvents().find((e) => e.event === 'trustedStateData')
            const decodedErr = (await trusted_state_from_string(errTrustedEvt!.data)) as any
            expect(decodedErr).toMatchObject({ version: 2, history: [] })
            expect(decodedErr.pendingResume).toBeUndefined()

            // 3. External TERMINATED abort trustedState parity
            const abortCtrl = new AbortController()
            abortCtrl.abort()
            const sseTerm = createRealSSERecorder('chat-trusted-term')
            await expect(
                runTestAgentFlow({
                    chatflow: errFlow,
                    incomingInput: { question: 'term' },
                    appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: sseTerm.sseStreamer,
                    chatId: 'chat-trusted-term',
                    signal: abortCtrl
                })
            ).rejects.toThrow(/cancelled/i)
            sseTerm.sseStreamer.removeClient('chat-trusted-term')
            const termTrustedEvt = sseTerm.getEvents().find((e) => e.event === 'trustedStateData')
            const decodedTerm = (await trusted_state_from_string(termTrustedEvt!.data)) as any
            expect(decodedTerm).toMatchObject({ version: 2, history: [] })
            expect(decodedTerm.pendingResume).toBeUndefined()
        })
    })
})
