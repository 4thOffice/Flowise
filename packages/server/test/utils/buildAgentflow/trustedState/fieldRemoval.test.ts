import { cloneDeep, isEqual } from 'lodash'
import { resolveVariables } from '../../../../src/utils/buildAgentflow'
import {
    Conversation,
    ScenarioScript,
    TurnResult,
    TurnSpec,
    comparableRequests,
    countSentinels,
    decodeToken,
    encodeToken,
    isV2Token,
    loadBeforeTrace,
    loadHarnessComponentNodes,
    loadHarnessScenario,
    normalizeValue,
    runConversation,
    tokenHistory,
    tokenRecords,
    withReplyOverrides
} from './harness'

/*
 * Task 03 of plans/agentflow-trusted-state: which token fields the next turn needs, proven by running turn n+1 of every
 * scenario with a token built from T(n) and comparing the outcome with the run on T(n). Every built token uses the v1
 * layout, with each field placed where the v1 code read it, so these runs also exercise the v1 upgrade. Since Task 05
 * the server writes v2 tokens: the removals edit their v2 fields, a stopped run's records sit in the interim pending
 * data, and the pending action is marked by its history index instead of an `action` on the history message.
 */

jest.setTimeout(180000)

const SCENARIOS = [
    'S01',
    'S01r',
    'S02',
    'S03',
    'S04a',
    'S04b',
    'S05',
    'S06',
    'S06b',
    'S07',
    'S08',
    'S09',
    'S10a',
    'S10b',
    'S11',
    'S12',
    'S13'
]

// ---------- cases and boundaries ----------

interface Case {
    name: string
    conversation: () => Promise<Conversation>
}

interface Boundary {
    label: string
    from: string
    to: string
    resume: boolean
}

const conversations = new Map<string, Promise<Conversation>>()
const caseConversation = (c: Case) => {
    if (!conversations.has(c.name)) conversations.set(c.name, c.conversation())
    return conversations.get(c.name) as Promise<Conversation>
}

// S11's delays only order its parallel branches (LLM B settles before Agent A fails); shorter ones keep that order
const fastS11 = () =>
    withReplyOverrides(loadHarnessScenario('S11'), {
        'agentA-error': { delayMs: 250 },
        'llmB-t1': { delayMs: 10 },
        'llmB-t2': { delayMs: 10 },
        'llmB-t3': { delayMs: 10 }
    })

const scenarioCase = (id: string): Case => ({ name: id, conversation: () => runConversation({ scenario: id === 'S11' ? fastS11() : id }) })

const withTurns = (script: ScenarioScript, turns: TurnSpec[]): ScenarioScript => ({ ...script, turns })

const P1 = 'P1 S06 rejected twice'
const P2 = 'P2 S08 manager denies'
const P3 = 'P3 S06 Finalizer reads the Drafter output and the flow state'
const P4 = 'P4 S07 tool call with text'
const P5 = 'P5 S08 gate approved first'

const PROBES: Case[] = [
    {
        // Loop counts: the second rejection reaches the Revise Loop's max count (2)
        name: P1,
        conversation: () => {
            const s06 = loadHarnessScenario('S06')
            return runConversation({
                scenario: withTurns(s06, [
                    s06.turns[0],
                    s06.turns[1],
                    { id: 't3', humanInput: { type: 'reject', feedback: 'Shorter, please.' } }
                ])
            })
        }
    },
    {
        // Decisions of a node resumed in an earlier turn: the Summary joins the Policy Check (finished in t2) and the gate
        name: P2,
        conversation: () => {
            const s08 = loadHarnessScenario('S08')
            return runConversation({
                scenario: withTurns(s08, [
                    s08.turns[0],
                    s08.turns[1],
                    { id: 't3', humanInput: { type: 'reject', feedback: 'The manager denied it.' } }
                ])
            })
        }
    },
    {
        // A node after the resume references the output of a node that finished in the stopped run, and the flow state
        name: P3,
        conversation: async () => {
            const conversation = new Conversation({ scenario: 'S06' })
            const chatflow = conversation.chatflows[conversation.scenario.flow]
            const flow = JSON.parse(chatflow.flowData)
            const nodeById = (id: string) => flow.nodes.find((node: any) => node.id === id)
            nodeById('startAgentflow_0').data.inputs.startState = [{ key: 'stage', value: 'review' }]
            nodeById('llmAgentflow_0').data.inputs.llmMessages[0].content +=
                '\n<p>Draft under review: {{agentAgentflow_0}}</p>\n<p>Stage: {{$flow.state.stage}}</p>'
            chatflow.flowData = JSON.stringify(flow)
            await conversation.runAll()
            return conversation
        }
    },
    {
        // The model writes text next to the tool call it wants approved
        name: P4,
        conversation: () =>
            runConversation({
                scenario: withReplyOverrides(loadHarnessScenario('S07'), { 't2-tool': { content: 'Let me work that out.' } }),
                turns: ['t1', 't2', 't3']
            })
    },
    {
        // A decision that finished in the stopped run: the gate approved first, so its reject branch stays skipped
        name: P5,
        conversation: () => {
            const s08 = loadHarnessScenario('S08')
            return runConversation({
                scenario: withTurns(s08, [
                    s08.turns[0],
                    {
                        id: 't2',
                        humanInput: { type: 'proceed', feedback: 'Approved by the store manager.', startNodeId: 'humanInputAgentflow_0' }
                    },
                    { id: 't3', humanInput: { type: 'proceed' } }
                ])
            })
        }
    }
]

