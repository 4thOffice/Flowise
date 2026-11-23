import * as trustedStateHelper from '../../../../src/utils/trustedStateHelper'
import { EXPECTED_TOKEN_CONTENTS, EXPECTED_TURN_FACTS } from './characterization.expected'
import {
    ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG,
    BeforeTurn,
    Conversation,
    HarnessMode,
    TurnResult,
    beforeTraceExists,
    compactModelCalls,
    comparableRequests,
    conversationMessages,
    countSentinels,
    decodeToken,
    encodeToken,
    executionRecords,
    findNodeRecords,
    historyRolesCompact,
    loadBeforeTrace,
    loadScenario,
    normalizeValue,
    runConversation,
    startConversation,
    tokenHistory,
    tokenSize,
    turnFacts,
    userFacingAction,
    withoutRetries
} from './harness'
import { ScriptedOpenAIServer } from './testChatModel'

/*
 * Today's cross-turn behaviour of Agentflow V2 (Task 01 of plans/agentflow-trusted-state). Real Start, Agent, LLM,
 * Condition Agent, HumanInput, Execute Flow and Iteration nodes run the 00b scenario flows against the scripted model.
 * These tests keep passing through Tasks 03 and 05-09; an assertion changes only in the task whose finding intends it,
 * to the behaviour recorded for that finding in baselines/compare.config.json (TS6).
 */

jest.setTimeout(120000)

const SCENARIOS: Array<[string, string]> = [
    ['S01', 'single agent with all-messages memory and tools'],
    ['S01r', 'Redirect to Flow mapping to S01'],
    ['S02', 'Condition Agent router with different memory per branch'],
    ['S03', 'parallel researcher and critic joined by a composer'],
    ['S04a', 'state carry-over with Persist State on'],
    ['S04b', 'state carry-over with Persist State off'],
    ['S05', 'form start, chat, a new form, chat'],
    ['S06', 'human review with feedback, revise loop and companion reply'],
    ['S06b', 'human review with the history toggle off'],
    ['S07', 'agent tool that requires approval'],
    ['S08', 'parallel tool approval and HumanInput stops'],
    ['S09', 'iteration with an LLM per item, aggregator and loop'],
    ['S10a', 'client sends the whole conversation in history'],
    ['S10b', 'ephemeral memory with carried state'],
    ['S11', 'a parallel branch fails on turn 2'],
    ['S12', 'Execute Flow child with memory and a state counter'],
    ['S13', "S01's flow over non-streaming requests"]
]

const runs = new Map<string, Promise<Conversation>>()

function runOf(id: string, mode: HarnessMode = 'M1'): Promise<Conversation> {
    const key = `${mode}/${id}`
    if (!runs.has(key)) runs.set(key, runConversation({ scenario: id, mode }))
    return runs.get(key) as Promise<Conversation>
}

