import logger from '../../../../src/utils/logger'
import {
    PendingNode,
    PendingResume,
    TRUSTED_STATE_VERSION,
    TrustedHistoryMessage,
    buildPendingResume,
    buildTrustedState,
    findOutputReferences,
    readTurnInput,
    rehydratePendingResume,
    toNodeMessage,
    toSlimAction,
    writeToken
} from '../../../../src/utils/agentflow/trustedState'
import { decodeToken, encodeToken, loadBeforeTrace, loadFlow, loadScenario } from './harness'

/*
 * The v2 token codec of Task 05 (plans/agentflow-trusted-state, 04 §2.1-2.5): round trip, the turn input, and the upgrade
 * of v1 tokens captured in traces/before/; the pending resume data of Task 07 (04 §2.6).
 */

// Today's node input for a v1 history message (buildAgentflow's mapChatMessageToIMessage before Task 05)
function v1NodeMessage(message: any) {
    const mapped: any = { content: message.content, role: message.role === 'userMessage' ? 'user' : 'assistant' }
    const parse = (value: string) => {
        try {
            return JSON.parse(value)
        } catch {
            return value
        }
    }
    const kwargs: Record<string, any> = {}
    for (const key of ['fileUploads', 'artifacts', 'fileAnnotations', 'usedTools']) {
        if (message[key] && message[key] !== '') kwargs[key] = parse(message[key])
    }
    if (Object.keys(kwargs).length) mapped.additional_kwargs = kwargs
    return mapped
}

// usedTools and fileAnnotations never reach a model and are not kept in v2 history (D2)
function withoutDroppedKwargs(message: any) {
    if (!message.additional_kwargs) return message
    const { usedTools, fileAnnotations, ...kept } = message.additional_kwargs
    return Object.keys(kept).length ? { ...message, additional_kwargs: kept } : { content: message.content, role: message.role }
}

const UPLOAD = { type: 'stored-file', name: 'FILE-STORAGE::photo.png', mime: 'image/png' }
const ARTIFACT = { type: 'png', data: 'FILE-STORAGE::chart.png' }

const SLIM_ACTION = {
    id: 'a1',
    mapping: { approve: 'Proceed', reject: 'Reject' },
    elements: [
        { type: 'agentflowv2-approve-button', label: 'Approve' },
        { type: 'agentflowv2-reject-button', label: 'Request changes' }
    ],
    data: { nodeId: 'humanInputAgentflow_0', nodeLabel: 'Review Gate', input: { humanInputEnableFeedback: true } }
}
const PENDING: PendingResume = {
    nodes: [
        { nodeId: 'startAgentflow_0', status: 'FINISHED' },
        { nodeId: 'humanInputAgentflow_0', status: 'STOPPED', action: SLIM_ACTION, prompt: 'Approve this draft?' }
    ],
    executionId: 'e1',
    stopMessageId: 'm1'
}