const RESUME_CASES: Case[] = [...['S06', 'S06b', 'S07', 'S08'].map(scenarioCase), ...PROBES]

const boundariesOf = (c: Case, conversation: Conversation): Boundary[] =>
    conversation.turns.slice(1).map((turn, i) => ({
        label: `${c.name} ${turn.id}`,
        from: conversation.turns[i].id,
        to: turn.id,
        resume: Boolean(turn.request.humanInput)
    }))

const at = (name: string, turns: string) => turns.split(' ').map((turn) => `${name} ${turn}`)

const tokenOf = (turn: TurnResult): string | null => turn.token

const tokenStateOf = (turn: TurnResult) => decodeToken(tokenOf(turn) as string).state

// ---------- token editing ----------

const pick = (value: Record<string, any>, keys: string[]) =>
    Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))
const omit = (value: Record<string, any>, keys: string[]) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

const withHistory = (state: any, map: (message: any) => any) =>
    isV2Token(state) ? { ...state, history: tokenHistory(state).map(map) } : { ...state, pastChatHistory: tokenHistory(state).map(map) }
const withExecution = (state: any, map: (execution: any) => any) =>
    isV2Token(state)
        ? { ...state, pendingResume: { ...state.pendingResume, legacyExecution: map(state.pendingResume.legacyExecution) } }
        : { ...state, previousExecution: map(state.previousExecution) }
const withRecords = (state: any, map: (records: any[]) => any[]) =>
    withExecution(state, (execution) => ({ ...execution, executionData: JSON.stringify(map(tokenRecords(state))) }))
const eachRecord = (state: any, map: (record: any) => any) => withRecords(state, (records) => records.map(map))
const withOutput = (record: any, map: (output: any) => any) =>
    record.data?.output && typeof record.data.output === 'object'
        ? { ...record, data: { ...record.data, output: map(record.data.output) } }
        : record
const withAction = (record: any, map: (action: any) => any) =>
    withOutput(record, (output) => (output.humanInputAction ? { ...output, humanInputAction: map(output.humanInputAction) } : output))

const isDecision = (output: any) => Array.isArray(output?.conditions)
const latestStateIndex = (records: any[]) => records.map((record) => Boolean(record.data?.state)).lastIndexOf(true)

// TS20's slim action
const slimAction = (action: any, inputFields = ['humanInputEnableFeedback']) => ({
    ...pick(action, ['id', 'mapping', 'elements']),
    data: { ...pick(action.data ?? {}, ['nodeId', 'nodeLabel']), input: pick(action.data?.input ?? {}, inputFields) }
})

// ---------- the contract fields (TS19: history, flow state, form values) ----------

const CONTRACT_MESSAGE_FIELDS = ['role', 'content', 'fileUploads', 'artifacts']

interface ContractFields {
    history: any[]
    flowState?: any
    form?: any
}

function latestFlowState(records: any[]) {
    for (let i = records.length - 1; i >= 0; i--) if (records[i]?.data?.state) return records[i].data.state
    return undefined
}

