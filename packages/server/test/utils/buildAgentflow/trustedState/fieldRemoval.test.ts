import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { cloneDeep, isEqual } from 'lodash'
import {
    Conversation,
    HarnessMode,
    ScenarioScript,
    TurnResult,
    TurnSpec,
    comparableRequests,
    countSentinels,
    decodeToken,
    encodeToken,
    isV2Token,
    loadBeforeTrace,
    loadHarnessScenario,
    normalizeValue,
    runConversation,
    tokenHistory,
    tokenRecords,
    withReplyOverrides
} from './harness'

/*
 * Task 03 of plans/agentflow-trusted-state: which token fields the next turn needs, proven by running turn n+1 of every
 * scenario with a token built from T(n) and comparing the outcome with the run on T(n). Every built normal-turn token uses
 * the v1 layout, with each field placed where the v1 code read it, so these runs also exercise the v1 upgrade; only a token
 * with child flow tokens, which v1 has no place for, uses the v2 layout (Task 08). Resumes run on the v2 tokens the server
 * writes since Task 07, whose pending resume data the removals edit.
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

// The D5 = D4 test replays the prompt a stopped Agent sent, which only the internal chat's executed data holds (TS18)
const MODE: HarnessMode = 'M1-internal'

const scenarioCase = (id: string): Case => ({
    name: id,
    conversation: () => runConversation({ scenario: id === 'S11' ? fastS11() : id, mode: MODE })
})

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
                mode: MODE,
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
                mode: MODE,
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
            const conversation = new Conversation({ scenario: 'S06', mode: MODE })
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
                mode: MODE,
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
                mode: MODE,
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

// ---------- the contract fields (TS19: history, flow state, form values, child flow tokens) ----------

const CONTRACT_MESSAGE_FIELDS = ['role', 'content', 'fileUploads', 'artifacts']

interface ContractFields {
    history: any[]
    flowState?: any
    form?: any
    childFlowTokens?: Record<string, { flowId: string; token: string }>
}

function latestFlowState(records: any[]) {
    for (let i = records.length - 1; i >= 0; i--) if (records[i]?.data?.state) return records[i].data.state
    return undefined
}

function contractFieldsOf(state: any): ContractFields {
    const history = tokenHistory(state).map((message: any) => pick(message, CONTRACT_MESSAGE_FIELDS))
    if (isV2Token(state)) {
        return {
            history,
            flowState: state.flowState,
            form: Object.keys(state.formValues).length ? state.formValues : undefined,
            childFlowTokens: Object.keys(state.childFlowTokens).length ? state.childFlowTokens : undefined
        }
    }
    const records = tokenRecords(state)
    return {
        history,
        flowState: latestFlowState(records),
        form: records.find((record) => record.data?.name === 'startAgentflow')?.data?.output?.form
    }
}

// Persist State reads the latest record with data.state; form values are read from the first Start record
function contractToken({ history, flowState, form, childFlowTokens }: ContractFields, { startRecordName = true } = {}) {
    if (childFlowTokens) return { version: 2, history, flowState: flowState ?? {}, formValues: form ?? {}, childFlowTokens }
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

const report: Record<string, Record<string, string[] | string>> = { normal: {}, resume: {}, sizes: {} }

// ---------- normal turns ----------

describe('normal turns: the contract token', () => {
    test.each(SCENARIOS)('%s: the TS19 fields alone keep every normal turn identical', async (id) => {
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
    },
    {
        name: 'child flow tokens',
        build: contractRemoval((f) => (f.childFlowTokens ? { ...f, childFlowTokens: undefined } : null)),
        expected: at('S12', 't2 t3 t4')
    }
]

describe('normal turns: each contract field is required', () => {
    test.each(CONTRACT_FIELD_REMOVALS)('without the $name', async ({ name, build, expected, firstPerCase }) => {
        const changed = await changedBoundaries(SCENARIOS.map(scenarioCase), (b) => !b.resume, build, firstPerCase)
        report.normal[name] = changed
        expect(changed).toEqual(expected)
    })
})

// ---------- resumes: the pending resume data of v2 tokens (Task 07) ----------

const withPending = (state: any, map: (pending: any) => any) => ({ ...state, pendingResume: map(state.pendingResume) })
const eachEntry = (state: any, map: (entry: any) => any) => withPending(state, (pending) => ({ ...pending, nodes: pending.nodes.map(map) }))
const eachAction = (state: any, map: (action: any) => any) =>
    eachEntry(state, (entry) => (entry.action ? { ...entry, action: map(entry.action) } : entry))

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

// The other branch is still stopped at these resumes: its action is announced again and, as nothing else answers, its prompt saved
const REANNOUNCED = [...at('S08', 't2'), ...at(P2, 't2'), ...at(P5, 't2')]

const RESUME_REMOVALS: Removal[] = [
    removal('pending resume data', (s) => omit(s, ['pendingResume']), ALL_RESUMES),
    removal('entry nodeId', (s) => eachEntry(s, (entry) => omit(entry, ['nodeId'])), ALL_RESUMES),
    // Without statuses the replay settles no edges, and a resume finds neither the stopped Agent's checkpoint nor the answered button
    removal('entry status', (s) => eachEntry(s, (entry) => omit(entry, ['status'])), [
        ...at('S06', 't2 t3'),
        ...at('S06b', 't2'),
        ...at('S07', 't3 t5'),
        ...at('S08', 't2 t3'),
        ...at(P1, 't2 t3'),
        ...at(P2, 't2 t3'),
        ...at(P3, 't2 t3'),
        ...at(P4, 't3'),
        ...at(P5, 't2 t3')
    ]),
    removal('Agent checkpoint', (s) => eachEntry(s, (entry) => omit(entry, ['checkpoint'])), [
        ...at('S07', 't3 t5'),
        ...at('S08', 't2'),
        ...at(P2, 't2'),
        ...at(P4, 't3'),
        ...at(P5, 't3')
    ]),
    removal(
        'action id, mapping, data.nodeId and data.nodeLabel',
        (s) => eachAction(s, (action) => ({ ...omit(action, ['id', 'mapping']), data: omit(action.data, ['nodeId', 'nodeLabel']) })),
        REANNOUNCED
    ),
    // An answer without feedback is saved as the label of its button (TS15)
    removal('action elements', (s) => eachAction(s, (action) => omit(action, ['elements'])), [
        ...at('S06', 't3'),
        ...at('S08', 't2'),
        ...at(P2, 't2'),
        ...at(P3, 't3'),
        ...at(P5, 't2')
    ]),
    removal('stopped node prompt', (s) => eachEntry(s, (entry) => omit(entry, ['prompt'])), REANNOUNCED),
    removal('referenced outputs', (s) => eachEntry(s, (entry) => omit(entry, ['output'])), at(P3, 't3 t5')),
    removal('decision conditions', (s) => eachEntry(s, (entry) => omit(entry, ['conditions'])), at(P5, 't3')),
    removal('loop target and max count', (s) => eachEntry(s, (entry) => omit(entry, ['loop'])), [
        ...at('S06', 't3'),
        ...at('S06b', 't3'),
        ...at(P1, 't3'),
        ...at(P3, 't3')
    ]),
    removal('flow state', (s) => (Object.keys(s.flowState).length ? { ...s, flowState: {} } : null), at(P3, 't2 t3 t5')),
    removal(
        'finished entries (only the stopped ones kept)',
        (s) => withPending(s, (pending) => ({ ...pending, nodes: pending.nodes.filter((entry: any) => entry.status === 'STOPPED') })),
        [...at(P1, 't3'), ...at(P2, 't3'), ...at(P3, 't3 t5')]
    )
]

describe('resumes: single-field removals', () => {
    test('every resume runs on a v2 token with pending resume data', async () => {
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            for (const boundary of boundariesOf(c, conversation).filter((b) => b.resume)) {
                const state = tokenStateOf(conversation.turn(boundary.from))
                expect([boundary.label, isV2Token(state), Array.isArray(state.pendingResume?.nodes)]).toEqual([boundary.label, true, true])
            }
        }
    })

    test.each(RESUME_REMOVALS)('without the $name', async ({ name, build, expected }) => {
        const changed = await changedBoundaries(RESUME_CASES, (b) => b.resume, build)
        report.resume[name] = changed
        expect(changed).toEqual(expected)
    })
})

// ---------- resumes: class A as before Task 07 ----------

// The outcomes of every turn of RESUME_CASES before Task 07 (class A and the token history), captured at d0afdbed with
// strings over 300 characters folded to their length and hash
const BEFORE_TASK_07 = JSON.parse(fs.readFileSync(path.join(__dirname, 'resumeBoundaries.before.json'), 'utf8')).cases

const fold = (value: any): any => {
    if (typeof value === 'string')
        return value.length > 300 ? `<${value.length} chars sha256:${crypto.createHash('sha256').update(value).digest('hex')}>` : value
    if (Array.isArray(value)) return value.map(fold)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fold(v)]))
    return value
}

// Answers saved as user messages, and a blank stop saved as the waiting prompt, reach the models of later turns (F05, D9)
const LATER_MODEL_INPUT = [
    ...at('S06', 't3 t4 t5'),
    ...at('S06b', 't3 t4'),
    ...at('S07', 't4 t5 t6'),
    ...at('S08', 't3 t4'),
    ...at(P2, 't3'),
    ...at(P3, 't3 t4 t5'),
    ...at(P5, 't3')
]

describe('resumes: class A as before Task 07', () => {
    test.each(RESUME_CASES.map((c) => [c.name, c]))('%s', async (_, c) => {
        const conversation = await caseConversation(c)
        const before = BEFORE_TASK_07[c.name]
        expect(conversation.turns.map((turn) => turn.id)).toEqual(Object.keys(before))
        for (const turn of conversation.turns) {
            const { next, action, ...classA } = fold(normalizeValue(outcome(turn)))
            const { history, resume, ...beforeClassA } = before[turn.id]
            const label = `${c.name} ${turn.id}`
            const aspects = LATER_MODEL_INPUT.includes(label) ? ['requests'] : []
            const actual = { ...classA, action: action && omit(action, ['id']) }
            expect({ label, resume, ...omit(actual, aspects) }).toEqual({
                label,
                resume: Boolean(turn.request.humanInput),
                ...omit(beforeClassA, aspects)
            })
            if (aspects.length)
                expect({ label, differs: !isEqual(actual.requests, beforeClassA.requests) }).toEqual({ label, differs: true })
            // The history differs as F05-F07 intend: it alternates, starting with a user message, with no blank message
            const alternates = next.history.every(
                ([role, content]: [string, string], i: number) => role === (i % 2 ? 'apiMessage' : 'userMessage') && content.trim() !== ''
            )
            expect({ label, alternates, history: history.length > 0 }).toEqual({ label, alternates: true, history: true })
        }
    })
})

// ---------- pending resume data (TS26, Task 07) ----------

const PENDING_KEYS = ['nodes', 'executionId', 'stopMessageId']
const ENTRY_KEYS = ['nodeId', 'status', 'conditions', 'loop', 'output', 'action', 'prompt', 'checkpoint', 'legacyMessages']
const ACTION_KEYS = ['id', 'mapping', 'elements', 'data']

// The prompt the stopped Agent sent, as its STOPPED record of the stop turn holds it
function storedPrompt(conversation: Conversation, actionId: string): any[] {
    for (const turn of conversation.turns) {
        const record = (turn.executedData ?? []).find(
            (r: any) => r.status === 'STOPPED' && r.data?.output?.humanInputAction?.id === actionId && r.data?.input?.messages
        )
        if (record) return record.data.input.messages
    }
    throw new Error(`No turn stopped with action ${actionId}`)
}

interface PausedSizes {
    today?: number
    v2: number
}

// Base64 characters of the paused token: today's (v1, as captured in traces/before/) and the v2 token with its pending data
const EXPECTED_PAUSED_SIZES: Record<string, PausedSizes> = {
    'S06 t1': { today: 15336, v2: 740 },
    'S06 t2': { today: 27816, v2: 892 },
    'S06 t4': { today: 16108, v2: 960 },
    'S06b t1': { today: 15192, v2: 684 },
    'S06b t2': { today: 27380, v2: 776 },
    'S06b t4': { today: 15768, v2: 824 },
    'S07 t2': { today: 39844, v2: 956 },
    'S07 t4': { today: 40516, v2: 1032 },
    'S08 t1': { today: 38812, v2: 1068 },
    'S08 t2': { today: 15496, v2: 796 },
    'S08 t4': { today: 15964, v2: 912 }
}

describe('pending resume data (TS26)', () => {
    test('a paused token holds the skeleton, slim actions, prompts and Agent checkpoints only, and no system prompt', async () => {
        const problems: string[] = []
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            for (const turn of conversation.turns.filter((t) => t.status === 'STOPPED')) {
                const label = `${c.name} ${turn.id}`
                const pending = tokenStateOf(turn).pendingResume
                const extra = (value: any, allowed: string[]) => Object.keys(value ?? {}).filter((key) => !allowed.includes(key))
                if (extra(pending, PENDING_KEYS).length) problems.push(`${label}: pending ${extra(pending, PENDING_KEYS)}`)
                for (const entry of pending.nodes) {
                    if (extra(entry, ENTRY_KEYS).length) problems.push(`${label} ${entry.nodeId}: ${extra(entry, ENTRY_KEYS)}`)
                    if (extra(entry.action, ACTION_KEYS).length)
                        problems.push(`${label} ${entry.nodeId} action: ${extra(entry.action, ACTION_KEYS)}`)
                    if (entry.action && extra(entry.action.data.input, ['humanInputEnableFeedback']).length)
                        problems.push(
                            `${label} ${entry.nodeId} action input: ${extra(entry.action.data.input, ['humanInputEnableFeedback'])}`
                        )
                }
                if (countSentinels(tokenStateOf(turn)).total) problems.push(`${label}: prompt sentinels`)
            }
        }
        expect(problems).toEqual([])
    })

    test('an Agent resume rebuilt from its checkpoint sends what replaying its stored prompt sends (D5, D4)', async () => {
        const checked: string[] = []
        for (const c of RESUME_CASES) {
            const conversation = await caseConversation(c)
            for (const boundary of boundariesOf(c, conversation).filter((b) => b.resume)) {
                const state = tokenStateOf(conversation.turn(boundary.from))
                const resumed = state.pendingResume.nodes.find(
                    (entry: any) => entry.nodeId === conversation.turn(boundary.to).request.humanInput.startNodeId && entry.checkpoint
                )
                if (!resumed) continue
                const replayed = eachEntry(state, (entry) =>
                    entry.checkpoint
                        ? { ...omit(entry, ['checkpoint']), legacyMessages: storedPrompt(conversation, entry.action.id) }
                        : entry
                )
                expect({ boundary: boundary.label, ...(await runWithToken(conversation, boundary, replayed)) }).toEqual({
                    boundary: boundary.label,
                    ...(await baselineOf(conversation, boundary))
                })
                checked.push(boundary.label)
            }
        }
        expect(checked).toEqual([...at('S07', 't3 t5'), ...at('S08', 't2'), ...at(P2, 't2'), ...at(P4, 't3'), ...at(P5, 't3')])
    })

    test('paused token sizes', async () => {
        for (const c of RESUME_CASES.filter((c) => SCENARIOS.includes(c.name))) {
            const conversation = await caseConversation(c)
            const before = loadBeforeTrace('M1', loadHarnessScenario(c.name).slug)
            for (const turn of conversation.turns.filter((t) => t.status === 'STOPPED')) {
                const label = `${c.name} ${turn.id}`
                const sizes: PausedSizes = {
                    today: before.turns.find((t) => t.id === turn.id)?.token?.base64Length,
                    v2: (tokenOf(turn) as string).length
                }
                report.sizes[label] = JSON.stringify(sizes)
                const pinned = EXPECTED_PAUSED_SIZES[label]
                expect([label, sizes.today]).toEqual([label, pinned.today])
                if (Math.abs(sizes.v2 - pinned.v2) / pinned.v2 >= 0.03)
                    throw new Error(`${label}: ${sizes.v2} base64 characters, pinned ${pinned.v2}`)
            }
        }
    })
})

afterAll(() => {
    if (process.env.TS03_REPORT !== '1') return
    console.info(JSON.stringify(report, null, 2))
})