describe('v2 token', () => {
    const history: TrustedHistoryMessage[] = [
        { role: 'userMessage', content: 'Here is a photo', fileUploads: [UPLOAD as any] },
        { role: 'apiMessage', content: 'Here is a chart', artifacts: [ARTIFACT] },
        { role: 'userMessage', content: 'Thanks' }
    ]

    test('round trip: the token the builder writes is the turn input of the next request', async () => {
        const pendingResume = PENDING
        const state = buildTrustedState({
            history,
            flowState: { count: '2' },
            form: { name: 'Ada' },
            childFlowTokens: { executeFlowAgentflow_0: { flowId: 'child', token: 'child-token' } },
            flowNodeIds: new Set(['executeFlowAgentflow_0']),
            pendingResume
        })
        const token = await writeToken(state)
        expect(decodeToken(token).state).toEqual({
            version: TRUSTED_STATE_VERSION,
            history,
            flowState: { count: '2' },
            formValues: { name: 'Ada' },
            childFlowTokens: { executeFlowAgentflow_0: { flowId: 'child', token: 'child-token' } },
            pendingResume
        })

        const resume = await readTurnInput({ trustedState: token, humanInput: { type: 'proceed' } })
        expect(resume).toEqual({
            history,
            flowState: { count: '2' },
            formValues: { name: 'Ada' },
            childFlowTokens: { executeFlowAgentflow_0: { flowId: 'child', token: 'child-token' } },
            pendingResume,
            historySource: 'token',
            incoming: { version: 2, base64Length: token.length, historyLength: 3, hadPending: true }
        })
    })

    test('pending resume data reaches the turn input only when the request answers it', async () => {
        const token = await writeToken(
            buildTrustedState({
                history,
                childFlowTokens: {},
                flowNodeIds: new Set(),
                pendingResume: PENDING
            })
        )
        const normalTurn = await readTurnInput({ trustedState: token })
        expect(normalTurn.pendingResume).toBeUndefined()
        expect(normalTurn.incoming.hadPending).toBe(true)
    })

    test('every field except the pending data is written, a form string is stored as values, unknown child nodes are dropped', () => {
        expect(
            buildTrustedState({
                history: [],
                form: 'name: Ada Lovelace\ntopic: billing',
                childFlowTokens: { gone_0: { flowId: 'child', token: 't' } },
                flowNodeIds: new Set(['executeFlowAgentflow_0'])
            })
        ).toEqual({
            version: 2,
            history: [],
            flowState: {},
            formValues: { name: 'Ada Lovelace', topic: 'billing' },
            childFlowTokens: {}
        })
    })

    test('history messages map to the node input of today', () => {
        expect(history.map(toNodeMessage)).toEqual([
            { content: 'Here is a photo', role: 'user', additional_kwargs: { fileUploads: [UPLOAD] } },
            { content: 'Here is a chart', role: 'assistant', additional_kwargs: { artifacts: [ARTIFACT] } },
            { content: 'Thanks', role: 'user' }
        ])
    })

    test('no token, a broken token or an unknown version is a new conversation; the last two log a warning', async () => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
        try {
            const empty = {
                history: [],
                historySource: 'token',
                flowState: {},
                formValues: {},
                childFlowTokens: {},
                pendingResume: undefined
            }
            expect(await readTurnInput({})).toEqual({
                ...empty,
                incoming: { version: 0, base64Length: 0, historyLength: 0, hadPending: false }
            })
            expect(warn).not.toHaveBeenCalled()

            for (const token of ['not a token', encodeToken({ version: 3, history: [{ role: 'userMessage', content: 'Hi' }] })]) {
                warn.mockClear()
                expect(await readTurnInput({ trustedState: token, humanInput: { type: 'proceed' } })).toEqual({
                    ...empty,
                    incoming: { version: 0, base64Length: token.length, historyLength: 0, hadPending: false }
                })
                expect(warn).toHaveBeenCalledTimes(1)
            }
        } finally {
            warn.mockRestore()
        }
    })
})