function contractFieldsOf(state: any): ContractFields {
    const history = tokenHistory(state).map((message: any) => pick(message, CONTRACT_MESSAGE_FIELDS))
    if (isV2Token(state)) {
        return { history, flowState: state.flowState, form: Object.keys(state.formValues).length ? state.formValues : undefined }
    }
    const records = tokenRecords(state)
    return {
        history,
        flowState: latestFlowState(records),
        form: records.find((record) => record.data?.name === 'startAgentflow')?.data?.output?.form
    }
}

// Persist State reads the latest record with data.state; form values are read from the first Start record
function contractToken({ history, flowState, form }: ContractFields, { startRecordName = true } = {}) {
    const records: any[] = []
    if (form !== undefined) records.push({ data: { ...(startRecordName ? { name: 'startAgentflow' } : {}), output: { form } } })
    if (flowState !== undefined) records.push({ data: { state: flowState } })
    return { pastChatHistory: history, ...(records.length ? { previousExecution: { executionData: JSON.stringify(records) } } : {}) }
}

// ---------- outcome: class A plus the contract fields of the token the turn writes ----------

const actionFields = (action: any) =>
    action && {
        id: action.id,
        mapping: action.mapping,
        elements: action.elements,
        nodeId: action.data?.nodeId,
        nodeLabel: action.data?.nodeLabel,
        feedback: action.data?.input?.humanInputEnableFeedback
    }

// A resume carries the records of the stopped run into its own (F09); only the nodes this turn ran are behaviour
function currentTurnNodes(turn: TurnResult): string[] {
    const nodes = [...turn.nodeSequence]
    const resumed = turn.request.humanInput?.startNodeId
    if (resumed && turn.tokenSent) {
        for (const record of tokenRecords(decodeToken(turn.tokenSent).state)) {
            if (record.nodeId === resumed) continue
            const i = nodes.indexOf(`${record.nodeId}:${record.status}`)
            if (i >= 0) nodes.splice(i, 1)
        }
    }
    return nodes.sort()
}

function outcome(turn: TurnResult) {
    const token = tokenOf(turn)
    const next = token ? contractFieldsOf(decodeToken(token).state) : null
    return normalizeValue({
        status: turn.status,
        error: turn.error,
        text: turn.text,
        streamed: turn.tokens,
        nodes: currentTurnNodes(turn),
        state: turn.finalState,
        action: actionFields(turn.action) ?? null,
        requests: comparableRequests(turn.modelCalls),
        next: next && {
            history: next.history.map((message) => [message.role, message.content]),
            flowState: next.flowState ?? null,
            form: next.form ?? null
        }
    })
}

const baselines = new Map<string, Promise<any>>()
function baselineOf(conversation: Conversation, boundary: Boundary): Promise<any> {
    if (!baselines.has(boundary.label)) {
        baselines.set(boundary.label, Promise.resolve(outcome(conversation.turn(boundary.to))))
    }
    return baselines.get(boundary.label) as Promise<any>
}

async function runWithToken(conversation: Conversation, boundary: Boundary, state: any) {
    return outcome(await conversation.replay(boundary.to, { token: encodeToken(state) }))
}

/*
 * Runs every boundary whose token `build` changes (null: nothing to remove there), or only the first such boundary of
 * each case, and returns the labels of the boundaries where the outcome differs from the run on the original token.
 */
async function changedBoundaries(cases: Case[], filter: (b: Boundary) => boolean, build: (state: any) => any, firstPerCase = false) {
    const changed: string[] = []
    for (const c of cases) {
        const conversation = await caseConversation(c)
        for (const boundary of boundariesOf(c, conversation).filter(filter)) {
            const original = tokenStateOf(conversation.turn(boundary.from))
            const modified = build(cloneDeep(original))
            if (modified === null || isEqual(modified, original)) continue
            if (!isEqual(await runWithToken(conversation, boundary, modified), await baselineOf(conversation, boundary)))
                changed.push(boundary.label)
            if (firstPerCase) break
        }
    }
    return changed
}

const report: Record<string, Record<string, string[] | string>> = { normal: {}, resume: {}, variants: {}, sizes: {} }

// ---------- normal turns ----------

