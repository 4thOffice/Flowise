import { cloneDeep, countBy } from 'lodash'
import { AnalyticHandler, ICommonObject } from 'flowise-components'
import { Compression, Execution } from '../../../src/database/entities/Execution'
import { IAgentflowExecutedData, IncomingAgentflowInput, IReactFlowObject } from '../../../src/Interface'
import { NodeInstanceFactory } from '../../../src/utils/agentflow/types'
import executionsWorker from '../../../src/utils/executionsWorker'
import { trusted_state_from_string } from '../../../src/utils/trustedStateHelper'
import { SSEStreamer } from '../../../src/utils/SSEStreamer'
import logger from '../../../src/utils/logger'
import { PredictionQueue } from '../../../src/queue/PredictionQueue'
import { AbortControllerPool } from '../../../src/AbortControllerPool'
import { CachePool } from '../../../src/CachePool'
import { UsageCacheManager } from '../../../src/UsageCacheManager'
import { Telemetry } from '../../../src/utils/telemetry'
import {
    ConcurrencyTracker,
    MockNodeHandler,
    RunTestAgentFlowOptions,
    createBarrier,
    createChatflow,
    createDeferred,
    createEdge,
    createFlow,
    createMockDataSource,
    createMockNodeFactory,
    createMockSSEStreamer,
    createNode,
    createRealSSERecorder,
    loadBaselineFlow,
    loadRealComponentNodes,
    runTestAgentFlow,
    waitUntil
} from './testHelpers'

const mockExecutionsUpdaterRun = jest.fn()
let mockWorkerDataSourceRef: any
const mockRedisPublisherCalls: Array<{ method: string; args: any[] }> = []

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

jest.mock('bullmq', () => ({
    Queue: class {
        name: string
        constructor(name: string) {
            this.name = name
        }
    },
    QueueEvents: class {},
    Worker: class {}
}))