describe('turn history and form values (Task 06)', () => {
    const tokenHistory: TrustedHistoryMessage[] = [
        { role: 'userMessage', content: 'Do you ship to Norway?' },
        { role: 'apiMessage', content: 'Yes, in 3 to 5 days.' }
    ]
    const clientHistory = [
        { role: 'apiMessage', content: 'Welcome!' },
        { role: 'userMessage', content: 'Do you ship to Norway?' },
        { role: 'apiMessage', content: ' Yes, in 3 to 5 days. ' }
    ]
    let token: string
    let warn: jest.SpyInstance
    beforeAll(async () => {
        token = await writeToken(
            buildTrustedState({ history: tokenHistory, form: { name: 'Ada' }, childFlowTokens: {}, flowNodeIds: new Set() })
        )
    })
    beforeEach(() => {
        warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    })
    afterEach(() => warn.mockRestore())
    const warnings = () => warn.mock.calls.map((call) => String(call[0]))

    test('TS13a: with the setting on, the request history is the turn history', async () => {
        const input = await readTurnInput({ trustedState: token, history: clientHistory as any }, { acceptClientHistory: true })
        expect([input.historySource, input.history]).toEqual(['client', clientHistory])
        expect(warnings()).toEqual([])
    })

    test('TS13: a request history without the last message of the token history logs a warning and is used', async () => {
        const input = await readTurnInput({ trustedState: token, history: clientHistory.slice(0, 2) as any }, { acceptClientHistory: true })
        expect([input.historySource, input.history]).toEqual(['client', clientHistory.slice(0, 2)])
        expect(warnings()).toEqual([expect.stringContaining('lacks the last message of the token history')])
    })

    test('TS13a: with the setting off, the request history is ignored with a warning', async () => {
        const input = await readTurnInput({ trustedState: token, history: clientHistory as any })
        expect([input.historySource, input.history]).toEqual(['token', tokenHistory])
        expect(warnings()).toEqual([expect.stringContaining('"Accept conversation history from the client" is off')])
    })

    test('D7: a resume turn ignores the request history with a warning, whatever the setting', async () => {
        const input = await readTurnInput(
            { trustedState: token, history: clientHistory as any, humanInput: { type: 'proceed' } },
            { acceptClientHistory: true }
        )
        expect([input.historySource, input.history]).toEqual(['token', tokenHistory])
        expect(warnings()).toEqual([expect.stringContaining('resume turn')])
    })

    test('an empty request history is no history', async () => {
        const input = await readTurnInput({ trustedState: token, history: [] }, { acceptClientHistory: false })
        expect([input.historySource, input.history]).toEqual(['token', tokenHistory])
        expect(warnings()).toEqual([])
    })

    test('TS12: a form submission replaces the carried form values', async () => {
        expect((await readTurnInput({ trustedState: token })).formValues).toEqual({ name: 'Ada' })
        expect((await readTurnInput({ trustedState: token, form: { name: 'Grace' } })).formValues).toEqual({ name: 'Grace' })
    })
})