describe('normal turns: the contract token', () => {
    test.each(SCENARIOS)('%s: history, flow state and form values alone keep every normal turn identical', async (id) => {
        const c = scenarioCase(id)
        const conversation = await caseConversation(c)
        const normal = boundariesOf(c, conversation).filter((b) => !b.resume)
        expect(normal.length).toBeGreaterThan(0)
        for (const boundary of normal) {
            const token = contractToken(contractFieldsOf(tokenStateOf(conversation.turn(boundary.from))))
            expect({ boundary: boundary.label, ...(await runWithToken(conversation, boundary, token)) }).toEqual({
                boundary: boundary.label,
                ...(await baselineOf(conversation, boundary))
            })
        }
    })
})

const contractRemoval =
    (remove: (fields: ContractFields) => ContractFields | null, options?: { startRecordName?: boolean }) => (state: any) => {
        const fields = contractFieldsOf(state)
        const removed = remove(fields)
        return removed === null ? null : contractToken(removed, options)
    }

interface Removal {
    name: string
    build: (state: any) => any
    // Boundaries where the token without the field changes the outcome
    expected: string[]
    firstPerCase?: boolean
}

// The first normal turn with history of every scenario (S10b since TS17: its saved Ephemeral Memory option no longer hides the history)
const HISTORY_READERS = [
    ...at('S01', 't2'),
    ...at('S01r', 't2'),
    ...at('S02', 't2'),
    ...at('S03', 't2'),
    ...at('S04a', 't2'),
    ...at('S04b', 't2'),
    ...at('S05', 't2'),
    ...at('S06', 't4'),
    ...at('S06b', 't4'),
    ...at('S07', 't2'),
    ...at('S08', 't4'),
    ...at('S09', 't2'),
    ...at('S10a', 't2'),
    ...at('S10b', 't2'),
    ...at('S11', 't2'),
    ...at('S12', 't2'),
    ...at('S13', 't2')
]

const CONTRACT_FIELD_REMOVALS: Removal[] = [
    {
        name: 'history (first boundary per scenario)',
        build: contractRemoval((f) => (f.history.length ? { ...f, history: [] } : null)),
        expected: HISTORY_READERS,
        firstPerCase: true
    },
    {
        name: 'history message role (first boundary per scenario)',
        build: contractRemoval((f) => (f.history.length ? { ...f, history: f.history.map((m) => omit(m, ['role'])) } : null)),
        expected: HISTORY_READERS,
        firstPerCase: true
    },
    {
        name: 'history message content (first boundary per scenario)',
        build: contractRemoval((f) => (f.history.length ? { ...f, history: f.history.map((m) => omit(m, ['content'])) } : null)),
        expected: HISTORY_READERS,
        firstPerCase: true
    },
    {
        // State always carries over (TS11), so S04b reads it as S04a does; S03 and S12 set their carried keys again before a node
        // reads them, and no S11 node reads b_note
        name: 'flow state',
        build: contractRemoval((f) => (f.flowState && Object.keys(f.flowState).length ? { ...f, flowState: undefined } : null)),
        expected: [...at('S04a', 't2 t3 t4'), ...at('S04b', 't2 t3 t4'), ...at('S10b', 't2 t3')]
    },
    {
        // t3 submits a new form, which replaces the carried values (TS12)
        name: 'form values',
        build: contractRemoval((f) => (f.form !== undefined ? { ...f, form: undefined } : null)),
        expected: at('S05', 't2 t4')
    },
    {
        name: 'Start record name (form lookup)',
        build: contractRemoval((f) => (f.form !== undefined ? f : null), { startRecordName: false }),
        expected: at('S05', 't2 t4')
    }
]

describe('normal turns: each contract field is required', () => {
    test.each(CONTRACT_FIELD_REMOVALS)('without the $name', async ({ name, build, expected, firstPerCase }) => {
        const changed = await changedBoundaries(SCENARIOS.map(scenarioCase), (b) => !b.resume, build, firstPerCase)
        report.normal[name] = changed
        expect(changed).toEqual(expected)
    })
})

// ---------- resumes: single-field removals from the original token ----------