describe('harness', () => {
    test('decodes the tokens the server writes and writes tokens the server reads', async () => {
        const state = { pastChatHistory: [{ role: 'userMessage', content: 'Hi' }], previousExecution: { id: 'e1', executionData: '[]' } }
        const fromServer = decodeToken(await trustedStateHelper.trusted_state_to_string(state as any))
        expect(fromServer.state).toEqual(state)
        expect(fromServer.sizes.rawJsonBytes).toBe(Buffer.byteLength(JSON.stringify(state)))
        expect(await trustedStateHelper.trusted_state_from_string(encodeToken(state))).toEqual(state)
    })

    test('tokenSize measures paths, including inside JSON strings', () => {
        const state = { previousExecution: { executionData: JSON.stringify([{ data: { input: { messages: ['abc'] } } }]) } }
        expect(tokenSize(state)).toBe(Buffer.byteLength(JSON.stringify(state)))
        expect(tokenSize(state, 'previousExecution.executionData<json>[0].data.input.messages')).toBe(7)
        expect(tokenSize(state, 'previousExecution.missing')).toBe(0)
    })

    test('countSentinels counts system prompt sentinels in any payload', () => {
        expect(countSentinels({ a: 'SYSPROMPT_SENTINEL_S01_agent', b: ['x SYSPROMPT_SENTINEL_S01_agent'] })).toEqual({
            total: 2,
            bySentinel: { SYSPROMPT_SENTINEL_S01_agent: 2 }
        })
    })

    test('the scripted model replies by route marker, turn and call index, like the 00b fake server', async () => {
        const server = new ScriptedOpenAIServer()
        server.setScenario({
            scenario: 'X',
            rules: [
                { id: 'first', route: 'X-a', turn: 't1', call: 0, reply: { content: 'one ({turn})' } },
                { id: 'later', route: 'X-a', reply: { content: 'call {call}' } }
            ]
        })
        server.markTurn('t1')
        const ask = async (route: string) => {
            const body = {
                model: 'fake-model',
                messages: [
                    { role: 'system', content: `\\[\\[route:${route}\\]\\] prompt` },
                    { role: 'user', content: 'q' }
                ]
            }
            const res = await server.fetch('http://fake-llm.test/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) })
            return (await res.json()).choices[0].message.content
        }
        expect([await ask('X-a'), await ask('X-a'), await ask('X-b')]).toEqual([
            'one (t1)',
            'call 1',
            expect.stringMatching(/^FAKE-UNSCRIPTED route=X-b turn=t1 call=0/)
        ])
        expect(server.calls.map((c) => [c.route, c.callIndex, c.ruleId])).toEqual([
            ['X-a', 0, 'first'],
            ['X-a', 1, 'later'],
            ['X-b', 0, 'unscripted']
        ])
    })

    test('model nodes run the real ChatOpenAI node offline and without retries', async () => {
        const conversation = await runOf('S11')
        const failed = conversation.turn('t2').modelCallsByRoute['S11-agentA']
        expect(failed.map((call) => [call.ruleId, call.status])).toEqual([['agentA-error', 500]])
        expect(conversation.turn('t1').modelCalls[0].body).toMatchObject({ model: 'fake-model', stream: true, store: false })
    })
})

// The turn to run again without the token (or, for S13, with the token the server built but did not return)
const TOKEN_DEPENDENT_TURNS: Record<string, string[]> = {
    S01: ['t2'],
    S01r: ['t2'],
    S02: ['t2'],
    S03: ['t2'],
    S04a: ['t2'],
    S04b: ['t2'],
    S05: ['t2'],
    S06: ['t2', 't4'],
    S06b: ['t2', 't4'],
    S07: ['t3', 't4'],
    S08: ['t2', 't4'],
    S09: ['t2'],
    S10a: ['t2'],
    S10b: ['t2'],
    S11: ['t3'],
    S12: ['t2'],
    S13: ['t2']
}

describe.each(SCENARIOS)('%s %s', (id) => {
    const turnIds = loadScenario(id).turns.map((turn) => turn.id)

    test.each(turnIds)('%s', async (turnId) => {
        const turn = (await runOf(id)).turn(turnId)
        expect(turnFacts(turn)).toEqual(EXPECTED_TURN_FACTS[id][turnId])
        expect({ streamed: turn.tokens, modelCalls: compactModelCalls(turn) }).toMatchSnapshot()
    })

    test('the next turn depends on the token', async () => {
        const conversation = await runOf(id)
        for (const turnId of TOKEN_DEPENDENT_TURNS[id]) {
            const actual = conversation.turn(turnId)
            const withoutToken = await conversation.replay(turnId, { sendToken: false })
            if (id === 'S10b') {
                // Ephemeral memory: the model sees no history either way, only the carried state depends on the token
                expect(comparableRequests(withoutToken.modelCalls)).toEqual(comparableRequests(actual.modelCalls))
                expect(withoutToken.finalState).toEqual({ counter: '1' })
                expect(actual.finalState).toEqual({ counter: '2' })
                continue
            }
            expect(comparableRequests(withoutToken.modelCalls)).not.toEqual(comparableRequests(actual.modelCalls))
        }
    })
})

describe('token contents', () => {
    test.each(SCENARIOS.map(([id]) => id))('%s', async (id) => {
        const conversation = await runOf(id)
        for (const turn of conversation.turns) {
            const expected = EXPECTED_TOKEN_CONTENTS[id][turn.id]
            if (!expected) {
                expect(turn.token).toBeNull()
                continue
            }
            const summary = turn.tokenSummary!
            expect({
                turn: turn.id,
                sentinels: turn.sentinels.token,
                records: summary.records.length,
                historyWithAction: summary.historyMessagesWithAction
            }).toEqual({
                turn: turn.id,
                sentinels: expected.sentinels,
                records: expected.records,
                historyWithAction: expected.historyWithAction
            })
            // Dates, ids and the Current DateTime output vary in length between runs
            expect(Math.abs(summary.rawJsonBytes - expected.bytes) / expected.bytes).toBeLessThan(0.03)
        }
    })
})

function observedFacts(
    turn: { status: string | null; text: string | null; nodeSequence: string[] | null; finalState: any; action: any },
    historyRoles: string[] | null
) {
    return {
        status: turn.status,
        text: turn.text,
        nodes: [...(turn.nodeSequence ?? [])].sort(),
        state: normalizeValue(turn.finalState ?? {}),
        action: userFacingAction(turn.action),
        history: historyRoles ? historyRolesCompact(historyRoles) : null
    }
}

const BEFORE_MODES: HarnessMode[] = ['M1', 'M2', 'M3', 'M1-internal', 'M1-reqflag', 'M3-envflags']
const BEFORE_CASES = BEFORE_MODES.flatMap((mode) =>
    SCENARIOS.map(([id]) => id)
        .filter((id) => beforeTraceExists(mode, loadScenario(id).slug))
        .map((id) => [mode, id] as [HarnessMode, string])
)

describe('before/ traces', () => {
    // Intended differences from traces/before/, by "<mode>/<scenario>/<turn>": the finding whose fix causes them
    const INTENDED_DIFFERENCES: Record<string, string> = {
        // The JSON response carries the token, so S13 has a token history and continues the conversation
        'M1/S13/t1': 'F14',
        'M1/S13/t2': 'F14',
        'M1/S13/t3': 'F14',
        // Client State off reads nothing from the database: resumes save no answer (as M1) and the child flow has no memory (as M1)
        'M3/S06/t2': 'F01',
        'M3/S06/t3': 'F01',
        'M3/S06/t4': 'F01',
        'M3/S06/t5': 'F01',
        'M3/S07/t3': 'F01',
        'M3/S07/t4': 'F01',
        'M3/S07/t5': 'F01',
        'M3/S07/t6': 'F01',
        'M3/S12/t2': 'F01',
        'M3/S12/t3': 'F01',
        'M3/S12/t4': 'F01'
    }

    test.each(BEFORE_CASES)('%s %s matches the captured model requests and responses', async (mode, id) => {
        const conversation = await runOf(id, mode)
        const trace = loadBeforeTrace(mode, loadScenario(id).slug)
        expect(conversation.turns.map((t) => t.id)).toEqual(trace.turns.map((t) => t.id))
        for (const turn of conversation.turns) {
            if (INTENDED_DIFFERENCES[`${mode}/${id}/${turn.id}`]) continue
            const before = trace.turns.find((t) => t.id === turn.id) as BeforeTurn
            expect({ turn: turn.id, requests: comparableRequests(turn.modelCalls) }).toEqual({
                turn: turn.id,
                requests: comparableRequests(withoutRetries(before.modelRequests))
            })
            expect(observedFacts(turn, turn.tokenSummary?.historyRoles ?? null)).toEqual(
                observedFacts(before, before.token?.sizes?.historyRoles ?? null)
            )
        }
    })
})

describe('kept behaviour', () => {
    test('TS5 with execution recording on (M2), executions are saved with full node records and never read', async () => {
        const conversation = await runOf('S07', 'M2')
        const rows = conversation.turns[conversation.turns.length - 1].db.executions
        expect(rows).toHaveLength(conversation.turns.filter((t) => !t.request.humanInput).length)
        const records = await executionRecords(rows[1])
        expect(records.map((r) => `${r.nodeId}:${r.status}`)).toEqual(['startAgentflow_0:FINISHED', 'agentAgentflow_0:FINISHED'])
        expect(countSentinels(records).total).toBeGreaterThan(0)
        expect(conversation.dataSource.reads.filter((read) => !read.allowed)).toEqual([])
    })

    test('TS14 a failed turn keeps the state changes of finished nodes and adds nothing to history (S11)', async () => {
        const conversation = await runOf('S11')
        const failed = conversation.turn('t2')
        expect(failed.status).toBe('ERROR')
        expect(failed.nodeSequence).toEqual(['startAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'agentAgentflow_0:ERROR'])
        expect(failed.finalState).toEqual({ b_note: 'Side note: photos are needed for damage claims.' })
        expect(failed.tokenSummary?.historyMessages).toBe(conversation.turn('t1').tokenSummary?.historyMessages)
        expect(conversation.turn('t3').status).toBe('FINISHED')
    })

    test('F18 the internal chat receives full executed data (TS18)', async () => {
        const conversation = await runOf('S01', 'M1-internal')
        for (const turn of conversation.turns) {
            expect(countSentinels(turn.executedData).total).toBeGreaterThan(0)
            expect(turn.executedData?.find((r) => r.nodeId === 'agentAgentflow_0')?.data?.input?.messages?.length).toBeGreaterThan(0)
        }
    })
})

describe('token-only conversations (Task 05)', () => {
    const TOKEN_ONLY_SCENARIOS = ['S01', 'S01r', 'S02', 'S03', 'S04a', 'S04b', 'S05', 'S09', 'S10a', 'S10b', 'S11', 'S13']

    test.each(TOKEN_ONLY_SCENARIOS)('%s runs with Client State off and every conversation read failing, as with it on', async (id) => {
        const tokenMode = await runOf(id)
        const dbMode = await runConversation({ scenario: id, mode: 'M3', readGuard: 'throw' })
        expect(dbMode.dataSource.reads.filter((read) => !read.allowed)).toEqual([])
        expect(dbMode.turns.map((t) => [t.id, t.status, t.error])).toEqual(tokenMode.turns.map((t) => [t.id, t.status, t.error]))
        for (const turn of dbMode.turns) {
            expect({ turn: turn.id, requests: comparableRequests(turn.modelCalls) }).toEqual({
                turn: turn.id,
                requests: comparableRequests(tokenMode.turn(turn.id).modelCalls)
            })
        }
    })

    test('D10 a resume whose recorded execution is gone continues, warns, and records the run as a new execution', async () => {
        const recorded = await runOf('S06', 'M2')
        const missing = await runConversation({ scenario: 'S06', mode: 'M2', turns: ['t1', 't2'], freshDataSourcePerTurn: true })
        const resumed = missing.turn('t2')
        expect([resumed.status, resumed.error]).toEqual(['STOPPED', null])
        expect(comparableRequests(resumed.modelCalls)).toEqual(comparableRequests(recorded.turn('t2').modelCalls))
        expect(resumed.logs.filter((entry) => entry.level === 'warn' && /Execution .* not found/.test(entry.message)).length).toBe(2)
        expect(resumed.db.executions.map((row) => row.state)).toEqual(['STOPPED'])
        expect(decodeToken(resumed.token!).state.pendingResume.legacyExecution.id).toBe(resumed.db.executions[0].id)
    })

    test('the v2 token of every turn that does not end stopped holds no system prompt and is at most 5 % of the v1 token', async () => {
        const problems: string[] = []
        for (const [id] of SCENARIOS) {
            const before = loadBeforeTrace('M1', loadScenario(id).slug)
            for (const turn of (await runOf(id)).turns) {
                if (turn.status === 'STOPPED') continue
                if (!turn.decoded) {
                    problems.push(`${id} ${turn.id}: no token`)
                    continue
                }
                // S13 has no v1 token (F14)
                const beforeBytes = before.turns.find((t) => t.id === turn.id)?.token?.sizes?.rawJsonBytes
                const maxBytes = beforeBytes ? 0.05 * beforeBytes : 4096
                if (turn.decoded.state.version !== 2) problems.push(`${id} ${turn.id}: version ${turn.decoded.state.version}`)
                if (turn.sentinels.token) problems.push(`${id} ${turn.id}: ${turn.sentinels.token} prompt sentinels`)
                if (turn.decoded.sizes.rawJsonBytes > maxBytes)
                    problems.push(`${id} ${turn.id}: ${turn.decoded.sizes.rawJsonBytes} bytes, more than ${Math.floor(maxBytes)}`)
            }
        }
        expect(problems).toEqual([])
    })
})

function conversationOf(turn: TurnResult, route: string, index = 0) {
    const call = turn.modelCallsByRoute[route]?.[index]
    if (!call) throw new Error(`Turn ${turn.id} made no call ${index} on route ${route}`)
    return conversationMessages(call)
}

// The message right before the assistant message with this content
function messageBefore(messages: Array<{ role: string; content: string }>, assistantContent: string | null) {
    const index = messages.findIndex((m) => m.role === 'assistant' && m.content === assistantContent)
    return index > 0 ? messages[index - 1] : undefined
}

const S10A_WELCOME = 'Welcome to Northwind Outfitters! How can I help you today?'

/*
 * Target behaviour for each finding in 00c-findings.md, as decided in PLAN §2. Every test in this block fails today
 * and is marked `test.failing`; the task that fixes a finding flips its tests to `test` (PLAN §6, step 6). Why each one
 * fails today is recorded in 01-test-harness-and-characterization-tests.md.
 */
describe('findings: target behaviour', () => {
    describe('F01 no ChatMessage or Execution reads (TS9)', () => {
        test('F01 conversations with approvals run with conversation reads failing, with Client State off as well', async () => {
            for (const id of ['S06', 'S07']) {
                const tokenMode = await runOf(id)
                const dbMode = await runConversation({ scenario: id, mode: 'M3', readGuard: 'throw' })
                expect(dbMode.turns.map((t) => [t.id, t.error])).toEqual(dbMode.turns.map((t) => [t.id, null]))
                expect(dbMode.dataSource.reads.filter((read) => !read.allowed)).toEqual([])
                for (const turn of dbMode.turns) {
                    expect(comparableRequests(turn.modelCalls)).toEqual(comparableRequests(tokenMode.turn(turn.id).modelCalls))
                }
            }
        })
    })

    describe('F02 client history (TS13, TS13a, TS22)', () => {
        let acceptingRun: Promise<Conversation> | undefined
        const accepting = () =>
            (acceptingRun ??= runConversation({ scenario: 'S10a', chatbotConfig: ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG }))

        test.failing('F02 with "Accept conversation history from the client" on, a memory node sees the client history once', async () => {
            const conversation = await accepting()
            expect(conversationOf(conversation.turn('t2'), 'S10a-context')).toEqual([
                { role: 'assistant', content: S10A_WELCOME },
                { role: 'user', content: 'Do you ship to Norway?' },
                { role: 'assistant', content: conversation.turn('t1').text },
                { role: 'user', content: 'How much does shipping cost?' }
            ])
        })

        test.failing('F02 the client history, welcome message included, is saved in the token with the turn appended', async () => {
            const conversation = await accepting()
            const history = tokenHistory(conversation.turn('t1').decoded!.state).map((m: any) => [m.role, m.content])
            expect(history).toEqual([
                ['apiMessage', S10A_WELCOME],
                ['userMessage', 'Do you ship to Norway?'],
                ['apiMessage', conversation.turn('t1').text]
            ])
        })

        test.failing('F02 a memory-off first node sees no history, neither from the client nor from the token (TS22)', async () => {
            const conversation = await accepting()
            for (const turn of conversation.turns) {
                const question = turn.request.question
                expect(conversationOf(turn, 'S10a-quick')).toEqual([{ role: 'user', content: question }])
            }
        })

        test.failing(
            "F02 a warning is logged when the client history lacks the token's last message, and the turn continues (TS13)",
            async () => {
                const conversation = await accepting()
                const warnings = (turn: TurnResult) => turn.logs.filter((entry) => entry.level === 'warn')
                expect(warnings(conversation.turn('t2'))).toEqual([])
                expect(warnings(conversation.turn('t3')).length).toBeGreaterThan(0)
                expect(conversation.turn('t3').status).toBe('FINISHED')
            }
        )

        test.failing('F02 with the setting off, the client history is ignored with a warning (TS13a)', async () => {
            const conversation = await runOf('S10a')
            const t2 = conversation.turn('t2')
            expect(conversationOf(t2, 'S10a-context')).toEqual([
                { role: 'user', content: 'Do you ship to Norway?' },
                { role: 'assistant', content: conversation.turn('t1').text },
                { role: 'user', content: 'How much does shipping cost?' }
            ])
            expect(t2.logs.filter((entry) => entry.level === 'warn').length).toBeGreaterThan(0)
        })
    })

    describe('F03 state always carries over (TS11)', () => {
        test.failing('F03 flow state carries over with Persist State off, as it does with it on (S04b vs S04a)', async () => {
            const persistOff = await runOf('S04b')
            const persistOn = await runOf('S04a')
            expect(persistOff.turns.map((t) => t.finalState)).toEqual(persistOn.turns.map((t) => t.finalState))
            expect(persistOff.turns.map((t) => Object.keys(t.modelCallsByRoute))).toEqual(
                persistOn.turns.map((t) => Object.keys(t.modelCallsByRoute).map((route) => route.replace('S04a', 'S04b')))
            )
        })
    })

    describe('F04 form values (TS12)', () => {
        test.failing('F04 a new form submission replaces the values the Start node and $form.* see (S05)', async () => {
            const conversation = await runOf('S05')
            const startForm = (turn: TurnResult) =>
                turn.executedData?.find((record) => record.nodeId === 'startAgentflow_0')?.data?.output?.form
            expect(startForm(conversation.turn('t3'))).toEqual({ name: 'Grace Hopper', topic: 'shipping' })
            for (const turnId of ['t3', 't4']) {
                const systemPrompt = conversation.turn(turnId).modelCallsByRoute['S05-assistant'][0].messages[0].content
                expect(systemPrompt).toContain('Customer name: Grace Hopper. Topic: shipping.')
            }
        })
    })

    describe('F05 approval answers in history (TS15)', () => {
        test.failing(
            'F05 HumanInput: the feedback, otherwise the button label, sits between the approval prompt and the reply (S06)',
            async () => {
                const conversation = await runOf('S06')
                const drafter = conversationOf(conversation.turn('t4'), 'S06-drafter')
                expect(messageBefore(drafter, conversation.turn('t2').text)).toEqual({
                    role: 'user',
                    content: 'Please mention the 10% discount code SORRY10.'
                })
                expect(messageBefore(drafter, conversation.turn('t3').text)).toEqual({ role: 'user', content: 'Approve' })
                const finalizer = conversationOf(conversation.turn('t5'), 'S06-finalizer')
                expect(finalizer[finalizer.length - 1]).toEqual({ role: 'user', content: 'Approved, send it.' })
            }
        )

        test.failing('F05 Agent tool approval: the button label or the feedback is the user message of the resume turn (S07)', async () => {
            const conversation = await runOf('S07')
            expect(messageBefore(conversationOf(conversation.turn('t4'), 'S07-agent'), conversation.turn('t3').text)).toEqual({
                role: 'user',
                content: 'Proceed'
            })
            expect(messageBefore(conversationOf(conversation.turn('t6'), 'S07-agent'), conversation.turn('t5').text)).toEqual({
                role: 'user',
                content: 'Do not calculate it; escalate to a manager instead.'
            })
        })

        test.failing('F05 parallel stops: both answers reach the Summary and the next turn (S08)', async () => {
            const conversation = await runOf('S08')
            for (const [turnId, route] of [
                ['t3', 'S08-summary'],
                ['t4', 'S08-policy']
            ]) {
                const userMessages = conversationOf(conversation.turn(turnId), route)
                    .filter((m) => m.role === 'user')
                    .map((m) => m.content)
                expect(userMessages).toEqual(expect.arrayContaining(['Proceed', 'Approved by the store manager.']))
            }
        })
    })

    describe('F06 HumanInput history toggle (TS15)', () => {
        test.failing(
            'F06 with the toggle off, neither the approval prompt nor the answer is in history, without state flags (S06b)',
            async () => {
                const conversation = await runOf('S06b')
                for (const turn of conversation.turns) {
                    expect(turn.action?.extra || undefined).toBeUndefined()
                    for (const record of turn.executedData ?? [])
                        expect(record.data?.state ?? {}).not.toHaveProperty('doNotIncludeFeedbackHistory')
                }
                expect(conversationOf(conversation.turn('t4'), 'S06b-drafter')).toEqual([
                    { role: 'user', content: 'Draft a reply to a customer whose shipment is delayed by a week.' },
                    { role: 'assistant', content: conversation.turn('t3').text },
                    { role: 'user', content: 'Now draft a short SMS version of that message.' }
                ])
            }
        )
    })

    describe('F07 message order after resumes', () => {
        test.failing('F07 no model input has two assistant messages in a row or a blank assistant message', async () => {
            const problems: string[] = []
            for (const [id, turnIds] of [
                ['S06', ['t3', 't4', 't5']],
                ['S07', ['t4', 't5', 't6']],
                ['S08', ['t3', 't4']]
            ] as Array<[string, string[]]>) {
                const conversation = await runOf(id)
                for (const turnId of turnIds) {
                    for (const call of conversation.turn(turnId).modelCalls) {
                        const messages = conversationMessages(call)
                        messages.forEach((message, i) => {
                            if (message.role !== 'assistant') return
                            if (!message.content.trim()) problems.push(`${id} ${turnId} ${call.route}: blank assistant message at ${i}`)
                            if (messages[i - 1]?.role === 'assistant')
                                problems.push(`${id} ${turnId} ${call.route}: assistant after assistant at ${i}`)
                        })
                    }
                }
            }
            expect(problems).toEqual([])
        })
    })

    describe('F08 pending action outside history', () => {
        test('F08 no history message carries an action while a turn is stopped', async () => {
            for (const [id, turnId] of [
                ['S06', 't1'],
                ['S07', 't2'],
                ['S08', 't1']
            ]) {
                const turn = (await runOf(id)).turn(turnId)
                expect(turn.status).toBe('STOPPED')
                expect(tokenHistory(turn.decoded!.state).filter((message: any) => message.action)).toEqual([])
            }
        })
    })

    describe('F09 resume chains', () => {
        test.failing('F09 a chain of stops and resumes does not copy earlier records into the token', async () => {
            const historyBytes = (turn: TurnResult) => Buffer.byteLength(JSON.stringify(tokenHistory(turn.decoded!.state)))
            const growth: string[] = []
            for (const [id, from, to] of [
                ['S06', 't1', 't2'],
                ['S06', 't2', 't3'],
                ['S08', 't2', 't3']
            ]) {
                const conversation = await runOf(id)
                const a = conversation.turn(from)
                const b = conversation.turn(to)
                const extra = b.decoded!.sizes.rawJsonBytes - a.decoded!.sizes.rawJsonBytes - (historyBytes(b) - historyBytes(a))
                if (extra > 8 * 1024) growth.push(`${id} ${from}->${to}: ${extra} bytes beyond the added history`)
            }
            expect(growth).toEqual([])
        })
    })

    describe('F10 Execute Flow child tokens (TS16)', () => {
        test.failing('F10 the child flow sees its own earlier messages and state on the next turn (S12)', async () => {
            const conversation = await runOf('S12')
            expect(conversationOf(conversation.turn('t2'), 'S12-specialist')).toEqual([
                { role: 'user', content: 'I want to return a pair of boots.' },
                { role: 'assistant', content: 'Boots can be returned within 30 days if they are unworn.' },
                { role: 'user', content: 'They were worn once, is that a problem?' }
            ])
            expect(conversation.turns.map((t) => t.finalState?.child_count)).toEqual(['1', '2', '3', '4'])
        })
    })

    describe('F11 ephemeral memory dropped (TS17)', () => {
        test.failing('F11 a saved Ephemeral Memory option changes nothing: the memory-on agent sees earlier turns (S10b)', async () => {
            const conversation = await runOf('S10b')
            expect(conversationOf(conversation.turn('t2'), 'S10b-agent')).toEqual([
                { role: 'user', content: 'Remember that my favourite colour is green.' },
                { role: 'assistant', content: conversation.turn('t1').text },
                { role: 'user', content: 'What is my favourite colour?' }
            ])
            expect(conversation.turns.map((t) => tokenHistory(t.decoded!.state).length)).toEqual([2, 4, 6])
            expect(conversation.turns.map((t) => t.finalState?.counter)).toEqual(['1', '2', '3'])
        })
    })

    describe('F12 iteration', () => {
        test('F12 iteration items reuse the decoded token: one decode per turn and no parent execution lookup (S09)', async () => {
            const conversation = await startConversation({ scenario: 'S09' })
            await conversation.run('t1')
            const decode = jest.spyOn(trustedStateHelper, 'trusted_state_from_string')
            try {
                const t2 = await conversation.run('t2')
                expect(t2.status).toBe('FINISHED')
                expect(decode).toHaveBeenCalledTimes(1)
                expect(t2.reads.filter((read) => read.entity === 'Execution' && !read.allowed)).toEqual([])
                expect(t2.logs.filter((entry) => /Parent execution ID .* not found/.test(entry.message))).toEqual([])
            } finally {
                decode.mockRestore()
            }
        })
    })

    describe('F13 token contents', () => {
        test('F13 the token of a finished turn holds no node records and no system prompt', async () => {
            const problems: string[] = []
            for (const [id] of SCENARIOS) {
                for (const turn of (await runOf(id)).turns) {
                    if (!turn.decoded || turn.status === 'STOPPED') continue
                    const sentinels = countSentinels(turn.decoded.json).total
                    const records = findNodeRecords(turn.decoded.state).length
                    if (sentinels || records) problems.push(`${id} ${turn.id}: ${sentinels} prompt sentinels, ${records} node records`)
                }
            }
            expect(problems).toEqual([])
        })
    })

    describe('F14 non-streaming responses', () => {
        test('F14 a non-streaming response carries a token that continues the conversation (S13)', async () => {
            const conversation = await runOf('S13')
            expect(conversation.turn('t1').tokenSource).toBe('json')
            expect(conversationOf(conversation.turn('t2'), 'S01-agent')).toEqual([
                { role: 'user', content: 'Hi, my order ORD-3003 is late.' },
                { role: 'assistant', content: conversation.turn('t1').text },
                { role: 'user', content: 'Which order did I mention?' }
            ])
        })
    })

    describe('F15 one path whatever the Client State settings (TS9)', () => {
        test('F15 with Client State off or only the request flag, the token continues the conversation like with Client State on', async () => {
            const turns = ['t1', 't2']
            const clientState = await runConversation({ scenario: 'S01', turns })
            const requestFlag = await runConversation({ scenario: 'S01', mode: 'M1-reqflag', turns, freshDataSourcePerTurn: true })
            const off = await runConversation({ scenario: 'S01', mode: 'M3', turns, freshDataSourcePerTurn: true })
            const expected = comparableRequests(clientState.turn('t2').modelCalls)
            expect(comparableRequests(requestFlag.turn('t2').modelCalls)).toEqual(expected)
            expect(comparableRequests(off.turn('t2').modelCalls)).toEqual(expected)
        })
    })

    describe('F16 recording env flags', () => {
        test('F16 DISABLE_*_RECORDING change only what is written: history comes from the token with and without them', async () => {
            const turns = ['t1', 't2']
            const withFlags = await runConversation({ scenario: 'S01', mode: 'M3-envflags', turns, freshDataSourcePerTurn: true })
            const withoutFlags = await runConversation({ scenario: 'S01', mode: 'M3', turns, freshDataSourcePerTurn: true })
            expect(withFlags.turns.map((t) => t.db.newChatMessages + t.db.newExecutions)).toEqual([0, 0])
            expect(withoutFlags.turns.map((t) => t.db.newChatMessages > 0 && t.db.newExecutions > 0)).toEqual([true, true])
            expect(comparableRequests(withoutFlags.turn('t2').modelCalls)).toEqual(comparableRequests(withFlags.turn('t2').modelCalls))
        })
    })

    describe('F17 internal chat reload', () => {
        test.todo(
            'F17 the internal chat keeps the token across a page reload (UI only, decided in Task 09; not testable in the server suite)'
        )
    })

    describe('F18 executed data for external clients (TS18)', () => {
        test.failing('F18 external clients get records pruned to status, state, error and the slim action, over SSE and JSON', async () => {
            const streamed = await runOf('S07')
            const json = await runOf('S13')
            const payloads = [...streamed.turns.map((t) => t.executedData), json.turn('t1').result?.agentFlowExecutedData]
            for (const records of payloads) {
                expect(countSentinels(records).total).toBe(0)
                for (const record of records ?? []) {
                    expect(
                        Object.keys(record).filter((key) => !['nodeId', 'nodeLabel', 'status', 'previousNodeIds', 'data'].includes(key))
                    ).toEqual([])
                    expect(
                        Object.keys(record.data ?? {}).filter((key) => !['name', 'state', 'error', 'output', 'action'].includes(key))
                    ).toEqual([])
                    expect(Object.keys(record.data?.output ?? {}).filter((key) => key !== 'humanInputAction')).toEqual([])
                }
            }
        })
    })

    describe('F19 slim action (TS20)', () => {
        test.failing(
            'F19 the action event carries only id, mapping, elements, data.nodeId, data.nodeLabel and the feedback flag',
            async () => {
                for (const [id, turnId] of [
                    ['S06', 't1'],
                    ['S07', 't2'],
                    ['S08', 't1']
                ]) {
                    const action = (await runOf(id)).turn(turnId).action
                    expect(Object.keys(action).filter((key) => !['id', 'mapping', 'elements', 'data'].includes(key))).toEqual([])
                    expect(Object.keys(action.data).filter((key) => !['nodeId', 'nodeLabel', 'input'].includes(key))).toEqual([])
                    expect(Object.keys(action.data.input ?? {}).filter((key) => key !== 'humanInputEnableFeedback')).toEqual([])
                    expect(countSentinels(action).total).toBe(0)
                }
                expect((await runOf('S06')).turn('t1').action.data.input.humanInputEnableFeedback).toBe(true)
            }
        )
    })
})