describe('v1 tokens from traces/before/ upgrade to v2', () => {
    const CASES: Array<[string, string]> = [
        ['S01', 't5'],
        ['S04a', 't2'],
        ['S05', 't1'],
        ['S05', 't2'],
        ['S06', 't1'],
        ['S07', 't2'],
        ['S08', 't1']
    ]
    const EXPECTED_FORM_VALUES: Record<string, Record<string, string>> = {
        'S05 t1': { name: 'Ada Lovelace', topic: 'billing' },
        'S05 t2': { name: 'Ada Lovelace', topic: 'billing' }
    }

    test.each(CASES)('%s %s', async (id, turnId) => {
        const before = loadBeforeTrace('M1', loadScenario(id).slug).turns.find((turn) => turn.id === turnId)!
        const v1 = before.token.decoded
        const token = encodeToken(v1)
        const input = await readTurnInput({ trustedState: token, humanInput: { type: 'proceed' } })

        expect(input.incoming).toEqual({
            version: 1,
            base64Length: token.length,
            historyLength: v1.pastChatHistory.length,
            hadPending: before.status === 'STOPPED'
        })
        expect(input.history.map((message) => [message.role, message.content])).toEqual(
            v1.pastChatHistory.map((message: any) => [message.role, message.content])
        )
        expect(input.history.flatMap((message) => Object.keys(message))).not.toContain('action')
        expect(input.history.map(toNodeMessage)).toEqual(v1.pastChatHistory.map(v1NodeMessage).map(withoutDroppedKwargs))
        expect(input.flowState).toEqual(before.finalState)
        expect(input.formValues).toEqual(EXPECTED_FORM_VALUES[`${id} ${turnId}`] ?? {})
        expect(input.childFlowTokens).toEqual({})

        if (before.status === 'STOPPED') {
            const records = JSON.parse(v1.previousExecution.executionData)
            const stopMessage = v1.pastChatHistory[v1.pastChatHistory.length - 1]
            expect(stopMessage.action).toBeTruthy()
            // M1 recorded no execution (a mock- id), and the skeleton keeps one entry per record
            expect(input.pendingResume).toEqual({
                nodes: records.map((record: any) => {
                    if (record.status !== 'STOPPED') return { nodeId: record.nodeId, status: record.status }
                    const action = record.data.output.humanInputAction
                    return {
                        nodeId: record.nodeId,
                        status: 'STOPPED',
                        action: toSlimAction(action),
                        prompt: record.data.output.content,
                        ...(record.data.name === 'agentAgentflow' ? { legacyMessages: action.data.input.messages } : {})
                    }
                }),
                stopMessageId: stopMessage.id
            })
        } else {
            expect(input.pendingResume).toBeUndefined()
        }
    })

    test('the upgrade keeps the outputs that nodes of the flow reference, and a recorded execution id', async () => {
        const before = loadBeforeTrace('M2', loadScenario('S06').slug).turns.find((turn) => turn.id === 't1')!
        const v1 = before.token.decoded
        const nodes = loadFlow(loadScenario('S06').flow).flow.nodes
        const drafter = nodes.find((node) => node.id === 'llmAgentflow_0')!
        drafter.data.inputs!.llmMessages[0].content += '<p>{{agentAgentflow_0}} {{directReplyAgentflow_0.output.content}}</p>'
        const input = await readTurnInput(
            { trustedState: encodeToken(v1), humanInput: { type: 'proceed' } },
            { references: findOutputReferences(nodes) }
        )
        const records = JSON.parse(v1.previousExecution.executionData)
        const outputOf = (nodeId: string) => records.find((record: any) => record.nodeId === nodeId).data.output
        expect(input.pendingResume?.executionId).toBe(v1.previousExecution.id)
        expect(input.pendingResume?.nodes.find((entry) => entry.nodeId === 'agentAgentflow_0')?.output).toEqual({
            content: outputOf('agentAgentflow_0').content
        })
        expect(input.pendingResume?.nodes.find((entry) => entry.nodeId === 'directReplyAgentflow_0')?.output).toEqual({
            content: outputOf('directReplyAgentflow_0').content
        })
    })

    test('stored JSON strings of uploads and artifacts are parsed; the dropped fields and blank values are not kept', async () => {
        const v1 = {
            pastChatHistory: [
                { role: 'userMessage', content: 'Photo', fileUploads: JSON.stringify([UPLOAD]), artifacts: '' },
                {
                    role: 'apiMessage',
                    content: 'Chart',
                    artifacts: JSON.stringify([ARTIFACT]),
                    usedTools: JSON.stringify([{ tool: 'calculator' }]),
                    fileAnnotations: JSON.stringify([{ filePath: 'a' }]),
                    sourceDocuments: '[]',
                    action: null
                }
            ],
            previousExecution: { id: 'mock-1', state: 'FINISHED', executionData: '[]' }
        }
        const input = await readTurnInput({ trustedState: encodeToken(v1) })
        expect(input.history).toEqual([
            { role: 'userMessage', content: 'Photo', fileUploads: [UPLOAD] },
            { role: 'apiMessage', content: 'Chart', artifacts: [ARTIFACT] }
        ])
        expect(input.history.map(toNodeMessage)).toEqual(v1.pastChatHistory.map(v1NodeMessage).map(withoutDroppedKwargs))
    })

    test('an error right after a stop stays resumable without the error record, other failed runs do not', async () => {
        const records = (statuses: string[]) => JSON.stringify(statuses.map((status, i) => ({ nodeId: `n${i}`, status, data: {} })))
        const pendingOf = async (state: string, statuses: string[]) =>
            (
                await readTurnInput({
                    trustedState: encodeToken({
                        pastChatHistory: [],
                        previousExecution: { id: 'e', state, executionData: records(statuses) }
                    }),
                    humanInput: { type: 'proceed' }
                })
            ).pendingResume
        expect(await pendingOf('ERROR', ['FINISHED', 'STOPPED', 'ERROR'])).toEqual({
            nodes: [
                { nodeId: 'n0', status: 'FINISHED' },
                { nodeId: 'n1', status: 'STOPPED' }
            ],
            executionId: 'e'
        })
        expect(await pendingOf('ERROR', ['FINISHED', 'ERROR'])).toBeUndefined()
        expect(await pendingOf('TERMINATED', ['STOPPED', 'TERMINATED'])).toBeUndefined()
        expect(await pendingOf('FINISHED', ['FINISHED'])).toBeUndefined()
    })
})