// Every field the inventory marks drop or reads only on normal turns, removed at once
function withoutDropFields(state: any) {
    const kept = withHistory(state, (m) => pick(m, [...CONTRACT_MESSAGE_FIELDS, 'action']))
    return withRecords(
        withExecution(kept, (execution) => pick(execution, ['state', 'executionData'])),
        (records) =>
            records.map((record, i) => {
                const output = record.data?.output ?? {}
                const action = output.humanInputAction
                return {
                    nodeId: record.nodeId,
                    status: record.status,
                    data: {
                        ...pick(record.data ?? {}, ['parentNodeId']),
                        ...(i === latestStateIndex(records) ? { state: record.data.state } : {}),
                        output: {
                            ...pick(output, ['content', 'nodeID', 'maxLoopCount']),
                            ...(isDecision(output)
                                ? { conditions: output.conditions.map((c: any) => ({ isFulfilled: c?.isFulfilled })) }
                                : {}),
                            ...(action ? { humanInputAction: slimAction(action, ['messages', 'humanInputEnableFeedback']) } : {})
                        }
                    }
                }
            })
    )
}

const removal = (name: string, build: (state: any) => any, expected: string[]): Removal => ({ name, build, expected })

const ALL_RESUMES = [
    ...at('S06', 't2 t3 t5'),
    ...at('S06b', 't2 t3'),
    ...at('S07', 't3 t5'),
    ...at('S08', 't2 t3'),
    ...at(P1, 't2 t3'),
    ...at(P2, 't2 t3'),
    ...at(P3, 't2 t3 t5'),
    ...at(P4, 't3'),
    ...at(P5, 't2 t3')
]

const RESUME_REMOVALS: Removal[] = [
    removal('fields marked drop, all at once', withoutDropFields, []),
    // Without a pending action the resume saves a user message; S06b's history toggle removes it again
    removal(
        'history message action',
        (s) =>
            isV2Token(s)
                ? { ...s, pendingResume: omit(s.pendingResume, ['actionMessageIndex']) }
                : withHistory(s, (m) => omit(m, ['action'])),
        ALL_RESUMES.filter((label) => !label.startsWith('S06b '))
    ),
    // A v2 token marks the pending action by its history index already
    removal(
        'history message action, replaced by a marker',
        (s) => (isV2Token(s) ? null : withHistory(s, (m) => (m.action ? { ...m, action: 'pending' } : m))),
        []
    ),
    removal('execution state', (s) => withExecution(s, (execution) => omit(execution, ['state'])), ALL_RESUMES),
    removal('record nodeId', (s) => eachRecord(s, (record) => omit(record, ['nodeId'])), ALL_RESUMES),
    removal('record status', (s) => eachRecord(s, (record) => omit(record, ['status'])), [
        ...at('S06', 't2'),
        ...at('S06b', 't2'),
        ...at('S08', 't2 t3'),
        ...at(P1, 't2 t3'),
        ...at(P2, 't2 t3'),
        ...at(P3, 't2'),
        ...at(P5, 't2 t3')
    ]),
    removal(
        'checkpoint messages (humanInputAction.data.input.messages)',
        (s) =>
            eachRecord(s, (record) =>
                withAction(record, (a) => ({ ...a, data: { ...a.data, input: omit(a.data?.input ?? {}, ['messages']) } }))
            ),
        [...at('S07', 't3 t5'), ...at('S08', 't2'), ...at(P2, 't2'), ...at(P4, 't3'), ...at(P5, 't3')]
    ),
    removal(
        'humanInputAction id, mapping, elements, data.nodeId and data.nodeLabel',
        (s) =>
            eachRecord(s, (record) =>
                withAction(record, (a) => ({
                    ...omit(a, ['id', 'mapping', 'elements']),
                    data: omit(a.data ?? {}, ['nodeId', 'nodeLabel'])
                }))
            ),
        // The other branch is still stopped: its action is announced again from its record
        [...at('S08', 't2'), ...at(P2, 't2'), ...at(P5, 't2')]
    ),
    removal(
        'record data.output.content',
        (s) => eachRecord(s, (record) => withOutput(record, (o) => omit(o, ['content']))),
        at(P3, 't3 t5')
    ),
    removal('decision conditions', (s) => eachRecord(s, (record) => withOutput(record, (o) => omit(o, ['conditions']))), at(P5, 't3')),
    removal(
        'loop output nodeID and maxLoopCount',
        (s) => eachRecord(s, (record) => withOutput(record, (o) => omit(o, ['nodeID', 'maxLoopCount']))),
        [...at('S06', 't3'), ...at('S06b', 't3'), ...at(P1, 't3'), ...at(P3, 't3')]
    ),
    removal(
        'data.state on every record',
        (s) => eachRecord(s, (record) => ({ ...record, data: omit(record.data ?? {}, ['state']) })),
        at(P3, 't2 t3 t5')
    ),
    removal(
        'finished records (only the stopped ones kept)',
        (s) => withRecords(s, (records) => records.filter((record) => record.status === 'STOPPED')),
        [...at(P1, 't3'), ...at(P2, 't3'), ...at(P3, 't3 t5')]
    )
]