jest.mock('../../../src/queue/RedisEventPublisher', () => ({
    RedisEventPublisher: class {
        constructor() {
            return new Proxy(
                { connect: async () => undefined },
                {
                    get: (target: Record<string, any>, prop: string | symbol) => {
                        if (typeof prop !== 'string' || prop === 'then') return undefined
                        if (prop in target) return target[prop]
                        return (...args: any[]) => {
                            mockRedisPublisherCalls.push({ method: prop, args })
                        }
                    }
                }
            )
        }
    }
}))

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const createAbortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError())
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(createAbortError())
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function hashString(value: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

// Keyed by (seed, node, visit) rather than drawn in call order so a seed replays identically regardless of interleaving
const seededUnit = (seed: number, key: string) => mulberry32((seed ^ hashString(key)) >>> 0)()

const finalStateOf = (records: IAgentflowExecutedData[]) => records[records.length - 1]?.data?.state ?? {}

const nextAgentFlowEvents = (events: Array<{ event: string; data: any }>) =>
    events.filter((e) => e.event === 'nextAgentFlow').map((e) => e.data as { nodeId: string; status: string; error?: string })

const indexOfStatus = (events: Array<{ event: string; data: any }>, nodeId: string, status: string) =>
    events.findIndex((e) => e.event === 'nextAgentFlow' && e.data?.nodeId === nodeId && e.data?.status === status)

async function decompressExecutionData(execution: any): Promise<IAgentflowExecutedData[]> {
    return JSON.parse(await Compression.decompress(execution.executionDataBlob))
}

async function runFlow(options: RunTestAgentFlowOptions): Promise<ICommonObject> {
    return (await runTestAgentFlow(options)) as ICommonObject
}

describe('Agentflow V2 Task 07: end-to-end concurrent execution integration', () => {
    const realComponentNodes = loadRealComponentNodes()
    const originalEnv = {
        AGENTFLOW_MAX_NODE_CONCURRENCY: process.env.AGENTFLOW_MAX_NODE_CONCURRENCY,
        EXECUTIONS_DB_THREAD: process.env.EXECUTIONS_DB_THREAD
    }

    const setConcurrency = (limit: number) => {
        process.env.AGENTFLOW_MAX_NODE_CONCURRENCY = String(limit)
    }

    const createTrackedFactory = (
        handlers: Record<string, MockNodeHandler>,
        tracker: ConcurrencyTracker,
        runLog: string[]
    ): NodeInstanceFactory => {
        const inner = createMockNodeFactory(handlers, realComponentNodes)
        return async (nodeName, reactFlowNode, componentNodes) => {
            const instance = await inner(nodeName, reactFlowNode, componentNodes)
            return {
                run: (nodeData, input, options) => {
                    runLog.push(reactFlowNode.id)
                    return tracker.track(reactFlowNode.id, () => instance.run(nodeData, input, options))
                }
            }
        }
    }

    const startNode = (inputs: Record<string, any> = {}) =>
        createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput', ...inputs } }, realComponentNodes)

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
        mockExecutionsUpdaterRun.mockReset()
        mockWorkerDataSourceRef = undefined
        mockRedisPublisherCalls.length = 0
        jest.restoreAllMocks()
    })

    describe('1. Randomized latency fuzzing and concurrency parity', () => {
        type FuzzPlan = { outer: 'T' | 'F'; inner: 'A' | 'B'; passes: number }

        const FAST_LEAF_TEXT = 'Fast leaf: quick acknowledgement'
        const exitText = (label: 'A' | 'B', passes: number) => `Exit ${label} after ${passes} passes`
        const MOCK_NODE_IDS = [
            'w1',
            'w2',
            'w3',
            'w4',
            'w5',
            'ia1',
            'ia2',
            'ib1',
            'of1',
            'of2',
            'of3',
            'joinMain',
            'loopEntry',
            'la',
            'lb',
            'leafFast',
            'exitA',
            'exitB',
            'silentLeaf'
        ]

        // start -> 5-wide fan-out; w1 -> nested conditions with multi-hop branches; join; loop over [la, lb]; 4 leaves (1 silent)
        const buildFuzzFlow = (passes: number): IReactFlowObject => {
            const real = (id: string, name: string, y: number, inputs: Record<string, any>) =>
                createNode(id, name, { position: { x: 0, y }, inputs }, realComponentNodes)
            const mock = (id: string, y: number) => createNode(id, 'mockWorker', { position: { x: 0, y } })
            return createFlow(
                [
                    real('start_0', 'startAgentflow', 0, { startInputType: 'chatInput', startState: [{ key: 'tmp', value: 'seed' }] }),
                    mock('w1', 10),
                    mock('w2', 20),
                    mock('w3', 30),
                    mock('w4', 40),
                    mock('w5', 50),
                    real('condOuter', 'conditionAgentflow', 60, {
                        conditions: [{ type: 'string', value1: '{{ question }}', operation: 'contains', value2: 'outer:T' }]
                    }),
                    real('condInner', 'conditionAgentflow', 70, {
                        conditions: [{ type: 'string', value1: '{{ question }}', operation: 'contains', value2: 'inner:A' }]
                    }),
                    mock('ia1', 80),
                    mock('ia2', 90),
                    mock('ib1', 100),
                    mock('of1', 110),
                    mock('of2', 120),
                    mock('of3', 130),
                    mock('joinMain', 140),
                    mock('loopEntry', 150),
                    mock('la', 160),
                    mock('lb', 170),
                    real('loopCheck', 'conditionAgentflow', 180, {
                        conditions: [{ type: 'number', value1: '{{ loop_count }}', operation: 'smaller', value2: String(passes - 1) }]
                    }),
                    real('loopBack', 'loopAgentflow', 190, { loopBackToNode: 'loopEntry-Loop Entry', maxLoopCount: '10' }),
                    mock('leafFast', 200),
                    mock('exitA', 210),
                    mock('exitB', 220),
                    mock('silentLeaf', 230)
                ],
                [
                    createEdge('start_0', 'w1'),
                    createEdge('start_0', 'w2'),
                    createEdge('start_0', 'w3'),
                    createEdge('start_0', 'w4'),
                    createEdge('start_0', 'w5'),
                    createEdge('w1', 'condOuter'),
                    createEdge('condOuter', 'condInner', 'condOuter-output-0'),
                    createEdge('condOuter', 'of1', 'condOuter-output-1'),
                    createEdge('condInner', 'ia1', 'condInner-output-0'),
                    createEdge('condInner', 'ib1', 'condInner-output-1'),
                    createEdge('ia1', 'ia2'),
                    createEdge('of1', 'of2'),
                    createEdge('of2', 'of3'),
                    createEdge('ia2', 'joinMain'),
                    createEdge('ib1', 'joinMain'),
                    createEdge('of3', 'joinMain'),
                    createEdge('w2', 'joinMain'),
                    createEdge('w3', 'joinMain'),
                    createEdge('joinMain', 'loopEntry'),
                    createEdge('loopEntry', 'la'),
                    createEdge('loopEntry', 'lb'),
                    createEdge('la', 'loopCheck'),
                    createEdge('lb', 'loopCheck'),
                    createEdge('loopCheck', 'loopBack', 'loopCheck-output-0'),
                    createEdge('loopCheck', 'exitA', 'loopCheck-output-1'),
                    createEdge('loopCheck', 'exitB', 'loopCheck-output-1'),
                    createEdge('w4', 'leafFast'),
                    createEdge('w5', 'silentLeaf')
                ]
            )
        }

        const createFuzzHandlers = (plan: FuzzPlan, seed: number, violations: string[]): Record<string, MockNodeHandler> => {
            const visitKey = (id: string) => `visit_${id}`
            const nextVisit = (state: ICommonObject, id: string) => Number(state[visitKey(id)] ?? 0) + 1
            const latency = (key: string, maxMs: number) => sleep(Math.floor(seededUnit(seed, key) * (maxMs + 1)))
            const check = (condition: boolean, message: string) => {
                if (!condition) violations.push(message)
            }

            const worker =
                (
                    id: string,
                    hooks: {
                        check?: (state: ICommonObject, visit: number) => void
                        extraState?: (state: ICommonObject, visit: number) => ICommonObject
                    } = {}
                ): MockNodeHandler =>
                async (nodeData, _input, options) => {
                    const state: ICommonObject = options.agentflowRuntime.state
                    const visit = nextVisit(state, id)
                    hooks.check?.(state, visit)
                    await latency(`${id}#${visit}`, 20)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        input: {},
                        output: { content: `${id}#${visit}` },
                        state: { ...state, [visitKey(id)]: visit, ...(hooks.extraState?.(state, visit) ?? {}) }
                    }
                }

            const streamingLeaf =
                (id: string, text: (state: ICommonObject) => string, hookCheck?: (state: ICommonObject) => void): MockNodeHandler =>
                async (nodeData, _input, options) => {
                    const state: ICommonObject = options.agentflowRuntime.state
                    const visit = nextVisit(state, id)
                    hookCheck?.(state)
                    await latency(`${id}#${visit}`, 20)
                    const content = text(state)
                    const size = Math.ceil(content.length / 3)
                    const chunks = [content.slice(0, size), content.slice(size, size * 2), content.slice(size * 2)]
                    for (let i = 0; i < chunks.length; i += 1) {
                        if (i > 0) await latency(`${id}#${visit}:chunk${i}`, 3)
                        if (options.isLastNode && options.sseStreamer) {
                            options.sseStreamer.streamTokenEvent(options.chatId, chunks[i])
                        }
                    }
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        input: {},
                        output: { content },
                        state: { ...state, [visitKey(id)]: visit }
                    }
                }

            const checkLoopCompleted = (label: string) => (state: ICommonObject) => {
                check(
                    state.passes === plan.passes && state.visit_la === plan.passes && state.visit_lb === plan.passes,
                    `${label} launched with passes=${state.passes} visit_la=${state.visit_la} visit_lb=${state.visit_lb}`
                )
            }

            return {
                w1: worker('w1'),
                w2: worker('w2'),
                w3: worker('w3'),
                w4: worker('w4'),
                w5: worker('w5'),
                ia1: worker('ia1'),
                ia2: worker('ia2', { check: (state) => check(state.visit_ia1 === 1, 'ia2 launched before ia1 committed') }),
                ib1: worker('ib1'),
                of1: worker('of1'),
                of2: worker('of2', { check: (state) => check(state.visit_of1 === 1, 'of2 launched before of1 committed') }),
                of3: worker('of3', { check: (state) => check(state.visit_of2 === 1, 'of3 launched before of2 committed') }),
                joinMain: worker('joinMain', {
                    check: (state) => {
                        const tail = plan.outer === 'F' ? 'of3' : plan.inner === 'A' ? 'ia2' : 'ib1'
                        for (const id of ['w1', 'w2', 'w3', tail]) {
                            check(state[visitKey(id)] === 1, `joinMain launched before ${id} committed`)
                        }
                    }
                }),
                loopEntry: worker('loopEntry', {
                    check: (state, visit) => {
                        const previous = visit - 1
                        check(
                            Number(state.passes ?? 0) === previous &&
                                Number(state.visit_la ?? 0) === previous &&
                                Number(state.visit_lb ?? 0) === previous,
                            `loopEntry pass ${visit} launched before pass ${previous} fully committed`
                        )
                    },
                    extraState: (_state, visit) => ({ passes: visit })
                }),
                la: worker('la', { check: (state, visit) => check(state.passes === visit, `la pass ${visit} saw passes=${state.passes}`) }),
                lb: worker('lb', { check: (state, visit) => check(state.passes === visit, `lb pass ${visit} saw passes=${state.passes}`) }),
                leafFast: streamingLeaf('leafFast', () => FAST_LEAF_TEXT),
                exitA: streamingLeaf('exitA', (state) => exitText('A', state.passes), checkLoopCompleted('exitA')),
                exitB: streamingLeaf('exitB', (state) => exitText('B', state.passes), checkLoopCompleted('exitB')),
                silentLeaf: async (nodeData, _input, options) => {
                    const state: ICommonObject = { ...options.agentflowRuntime.state }
                    delete state.tmp
                    const visit = nextVisit(state, 'silentLeaf')
                    await latency(`silentLeaf#${visit}`, 20)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        input: {},
                        output: { content: '' },
                        state: { ...state, [visitKey('silentLeaf')]: visit }
                    }
                }
            }
        }

        const expectedRunCounts = (plan: FuzzPlan): Record<string, number> => {
            const counts: Record<string, number> = {
                start_0: 1,
                w1: 1,
                w2: 1,
                w3: 1,
                w4: 1,
                w5: 1,
                condOuter: 1,
                joinMain: 1,
                loopEntry: plan.passes,
                la: plan.passes,
                lb: plan.passes,
                loopCheck: plan.passes,
                exitA: 1,
                exitB: 1,
                leafFast: 1,
                silentLeaf: 1
            }
            if (plan.passes > 1) counts.loopBack = plan.passes - 1
            if (plan.outer === 'T') {
                counts.condInner = 1
                if (plan.inner === 'A') {
                    counts.ia1 = 1
                    counts.ia2 = 1
                } else {
                    counts.ib1 = 1
                }
            } else {
                counts.of1 = 1
                counts.of2 = 1
                counts.of3 = 1
            }
            return counts
        }

        const expectedFinalState = (plan: FuzzPlan): ICommonObject => {
            const state: ICommonObject = { passes: plan.passes }
            for (const [id, count] of Object.entries(expectedRunCounts(plan))) {
                if (MOCK_NODE_IDS.includes(id)) state[`visit_${id}`] = count
            }
            return state
        }

        const expectedSegments = (plan: FuzzPlan) => [FAST_LEAF_TEXT, exitText('A', plan.passes), exitText('B', plan.passes)]

        const runFuzzScenario = async (plan: FuzzPlan, seed: number, streaming: boolean) => {
            const violations: string[] = []
            const tracker = new ConcurrencyTracker()
            const runLog: string[] = []
            const db = createMockDataSource()
            const chatId = `chat-fuzz-${seed}`
            const recorder = streaming ? createRealSSERecorder(chatId) : undefined
            const result = await runFlow({
                flow: buildFuzzFlow(plan.passes),
                incomingInput: { question: `outer:${plan.outer} inner:${plan.inner}` },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder?.sseStreamer,
                chatId,
                nodeInstanceFactory: createTrackedFactory(createFuzzHandlers(plan, seed, violations), tracker, runLog)
            })
            recorder?.close()
            return { result, violations, tracker, runLog, db, recorder }
        }

        const assertFuzzRun = async (
            run: Awaited<ReturnType<typeof runFuzzScenario>>,
            plan: FuzzPlan,
            limit: number,
            streaming: boolean
        ) => {
            const { result, violations, tracker, runLog, db, recorder } = run
            const records = result.agentFlowExecutedData as IAgentflowExecutedData[]
            const expectedCounts = expectedRunCounts(plan)

            expect(violations).toEqual([])
            expect(countBy(runLog)).toEqual(expectedCounts)
            expect(countBy(records.map((r) => r.nodeId))).toEqual(expectedCounts)
            expect(records.every((r) => r.status === 'FINISHED')).toBe(true)
            expect(finalStateOf(records)).toEqual(expectedFinalState(plan))

            expect(tracker.maxObserved).toBeLessThanOrEqual(limit)
            expect(tracker.maxObserved).toBeGreaterThanOrEqual(Math.min(limit, 5))

            expect(db.executions).toHaveLength(1)
            expect(db.executions[0].state).toBe('FINISHED')
            expect((await decompressExecutionData(db.executions[0])).map((r) => r.nodeId)).toEqual(records.map((r) => r.nodeId))
            const apiMessage = db.chatMessages.find((m) => m.role === 'apiMessage')
            expect(apiMessage?.content).toBe(result.text)
            expect(apiMessage?.executionId).toBe(db.executions[0].id)

            if (streaming && recorder) {
                const events = recorder.getEvents()
                expect(recorder.getStreamedText()).toBe(result.text)
                expect([...result.text.split('\n\n')].sort()).toEqual([...expectedSegments(plan)].sort())
                expect(events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'FINISHED'])
                const statusCounts = countBy(nextAgentFlowEvents(events).map((e) => `${e.nodeId}:${e.status}`))
                for (const [nodeId, count] of Object.entries(expectedCounts)) {
                    expect(statusCounts[`${nodeId}:INPROGRESS`]).toBe(count)
                    expect(statusCounts[`${nodeId}:FINISHED`]).toBe(count)
                }
                expect(nextAgentFlowEvents(events).some((e) => e.status === 'ERROR' || e.status === 'TERMINATED')).toBe(false)
                expect(events[events.length - 1]).toEqual({ event: 'end', data: '[DONE]' })
            } else {
                expect(result.text).toBe(expectedSegments(plan).join('\n\n'))
            }
        }

        it('keeps exact execution counts, DPE skips, disjoint state merges, terminal output, and the concurrency bound across 60 randomized runs', async () => {
            const LIMITS = [1, 2, 3, 4, 6, 10]
            const BASE_SEED = 0x7a5c07
            const rng = mulberry32(BASE_SEED)

            for (let iteration = 0; iteration < 60; iteration += 1) {
                const seed = BASE_SEED + iteration
                const limit = LIMITS[iteration % LIMITS.length]
                const streaming = Math.floor(iteration / LIMITS.length) % 2 === 0
                const plan: FuzzPlan = {
                    outer: rng() < 0.5 ? 'T' : 'F',
                    inner: rng() < 0.5 ? 'A' : 'B',
                    passes: 1 + Math.floor(rng() * 3)
                }
                setConcurrency(limit)
                try {
                    await assertFuzzRun(await runFuzzScenario(plan, seed, streaming), plan, limit, streaming)
                } catch (error) {
                    if (error instanceof Error) {
                        error.message = `[fuzz iteration=${iteration} seed=${seed} limit=${limit} streaming=${streaming} plan=${JSON.stringify(
                            plan
                        )}]\n${error.message}`
                    }
                    throw error
                }
            }
        }, 180000)

        describe('Parity: AGENTFLOW_MAX_NODE_CONCURRENCY=1 vs 10', () => {
            const normalizeRun = (result: ICommonObject, db: ReturnType<typeof createMockDataSource>) => {
                const records = result.agentFlowExecutedData as IAgentflowExecutedData[]
                const apiMessages = db.chatMessages.filter((m) => m.role === 'apiMessage')
                const lastApiMessage = apiMessages[apiMessages.length - 1]
                return {
                    text: result.text,
                    executionStates: db.executions.map((e) => e.state),
                    finalState: finalStateOf(records),
                    recordCounts: countBy(records.map((r) => `${r.nodeId}:${r.status}`)),
                    actionNodeId: lastApiMessage?.action ? JSON.parse(lastApiMessage.action).data.nodeId : null
                }
            }

            const runBaselineTurns = async (file: string, turns: IncomingAgentflowInput[]) => {
                const chatflow = createChatflow(loadBaselineFlow(file), { id: `cf-parity-${file}` })
                const db = createMockDataSource()
                const normalized = []
                let trustedState: string | undefined
                for (const incomingInput of turns) {
                    const result = await runFlow({
                        chatflow,
                        incomingInput: { ...incomingInput, trustedState },
                        appDataSource: db.appDataSource,
                        componentNodes: realComponentNodes
                    })
                    trustedState = result.trustedState
                    normalized.push(normalizeRun(result, db))
                }
                return normalized
            }

            const runFuzzParity = async (plan: FuzzPlan) => {
                const run = await runFuzzScenario(plan, 0xfa11, false)
                expect(run.violations).toEqual([])
                return [normalizeRun(run.result, run.db)]
            }

            const PARITY_CASES: Array<[string, () => Promise<ReturnType<typeof normalizeRun>[]>, string[]]> = [
                [
                    'fuzz DAG (outer=T, inner=A, 2 loop passes)',
                    () => runFuzzParity({ outer: 'T', inner: 'A', passes: 2 }),
                    [expectedSegments({ outer: 'T', inner: 'A', passes: 2 }).join('\n\n')]
                ],
                [
                    'fuzz DAG (outer=F, 3 loop passes)',
                    () => runFuzzParity({ outer: 'F', inner: 'B', passes: 3 }),
                    [expectedSegments({ outer: 'F', inner: 'B', passes: 3 }).join('\n\n')]
                ],
                [
                    'baseline Flow 02 (Cond1=True)',
                    () => runBaselineTurns('02-multi-hop-and-nested-conditions.json', [{ question: 'true-branchA' }]),
                    ['Join reached: parallel=parallel-ok, branch=cond1-true-cond2-A']
                ],
                [
                    'baseline Flow 02 (Cond1=False)',
                    () => runBaselineTurns('02-multi-hop-and-nested-conditions.json', [{ question: 'false' }]),
                    ['Join reached: parallel=parallel-ok, branch=cond1-false-F1-F2']
                ],
                [
                    'baseline Flow 03 (multi-edge Else fan-out)',
                    () => runBaselineTurns('03-condition-multi-edge-fanout.json', [{ question: 'go-true' }]),
                    ['True branch executed cleanly.']
                ],
                [
                    'baseline Flow 04 (multi-terminal + silent leaf)',
                    () => runBaselineTurns('04-multi-terminal-streaming-and-silent-leaf.json', [{ question: 'lookup data' }]),
                    ["I'm looking up the data...\n\nHere is the result."]
                ],
                [
                    'baseline Flow 05 (STOPPED + proceed resume)',
                    () =>
                        runBaselineTurns('05-human-input-with-companion-text.json', [
                            { question: 'please review', overrideConfig: { sessionId: 'parity-05' } },
                            {
                                humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'ok' },
                                overrideConfig: { sessionId: 'parity-05' }
                            }
                        ]),
                    ['Review summary: All pre-checks passed\n\n\n\nApprove?', 'Approved!']
                ],
                [
                    'baseline Flow 06 (loop over parallel subgraph)',
                    () => runBaselineTurns('06-loop-over-parallel-subgraph.json', [{ question: 'run loop' }]),
                    ['Loop exited at loop_count=2; iterA=A,A,A; iterB=B,B,B']
                ]
            ]

            it.each(PARITY_CASES)(
                '%s produces identical text, final state, node records, and execution state',
                async (_name, runScenario, expectedTexts) => {
                    setConcurrency(1)
                    const sequential = await runScenario()
                    setConcurrency(10)
                    const concurrent = await runScenario()

                    expect(concurrent).toEqual(sequential)
                    expect(concurrent.map((turn) => turn.text)).toEqual(expectedTexts)
                },
                30000
            )

            it('baseline Flow 01: =1 reproduces the pre-change sequential output verbatim while =10 runs both branches on isolated snapshots', async () => {
                const chatflow = createChatflow(loadBaselineFlow('01-parallel-fork-join-timing-and-state.json'), { id: 'cf-parity-01' })
                const runWithLimit = async (limit: number) => {
                    setConcurrency(limit)
                    const recorder = createRealSSERecorder(`chat-parity-01-${limit}`)
                    const result = await runFlow({
                        chatflow,
                        incomingInput: { question: 'run flow 01' },
                        componentNodes: realComponentNodes,
                        sseStreamer: recorder.sseStreamer,
                        chatId: `chat-parity-01-${limit}`
                    })
                    recorder.close()
                    return { result, events: recorder.getEvents() }
                }

                const sequential = await runWithLimit(1)
                expect(sequential.result.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=A(saw_b=empty))')
                expect(indexOfStatus(sequential.events, 'customFunctionAgentflow_1', 'INPROGRESS')).toBeGreaterThan(
                    indexOfStatus(sequential.events, 'customFunctionAgentflow_0', 'FINISHED')
                )

                const concurrent = await runWithLimit(10)
                expect(concurrent.result.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=empty)')
                const firstFinished = Math.min(
                    indexOfStatus(concurrent.events, 'customFunctionAgentflow_0', 'FINISHED'),
                    indexOfStatus(concurrent.events, 'customFunctionAgentflow_1', 'FINISHED')
                )
                expect(indexOfStatus(concurrent.events, 'customFunctionAgentflow_0', 'INPROGRESS')).toBeLessThan(firstFinished)
                expect(indexOfStatus(concurrent.events, 'customFunctionAgentflow_1', 'INPROGRESS')).toBeLessThan(firstFinished)
                expect(finalStateOf(concurrent.result.agentFlowExecutedData)).toEqual({
                    a: 'A(saw_b=empty)',
                    b: 'B(saw_a=empty)'
                })
            }, 15000)
        })
    })

    describe('2. Multi-terminal streaming, non-interrupting STOPPED, and fail-fast matrix', () => {
        const FAST_REPLY = 'Fast reply ready.'
        const LLM_CHUNKS = ['Slow ', 'LLM ', 'answer ', 'complete.']
        const LLM_TEXT = LLM_CHUNKS.join('')

        const buildFastSlowFlow = () =>
            createFlow(
                [
                    startNode(),
                    createNode(
                        'fastReply',
                        'directReplyAgentflow',
                        { position: { x: 0, y: 0 }, inputs: { directReplyMessage: FAST_REPLY } },
                        realComponentNodes
                    ),
                    createNode('slowLlm', 'llmAgentflow', { position: { x: 0, y: 100 } })
                ],
                [createEdge('start_0', 'fastReply'), createEdge('start_0', 'slowLlm')]
            )

        it.each([
            ['fast-first', 2, true],
            ['fast-first', 10, true],
            ['llm-first', 2, true],
            ['llm-first', 10, true],
            ['fast-first', 2, false],
            ['llm-first', 10, false]
        ] as Array<['fast-first' | 'llm-first', number, boolean]>)(
            'fast DirectReply leaf + slow LLM leaf (%s, concurrency=%i, streaming=%s) emit consecutive \\n\\n-separated streams matching ChatMessage.content',
            async (order, limit, streaming) => {
                setConcurrency(limit)
                const fastDone = createDeferred<void>()
                const llmStarted = createDeferred<void>()
                const factory = createMockNodeFactory({
                    fastReply: async (nodeData, input, options) => {
                        if (order === 'llm-first') await llmStarted.promise
                        const output = await (realComponentNodes.directReplyAgentflow as any).run(nodeData, input, options)
                        fastDone.resolve()
                        return output
                    },
                    slowLlm: async (nodeData, _input, options) => {
                        if (order === 'fast-first') await fastDone.promise
                        for (let i = 0; i < LLM_CHUNKS.length; i += 1) {
                            if (options.isLastNode && options.sseStreamer) {
                                options.sseStreamer.streamTokenEvent(options.chatId, LLM_CHUNKS[i])
                            }
                            if (i === 0) llmStarted.resolve()
                            if (i === 1 && order === 'llm-first') await fastDone.promise
                            await sleep(5)
                        }
                        return { id: nodeData.id, name: 'llmAgentflow', input: {}, output: { content: LLM_TEXT }, state: {} }
                    }
                })

                const db = createMockDataSource()
                const chatId = `chat-fast-slow-${order}-${limit}-${streaming}`
                const recorder = streaming ? createRealSSERecorder(chatId) : undefined
                const result = await runFlow({
                    flow: buildFastSlowFlow(),
                    incomingInput: { question: 'two leaves' },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: recorder?.sseStreamer,
                    chatId,
                    nodeInstanceFactory: factory
                })
                recorder?.close()

                const apiMessage = db.chatMessages.find((m) => m.role === 'apiMessage')
                expect(db.executions[0].state).toBe('FINISHED')
                expect(apiMessage?.content).toBe(result.text)

                if (recorder) {
                    const expectedTokens =
                        order === 'fast-first' ? [FAST_REPLY, '\n\n', ...LLM_CHUNKS] : [...LLM_CHUNKS, '\n\n', FAST_REPLY]
                    expect(recorder.getTokens()).toEqual(expectedTokens)
                    expect(result.text).toBe(expectedTokens.join(''))
                } else {
                    expect(result.text).toBe(`${FAST_REPLY}\n\n${LLM_TEXT}`)
                }
            },
            10000
        )

        const COMPANION_TEXT = 'Companion: deployment plan summarised.'
        const buildCompanionGateFlow = () =>
            createFlow(
                [
                    startNode(),
                    createNode(
                        'companion',
                        'directReplyAgentflow',
                        { position: { x: 0, y: 0 }, inputs: { directReplyMessage: COMPANION_TEXT } },
                        realComponentNodes
                    ),
                    createNode(
                        'gate',
                        'humanInputAgentflow',
                        {
                            position: { x: 0, y: 200 },
                            inputs: { humanInputDescriptionType: 'fixed', humanInputDescription: 'Approve deployment?' }
                        },
                        realComponentNodes
                    ),
                    createNode(
                        'approved',
                        'directReplyAgentflow',
                        { position: { x: 200, y: 150 }, inputs: { directReplyMessage: 'Approved!' } },
                        realComponentNodes
                    ),
                    createNode(
                        'rejected',
                        'directReplyAgentflow',
                        { position: { x: 200, y: 250 }, inputs: { directReplyMessage: 'Rejected.' } },
                        realComponentNodes
                    )
                ],
                [
                    createEdge('start_0', 'companion'),
                    createEdge('start_0', 'gate'),
                    createEdge('gate', 'approved', 'gate-output-0'),
                    createEdge('gate', 'rejected', 'gate-output-1')
                ]
            )

        const createSlowCompanionFactory = () => {
            const gateStopped = createDeferred<void>()
            return createMockNodeFactory({
                gate: async (nodeData, input, options) => {
                    const output = await (realComponentNodes.humanInputAgentflow as any).run(nodeData, input, options)
                    gateStopped.resolve()
                    return output
                },
                companion: async (nodeData, input, options) => {
                    await gateStopped.promise
                    await sleep(20)
                    return (realComponentNodes.directReplyAgentflow as any).run(nodeData, input, options)
                }
            })
        }

        it.each([
            [true, 'proceed', 'Approved!'],
            [true, 'reject', 'Rejected.'],
            [false, 'proceed', 'Approved!'],
            [false, 'reject', 'Rejected.']
        ] as Array<[boolean, 'proceed' | 'reject', string]>)(
            'companion branch + HumanInput (streaming=%s, resume=%s) drains companion text before STOPPED, persists text + action, and resumes cleanly',
            async (streaming, resumeType, expectedResumeText) => {
                setConcurrency(4)
                const flow = buildCompanionGateFlow()
                const db = createMockDataSource()
                const sessionId = `sess-companion-${streaming}-${resumeType}`
                const chatId = `chat-companion-${streaming}-${resumeType}`
                const recorder = streaming ? createRealSSERecorder(chatId) : undefined

                const turn1 = await runFlow({
                    flow,
                    incomingInput: { question: 'deploy please', overrideConfig: { sessionId } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: recorder?.sseStreamer,
                    chatId,
                    nodeInstanceFactory: createSlowCompanionFactory()
                })
                recorder?.close()

                expect(db.executions[0].state).toBe('STOPPED')
                const turn1Message = db.chatMessages.find((m) => m.role === 'apiMessage')
                expect(JSON.parse(turn1Message.action).data.nodeId).toBe('gate')
                expect(turn1Message.content).toBe(turn1.text)
                expect(turn1.text).toContain(COMPANION_TEXT)
                expect(turn1.text).toContain('Approve deployment?')

                if (recorder) {
                    const events = recorder.getEvents()
                    expect(recorder.getStreamedText()).toBe(turn1.text)
                    expect(events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'STOPPED'])
                    const gateStoppedIdx = indexOfStatus(events, 'gate', 'STOPPED')
                    const companionFinishedIdx = indexOfStatus(events, 'companion', 'FINISHED')
                    const actionIdxs = events.flatMap((e, idx) => (e.event === 'action' ? [idx] : []))
                    const stoppedFlowIdx = events.findIndex((e) => e.event === 'agentFlowEvent' && e.data === 'STOPPED')
                    const lastTokenIdx = events.map((e) => e.event).lastIndexOf('token')
                    expect(gateStoppedIdx).toBeGreaterThan(-1)
                    expect(companionFinishedIdx).toBeGreaterThan(gateStoppedIdx)
                    expect(actionIdxs).toHaveLength(1)
                    expect(actionIdxs[0]).toBeGreaterThan(companionFinishedIdx)
                    expect(stoppedFlowIdx).toBeGreaterThan(lastTokenIdx)
                } else {
                    expect(turn1.text).toBe(`${COMPANION_TEXT}\n\n\n\nApprove deployment?`)
                }

                const turn2 = await runFlow({
                    flow,
                    incomingInput: {
                        humanInput: { type: resumeType, startNodeId: 'gate', feedback: `${resumeType} via test` },
                        overrideConfig: { sessionId },
                        trustedState: turn1.trustedState
                    },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    chatId: `${chatId}-resume`,
                    nodeInstanceFactory: createSlowCompanionFactory()
                })

                const records = turn2.agentFlowExecutedData as IAgentflowExecutedData[]
                expect(turn2.text).toBe(expectedResumeText)
                expect(db.executions).toHaveLength(1)
                expect(db.executions[0].state).toBe('FINISHED')
                expect(records.filter((r) => r.nodeId === 'companion')).toHaveLength(1)
                expect(records.filter((r) => r.nodeId === 'gate').map((r) => r.status)).toEqual(['FINISHED'])
                expect(records.some((r) => r.status === 'STOPPED')).toBe(false)
                // Task 07 (D11) clears the recorded stop message's action by its id; until then the row keeps it
                expect(db.chatMessages.filter((m) => Boolean(m.action))).toHaveLength(1)
            },
            10000
        )

        it.each([
            [3, false],
            [3, true],
            [10, false],
            [10, true]
        ] as Array<[number, boolean]>)(
            'fail-fast (concurrency=%i, streaming=%s): siblings observe the child abort and settle before the root error is thrown',
            async (limit, streaming) => {
                setConcurrency(limit)
                const flow = createFlow(
                    [
                        startNode(),
                        createNode('boom', 'mockBoom', { position: { x: 0, y: 0 } }),
                        createNode('coop', 'mockCoop', { position: { x: 0, y: 100 } }),
                        createNode('stubborn', 'mockStubborn', { position: { x: 0, y: 200 } }),
                        createNode('afterStubborn', 'mockAfter', { position: { x: 200, y: 200 } }),
                        createNode('late', 'mockCoop', { position: { x: 0, y: 300 } })
                    ],
                    [
                        createEdge('start_0', 'boom'),
                        createEdge('start_0', 'coop'),
                        createEdge('start_0', 'stubborn'),
                        createEdge('stubborn', 'afterStubborn'),
                        createEdge('start_0', 'late')
                    ]
                )

                const settled: Record<string, { at: number; sawAbort: boolean }> = {}
                const cooperative: MockNodeHandler = async (nodeData, _input, options) => {
                    const signal: AbortSignal | undefined = options.abortController?.signal
                    try {
                        if (options.isLastNode && options.sseStreamer) {
                            options.sseStreamer.streamTokenEvent(options.chatId, `${nodeData.id} partial`)
                        }
                        await abortableSleep(2000, signal)
                        return { id: nodeData.id, name: nodeData.name, output: { content: `${nodeData.id} done` } }
                    } finally {
                        settled[nodeData.id] = { at: Date.now(), sawAbort: Boolean(signal?.aborted) }
                    }
                }
                const runLog: string[] = []
                const factory = createTrackedFactory(
                    {
                        boom: async () => {
                            await sleep(15)
                            throw new Error('boom-root-cause')
                        },
                        coop: cooperative,
                        late: cooperative,
                        stubborn: async (nodeData) => {
                            await sleep(60)
                            settled.stubborn = { at: Date.now(), sawAbort: false }
                            return { id: nodeData.id, name: nodeData.name, output: { content: 'stubborn done' } }
                        },
                        afterStubborn: async (nodeData) => ({ id: nodeData.id, name: nodeData.name, output: { content: 'never' } })
                    },
                    new ConcurrencyTracker(),
                    runLog
                )

                const callerController = new AbortController()
                const db = createMockDataSource()
                const chatId = `chat-failfast-${limit}-${streaming}`
                const recorder = streaming ? createRealSSERecorder(chatId) : undefined
                await expect(
                    runFlow({
                        flow,
                        incomingInput: { question: 'fail fast' },
                        appDataSource: db.appDataSource,
                        componentNodes: realComponentNodes,
                        sseStreamer: recorder?.sseStreamer,
                        chatId,
                        signal: callerController,
                        nodeInstanceFactory: factory
                    })
                ).rejects.toThrow('boom-root-cause')
                const rejectedAt = Date.now()
                recorder?.close()

                expect(callerController.signal.aborted).toBe(false)
                expect(settled.coop.sawAbort).toBe(true)
                expect(settled.coop.at).toBeLessThanOrEqual(rejectedAt)
                expect(settled.stubborn.at).toBeLessThanOrEqual(rejectedAt)
                expect(runLog).not.toContain('afterStubborn')
                expect(runLog.includes('late')).toBe(limit > 3)
                if (limit > 3) expect(settled.late.sawAbort).toBe(true)

                expect(db.executions[0].state).toBe('ERROR')
                expect(db.chatMessages).toHaveLength(0)
                const persisted = await decompressExecutionData(db.executions[0])
                const statusOf = (nodeId: string) => persisted.filter((r) => r.nodeId === nodeId).map((r) => r.status)
                expect(statusOf('boom')).toEqual(['ERROR'])
                expect(persisted.find((r) => r.nodeId === 'boom')?.data?.error).toBe('boom-root-cause')
                expect(statusOf('coop')).toEqual(['TERMINATED'])
                expect(statusOf('stubborn')).toEqual(['FINISHED'])
                expect(statusOf('afterStubborn')).toEqual([])
                expect(statusOf('late')).toEqual(limit > 3 ? ['TERMINATED'] : [])

                if (recorder) {
                    const events = recorder.getEvents()
                    expect(events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'ERROR'])
                    expect(nextAgentFlowEvents(events).find((e) => e.nodeId === 'boom' && e.status === 'ERROR')?.error).toBe(
                        'boom-root-cause'
                    )
                    expect(events.some((e) => e.event === 'action')).toBe(false)
                }
            },
            10000
        )
    })

    describe('3. Sequential iterationAgentflow with a concurrent inner subflow', () => {
        it('runs 3 items strictly in order, fans each item out concurrently, and never leaks subflow state across items', async () => {
            setConcurrency(4)
            const items = ['alpha', 'beta', 'gamma']
            const flow = createFlow(
                [
                    startNode({ startState: [{ key: 'origin', value: 'outer' }] }),
                    createNode(
                        'iter_0',
                        'iterationAgentflow',
                        { position: { x: 0, y: 0 }, inputs: { iterationInput: JSON.stringify(items) } },
                        realComponentNodes
                    ),
                    createNode('side_0', 'mockSide', { position: { x: 0, y: 300 } }),
                    createNode('after_0', 'mockAfter'),
                    createNode(
                        'subStart',
                        'startAgentflow',
                        { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                        realComponentNodes
                    ),
                    createNode('subA', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                    createNode('subB', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                    createNode('subJoin', 'mockSub', { parentNode: 'iter_0', extent: 'parent' })
                ],
                [
                    createEdge('start_0', 'iter_0'),
                    createEdge('start_0', 'side_0'),
                    createEdge('iter_0', 'after_0'),
                    createEdge('side_0', 'after_0'),
                    createEdge('subStart', 'subA'),
                    createEdge('subStart', 'subB'),
                    createEdge('subA', 'subJoin'),
                    createEdge('subB', 'subJoin')
                ]
            )

            const violations: string[] = []
            const phases: string[] = []
            const barriers = items.map(() => createBarrier(2, 2000))
            const innerTracker = new ConcurrencyTracker()
            const firstItemStarted = createDeferred<void>()
            let afterState: ICommonObject = {}

            const itemKeys = (j: number) => [`a_${j}`, `b_${j}`, `joined_${j}`]
            const subBranch =
                (label: 'a' | 'b'): MockNodeHandler =>
                async (nodeData, _input, options) => {
                    const idx = options.iterationContext.index as number
                    const value = options.iterationContext.value as string
                    const ownState: ICommonObject = options.agentflowRuntime.state
                    const inherited: ICommonObject = options.iterationContext.agentflowRuntime?.state ?? {}
                    if (idx === 0) firstItemStarted.resolve()
                    for (let j = 0; j < items.length; j += 1) {
                        if (itemKeys(j).some((key) => key in ownState)) {
                            violations.push(`item ${idx} sub-${label} subflow runtime already holds item ${j} keys`)
                        }
                        const inheritedCount = itemKeys(j).filter((key) => key in inherited).length
                        if (inheritedCount !== (j < idx ? 3 : 0)) {
                            violations.push(`item ${idx} sub-${label} inherited ${inheritedCount}/3 keys of item ${j}`)
                        }
                    }
                    phases.push(`start:${label}:${idx}`)
                    return innerTracker.track(`${label}:${idx}`, async () => {
                        await barriers[idx].arrive()
                        phases.push(`end:${label}:${idx}`)
                        return {
                            id: nodeData.id,
                            name: nodeData.name,
                            output: { content: `${label}:${value}` },
                            state: { ...ownState, [`${label}_${idx}`]: value }
                        }
                    })
                }

            const factory = createMockNodeFactory({
                subA: subBranch('a'),
                subB: subBranch('b'),
                subJoin: async (nodeData, _input, options) => {
                    const idx = options.iterationContext.index as number
                    const state: ICommonObject = options.agentflowRuntime.state
                    if (state[`a_${idx}`] !== items[idx] || state[`b_${idx}`] !== items[idx]) {
                        violations.push(`item ${idx} join saw a=${state[`a_${idx}`]} b=${state[`b_${idx}`]}`)
                    }
                    phases.push(`join:${idx}`)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `joined:${items[idx]}` },
                        state: { ...state, [`joined_${idx}`]: `${state[`a_${idx}`]}+${state[`b_${idx}`]}`, lastItem: idx }
                    }
                },
                side_0: async (nodeData, _input, options) => {
                    await firstItemStarted.promise
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: '' },
                        state: { ...options.agentflowRuntime.state, side: 'done' }
                    }
                },
                after_0: async (nodeData, _input, options) => {
                    afterState = cloneDeep(options.agentflowRuntime.state)
                    const joined = items.map((_item, i) => afterState[`joined_${i}`]).join('|')
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `after:${joined}:${afterState.side}` },
                        state: options.agentflowRuntime.state
                    }
                }
            })

            const result = await runFlow({
                flow,
                incomingInput: { question: 'iterate' },
                componentNodes: realComponentNodes,
                nodeInstanceFactory: factory
            })

            expect(violations).toEqual([])
            expect(innerTracker.maxObserved).toBe(2)
            expect(result.text).toBe('after:alpha+alpha|beta+beta|gamma+gamma:done')
            expect(afterState).toEqual({
                origin: 'outer',
                side: 'done',
                a_0: 'alpha',
                b_0: 'alpha',
                joined_0: 'alpha+alpha',
                a_1: 'beta',
                b_1: 'beta',
                joined_1: 'beta+beta',
                a_2: 'gamma',
                b_2: 'gamma',
                joined_2: 'gamma+gamma',
                lastItem: 2
            })
            for (let idx = 1; idx < items.length; idx += 1) {
                const previousJoin = phases.indexOf(`join:${idx - 1}`)
                expect(previousJoin).toBeGreaterThan(-1)
                expect(phases.indexOf(`start:a:${idx}`)).toBeGreaterThan(previousJoin)
                expect(phases.indexOf(`start:b:${idx}`)).toBeGreaterThan(previousJoin)
            }
            const subRecords = (result.agentFlowExecutedData as IAgentflowExecutedData[]).filter(
                (r) => r.data?.parentNodeId === 'iter_0' && r.nodeId === 'subJoin'
            )
            expect(subRecords.map((r) => r.data.iterationIndex)).toEqual([0, 1, 2])
        }, 15000)
    })

    describe('4. Multi-request isolation', () => {
        it('runs concurrent executeAgentFlow calls on shared streamer + datasource with zero cross-request leakage', async () => {
            setConcurrency(3)
            const forkFlow = createFlow(
                [
                    startNode(),
                    createNode('p1', 'mockWorker', { position: { x: 0, y: 0 } }),
                    createNode('p2', 'mockWorker', { position: { x: 0, y: 100 } }),
                    createNode('p3', 'mockWorker', { position: { x: 0, y: 200 } }),
                    createNode('join', 'mockWorker'),
                    createNode('leafX', 'mockLeaf', { position: { x: 0, y: 0 } }),
                    createNode('leafY', 'mockLeaf', { position: { x: 0, y: 100 } })
                ],
                [
                    createEdge('start_0', 'p1'),
                    createEdge('start_0', 'p2'),
                    createEdge('start_0', 'p3'),
                    createEdge('p1', 'join'),
                    createEdge('p2', 'join'),
                    createEdge('p3', 'join'),
                    createEdge('join', 'leafX'),
                    createEdge('join', 'leafY')
                ]
            )
            const forkChatflow = createChatflow(forkFlow, { id: 'cf-iso-fork' })
            const gateChatflow = createChatflow(loadBaselineFlow('05-human-input-with-companion-text.json'), { id: 'cf-iso-gate' })

            const violations: string[] = []
            const tagDelay = (tag: string, key: string) => sleep(Math.floor(seededUnit(hashString(tag), key) * 16))
            const branch =
                (id: string): MockNodeHandler =>
                async (nodeData, input, options) => {
                    const tag = String(input)
                    await tagDelay(tag, id)
                    if (id === 'p2' && tag.includes('boom')) throw new Error(`boom in ${tag}`)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `${tag}:${id}` },
                        state: { ...options.agentflowRuntime.state, [id]: tag }
                    }
                }
            const leaf =
                (label: string): MockNodeHandler =>
                async (nodeData, input, options) => {
                    const tag = String(input)
                    const text = `${tag} says ${label}`
                    for (const chunk of [`${tag} `, `says ${label}`]) {
                        await tagDelay(tag, `${label}:${chunk}`)
                        if (options.isLastNode && options.sseStreamer) options.sseStreamer.streamTokenEvent(options.chatId, chunk)
                    }
                    return { id: nodeData.id, name: nodeData.name, output: { content: text }, state: options.agentflowRuntime.state }
                }
            const factory = createMockNodeFactory({
                p1: branch('p1'),
                p2: branch('p2'),
                p3: branch('p3'),
                join: async (nodeData, input, options) => {
                    const tag = String(input)
                    const state: ICommonObject = options.agentflowRuntime.state
                    for (const key of ['p1', 'p2', 'p3']) {
                        if (state[key] !== tag) violations.push(`${tag} join saw ${key}=${state[key]}`)
                    }
                    return { id: nodeData.id, name: nodeData.name, output: { content: `${tag}:join` }, state: { ...state, joined: tag } }
                },
                leafX: leaf('X'),
                leafY: leaf('Y')
            })

            const sharedStreamer = new SSEStreamer()
            const db = createMockDataSource()
            const forkTags = ['req-0', 'req-1', 'req-2', 'req-3 boom', 'req-4', 'req-5', 'req-6']
            const forkRequests = forkTags.map((tag, i) => {
                const chatId = `chat-iso-${i}`
                const recorder = createRealSSERecorder(chatId, sharedStreamer)
                const promise = runFlow({
                    chatflow: forkChatflow,
                    incomingInput: { question: tag, overrideConfig: { sessionId: `sess-iso-${i}` } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: sharedStreamer,
                    chatId,
                    nodeInstanceFactory: factory
                })
                return { tag, chatId, sessionId: `sess-iso-${i}`, recorder, promise }
            })
            const gateRequests = ['gate-a', 'gate-b'].map((sessionId) => {
                const chatId = `chat-${sessionId}`
                const recorder = createRealSSERecorder(chatId, sharedStreamer)
                const promise = runFlow({
                    chatflow: gateChatflow,
                    incomingInput: { question: `please review ${sessionId}`, overrideConfig: { sessionId } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: sharedStreamer,
                    chatId
                })
                return { sessionId, chatId, recorder, promise }
            })

            const forkResults = await Promise.allSettled(forkRequests.map((r) => r.promise))
            const gateResults = await Promise.allSettled(gateRequests.map((r) => r.promise))
            forkRequests.forEach((r) => r.recorder.close())
            gateRequests.forEach((r) => r.recorder.close())

            expect(violations).toEqual([])

            forkRequests.forEach((request, i) => {
                const settled = forkResults[i]
                const wire = request.recorder.getRawWire()
                const foreignTags = (wire.match(/req-\d+/g) ?? []).filter((t) => t !== request.tag.split(' ')[0])
                expect(foreignTags).toEqual([])
                const execution = db.executions.find((e) => e.sessionId === request.sessionId)
                if (request.tag.includes('boom')) {
                    expect(settled.status).toBe('rejected')
                    expect((settled as PromiseRejectedResult).reason.message).toBe('boom in req-3 boom')
                    expect(execution.state).toBe('ERROR')
                    expect(
                        request.recorder
                            .getEvents()
                            .filter((e) => e.event === 'agentFlowEvent')
                            .map((e) => e.data)
                    ).toEqual(['INPROGRESS', 'ERROR'])
                    return
                }
                expect(settled.status).toBe('fulfilled')
                const result = (settled as PromiseFulfilledResult<ICommonObject>).value
                expect([...result.text.split('\n\n')].sort()).toEqual([`${request.tag} says X`, `${request.tag} says Y`])
                expect(request.recorder.getStreamedText()).toBe(result.text)
                expect(finalStateOf(result.agentFlowExecutedData)).toEqual({
                    p1: request.tag,
                    p2: request.tag,
                    p3: request.tag,
                    joined: request.tag
                })
                expect(execution.state).toBe('FINISHED')
                const sessionMessages = db.chatMessages.filter((m) => m.sessionId === request.sessionId)
                expect(sessionMessages.map((m) => [m.role, m.content])).toEqual([
                    ['userMessage', request.tag],
                    ['apiMessage', result.text]
                ])
            })

            for (const [i, request] of gateRequests.entries()) {
                expect(gateResults[i].status).toBe('fulfilled')
                const turn1 = (gateResults[i] as PromiseFulfilledResult<ICommonObject>).value
                expect(request.recorder.getStreamedText()).toBe(turn1.text)
                expect(turn1.text).toContain('Review summary: All pre-checks passed')
                expect(turn1.text).toContain('Approve?')
                expect(db.executions.find((e) => e.sessionId === request.sessionId).state).toBe('STOPPED')
            }

            const resumes = await Promise.all(
                gateRequests.map((request, i) =>
                    runFlow({
                        chatflow: gateChatflow,
                        incomingInput: {
                            humanInput: {
                                type: i === 0 ? 'proceed' : 'reject',
                                startNodeId: 'humanInputAgentflow_0',
                                feedback: request.sessionId
                            },
                            overrideConfig: { sessionId: request.sessionId },
                            trustedState: (gateResults[i] as PromiseFulfilledResult<ICommonObject>).value.trustedState
                        },
                        appDataSource: db.appDataSource,
                        componentNodes: realComponentNodes,
                        chatId: `${request.chatId}-resume`
                    })
                )
            )
            expect(resumes.map((r) => r.text)).toEqual(['Approved!', 'Rejected.'])
            expect(db.executions).toHaveLength(forkTags.length + gateRequests.length)
            for (const request of gateRequests) {
                expect(db.executions.find((e) => e.sessionId === request.sessionId).state).toBe('FINISHED')
            }
        }, 20000)
    })

    describe('5. Persistence & execution modes', () => {
        const buildCheckpointFlow = () =>
            createFlow(
                [
                    startNode(),
                    createNode('w1', 'mockWorker', { position: { x: 0, y: 0 } }),
                    createNode(
                        'iter_0',
                        'iterationAgentflow',
                        { position: { x: 0, y: 100 }, inputs: { iterationInput: '["one","two"]' } },
                        realComponentNodes
                    ),
                    createNode(
                        'subStart',
                        'startAgentflow',
                        { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                        realComponentNodes
                    ),
                    createNode('subLeaf', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                    createNode('join', 'mockWorker')
                ],
                [
                    createEdge('start_0', 'w1'),
                    createEdge('start_0', 'iter_0'),
                    createEdge('w1', 'join'),
                    createEdge('iter_0', 'join'),
                    createEdge('subStart', 'subLeaf')
                ]
            )

        const checkpointFactory = () =>
            createMockNodeFactory({
                w1: async (nodeData, _input, options) => {
                    await sleep(10)
                    return {
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: 'w1' },
                        state: { ...options.agentflowRuntime.state, w1: 'done' }
                    }
                },
                subLeaf: async (nodeData, _input, options) => ({
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `item:${options.iterationContext?.value}` },
                    state: {
                        ...options.agentflowRuntime.state,
                        [`item_${options.iterationContext?.index}`]: options.iterationContext?.value
                    }
                }),
                join: async (nodeData, _input, options) => ({
                    id: nodeData.id,
                    name: nodeData.name,
                    output: { content: `join:${options.agentflowRuntime.state.w1}:${options.agentflowRuntime.state.item_1}` },
                    state: options.agentflowRuntime.state
                })
            })

        it('iteration checkpoints include records that parallel siblings committed after the iteration node started', async () => {
            setConcurrency(4)
            const flow = createFlow(
                [
                    startNode(),
                    createNode(
                        'iter_0',
                        'iterationAgentflow',
                        { position: { x: 0, y: 0 }, inputs: { iterationInput: '["one","two"]' } },
                        realComponentNodes
                    ),
                    createNode(
                        'subStart',
                        'startAgentflow',
                        { inputs: { startInputType: 'chatInput' }, parentNode: 'iter_0', extent: 'parent' },
                        realComponentNodes
                    ),
                    createNode('subLeaf', 'mockSub', { parentNode: 'iter_0', extent: 'parent' }),
                    createNode('sibling', 'mockWorker', { position: { x: 0, y: 100 } })
                ],
                [createEdge('start_0', 'iter_0'), createEdge('start_0', 'sibling'), createEdge('subStart', 'subLeaf')]
            )
            const db = createMockDataSource()
            const executionRepo: any = db.appDataSource.getRepository(Execution)
            const originalSave = executionRepo.save
            const checkpoints: string[][] = []
            executionRepo.save = async (obj: any) => {
                if (obj.state === 'INPROGRESS' && obj.executionDataBlob) {
                    checkpoints.push((await decompressExecutionData(obj)).map((r) => r.nodeId))
                }
                return originalSave(obj)
            }
            const { sseStreamer, getEvents } = createMockSSEStreamer()
            const siblingCommitted = () =>
                getEvents('nextAgentFlow').some((e) => e.data?.nodeId === 'sibling' && e.data?.status === 'FINISHED')

            await runFlow({
                flow,
                incomingInput: { question: 'checkpoint freshness' },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer,
                nodeInstanceFactory: createMockNodeFactory({
                    sibling: async (nodeData) => ({ id: nodeData.id, name: nodeData.name, output: { content: '' } }),
                    subLeaf: async (nodeData, _input, options) => {
                        await waitUntil(siblingCommitted, 2000)
                        return { id: nodeData.id, name: nodeData.name, output: { content: `item:${options.iterationContext?.value}` } }
                    }
                })
            })

            const iterationCheckpoints = checkpoints.filter((ids) => ids.includes('subLeaf'))
            expect(iterationCheckpoints).toHaveLength(2)
            for (const ids of iterationCheckpoints) {
                expect(ids).toContain('sibling')
                expect(ids.filter((id) => id === 'subLeaf').length).toBeLessThanOrEqual(2)
            }
        }, 10000)

        it('default TypeORM path: persists Execution + ChatMessage rows with strictly serialized checkpoint saves', async () => {
            setConcurrency(4)
            const db = createMockDataSource()
            const executionRepo: any = db.appDataSource.getRepository(Execution)
            const originalSave = executionRepo.save
            const saves: Array<{ state: string; recordCount: number }> = []
            let inFlight = 0
            let maxInFlight = 0
            executionRepo.save = async (obj: any) => {
                inFlight += 1
                maxInFlight = Math.max(maxInFlight, inFlight)
                try {
                    const recordCount = obj.executionDataBlob ? (await decompressExecutionData(obj)).length : 0
                    saves.push({ state: obj.state, recordCount })
                    await sleep(5)
                    return await originalSave(obj)
                } finally {
                    inFlight -= 1
                }
            }

            const result = await runFlow({
                flow: buildCheckpointFlow(),
                incomingInput: { question: 'persist' },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: checkpointFactory()
            })

            expect(result.text).toBe('join:done:two')
            expect(maxInFlight).toBe(1)
            expect(saves[0].state).toBe('INPROGRESS')
            expect(saves[saves.length - 1].state).toBe('FINISHED')
            expect(saves.length).toBe(4)
            for (let i = 1; i < saves.length; i += 1) {
                expect(saves[i].recordCount).toBeGreaterThanOrEqual(saves[i - 1].recordCount)
            }
            expect(db.executions).toHaveLength(1)
            const execution = db.executions[0]
            expect(execution.executionData).toBe('[]')
            expect(await decompressExecutionData(execution)).toEqual(JSON.parse(JSON.stringify(result.agentFlowExecutedData)))
            expect(db.chatMessages.map((m) => [m.role, m.content, m.executionId])).toEqual([
                ['userMessage', 'persist', execution.id],
                ['apiMessage', result.text, execution.id]
            ])
        }, 10000)

        it('EXECUTIONS_DB_THREAD=1: routes every checkpoint through the executions worker one at a time in FIFO order', async () => {
            process.env.EXECUTIONS_DB_THREAD = '1'
            setConcurrency(4)
            const db = createMockDataSource()
            mockWorkerDataSourceRef = Object.assign(db.appDataSource, { isInitialized: true })
            const workerCalls: Array<{ state?: string; recordCount: number }> = []
            let inFlight = 0
            let maxInFlight = 0
            mockExecutionsUpdaterRun.mockImplementation(async (payload: any) => {
                inFlight += 1
                maxInFlight = Math.max(maxInFlight, inFlight)
                try {
                    const recordCount = payload.data?.executionDataBlob
                        ? JSON.parse(await Compression.decompress(payload.data.executionDataBlob)).length
                        : 0
                    workerCalls.push({ state: payload.data?.state, recordCount })
                    await sleep(workerCalls.length === 1 ? 25 : 2)
                    return await executionsWorker(payload)
                } finally {
                    inFlight -= 1
                }
            })

            const result = await runFlow({
                flow: buildCheckpointFlow(),
                incomingInput: { question: 'persist-thread' },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                nodeInstanceFactory: checkpointFactory()
            })

            expect(result.text).toBe('join:done:two')
            expect(maxInFlight).toBe(1)
            expect(workerCalls.map((c) => c.state)).toEqual([undefined, undefined, 'FINISHED'])
            expect(workerCalls[0].recordCount).toBeLessThan(workerCalls[1].recordCount)
            expect(workerCalls[1].recordCount).toBeLessThanOrEqual(workerCalls[2].recordCount)
            expect(workerCalls[2].recordCount).toBe(result.agentFlowExecutedData.length)
            expect(db.executions).toHaveLength(1)
            expect(db.executions[0].state).toBe('FINISHED')
            expect(await decompressExecutionData(db.executions[0])).toEqual(JSON.parse(JSON.stringify(result.agentFlowExecutedData)))

            const hitlDb = createMockDataSource()
            mockWorkerDataSourceRef = Object.assign(hitlDb.appDataSource, { isInitialized: true })
            const chatflow = createChatflow(loadBaselineFlow('05-human-input-with-companion-text.json'), { id: 'cf-thread-05' })
            const turn1 = await runFlow({
                chatflow,
                incomingInput: { question: 'please review', overrideConfig: { sessionId: 'sess-thread-05' } },
                appDataSource: hitlDb.appDataSource,
                componentNodes: realComponentNodes
            })
            expect(turn1.text).toContain('Review summary: All pre-checks passed')
            expect(hitlDb.executions[0].state).toBe('STOPPED')
            expect(hitlDb.executions[0].stoppedDate).toBeInstanceOf(Date)
            const turn2 = await runFlow({
                chatflow,
                incomingInput: {
                    humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'ship it' },
                    overrideConfig: { sessionId: 'sess-thread-05' },
                    trustedState: turn1.trustedState
                },
                appDataSource: hitlDb.appDataSource,
                componentNodes: realComponentNodes
            })
            expect(turn2.text).toBe('Approved!')
            expect(hitlDb.executions).toHaveLength(1)
            expect(hitlDb.executions[0].state).toBe('FINISHED')
            expect(maxInFlight).toBe(1)
        }, 15000)

        it('a failed final Execution write is logged without failing the answer or masking the root node error', async () => {
            setConcurrency(4)
            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
            const db = createMockDataSource()
            const executionRepo: any = db.appDataSource.getRepository(Execution)
            const originalSave = executionRepo.save
            executionRepo.save = async (obj: any) => {
                if (obj.state !== 'INPROGRESS') throw new Error(`db write rejected for ${obj.state}`)
                return originalSave(obj)
            }
            const flow = createFlow(
                [
                    startNode(),
                    createNode('w1', 'mockWorker', { position: { x: 0, y: 0 } }),
                    createNode('w2', 'mockWorker', { position: { x: 0, y: 100 } })
                ],
                [createEdge('start_0', 'w1'), createEdge('start_0', 'w2')]
            )
            const agentFlowEventsOf = (recorder: ReturnType<typeof createRealSSERecorder>) =>
                recorder
                    .getEvents()
                    .filter((e) => e.event === 'agentFlowEvent')
                    .map((e) => e.data)

            const okRecorder = createRealSSERecorder('chat-db-fail-ok')
            const ok = await runFlow({
                flow,
                incomingInput: { question: 'db fails at the end', overrideConfig: { sessionId: 'db-fail-ok' } },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: okRecorder.sseStreamer,
                chatId: 'chat-db-fail-ok',
                nodeInstanceFactory: createMockNodeFactory({
                    w1: async (nodeData) => ({ id: nodeData.id, name: nodeData.name, output: { content: 'first leaf' } }),
                    w2: async (nodeData) => ({ id: nodeData.id, name: nodeData.name, output: { content: 'second leaf' } })
                })
            })
            okRecorder.close()
            expect(ok.text).toBe('first leaf\n\nsecond leaf')
            expect(agentFlowEventsOf(okRecorder)).toEqual(['INPROGRESS', 'FINISHED'])
            expect(db.chatMessages.filter((m) => m.sessionId === 'db-fail-ok').map((m) => [m.role, m.content])).toEqual([
                ['userMessage', 'db fails at the end'],
                ['apiMessage', ok.text]
            ])
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('db write rejected for FINISHED'))

            const errorRecorder = createRealSSERecorder('chat-db-fail-error')
            await expect(
                runFlow({
                    flow,
                    incomingInput: { question: 'node and db both fail', overrideConfig: { sessionId: 'db-fail-error' } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: errorRecorder.sseStreamer,
                    chatId: 'chat-db-fail-error',
                    nodeInstanceFactory: createMockNodeFactory({
                        w1: async () => {
                            throw new Error('root-cause-node-failure')
                        },
                        w2: async (nodeData) => ({ id: nodeData.id, name: nodeData.name, output: { content: 'second leaf' } })
                    })
                })
            ).rejects.toThrow('root-cause-node-failure')
            errorRecorder.close()
            expect(agentFlowEventsOf(errorRecorder)).toEqual(['INPROGRESS', 'ERROR'])
            expect(errorRecorder.getEvents().some((e) => e.event === 'trustedStateData')).toBe(true)
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('db write rejected for ERROR'))
        }, 10000)

        describe('useTrustedState / zeroRetention', () => {
            const zeroRetentionConfig = JSON.stringify({ clientState: { enabled: true, enabledFull: true } })

            const decodeTrustedState = async (recorder: ReturnType<typeof createRealSSERecorder>) => {
                const trustedEvents = recorder.getEvents().filter((e) => e.event === 'trustedStateData')
                expect(trustedEvents).toHaveLength(1)
                const decoded = (await trusted_state_from_string(trustedEvents[0].data)) as any
                expect(decoded.version).toBe(2)
                const pending = decoded.pendingResume?.legacyExecution
                return {
                    raw: trustedEvents[0].data as string,
                    history: decoded.history as Array<{ role: string; content: string }>,
                    flowState: decoded.flowState,
                    pendingState: pending?.state,
                    pendingRecords: (pending ? JSON.parse(pending.executionData) : []) as IAgentflowExecutedData[]
                }
            }
            const lastExecutedData = (recorder: ReturnType<typeof createRealSSERecorder>): IAgentflowExecutedData[] =>
                recorder
                    .getEvents()
                    .filter((e) => e.event === 'agentFlowExecutedData')
                    .slice(-1)[0].data

            const forkJoinFlow = () =>
                createFlow(
                    [
                        startNode(),
                        createNode('w1', 'mockWorker', { position: { x: 0, y: 0 } }),
                        createNode('w2', 'mockWorker', { position: { x: 0, y: 100 } }),
                        createNode('join', 'mockWorker')
                    ],
                    [createEdge('start_0', 'w1'), createEdge('start_0', 'w2'), createEdge('w1', 'join'), createEdge('w2', 'join')]
                )
            const forkJoinFactory = () => {
                const barrier = createBarrier(2, 2000)
                const branch =
                    (id: string): MockNodeHandler =>
                    async (nodeData, _input, options) => {
                        await barrier.arrive()
                        return {
                            id: nodeData.id,
                            name: nodeData.name,
                            output: { content: id },
                            state: { ...options.agentflowRuntime.state, [id]: 'ok' }
                        }
                    }
                return createMockNodeFactory({
                    w1: branch('w1'),
                    w2: branch('w2'),
                    join: async (nodeData, _input, options) => ({
                        id: nodeData.id,
                        name: nodeData.name,
                        output: { content: `join:${options.agentflowRuntime.state.w1}+${options.agentflowRuntime.state.w2}` },
                        state: options.agentflowRuntime.state
                    })
                })
            }

            it('zeroRetention produces valid encrypted state on FINISHED, STOPPED (+ stateless resume), and ERROR without DB writes', async () => {
                setConcurrency(4)
                const db = createMockDataSource()

                const finishedRecorder = createRealSSERecorder('chat-zr-finished')
                const finished = await runFlow({
                    chatflow: createChatflow(forkJoinFlow(), { id: 'cf-zr-fork', chatbotConfig: zeroRetentionConfig }),
                    incomingInput: { question: 'zr finished', overrideConfig: { sessionId: 'zr-finished' } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: finishedRecorder.sseStreamer,
                    chatId: 'chat-zr-finished',
                    nodeInstanceFactory: forkJoinFactory()
                })
                finishedRecorder.close()
                expect(finished.text).toBe('join:ok+ok')
                const finishedState = await decodeTrustedState(finishedRecorder)
                expect(finishedState.pendingState).toBeUndefined()
                expect(finishedState.flowState).toEqual({ w1: 'ok', w2: 'ok' })
                expect(countBy(finished.agentFlowExecutedData.map((r: IAgentflowExecutedData) => `${r.nodeId}:${r.status}`))).toEqual({
                    'start_0:FINISHED': 1,
                    'w1:FINISHED': 1,
                    'w2:FINISHED': 1,
                    'join:FINISHED': 1
                })
                expect(finishedState.history.map((m) => [m.role, m.content])).toEqual([
                    ['userMessage', 'zr finished'],
                    ['apiMessage', 'join:ok+ok']
                ])

                const gateChatflow = createChatflow(loadBaselineFlow('05-human-input-with-companion-text.json'), {
                    id: 'cf-zr-gate',
                    chatbotConfig: zeroRetentionConfig
                })
                const stoppedRecorder = createRealSSERecorder('chat-zr-stopped')
                await runFlow({
                    chatflow: gateChatflow,
                    incomingInput: { question: 'please review', overrideConfig: { sessionId: 'zr-stopped' } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: stoppedRecorder.sseStreamer,
                    chatId: 'chat-zr-stopped'
                })
                stoppedRecorder.close()
                const stoppedState = await decodeTrustedState(stoppedRecorder)
                expect(stoppedState.pendingState).toBe('STOPPED')
                expect(stoppedState.pendingRecords.find((r) => r.nodeId === 'directReplyAgentflow_0')?.status).toBe('FINISHED')
                expect(stoppedState.pendingRecords.find((r) => r.nodeId === 'humanInputAgentflow_0')?.status).toBe('STOPPED')

                const resumeRecorder = createRealSSERecorder('chat-zr-resume')
                const resumed = await runFlow({
                    chatflow: gateChatflow,
                    incomingInput: {
                        humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'ok' },
                        trustedState: stoppedState.raw,
                        overrideConfig: { sessionId: 'zr-stopped' }
                    },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: resumeRecorder.sseStreamer,
                    chatId: 'chat-zr-resume'
                })
                resumeRecorder.close()
                expect(resumed.text).toBe('Approved!')
                const resumedState = await decodeTrustedState(resumeRecorder)
                expect(resumedState.pendingState).toBeUndefined()
                expect(
                    resumed.agentFlowExecutedData.filter((r: IAgentflowExecutedData) => r.nodeId === 'directReplyAgentflow_0')
                ).toHaveLength(1)

                const errorRecorder = createRealSSERecorder('chat-zr-error')
                await expect(
                    runFlow({
                        chatflow: createChatflow(forkJoinFlow(), { id: 'cf-zr-error', chatbotConfig: zeroRetentionConfig }),
                        incomingInput: { question: 'zr error', overrideConfig: { sessionId: 'zr-error' } },
                        appDataSource: db.appDataSource,
                        componentNodes: realComponentNodes,
                        sseStreamer: errorRecorder.sseStreamer,
                        chatId: 'chat-zr-error',
                        nodeInstanceFactory: createMockNodeFactory({
                            w1: async () => {
                                await sleep(5)
                                throw new Error('zr-boom')
                            },
                            w2: async (nodeData, _input, options) => {
                                await abortableSleep(2000, options.abortController?.signal)
                                return { id: nodeData.id, name: nodeData.name, output: { content: 'w2' } }
                            }
                        })
                    })
                ).rejects.toThrow('zr-boom')
                errorRecorder.close()
                const errorState = await decodeTrustedState(errorRecorder)
                expect(errorState.pendingState).toBeUndefined()
                expect(errorState.history).toEqual([])
                expect(lastExecutedData(errorRecorder).find((r) => r.nodeId === 'w1')?.status).toBe('ERROR')
                expect(lastExecutedData(errorRecorder).find((r) => r.nodeId === 'w2')?.status).toBe('TERMINATED')

                expect(db.executions).toHaveLength(0)
                expect(db.chatMessages).toHaveLength(0)
            }, 15000)

            it('useTrustedState without zeroRetention keeps the Execution row but streams chat history only through trusted state', async () => {
                setConcurrency(4)
                const db = createMockDataSource()
                const recorder = createRealSSERecorder('chat-trusted-only')
                const result = await runFlow({
                    chatflow: createChatflow(forkJoinFlow(), {
                        id: 'cf-trusted-only',
                        chatbotConfig: JSON.stringify({ clientState: { enabled: true } })
                    }),
                    incomingInput: { question: 'trusted only', overrideConfig: { sessionId: 'trusted-only' } },
                    appDataSource: db.appDataSource,
                    componentNodes: realComponentNodes,
                    sseStreamer: recorder.sseStreamer,
                    chatId: 'chat-trusted-only',
                    nodeInstanceFactory: forkJoinFactory()
                })
                recorder.close()
                const trusted = await decodeTrustedState(recorder)
                expect(trusted.pendingState).toBeUndefined()
                expect(trusted.history.map((m) => m.content)).toEqual(['trusted only', result.text])
                expect(db.executions).toHaveLength(1)
                expect(db.executions[0].state).toBe('FINISHED')
                expect(db.chatMessages).toHaveLength(0)
            }, 10000)
        })

        describe('PredictionQueue worker path (MODE=queue)', () => {
            const createQueue = (appDataSource: any, abortControllerPool: AbortControllerPool) =>
                new PredictionQueue('agentflow-integration', {} as any, {
                    appDataSource,
                    telemetry: { sendTelemetry: jest.fn().mockResolvedValue(undefined) } as unknown as Telemetry,
                    cachePool: {} as CachePool,
                    componentNodes: realComponentNodes,
                    abortControllerPool,
                    usageCacheManager: {} as UsageCacheManager
                })

            const createJob = (chatflow: ReturnType<typeof createChatflow>, chatId: string, question: string): any => ({
                chatflow,
                chatId,
                incomingInput: { question, streaming: true },
                orgId: 'org-1',
                workspaceId: 'ws-1',
                subscriptionId: '',
                productId: '',
                baseURL: 'http://localhost:3000',
                isInternal: false,
                files: []
            })

            const publishedFlowEvents = () =>
                mockRedisPublisherCalls
                    .filter((c) => c.method === 'streamNextAgentFlowEvent')
                    .map((c) => ({ chatId: c.args[0] as string, ...(c.args[1] as { nodeId: string; status: string }) }))

            const publishedIndex = (chatId: string, nodeId: string, status: string) =>
                publishedFlowEvents().findIndex((e) => e.chatId === chatId && e.nodeId === nodeId && e.status === status)

            it('processJob -> executeFlow -> executeAgentFlow schedules parallel branches, honours the env limit, and publishes over Redis', async () => {
                const db = createMockDataSource()
                const pool = new AbortControllerPool()
                const queue = createQueue(db.appDataSource, pool)
                const chatflow = createChatflow(loadBaselineFlow('01-parallel-fork-join-timing-and-state.json'), { id: 'cf-queue-01' })

                setConcurrency(10)
                const concurrent = await queue.processJob(createJob(chatflow, 'chat-queue-par', 'run flow 01'))
                expect(concurrent.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=empty)')
                const firstFinished = Math.min(
                    publishedIndex('chat-queue-par', 'customFunctionAgentflow_0', 'FINISHED'),
                    publishedIndex('chat-queue-par', 'customFunctionAgentflow_1', 'FINISHED')
                )
                expect(publishedIndex('chat-queue-par', 'customFunctionAgentflow_0', 'INPROGRESS')).toBeLessThan(firstFinished)
                expect(publishedIndex('chat-queue-par', 'customFunctionAgentflow_1', 'INPROGRESS')).toBeLessThan(firstFinished)
                expect(pool.get('cf-queue-01_chat-queue-par')).toBeInstanceOf(AbortController)
                expect(
                    mockRedisPublisherCalls
                        .filter((c) => c.method === 'streamAgentFlowEvent' && c.args[0] === 'chat-queue-par')
                        .map((c) => c.args[1])
                ).toEqual(['INPROGRESS', 'FINISHED'])
                expect(
                    mockRedisPublisherCalls
                        .filter((c) => c.method === 'streamTokenEvent' && c.args[0] === 'chat-queue-par')
                        .map((c) => c.args[1])
                        .join('')
                ).toBe(concurrent.text)
                // The job result carries the token for non-streaming callers, the same one published over Redis (F14)
                expect(
                    mockRedisPublisherCalls
                        .filter((c) => c.method === 'streamTrustedStateDataEvent' && c.args[0] === 'chat-queue-par')
                        .map((c) => c.args[1])
                ).toEqual([concurrent.trustedState])

                setConcurrency(1)
                const sequential = await queue.processJob(createJob(chatflow, 'chat-queue-seq', 'run flow 01'))
                expect(sequential.text).toBe('State: a=A(saw_b=empty) / b=B(saw_a=A(saw_b=empty))')
                expect(publishedIndex('chat-queue-seq', 'customFunctionAgentflow_1', 'INPROGRESS')).toBeGreaterThan(
                    publishedIndex('chat-queue-seq', 'customFunctionAgentflow_0', 'FINISHED')
                )
                expect(db.executions.map((e) => e.state)).toEqual(['FINISHED', 'FINISHED'])
            }, 15000)

            it('cancels an in-flight loop over parallel workers through AbortControllerPool and persists TERMINATED', async () => {
                setConcurrency(10)
                const db = createMockDataSource()
                const pool = new AbortControllerPool()
                const queue = createQueue(db.appDataSource, pool)
                const chatflow = createChatflow(loadBaselineFlow('06-loop-over-parallel-subgraph.json'), { id: 'cf-queue-06' })

                const job = queue.processJob(createJob(chatflow, 'chat-queue-abort', 'run loop'))
                const outcome = job.then(
                    () => new Error('queued job unexpectedly completed'),
                    (error: Error) => error
                )
                await waitUntil(() => publishedIndex('chat-queue-abort', 'customFunctionAgentflow_1', 'INPROGRESS') > -1, 3000)
                pool.abort('cf-queue-06_chat-queue-abort')

                expect((await outcome).message).toMatch(/cancelled/i)
                expect(db.executions[0].state).toBe('TERMINATED')
                expect(publishedIndex('chat-queue-abort', 'directReplyAgentflow_0', 'INPROGRESS')).toBe(-1)
                expect(
                    mockRedisPublisherCalls
                        .filter((c) => c.method === 'streamAgentFlowEvent' && c.args[0] === 'chat-queue-abort')
                        .map((c) => c.args[1])
                ).toEqual(['INPROGRESS', 'TERMINATED'])
            }, 15000)
        })

        describe('analyticHandlers lifecycle', () => {
            const createFakeAnalyticHandler = () => {
                const calls: Array<{ method: string; args: any[] }> = []
                const recorder = (method: string, returnValue?: (args: any[]) => any) =>
                    jest.fn(async (...args: any[]) => {
                        calls.push({ method, args })
                        return returnValue?.(args)
                    })
                const handler = {
                    init: recorder('init'),
                    onChainStart: recorder('onChainStart', () => ({ trace: 'agentflow-root' })),
                    onChainEnd: recorder('onChainEnd'),
                    onChainError: recorder('onChainError'),
                    onLLMStart: recorder('onLLMStart', (args) => ({ llm: String(args[0]) })),
                    onLLMEnd: recorder('onLLMEnd'),
                    onLLMError: recorder('onLLMError')
                }
                jest.spyOn(AnalyticHandler, 'getInstance').mockReturnValue(handler as unknown as AnalyticHandler)
                return { handler, calls, methods: () => calls.map((c) => c.method) }
            }

            const analyticChatflow = (flow: IReactFlowObject, id: string) =>
                createChatflow(flow, { id, analytic: JSON.stringify({ langFuse: { status: true } }) })

            const tracedLlm =
                (
                    label: string,
                    seenContexts: Array<{ handler: unknown; parentTraceIds: unknown }>,
                    barrier?: ReturnType<typeof createBarrier>
                ): MockNodeHandler =>
                async (nodeData, _input, options) => {
                    seenContexts.push({ handler: options.analyticHandlers, parentTraceIds: options.parentTraceIds })
                    const llmIds = await options.analyticHandlers.onLLMStart(label, 'prompt', options.parentTraceIds)
                    try {
                        await barrier?.arrive()
                        await abortableSleep(barrier ? 10 : 2000, options.abortController?.signal)
                        await options.analyticHandlers.onLLMEnd(llmIds, `${label} output`)
                        return { id: nodeData.id, name: nodeData.name, output: { content: `${label} output` } }
                    } catch (error) {
                        await options.analyticHandlers.onLLMError(llmIds, String(error))
                        throw error
                    }
                }

            it('FINISHED: one chain start/end wraps concurrent LLM spans that share the handler and parent trace ids', async () => {
                setConcurrency(4)
                const { handler, calls, methods } = createFakeAnalyticHandler()
                const seen: Array<{ handler: unknown; parentTraceIds: unknown }> = []
                const barrier = createBarrier(2, 2000)
                const flow = createFlow(
                    [
                        startNode(),
                        createNode('llmA', 'llmAgentflow', { position: { x: 0, y: 0 } }),
                        createNode('llmB', 'llmAgentflow', { position: { x: 0, y: 100 } }),
                        createNode(
                            'summary',
                            'directReplyAgentflow',
                            { inputs: { directReplyMessage: 'Both spans done.' } },
                            realComponentNodes
                        )
                    ],
                    [
                        createEdge('start_0', 'llmA'),
                        createEdge('start_0', 'llmB'),
                        createEdge('llmA', 'summary'),
                        createEdge('llmB', 'summary')
                    ]
                )

                const result = await runFlow({
                    chatflow: analyticChatflow(flow, 'cf-analytics-ok'),
                    incomingInput: { question: 'trace me' },
                    componentNodes: realComponentNodes,
                    chatId: 'chat-analytics-ok',
                    nodeInstanceFactory: createMockNodeFactory({ llmA: tracedLlm('A', seen, barrier), llmB: tracedLlm('B', seen, barrier) })
                })

                expect(result.text).toBe('Both spans done.')
                expect(handler.init).toHaveBeenCalledTimes(1)
                expect(handler.onChainStart).toHaveBeenCalledTimes(1)
                expect(handler.onChainStart).toHaveBeenCalledWith('Agentflow', 'trace me')
                expect(handler.onChainEnd).toHaveBeenCalledTimes(1)
                expect(handler.onChainEnd).toHaveBeenCalledWith({ trace: 'agentflow-root' }, 'Both spans done.', true)
                expect(handler.onChainError).not.toHaveBeenCalled()
                expect(methods()).toEqual(['init', 'onChainStart', 'onLLMStart', 'onLLMStart', 'onLLMEnd', 'onLLMEnd', 'onChainEnd'])
                expect(
                    calls
                        .filter((c) => c.method === 'onLLMEnd')
                        .map((c) => c.args[0].llm)
                        .sort()
                ).toEqual(['A', 'B'])
                expect(seen).toHaveLength(2)
                for (const context of seen) {
                    expect(context.handler).toBe(handler)
                    expect(context.parentTraceIds).toEqual({ trace: 'agentflow-root' })
                }
                expect(seen[0].parentTraceIds).toBe(seen[1].parentTraceIds)
            }, 10000)

            it('ERROR: reports onChainError once after the aborted sibling closed its span, and never onChainEnd', async () => {
                setConcurrency(4)
                const { handler, calls, methods } = createFakeAnalyticHandler()
                const seen: Array<{ handler: unknown; parentTraceIds: unknown }> = []
                const flow = createFlow(
                    [
                        startNode(),
                        createNode('boom', 'mockBoom', { position: { x: 0, y: 0 } }),
                        createNode('llmSlow', 'llmAgentflow', { position: { x: 0, y: 100 } })
                    ],
                    [createEdge('start_0', 'boom'), createEdge('start_0', 'llmSlow')]
                )

                await expect(
                    runFlow({
                        chatflow: analyticChatflow(flow, 'cf-analytics-err'),
                        incomingInput: { question: 'trace error' },
                        componentNodes: realComponentNodes,
                        chatId: 'chat-analytics-err',
                        nodeInstanceFactory: createMockNodeFactory({
                            boom: async () => {
                                await sleep(10)
                                throw new Error('analytics-boom')
                            },
                            llmSlow: tracedLlm('Slow', seen)
                        })
                    })
                ).rejects.toThrow('analytics-boom')

                expect(handler.onChainEnd).not.toHaveBeenCalled()
                expect(handler.onChainError).toHaveBeenCalledTimes(1)
                expect(handler.onChainError).toHaveBeenCalledWith({ trace: 'agentflow-root' }, 'analytics-boom', true)
                expect(methods()).toEqual(['init', 'onChainStart', 'onLLMStart', 'onLLMError', 'onChainError'])
                expect(calls.find((c) => c.method === 'onLLMError')?.args[0]).toEqual({ llm: 'Slow' })
            }, 10000)

            it('STOPPED: closes the chain once with the companion + approval prompt text', async () => {
                setConcurrency(4)
                const { handler } = createFakeAnalyticHandler()
                const result = await runFlow({
                    chatflow: analyticChatflow(loadBaselineFlow('05-human-input-with-companion-text.json'), 'cf-analytics-stop'),
                    incomingInput: { question: 'please review', overrideConfig: { sessionId: 'analytics-stop' } },
                    componentNodes: realComponentNodes,
                    chatId: 'chat-analytics-stop'
                })
                expect(handler.onChainStart).toHaveBeenCalledTimes(1)
                expect(handler.onChainError).not.toHaveBeenCalled()
                expect(handler.onChainEnd).toHaveBeenCalledTimes(1)
                expect(handler.onChainEnd).toHaveBeenCalledWith({ trace: 'agentflow-root' }, result.text, true)
                expect(result.text).toBe('Review summary: All pre-checks passed\n\n\n\nApprove?')
            }, 10000)

            it('real AnalyticHandler closes every overlapping span from parallel LLM nodes across providers', async () => {
                setConcurrency(4)
                const chatId = 'chat-analytics-real'
                const analytic = JSON.stringify({ langFuse: { status: false } })
                const started: string[] = []
                const ended: string[] = []
                const lunaryEvents: Array<{ type: string; event: string; runId: string }> = []
                let sequence = 0
                const observation = (prefix: string) => {
                    const id = `${prefix}-${++sequence}`
                    started.push(id)
                    return { id, end: () => ended.push(id) }
                }
                const langWatchSpan = (prefix: string) => {
                    const { id, end } = observation(prefix)
                    return { spanId: id, end }
                }
                const otelSpan = (prefix: string) => {
                    const { id, end } = observation(prefix)
                    return { spanContext: () => ({ spanId: id }), setAttribute: () => undefined, setStatus: () => undefined, end }
                }
                const langfuseTrace = {
                    id: 'langfuse-trace',
                    update: () => undefined,
                    span: () => observation('langfuse-span'),
                    generation: () => observation('langfuse-generation')
                }
                const langWatchTrace = {
                    traceId: 'langwatch-trace',
                    startSpan: () => langWatchSpan('langwatch-span'),
                    startLLMSpan: () => langWatchSpan('langwatch-llm')
                }

                const handler = AnalyticHandler.getInstance({ inputs: { analytics: {} } } as any, { chatId, analytic })
                Object.assign(handler.getHandlers(), {
                    langFuse: { client: { trace: () => langfuseTrace, shutdownAsync: async () => undefined } },
                    lunary: {
                        client: {
                            trackEvent: async (type: string, event: string, payload: { runId: string }) => {
                                lunaryEvents.push({ type, event, runId: payload.runId })
                            }
                        }
                    },
                    langWatch: { client: { getTrace: () => langWatchTrace } },
                    arize: { client: { startSpan: (name: string) => otelSpan(`arize-${name}`) } }
                })

                const barrier = createBarrier(2, 2000)
                const seen: Array<{ handler: unknown; parentTraceIds: unknown }> = []
                const flow = createFlow(
                    [
                        startNode(),
                        createNode('llmA', 'llmAgentflow', { position: { x: 0, y: 0 } }),
                        createNode('llmB', 'llmAgentflow', { position: { x: 0, y: 100 } })
                    ],
                    [createEdge('start_0', 'llmA'), createEdge('start_0', 'llmB')]
                )
                await runFlow({
                    chatflow: createChatflow(flow, { id: 'cf-analytics-real', analytic }),
                    incomingInput: { question: 'trace real handler' },
                    componentNodes: realComponentNodes,
                    chatId,
                    nodeInstanceFactory: createMockNodeFactory({ llmA: tracedLlm('A', seen, barrier), llmB: tracedLlm('B', seen, barrier) })
                })

                expect(seen.map((context) => context.handler)).toEqual([handler, handler])
                expect(started.filter((id) => id.startsWith('langfuse-generation'))).toHaveLength(2)
                expect(started.filter((id) => id.startsWith('langwatch-llm'))).toHaveLength(2)
                expect([...ended].sort()).toEqual([...started].sort())
                const lunaryRunIds = (type: string, event: string) =>
                    lunaryEvents
                        .filter((e) => e.type === type && e.event === event)
                        .map((e) => e.runId)
                        .sort()
                expect(lunaryRunIds('llm', 'start')).toHaveLength(2)
                expect(lunaryRunIds('llm', 'end')).toEqual(lunaryRunIds('llm', 'start'))
                expect(lunaryRunIds('chain', 'end')).toEqual(lunaryRunIds('chain', 'start'))
            }, 10000)
        })
    })

    describe('6. SSE lifecycle on the wire', () => {
        it('Flow 04 streams overlapping INPROGRESS events, consecutive \\n\\n tokens, trusted state, final executed data, and [DONE]', async () => {
            setConcurrency(10)
            const db = createMockDataSource()
            const chatId = 'chat-sse-04'
            const recorder = createRealSSERecorder(chatId)
            const result = await runFlow({
                chatflow: createChatflow(loadBaselineFlow('04-multi-terminal-streaming-and-silent-leaf.json'), { id: 'cf-sse-04' }),
                incomingInput: { question: 'lookup data' },
                appDataSource: db.appDataSource,
                componentNodes: realComponentNodes,
                sseStreamer: recorder.sseStreamer,
                chatId
            })
            recorder.close()
            const events = recorder.getEvents()

            expect(recorder.getTokens()).toEqual(["I'm looking up the data...", '\n\n', 'Here is the result.'])
            expect(result.text).toBe(recorder.getStreamedText())
            expect(db.chatMessages.find((m) => m.role === 'apiMessage')?.content).toBe(result.text)

            const lookupFinished = indexOfStatus(events, 'customFunctionAgentflow_0', 'FINISHED')
            const prepFinished = indexOfStatus(events, 'customFunctionAgentflow_1', 'FINISHED')
            expect(indexOfStatus(events, 'customFunctionAgentflow_0', 'INPROGRESS')).toBeLessThan(prepFinished)
            expect(indexOfStatus(events, 'customFunctionAgentflow_1', 'INPROGRESS')).toBeLessThan(lookupFinished)
            expect(indexOfStatus(events, 'directReplyAgentflow_0', 'INPROGRESS')).toBeLessThan(lookupFinished)

            const kinds = events.map((e) => e.event)
            expect(events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'FINISHED'])
            const trusted = events.find((e) => e.event === 'trustedStateData')
            expect(await trusted_state_from_string(trusted!.data)).toMatchObject({ version: 2, flowState: {} })
            expect(result.trustedState).toBe(trusted!.data)
            const executedData = events.filter((e) => e.event === 'agentFlowExecutedData')
            expect(executedData).toHaveLength(1)
            expect(executedData[0].data.map((r: IAgentflowExecutedData) => r.nodeLabel).sort()).toEqual(
                ['Fast Ack', 'Final Result', 'Lookup Worker (300ms)', 'Silent Leaf (400ms)', 'Start', 'Telemetry Prep (50ms)'].sort()
            )
            expect(kinds.slice(-2)).toEqual(['agentFlowExecutedData', 'end'])
            expect(events[events.length - 1].data).toBe('[DONE]')
        }, 10000)
    })
})