describe('pending resume data (Task 07)', () => {
    const NODES: any[] = [
        { id: 'startAgentflow_0', data: { name: 'startAgentflow', label: 'Start', inputs: {} } },
        { id: 'conditionAgentflow_0', data: { name: 'conditionAgentflow', label: 'Check', inputs: {} } },
        { id: 'loopAgentflow_0', data: { name: 'loopAgentflow', label: 'Again', inputs: {} } },
        { id: 'httpAgentflow_0', data: { name: 'httpAgentflow', label: 'Fetch', inputs: {} } },
        {
            id: 'llmAgentflow_0',
            data: {
                name: 'llmAgentflow',
                label: 'Writer',
                inputs: {
                    llmMessages: [
                        { role: 'system', content: '<p>{{httpAgentflow\\_0}} {{conditionAgentflow_0.output.reason}} {{question}}</p>' }
                    ]
                }
            }
        },
        { id: 'agentAgentflow_0', data: { name: 'agentAgentflow', label: 'Agent', inputs: {} } }
    ]
    const AGENT_ACTION = {
        id: 'a2',
        mapping: { approve: 'Proceed', reject: 'Reject' },
        elements: [
            { type: 'agentflowv2-approve-button', label: 'Proceed' },
            { type: 'agentflowv2-reject-button', label: 'Reject' }
        ],
        data: { nodeId: 'agentAgentflow_0', nodeLabel: 'Agent', input: { messages: ['the whole prompt'], agentModel: 'chatOpenAI' } }
    }
    const CHECKPOINT = {
        historyLength: 2,
        conversation: [{ history: [0, 2] }, { role: 'user', content: 'Refund 10 %' }],
        toolCallMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'calculator', args: {} }] }
    }
    const RECORDS: any[] = [
        { nodeId: 'startAgentflow_0', status: 'FINISHED', data: { name: 'startAgentflow', output: { question: 'q' }, state: { a: 1 } } },
        {
            nodeId: 'conditionAgentflow_0',
            status: 'FINISHED',
            data: { output: { reason: 'big order', conditions: [{ isFulfilled: false, value1: 'x' }, { isFulfilled: true }] } }
        },
        {
            nodeId: 'loopAgentflow_0',
            status: 'FINISHED',
            data: { output: { nodeID: 'conditionAgentflow_0', maxLoopCount: 3, content: '' } }
        },
        { nodeId: 'httpAgentflow_0', status: 'FINISHED', data: { output: { http: { data: { ok: true }, headers: {} }, content: 'raw' } } },
        {
            nodeId: 'agentAgentflow_0',
            status: 'STOPPED',
            data: {
                input: { messages: ['the whole prompt'] },
                output: { content: 'Attempting to use tool', humanInputAction: AGENT_ACTION, resumeCheckpoint: CHECKPOINT }
            }
        },
        { nodeId: 'llmAgentflow_1', status: 'FINISHED', data: { parentNodeId: 'iterationAgentflow_0', output: { content: 'item' } } }
    ]
    const EXPECTED_NODES: PendingNode[] = [
        { nodeId: 'startAgentflow_0', status: 'FINISHED' },
        { nodeId: 'conditionAgentflow_0', status: 'FINISHED', conditions: [false, true], output: { reason: 'big order' } },
        { nodeId: 'loopAgentflow_0', status: 'FINISHED', loop: { nodeID: 'conditionAgentflow_0', maxLoopCount: 3 } },
        { nodeId: 'httpAgentflow_0', status: 'FINISHED', output: { content: 'raw', http: { data: { ok: true } } } },
        {
            nodeId: 'agentAgentflow_0',
            status: 'STOPPED',
            action: { ...AGENT_ACTION, data: { nodeId: 'agentAgentflow_0', nodeLabel: 'Agent' } },
            prompt: 'Attempting to use tool',
            checkpoint: CHECKPOINT
        }
    ]

    test('the flow references {{id}} (content or http.data) and {{id.output.<path>}}, escaped or not', () => {
        expect(findOutputReferences(NODES)).toEqual(
            new Map([
                ['httpAgentflow_0', new Set(['content', 'http.data'])],
                ['conditionAgentflow_0', new Set(['reason'])]
            ])
        )
    })

    test('the skeleton keeps decisions, loops, referenced outputs and what a stopped node needs, iteration records left out', () => {
        expect(
            buildPendingResume(RECORDS, {
                references: findOutputReferences(NODES),
                carried: new Map(),
                executionId: 'e1',
                stopMessageId: 'm1'
            })
        ).toEqual({ nodes: EXPECTED_NODES, executionId: 'e1', stopMessageId: 'm1' })
    })

    test('rehydrated records start a resume; an entry still present at the next stop is carried over unchanged', () => {
        const pending: PendingResume = { nodes: [...EXPECTED_NODES, { nodeId: 'gone_0', status: 'FINISHED' }] }
        const reversedGraph = { conditionAgentflow_0: ['startAgentflow_0'], agentAgentflow_0: ['httpAgentflow_0'] }
        const rehydrated = rehydratePendingResume(pending, NODES, reversedGraph)
        const records = [...rehydrated.keys()]
        expect(records.map((record) => [record.nodeId, record.nodeLabel, record.status, record.previousNodeIds, record.data.name])).toEqual(
            [
                ['startAgentflow_0', 'Start', 'FINISHED', [], 'startAgentflow'],
                ['conditionAgentflow_0', 'Check', 'FINISHED', ['startAgentflow_0'], 'conditionAgentflow'],
                ['loopAgentflow_0', 'Again', 'FINISHED', [], 'loopAgentflow'],
                ['httpAgentflow_0', 'Fetch', 'FINISHED', [], 'httpAgentflow'],
                ['agentAgentflow_0', 'Agent', 'STOPPED', ['httpAgentflow_0'], 'agentAgentflow'],
                ['gone_0', 'gone_0', 'FINISHED', [], undefined]
            ]
        )
        expect(records.map((record) => record.data.output as any)).toEqual([
            {},
            { conditions: [{ isFulfilled: false }, { isFulfilled: true }], reason: 'big order' },
            { nodeID: 'conditionAgentflow_0', maxLoopCount: 3 },
            { content: 'raw', http: { data: { ok: true } } },
            { content: 'Attempting to use tool', humanInputAction: EXPECTED_NODES[4].action, resumeCheckpoint: CHECKPOINT },
            {}
        ])

        const resumed = records.filter((record) => record.nodeId !== 'conditionAgentflow_0')
        const next = buildPendingResume(resumed, { references: new Map(), carried: rehydrated })
        expect(next.nodes).toEqual(pending.nodes.filter((entry) => entry.nodeId !== 'conditionAgentflow_0'))
        expect(next.nodes[3]).toBe(pending.nodes[4])
    })

    test('a v1 Agent stop keeps its stored prompt to replay it, in the action the Agent reads it from (D4)', () => {
        const pending: PendingResume = {
            nodes: [
                { nodeId: 'agentAgentflow_0', status: 'STOPPED', action: EXPECTED_NODES[4].action, legacyMessages: ['the whole prompt'] }
            ]
        }
        const [record] = [...rehydratePendingResume(pending, NODES, {}).keys()]
        expect((record.data.output as any).humanInputAction.data).toEqual({
            nodeId: 'agentAgentflow_0',
            nodeLabel: 'Agent',
            input: { messages: ['the whole prompt'] }
        })
    })
})