describe('resumes: single-field removals', () => {
    test.each(RESUME_REMOVALS)('without the $name', async ({ name, build, expected }) => {
        const changed = await changedBoundaries(RESUME_CASES, (b) => b.resume, build)
        report.resume[name] = changed
        expect(changed).toEqual(expected)
    })
})

// ---------- TS-O1: pending resume data ----------

type Variant = 'a' | 'b' | 'c'

interface PendingNode {
    nodeId: string
    status: string
    conditions?: boolean[]
    loop?: { nodeID: any; maxLoopCount: any }
    output?: Record<string, any>
    action?: Record<string, any>
    historyLength?: number
    toolCalls?: Array<{ id: string; name: string; args: any }>
    toolCallMessage?: Record<string, any>
    checkpoint?: any[]
}

interface PausedToken extends ContractFields {
    pending: { nodes: PendingNode[] }
}

const flowNodesOf = (conversation: Conversation): any[] => JSON.parse(conversation.chatflows[conversation.scenario.flow].flowData).nodes

// Node ids that another node's inputs reference as {{nodeId}} or {{nodeId.output.<path>}}
function referencedNodeIds(nodes: any[]): Set<string> {
    const text = JSON.stringify(nodes.map((node) => node.data?.inputs ?? {}))
    return new Set(
        nodes.map((node) => node.id).filter((id) => new RegExp(`\\{\\{\\s*${id.replace(/[^A-Za-z0-9]/g, '\\$&')}[\\s.}]`).test(text))
    )
}

// The turn in which the stopped record was written; its incoming history is the history the stopped Agent saw
function historyLengthAtStop(conversation: Conversation, record: any): number {
    const actionId = record.data.output.humanInputAction.id
    const stopTurn = conversation.turns.find((turn) =>
        (turn.executedData ?? []).some(
            (r: any) => r.nodeId === record.nodeId && r.status === 'STOPPED' && r.data?.output?.humanInputAction?.id === actionId
        )
    )
    if (!stopTurn) throw new Error(`No turn stopped ${record.nodeId} with action ${actionId}`)
    return stopTurn.tokenSent ? tokenHistory(decodeToken(stopTurn.tokenSent).state).length : 0
}

function pausedTokenOf(conversation: Conversation, turn: TurnResult, variant: Variant): PausedToken {
    const state = tokenStateOf(turn)
    const nodes = flowNodesOf(conversation)
    const nameOf = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.data?.name
    const referenced = referencedNodeIds(nodes)
    const pendingNodes = tokenRecords(state)
        .filter((record) => !record.data?.parentNodeId)
        .map((record): PendingNode => {
            const output = record.data?.output ?? {}
            const entry: PendingNode = { nodeId: record.nodeId, status: record.status }
            if (record.status !== 'STOPPED') {
                if (isDecision(output)) entry.conditions = output.conditions.map((c: any) => c?.isFulfilled === true)
                if (output.nodeID !== undefined) entry.loop = { nodeID: output.nodeID, maxLoopCount: output.maxLoopCount }
                if (referenced.has(record.nodeId)) entry.output = omit(output, ['humanInputAction'])
                return entry
            }
            const action = output.humanInputAction
            const messages: any[] = action.data?.input?.messages ?? []
            entry.action = slimAction(action)
            if (variant === 'c') {
                entry.checkpoint = messages
            } else if (nameOf(record.nodeId) === 'agentAgentflow') {
                const toolCallMessage = messages[messages.length - 1]
                entry.historyLength = historyLengthAtStop(conversation, record)
                if (variant === 'a') entry.toolCalls = toolCallMessage.tool_calls.map((tc: any) => pick(tc, ['id', 'name', 'args']))
                else entry.toolCallMessage = toolCallMessage
            }
            return entry
        })
    return { ...contractFieldsOf(state), pending: { nodes: pendingNodes } }
}

const toModelMessage = (message: any) => ({ role: message.role === 'userMessage' ? 'user' : 'assistant', content: message.content })

/*
 * What a server keeping no prompt would do on resume: resolve the Agent's messages again as they were at the stop, from
 * the flow, the history before the stopped turn and that turn's question. Covers the scenarios' Agent settings only.
 */
async function rebuildAgentCheckpoint(node: any, paused: PausedToken, entry: PendingNode, records: any[]) {
    const past = paused.history.slice(0, entry.historyLength).map(toModelMessage)
    const question = paused.history[entry.historyLength as number]?.content
    const flowConfig = { state: cloneDeep(paused.flowState ?? {}), chatHistory: past, runtimeChatHistoryLength: 0 }
    const resolved = await resolveVariables(
        cloneDeep(node.data),
        question,
        paused.form ?? {},
        flowConfig as any,
        [],
        [],
        '',
        past as any,
        loadHarnessComponentNodes(),
        records
    )
    const inputs: any = resolved.inputs ?? {}
    if (!inputs.agentEnableMemory || inputs.agentMemoryType !== 'allMessages' || inputs.agentUserMessage) {
        throw new Error(`rebuildAgentCheckpoint covers Agents with all-messages memory and no user message (${node.id})`)
    }
    const messages: any[] = []
    for (const message of inputs.agentMessages ?? []) {
        if (!message.role || !message.content) continue
        if (message.role === 'system') messages.unshift({ role: message.role, content: message.content })
        else messages.push({ role: message.role, content: message.content })
    }
    messages.push(...past, { role: 'user', content: question })
    const toolCallMessage = entry.toolCallMessage ?? {
        role: 'assistant',
        content: '',
        tool_calls: (entry.toolCalls ?? []).map((tc) => ({ ...tc, type: 'tool_call' }))
    }
    return [...messages, toolCallMessage]
}

// Today's code reads the pending data from records, and the presence of a pending action from the last history message
async function rehydrate(paused: PausedToken, nodes: any[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const records: any[] = []
    for (const entry of paused.pending.nodes) {
        const output: Record<string, any> = { ...(entry.output ?? {}) }
        if (entry.conditions) output.conditions = entry.conditions.map((isFulfilled) => ({ isFulfilled }))
        if (entry.loop) Object.assign(output, entry.loop)
        if (entry.action) {
            const messages =
                entry.checkpoint ??
                (entry.toolCalls || entry.toolCallMessage
                    ? await rebuildAgentCheckpoint(nodeById.get(entry.nodeId), paused, entry, records)
                    : [])
            output.humanInputAction = { ...entry.action, data: { ...entry.action.data, input: { ...entry.action.data.input, messages } } }
        }
        records.push({ nodeId: entry.nodeId, status: entry.status, data: { name: nodeById.get(entry.nodeId)?.data?.name, output } })
    }
    records[records.length - 1].data.state = paused.flowState ?? {}
    const last = paused.history.length - 1
    return {
        pastChatHistory: paused.history.map((message, i) => (i === last ? { ...message, action: 'pending' } : message)),
        previousExecution: { state: 'STOPPED', executionData: JSON.stringify(records) }
    }
}

interface PausedSizes {
    today?: number
    contract: number
    a: number
    b: number
    c: number
    promptsInC: number
}

// Base64 characters of the paused token: today's (v1, as captured in traces/before/), the contract fields alone, and the contract
// fields with each variant's pending data
const EXPECTED_PAUSED_SIZES: Record<string, PausedSizes> = {
    'S06 t1': { today: 15268, contract: 344, a: 680, b: 680, c: 724, promptsInC: 0 },
    'S06 t2': { today: 27716, contract: 420, a: 808, b: 808, c: 908, promptsInC: 0 },
    'S06 t4': { today: 16036, contract: 544, a: 872, b: 872, c: 964, promptsInC: 0 },
    'S07 t2': { today: 39676, contract: 428, a: 752, b: 856, c: 13852, promptsInC: 1 },
    'S07 t4': { today: 40368, contract: 500, a: 828, b: 932, c: 14124, promptsInC: 1 },
    'S08 t1': { today: 38656, contract: 408, a: 868, b: 972, c: 13668, promptsInC: 1 },
    'S08 t2': { today: 15412, contract: 416, a: 728, b: 728, c: 744, promptsInC: 0 },
    'S08 t4': { today: 15884, contract: 524, a: 836, b: 836, c: 900, promptsInC: 0 }
}

const VARIANTS: Array<[Variant, string]> = [
    ['a', 'stopped nodes, pending tool calls and stop-time state; prompt and history rebuilt'],
    ['b', '(a) plus the assistant message holding the tool calls'],
    ['c', 'the full checkpoint stored once']
]

describe('TS-O1: pending resume data', () => {
    test('the rebuilt Agent checkpoint equals the stored one at every Agent stop', async () => {
        const checked: string[] = []
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            const nodes = flowNodesOf(conversation)
            for (const turn of conversation.turns.filter((t) => t.status === 'STOPPED')) {
                const paused = pausedTokenOf(conversation, turn, 'b')
                const stored = tokenRecords(tokenStateOf(turn)).filter((r) => r.status === 'STOPPED')
                const rehydrated = tokenRecords(await rehydrate(paused, nodes)).filter((r) => r.status === 'STOPPED')
                for (const record of stored.filter((r) => nodes.find((n) => n.id === r.nodeId)?.data?.name === 'agentAgentflow')) {
                    const messagesOf = (r: any) =>
                        r.data.output.humanInputAction.data.input.messages.map((m: any) => pick(m, ['role', 'content', 'tool_calls']))
                    expect(messagesOf(rehydrated.find((r) => r.nodeId === record.nodeId))).toEqual(messagesOf(record))
                    checked.push(`${c.name} ${turn.id}`)
                }
            }
        }
        expect(checked).toEqual([...at('S07', 't2 t4'), ...at('S08', 't1'), ...at(P2, 't1'), ...at(P4, 't2'), ...at(P5, 't1 t2')])
    })

    test.each(VARIANTS)('variant (%s) %s', async (variant) => {
        const differences: string[] = []
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            const nodes = flowNodesOf(conversation)
            for (const boundary of boundariesOf(c, conversation).filter((b) => b.resume)) {
                const paused = pausedTokenOf(conversation, conversation.turn(boundary.from), variant)
                const actual = await runWithToken(conversation, boundary, await rehydrate(paused, nodes))
                if (!isEqual(actual, await baselineOf(conversation, boundary))) differences.push(boundary.label)
            }
        }
        report.variants[variant] = differences
        expect(differences).toEqual([])
    })

    test('paused token sizes, and system prompts only in (c)', async () => {
        const measured: Record<string, PausedSizes> = {}
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            const before = SCENARIOS.includes(c.name) ? loadBeforeTrace('M1', loadHarnessScenario(c.name).slug) : undefined
            for (const turn of conversation.turns.filter((t) => t.status === 'STOPPED')) {
                const paused = (variant: Variant) => pausedTokenOf(conversation, turn, variant)
                const today = before?.turns.find((t) => t.id === turn.id)?.token?.base64Length
                const sizes: PausedSizes = {
                    ...(today !== undefined ? { today } : {}),
                    contract: encodeToken(omit(paused('a'), ['pending'])).length,
                    a: encodeToken(paused('a')).length,
                    b: encodeToken(paused('b')).length,
                    c: encodeToken(paused('c')).length,
                    promptsInC: countSentinels(paused('c')).total
                }
                expect({
                    turn: `${c.name} ${turn.id}`,
                    a: countSentinels(paused('a')).total,
                    b: countSentinels(paused('b')).total
                }).toEqual({
                    turn: `${c.name} ${turn.id}`,
                    a: 0,
                    b: 0
                })
                measured[`${c.name} ${turn.id}`] = sizes
                report.sizes[`${c.name} ${turn.id}`] = JSON.stringify(sizes)
            }
        }
        for (const [turn, expected] of Object.entries(EXPECTED_PAUSED_SIZES)) {
            const { promptsInC, ...sizes } = measured[turn]
            expect({ turn, promptsInC }).toEqual({ turn, promptsInC: expected.promptsInC })
            for (const [key, value] of Object.entries(sizes)) {
                const pinned = expected[key as keyof PausedSizes] as number
                if (Math.abs(value - pinned) / pinned >= 0.03)
                    throw new Error(`${turn} ${key}: ${value} base64 characters, pinned ${pinned}`)
            }
        }
    })
})

afterAll(() => {
    if (process.env.TS03_REPORT !== '1') return
    console.info(JSON.stringify(report, null, 2))
})
