import fs from 'fs'
import path from 'path'
import { get, isEqual, omit } from 'lodash'
import * as trustedStateHelper from '../../../../src/utils/trustedStateHelper'
import { EXPECTED_TOKEN_CONTENTS, EXPECTED_TURN_FACTS } from './characterization.expected'
import {
    ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG,
    BASELINES_DIR,
    BeforeTurn,
    Conversation,
    HarnessMode,
    ScenarioScript,
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
    flowIdFor,
    historyRolesCompact,
    loadBeforeTrace,
    loadHarnessScenario,
    loadScenario,
    normalizeValue,
    runConversation,
    startConversation,
    tokenHistory,
    tokenSize,
    turnFacts,
    userFacingAction,
    withReplyOverrides,
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

// The S10a after-variant with "Accept conversation history from the client" on (TS13a); off is the flow as saved
const ACCEPT_ON = 'accept-client-history-on'

function runOf(id: string, mode: HarnessMode = 'M1', variant?: typeof ACCEPT_ON): Promise<Conversation> {
    const key = `${mode}/${id}${variant ? `@${variant}` : ''}`
    if (!runs.has(key)) {
        runs.set(key, runConversation({ scenario: id, mode, ...(variant ? { chatbotConfig: ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG } : {}) }))
    }
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

type Aspect = 'requests' | keyof ReturnType<typeof observedFacts>
const ASPECTS: Aspect[] = ['requests', 'status', 'text', 'nodes', 'state', 'action', 'history']

interface IntendedDifference {
    finding: string
    aspects: Aspect[]
    // The requests the turn must send instead, derived from the captured ones; compared like an aspect that must match
    requests?: (before: ReturnType<typeof comparableRequests>) => ReturnType<typeof comparableRequests>
}

const intended = (finding: string, aspects: Aspect[], ...keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, { finding, aspects }]))

// F05 with TS15: DB mode saved an answer without feedback as " "; the button label replaces it
const buttonAnswers = (label: string) => (before: ReturnType<typeof comparableRequests>) =>
    Object.fromEntries(
        Object.entries(before).map(([route, calls]) => [
            route,
            calls.map((call: any) => ({
                ...call,
                messages: call.messages.map((m: any) => (m.role === 'user' && m.content === ' ' ? { ...m, content: label } : m))
            }))
        ])
    )

// Stop and resume turns of S06, S06b, S07 and S08 (Task 07): aspects that differ from traces/before/ in the token modes
const APPROVAL_DIFFERENCES: Record<string, Aspect[]> = {
    'S06/t1': ['action'],
    'S06/t2': ['action', 'history'],
    'S06/t3': ['requests', 'history'],
    'S06/t4': ['requests', 'action', 'history'],
    'S06/t5': ['requests', 'history'],
    'S06b/t1': ['action', 'history'],
    'S06b/t2': ['action', 'history'],
    'S06b/t3': ['requests', 'history'],
    'S06b/t4': ['requests', 'action', 'history'],
    'S07/t3': ['history'],
    'S07/t4': ['requests', 'history'],
    'S07/t5': ['requests', 'history'],
    'S07/t6': ['requests', 'history'],
    'S08/t2': ['action', 'history'],
    'S08/t3': ['requests', 'history'],
    'S08/t4': ['requests', 'action', 'history']
}

// TS25: the captured requests carry a same-turn reply as a user message named after its node
const sameTurnRepliesAsAssistant = (before: ReturnType<typeof comparableRequests>) =>
    Object.fromEntries(
        Object.entries(before).map(([route, calls]) => [
            route,
            calls.map((call: any) => ({
                ...call,
                messages: call.messages.map((m: any) => (m.role === 'user' && m.name ? { ...m, role: 'assistant' } : m))
            }))
        ])
    )

describe('before/ traces', () => {
    // Intended differences from traces/before/, by "<mode>/<scenario>[@variant]/<turn>": the finding whose fix causes them, the
    // aspects that may differ, or the requests the turn must send instead. Everything else must match, and every listed turn differs.
    const INTENDED_DIFFERENCES: Record<string, IntendedDifference> = {
        // The JSON response carries the token, so S13 has a token history and continues the conversation
        ...intended('F14', ASPECTS, 'M1/S13/t1', 'M1/S13/t2', 'M1/S13/t3'),
        // Answers are user messages and the action has no `extra`: DB mode saved the answers already, with " " for a button
        ...intended('F06', ['action'], 'M3/S06/t1', 'M3/S06/t2'),
        'M3/S06/t4': { finding: 'F05, F06', aspects: ['action'], requests: buttonAnswers('Approve') },
        'M3/S06/t5': { finding: 'F05', aspects: [], requests: buttonAnswers('Approve') },
        ...Object.fromEntries(
            ['t4', 't5', 't6'].map((t) => [`M3/S07/${t}`, { finding: 'F05', aspects: [], requests: buttonAnswers('Proceed') }])
        ),
        // Answers are user messages, the toggle-off exchange leaves no trace, a blank stop saves the waiting node's prompt, and
        // the action has no `extra`; later turns send the answers to the model
        ...Object.fromEntries(
            (['M1', 'M2', 'M1-internal'] as HarnessMode[]).flatMap((mode) =>
                Object.entries(APPROVAL_DIFFERENCES)
                    .filter(([key]) => mode !== 'M2' || !key.startsWith('S06b/'))
                    .filter(([key]) => mode !== 'M1-internal' || key.startsWith('S07/'))
                    .map(([key, aspects]) => [`${mode}/${key}`, { finding: 'F05-F07, F06', aspects }])
            )
        ),
        // The child flow continues from the token the parent keeps for it, as it continued from the database in M3 (unchanged there)
        ...intended('F10', ['requests', 'text', 'state'], 'M1/S12/t2', 'M1/S12/t3', 'M1/S12/t4'),
        // The request history is ignored while "Accept conversation history from the client" is off, and no node prepends it
        ...intended('F02', ['requests'], 'M1/S10a/t1', 'M1/S10a/t2', 'M1/S10a/t3', 'M1/S10a/t4'),
        // With the setting on, the request history is the turn history and the token keeps it, welcome message included
        ...intended('F02', ['requests', 'history'], ...['t1', 't2', 't3', 't4'].map((t) => `M1/S10a@${ACCEPT_ON}/${t}`)),
        // State always carries over, so S04b routes as S04a does
        ...intended('F03', ['requests', 'text', 'nodes', 'state'], 'M1/S04b/t2', 'M1/S04b/t3', 'M1/S04b/t4'),
        // The t3 form replaces the carried form values
        ...intended('F04', ['requests'], 'M1/S05/t4', 'M3/S05/t4'),
        // The saved Ephemeral Memory option is ignored: the agent sees earlier turns and the token keeps them
        ...intended('F11', ['requests', 'history'], 'M1/S10b/t2', 'M1/S10b/t3'),
        // Same-turn replies reach later nodes as assistant messages
        ...Object.fromEntries(
            ['M1/S03/t1', 'M1/S03/t2', 'M1/S03/t3', 'M1/S03/t4', 'M1/S09/t1', 'M1/S09/t3'].map((key) => [
                key,
                { finding: 'TS25', aspects: [], requests: sameTurnRepliesAsAssistant }
            ])
        )
    }

    const compareWithBefore = (conversation: Conversation, mode: HarnessMode, id: string, variant?: string) => {
        const trace = loadBeforeTrace(mode, loadScenario(id).slug)
        expect(conversation.turns.map((t) => t.id)).toEqual(trace.turns.map((t) => t.id))
        for (const turn of conversation.turns) {
            const before = trace.turns.find((t) => t.id === turn.id) as BeforeTurn
            const expected = {
                requests: comparableRequests(withoutRetries(before.modelRequests)),
                ...observedFacts(before, before.token?.sizes?.historyRoles ?? null)
            }
            const actual = {
                requests: comparableRequests(turn.modelCalls),
                ...observedFacts(turn, turn.tokenSummary?.historyRoles ?? null)
            }
            const difference = INTENDED_DIFFERENCES[`${mode}/${id}${variant ? `@${variant}` : ''}/${turn.id}`]
            const aspects = difference?.aspects ?? []
            const target = difference?.requests ? { ...expected, requests: difference.requests(expected.requests) } : expected
            expect({ turn: turn.id, ...omit(actual, aspects) }).toEqual({ turn: turn.id, ...omit(target, aspects) })
            if (difference) {
                const differs = isEqual(target.requests, expected.requests)
                    ? aspects.some((aspect) => !isEqual(actual[aspect], expected[aspect]))
                    : true
                expect({ turn: turn.id, differs }).toEqual({ turn: turn.id, differs: true })
            }
        }
    }

    test.each(BEFORE_CASES)('%s %s matches the captured model requests and responses', async (mode, id) => {
        compareWithBefore(await runOf(id, mode), mode, id)
    })

    test(`M1 S10a@${ACCEPT_ON} matches the captured model requests and responses`, async () => {
        compareWithBefore(await runOf('S10a', 'M1', ACCEPT_ON), 'M1', 'S10a', ACCEPT_ON)
    })
})

/*
 * The checks of the baselines/compare.config.json entries whose findings are fixed, run on the harness turns (Task 10
 * runs all of them on captured after/ traces). Same semantics as compare-traces.mjs for the check types used here.
 */
describe('compare.config.json checks', () => {
    const config = JSON.parse(fs.readFileSync(path.join(BASELINES_DIR, 'compare.config.json'), 'utf8'))
    const CHECKED_ENTRIES = [
        'F02-S10a-accept-on',
        'F02-S10a-accept-off',
        'F03-S04b-state-carries',
        'F04-S05-new-form-wins',
        'F05-S06-answers-in-history',
        'F05-S07-answers-in-history',
        'F05-S08-answers-in-history',
        'F06-S06b-toggle-off',
        'F07-alternating-history',
        'F07-S08-blank-stop-message',
        'F08-no-action-in-history',
        'F09-no-record-copies',
        'F10-S12-child-token',
        'F11-S10b-ephemeral-dropped',
        'F13-tool-approval-pending',
        'F18-executed-data-external',
        'F18-executed-data-internal',
        'F19-slim-action',
        'TS25-S03-composer',
        'TS25-S09-aggregator',
        'TS26-pending-only-while-stopped'
    ]
    // '*' means the scenarios or modes with a before/ trace
    const scenariosOf = (entry: any): string[] => (entry.scenarios === '*' ? SCENARIOS.map(([id]) => id) : entry.scenarios)
    const modesOf = (entry: any, scenario: string): HarnessMode[] =>
        entry.modes === '*' || entry.scenarios === '*'
            ? (entry.modes === '*' ? BEFORE_MODES : (entry.modes as HarnessMode[])).filter((mode) =>
                  beforeTraceExists(mode, loadScenario(scenario).slug)
              )
            : entry.modes

    const turnMatches = (spec: string | string[] | undefined, turnId: string, turnIds: string[]) =>
        !spec ||
        spec === '*' ||
        (Array.isArray(spec) ? spec : [spec]).some((item) =>
            item.endsWith('+') ? turnIds.indexOf(turnId) >= turnIds.indexOf(item.slice(0, -1)) : item === turnId
        )

    const passes = (check: any, turn: TurnResult, beforeTurn?: BeforeTurn): boolean => {
        const history = () => (turn.decoded ? tokenHistory(turn.decoded.state) : null)
        switch (check.type) {
            case 'modelInputIncludes':
            case 'modelInputExcludes': {
                const calls = turn.modelCalls.filter(
                    (call) => (!check.route || call.route === check.route) && (check.call === undefined || call.callIndex === check.call)
                )
                const found = calls.some((call) =>
                    (call.body?.messages ?? []).some(
                        (m: any) =>
                            (!check.role || m.role === check.role) &&
                            (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(check.contentIncludes)
                    )
                )
                return check.type === 'modelInputIncludes' ? found : calls.length > 0 && !found
            }
            case 'serverLogIncludes':
                return turn.logs.some((entry) => new RegExp(check.pattern).test(entry.message))
            case 'tokenHistoryRoles':
                return isEqual(history()?.map((m: any) => m.role) ?? null, check.equals)
            case 'tokenHistoryHasNoKey':
                return Boolean(history()?.every((m: any) => !(check.key in m)))
            case 'tokenHistoryAlternates':
                return Boolean(
                    history()?.every(
                        (m: any, i: number) =>
                            m.role === (i % 2 === 0 ? 'userMessage' : 'apiMessage') &&
                            typeof m.content === 'string' &&
                            m.content.trim() !== ''
                    )
                )
            case 'tokenPendingWhileStopped':
                return Boolean(turn.decoded) && (turn.decoded!.state.pendingResume != null) === (turn.status === 'STOPPED')
            case 'tokenHasNoKey':
                return !JSON.stringify(turn.decoded?.state ?? {}).includes(`"${check.key}"`)
            case 'tokenSentinelMax':
                return (turn.sentinels.token ?? 0) <= check.max
            case 'tokenBytesRatioToBeforeMax': {
                const before = beforeTurn?.token?.sizes?.rawJsonBytes ?? 0
                return before > 0 && (turn.decoded?.sizes.rawJsonBytes ?? 0) <= before * check.max
            }
            case 'payloadSentinelMax':
                return (turn.sentinels[check.payload] ?? 0) <= check.max
            case 'payloadSentinelMin':
                return (turn.sentinels[check.payload] ?? 0) >= check.min
            case 'actionKeysOnly': {
                if (!turn.action) return false
                const flatten = (value: any, prefix = ''): string[] =>
                    value &&
                    typeof value === 'object' &&
                    !Array.isArray(value) &&
                    !['mapping', 'elements'].includes(prefix.split('.').pop()!)
                        ? Object.entries(value).flatMap(([key, inner]) => flatten(inner, prefix ? `${prefix}.${key}` : key))
                        : [prefix]
                return flatten(turn.action).every((key) => check.allowed.includes(key))
            }
            case 'finalStateEquals':
                return isEqual(get(turn.finalState ?? {}, check.key), check.value)
            case 'textIncludes':
                return String(turn.text ?? '').includes(check.value)
            default:
                throw new Error(`Check type ${check.type} is not evaluated on harness turns`)
        }
    }

    test.each(CHECKED_ENTRIES)('%s', async (entryId) => {
        const entry = config.intended.find((e: any) => e.id === entryId)
        expect(entry?.variant === undefined || entry.variant === ACCEPT_ON || entry.variant === 'accept-client-history-off').toBe(true)
        const failed: string[] = []
        let evaluated = 0
        for (const scenario of scenariosOf(entry)) {
            for (const mode of modesOf(entry, scenario)) {
                const conversation = await runOf(scenario, mode, entry.variant === ACCEPT_ON ? ACCEPT_ON : undefined)
                const turnIds = conversation.turns.map((t) => t.id)
                const before = beforeTraceExists(mode, loadScenario(scenario).slug)
                    ? loadBeforeTrace(mode, loadScenario(scenario).slug)
                    : null
                for (const check of entry.checks) {
                    for (const turn of conversation.turns) {
                        if (!turnMatches(check.turns ?? entry.turns, turn.id, turnIds)) continue
                        evaluated += 1
                        const beforeTurn = before?.turns.find((t) => t.id === turn.id)
                        if (!passes(check, turn, beforeTurn))
                            failed.push(`${mode}/${scenario}/${turn.id} ${JSON.stringify(omit(check, ['note']))}`)
                    }
                }
            }
        }
        expect(evaluated).toBeGreaterThan(0)
        expect(failed).toEqual([])
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
    const TOKEN_ONLY_SCENARIOS = ['S01', 'S01r', 'S02', 'S03', 'S04a', 'S04b', 'S05', 'S09', 'S10a', 'S10b', 'S11', 'S12', 'S13']

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
        expect(decodeToken(resumed.token!).state.pendingResume.executionId).toBe(resumed.db.executions[0].id)
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

describe('human input stop and resume (Task 07)', () => {
    // Child flow tokens are encrypted inside the parent token (08 §4.2)
    const tokenSentinels = (state: any): number =>
        countSentinels(state).total +
        Object.values(state.childFlowTokens ?? {}).reduce(
            (sum: number, child: any) => sum + tokenSentinels(decodeToken(child.token).state),
            0
        )

    const recordsOf = async (rows: any[]) =>
        Promise.all(rows.map(async (row) => (await executionRecords(row)).map((record) => `${record.nodeId}:${record.status}`)))

    test('a paused token holds one skeleton entry per node run and no system prompt; other turns hold no pending data', async () => {
        const problems: string[] = []
        for (const id of ['S06', 'S06b', 'S07', 'S08']) {
            for (const mode of ['M1', 'M2', 'M3'] as HarnessMode[]) {
                const conversation = await runOf(id, mode)
                const rowIds = conversation.turns[conversation.turns.length - 1].db.executions.map((row) => row.id)
                for (const turn of conversation.turns) {
                    const state = turn.decoded!.state
                    const label = `${mode}/${id}/${turn.id}`
                    if (tokenSentinels(state)) problems.push(`${label}: prompt sentinels`)
                    if (turn.status !== 'STOPPED') {
                        if (state.pendingResume) problems.push(`${label}: pending data after ${turn.status}`)
                        continue
                    }
                    const { nodes, executionId, stopMessageId } = state.pendingResume
                    const skeleton = nodes.map((entry: any) => `${entry.nodeId}:${entry.status}`)
                    if (!isEqual(skeleton, turn.nodeSequence))
                        problems.push(`${label}: skeleton ${skeleton} for records ${turn.nodeSequence}`)
                    // Recorded rows only: M2 and M3 record executions, M3 chat messages
                    if (mode !== 'M1' && !rowIds.includes(executionId)) problems.push(`${label}: execution ${executionId}`)
                    if (mode === 'M1' && executionId) problems.push(`${label}: execution id without a recorded execution`)
                    if ((mode === 'M3') !== Boolean(stopMessageId)) problems.push(`${label}: stop message id ${stopMessageId}`)
                }
            }
        }
        expect(problems).toEqual([])
    })

    test('a child flow paused for human input keeps its pending data, without prompts, inside the parent token', async () => {
        const s12 = loadHarnessScenario('S12')
        const s06 = loadHarnessScenario('S06')
        const script: ScenarioScript = {
            ...s12,
            extraFlows: [s06.flow],
            llm: { ...s12.llm, rules: [...s12.llm.rules, ...s06.llm.rules] },
            turns: [s12.turns[0]]
        }
        const conversation = new Conversation({ scenario: script })
        const parent = conversation.chatflows[script.flow]
        parent.flowData = parent.flowData.replace(flowIdFor('S12-child-flow'), flowIdFor(s06.flow))
        const [turn] = await conversation.runAll()
        expect(turn.status).toBe('FINISHED')
        const child = decodeToken(turn.decoded!.state.childFlowTokens.executeFlowAgentflow_0.token).state
        expect(child.pendingResume.nodes.map((entry: any) => `${entry.nodeId}:${entry.status}`)).toContain('humanInputAgentflow_0:STOPPED')
        expect(tokenSentinels(turn.decoded!.state)).toBe(0)
    })

    test('D6 a failed resume returns the incoming token unchanged, and answering again retries the resume', async () => {
        const s07 = loadHarnessScenario('S07')
        const failing: ScenarioScript = {
            ...s07,
            llm: {
                ...s07.llm,
                rules: [
                    {
                        id: 'resume-fails',
                        route: 'S07-agent',
                        turn: 't3-failed',
                        reply: { error: { status: 500, message: 'Injected fake LLM failure' } }
                    },
                    ...s07.llm.rules
                ]
            }
        }
        const conversation = await runConversation({ scenario: failing, turns: ['t1', 't2'] })
        const failed = await conversation.run({ id: 't3-failed', humanInput: { type: 'proceed' } })
        expect(failed.status).toBe('ERROR')
        expect(failed.token).toBe(failed.tokenSent)
        const retried = await conversation.run('t3')
        const native = (await runOf('S07')).turn('t3')
        expect([retried.status, retried.text]).toEqual([native.status, native.text])
        expect(comparableRequests(retried.modelCalls)).toEqual(comparableRequests(native.modelCalls))
        expect(tokenHistory(retried.decoded!.state)).toEqual(tokenHistory(native.decoded!.state))
    })

    test('D9 a resume that ends stopped without output saves the waiting gate prompt as its bot message (S08 t2)', async () => {
        const conversation = await runOf('S08')
        // External clients get no node output (TS18); the internal chat shows the prompt the gate announced
        const internal = await runOf('S08', 'M1-internal')
        const gate = internal.turn('t1').executedData!.find((record) => record.nodeId === 'humanInputAgentflow_0')
        expect(conversation.turn('t2').text).toBe('')
        expect(tokenHistory(conversation.turn('t2').decoded!.state).slice(2)).toEqual([
            { role: 'userMessage', content: 'Proceed' },
            { role: 'apiMessage', content: gate.data.output.content }
        ])
    })

    test('D10 a resume continues the paused run row, which ends with the records of before/ (M2)', async () => {
        for (const id of ['S06', 'S07', 'S08']) {
            const conversation = await runOf(id, 'M2')
            const slug = loadScenario(id).slug
            const trace = loadBeforeTrace('M2', slug)
            const beforeRows = (trace.turns[trace.turns.length - 1] as any).db[slug].executions.map((row: any) =>
                JSON.parse(row.executionDataFromBlob).map((record: any) => `${record.nodeId}:${record.status}`)
            )
            expect({ id, rows: await recordsOf(conversation.turns[conversation.turns.length - 1].db.executions) }).toEqual({
                id,
                rows: beforeRows
            })
            expect(conversation.dataSource.reads.filter((read) => !read.allowed)).toEqual([])
        }
    })

    test('D11 the answered stop message keeps no action, and with the history toggle off it is deleted (M3)', async () => {
        const rows = (turn: TurnResult) => turn.db.chatMessages.map((m) => [m.role, m.content, Boolean(m.action)])
        const historyRows = (turn: TurnResult) =>
            tokenHistory(turn.decoded!.state).map((m: any, i: number, all: any[]) => [
                m.role,
                m.content,
                turn.status === 'STOPPED' && i === all.length - 1
            ])

        const s06 = await runOf('S06', 'M3')
        for (const turn of s06.turns) expect({ turn: turn.id, rows: rows(turn) }).toEqual({ turn: turn.id, rows: historyRows(turn) })

        const s06b = await runConversation({ scenario: 'S06b', mode: 'M3' })
        const question = s06b.turn('t1').request.question
        const stop = (turnId: string) => ['apiMessage', s06b.turn(turnId).text, true]
        expect(s06b.turns.map((turn) => rows(turn))).toEqual([
            [['userMessage', question, false], stop('t1')],
            [['userMessage', question, false], stop('t2')],
            [
                ['userMessage', question, false],
                ['apiMessage', s06b.turn('t3').text, false]
            ],
            [
                ['userMessage', question, false],
                ['apiMessage', s06b.turn('t3').text, false],
                ['userMessage', s06b.turn('t4').request.question, false],
                stop('t4')
            ]
        ])
    })

    test('v1 tokens paused before the deploy resume, replaying a stored Agent prompt once (D4), and the conversation continues as in v2', async () => {
        for (const [id, pausedTurn] of [
            ['S06', 't1'],
            ['S07', 't2'],
            ['S08', 't1']
        ]) {
            const trace = loadBeforeTrace('M1', loadScenario(id).slug)
            const paused = trace.turns.find((t) => t.id === pausedTurn)!
            const native = await runOf(id)
            const conversation = await startConversation({ scenario: id })
            const turnIds = conversation.scenario.turns.map((t) => t.id)
            const [next, ...later] = turnIds.slice(turnIds.indexOf(pausedTurn) + 1)
            const spec = conversation.scenario.turns.find((t) => t.id === next)!
            const resumed = await conversation.run({
                ...spec,
                humanInput: { ...spec.humanInput!, startNodeId: paused.action.data.nodeId },
                token: encodeToken(paused.token.decoded)
            })
            const capturedResume = trace.turns.find((t) => t.id === next)!
            expect({ id, next, requests: comparableRequests(resumed.modelCalls) }).toEqual({
                id,
                next,
                requests: comparableRequests(withoutRetries(capturedResume.modelRequests))
            })
            expect([resumed.decoded!.state.version, tokenSentinels(resumed.decoded!.state)]).toEqual([2, 0])
            for (const turnId of later) {
                const turn = await conversation.run(turnId)
                expect({ id, turnId, text: turn.text, requests: comparableRequests(turn.modelCalls) }).toEqual({
                    id,
                    turnId,
                    text: native.turn(turnId).text,
                    requests: comparableRequests(native.turn(turnId).modelCalls)
                })
            }
        }
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
        const accepting = () => runOf('S10a', 'M1', ACCEPT_ON)

        test('F02 with "Accept conversation history from the client" on, a memory node sees the client history once', async () => {
            const conversation = await accepting()
            expect(conversationOf(conversation.turn('t2'), 'S10a-context')).toEqual([
                { role: 'assistant', content: S10A_WELCOME },
                { role: 'user', content: 'Do you ship to Norway?' },
                { role: 'assistant', content: conversation.turn('t1').text },
                { role: 'user', content: 'How much does shipping cost?' }
            ])
        })

        test('F02 the client history, welcome message included, is saved in the token with the turn appended', async () => {
            const conversation = await accepting()
            const history = tokenHistory(conversation.turn('t1').decoded!.state).map((m: any) => [m.role, m.content])
            expect(history).toEqual([
                ['apiMessage', S10A_WELCOME],
                ['userMessage', 'Do you ship to Norway?'],
                ['apiMessage', conversation.turn('t1').text]
            ])
        })

        test('F02 a memory-off first node sees no history, neither from the client nor from the token (TS22)', async () => {
            const conversation = await accepting()
            for (const turn of conversation.turns) {
                const question = turn.request.question
                expect(conversationOf(turn, 'S10a-quick')).toEqual([{ role: 'user', content: question }])
            }
        })

        test("F02 a warning is logged when the client history lacks the token's last message, and the turn continues (TS13)", async () => {
            const conversation = await accepting()
            const warnings = (turn: TurnResult) => turn.logs.filter((entry) => entry.level === 'warn')
            expect(warnings(conversation.turn('t2'))).toEqual([])
            expect(warnings(conversation.turn('t3')).length).toBeGreaterThan(0)
            expect(conversation.turn('t3').status).toBe('FINISHED')
        })

        test('F02 with the setting off, the client history is ignored with a warning (TS13a)', async () => {
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
        test('F03 flow state carries over with Persist State off, as it does with it on (S04b vs S04a)', async () => {
            const persistOff = await runOf('S04b')
            const persistOn = await runOf('S04a')
            expect(persistOff.turns.map((t) => t.finalState)).toEqual(persistOn.turns.map((t) => t.finalState))
            expect(persistOff.turns.map((t) => Object.keys(t.modelCallsByRoute))).toEqual(
                persistOn.turns.map((t) => Object.keys(t.modelCallsByRoute).map((route) => route.replace('S04a', 'S04b')))
            )
        })
    })

    describe('F04 form values (TS12)', () => {
        test('F04 a new form submission replaces the values the Start node and $form.* see (S05)', async () => {
            const conversation = await runOf('S05')
            // External clients get no node output (TS18)
            const internal = await runOf('S05', 'M1-internal')
            const startForm = (turn: TurnResult) =>
                turn.executedData?.find((record) => record.nodeId === 'startAgentflow_0')?.data?.output?.form
            expect(startForm(internal.turn('t3'))).toEqual({ name: 'Grace Hopper', topic: 'shipping' })
            for (const turnId of ['t3', 't4']) {
                const systemPrompt = conversation.turn(turnId).modelCallsByRoute['S05-assistant'][0].messages[0].content
                expect(systemPrompt).toContain('Customer name: Grace Hopper. Topic: shipping.')
            }
        })
    })

    describe('F05 approval answers in history (TS15)', () => {
        test('F05 HumanInput: the feedback, otherwise the button label, sits between the approval prompt and the reply (S06)', async () => {
            const conversation = await runOf('S06')
            const drafter = conversationOf(conversation.turn('t4'), 'S06-drafter')
            expect(messageBefore(drafter, conversation.turn('t2').text)).toEqual({
                role: 'user',
                content: 'Please mention the 10% discount code SORRY10.'
            })
            expect(messageBefore(drafter, conversation.turn('t3').text)).toEqual({ role: 'user', content: 'Approve' })
            const finalizer = conversationOf(conversation.turn('t5'), 'S06-finalizer')
            expect(finalizer[finalizer.length - 1]).toEqual({ role: 'user', content: 'Approved, send it.' })
        })

        test('F05 later turns send the history DB mode kept in before/ M3, with the button label for an answer without feedback', async () => {
            for (const [id, label, turnIds] of [
                ['S06', 'Approve', ['t2', 't3', 't4', 't5']],
                ['S07', 'Proceed', ['t3', 't4', 't5', 't6']]
            ] as Array<[string, string, string[]]>) {
                const conversation = await runOf(id)
                const dbMode = loadBeforeTrace('M3', loadScenario(id).slug)
                for (const turnId of turnIds) {
                    const before = dbMode.turns.find((t) => t.id === turnId)!
                    expect({ id, turnId, requests: comparableRequests(conversation.turn(turnId).modelCalls) }).toEqual({
                        id,
                        turnId,
                        requests: buttonAnswers(label)(comparableRequests(withoutRetries(before.modelRequests)))
                    })
                }
            }
        })

        test('F05 Agent tool approval: the button label or the feedback is the user message of the resume turn (S07)', async () => {
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

        test('F05 parallel stops: both answers reach the Summary and the next turn (S08)', async () => {
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
        test('F06 with the toggle off, neither the approval prompt nor the answer is in history, without state flags (S06b)', async () => {
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
        })
    })

    describe('F07 message order after resumes', () => {
        test('F07 no model input has two assistant messages in a row or a blank assistant message', async () => {
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
        test('F09 a chain of stops and resumes does not copy earlier records into the token', async () => {
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
        test('F10 the child flow sees its own earlier messages and state on the next turn (S12)', async () => {
            const conversation = await runOf('S12')
            expect(conversationOf(conversation.turn('t2'), 'S12-specialist')).toEqual([
                { role: 'user', content: 'I want to return a pair of boots.' },
                { role: 'assistant', content: 'Boots can be returned within 30 days if they are unworn.' },
                { role: 'user', content: 'They were worn once, is that a problem?' }
            ])
            expect(conversation.turns.map((t) => t.finalState?.child_count)).toEqual(['1', '2', '3', '4'])
        })

        test('F10 the conversation runs as it did when the child read its messages and state from the database (S12, M3 before/)', async () => {
            const trace = loadBeforeTrace('M3', loadScenario('S12').slug)
            for (const turn of (await runOf('S12')).turns) {
                const before = trace.turns.find((t) => t.id === turn.id) as BeforeTurn
                expect({
                    turn: turn.id,
                    requests: comparableRequests(turn.modelCalls),
                    ...observedFacts(turn, turn.tokenSummary?.historyRoles ?? null)
                }).toEqual({
                    turn: turn.id,
                    requests: comparableRequests(withoutRetries(before.modelRequests)),
                    ...observedFacts(before, before.token?.sizes?.historyRoles ?? null)
                })
            }
        })

        test("F10 the parent keeps the child's token by node id, sends it with the next call and stays within 10 % of the v1 token (S12)", async () => {
            for (const mode of ['M1', 'M3'] as HarnessMode[]) {
                const conversation = await runOf('S12', mode)
                const before = loadBeforeTrace(mode, loadScenario('S12').slug)
                conversation.turns.forEach((turn, i) => {
                    const [call] = turn.childCalls
                    const kept = turn.decoded!.state.childFlowTokens
                    expect(Object.keys(kept)).toEqual(['executeFlowAgentflow_0'])
                    expect(kept.executeFlowAgentflow_0).toEqual({ flowId: call.flowId, token: call.result?.trustedState })
                    expect(call.request.trustedState).toBe(
                        i ? conversation.turns[i - 1].decoded!.state.childFlowTokens.executeFlowAgentflow_0.token : undefined
                    )
                    const child = decodeToken(kept.executeFlowAgentflow_0.token)
                    expect(child.state.flowState).toEqual({ child_count: String(i + 1) })
                    expect(countSentinels(child.json).total).toBe(0)
                    expect(JSON.stringify(turn.executedData)).not.toContain(kept.executeFlowAgentflow_0.token)
                    const beforeBytes = before.turns.find((t) => t.id === turn.id)!.token!.sizes!.rawJsonBytes
                    expect(turn.decoded!.sizes.rawJsonBytes).toBeLessThanOrEqual(0.1 * beforeBytes)
                })
            }
        })

        test('F10 a failed child call fails the turn and keeps the earlier child token, which the next call continues from (S12)', async () => {
            const failing = withReplyOverrides(loadHarnessScenario('S12'), {
                'specialist-t2': { error: { status: 500, message: 'Injected fake LLM failure for the specialist' } }
            })
            const conversation = await runConversation({ scenario: failing })
            const kept = (turnId: string) => conversation.turn(turnId).decoded!.state.childFlowTokens.executeFlowAgentflow_0
            expect(conversation.turns.map((t) => t.status)).toEqual(['FINISHED', 'ERROR', 'FINISHED', 'FINISHED'])
            expect(kept('t2')).toEqual(kept('t1'))
            expect(conversation.turn('t3').childCalls[0].request.trustedState).toBe(kept('t1').token)
            expect(conversationOf(conversation.turn('t3'), 'S12-specialist')).toEqual([
                { role: 'user', content: 'I want to return a pair of boots.' },
                { role: 'assistant', content: 'Boots can be returned within 30 days if they are unworn.' },
                { role: 'user', content: 'What did I want to return again?' }
            ])
            expect(conversation.turn('t3').finalState).toEqual({ child_count: '2' })
        })
    })

    describe('F11 ephemeral memory dropped (TS17)', () => {
        test('F11 a saved Ephemeral Memory option changes nothing: the memory-on agent sees earlier turns (S10b)', async () => {
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
            'F17 the internal chat restores the token with its saved messages after a page reload (UI only: checked in the browser in Task 09)'
        )
    })

    describe('F18 executed data for external clients (TS18)', () => {
        test('F18 external clients get records pruned to status, state, error and the slim action, over SSE and JSON', async () => {
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

        test('F18 external records keep the order, node ids, statuses and state of the records, and the stopped record holds the announced action (S07)', async () => {
            const external = await runOf('S07')
            const internal = await runOf('S07', 'M1-internal')
            const kept = (records: any[]) =>
                records.map((r) => [r.nodeId, r.nodeLabel, r.status, r.previousNodeIds, normalizeValue(r.data?.state)])
            for (const turn of external.turns) {
                expect({ turn: turn.id, records: kept(turn.executedData!) }).toEqual({
                    turn: turn.id,
                    records: kept(internal.turn(turn.id).executedData!)
                })
                const stopped = turn.executedData!.filter((record) => record.status === 'STOPPED')
                expect({ turn: turn.id, actions: stopped.map((record) => record.data.output.humanInputAction) }).toEqual({
                    turn: turn.id,
                    actions: turn.action ? [turn.action] : []
                })
            }
        })

        test('F18, F19 a queue worker publishes only pruned executed data and the slim action, and its job result is pruned (S07)', async () => {
            const queued = await runConversation({ scenario: 'S07', queueMode: true })
            const direct = await runOf('S07')
            for (const turn of queued.turns) {
                const executedData = turn.events.filter((event) => event.event === 'agentFlowExecutedData').map((event) => event.data)
                const actions = turn.events.filter((event) => event.event === 'action').map((event) => event.data)
                expect(executedData.length).toBeGreaterThan(0)
                expect(countSentinels([executedData, actions, turn.result?.agentFlowExecutedData]).total).toBe(0)
                for (const record of [...executedData.flat(), ...(turn.result?.agentFlowExecutedData ?? [])]) {
                    expect(Object.keys(record.data).filter((key) => !['name', 'state', 'error', 'output'].includes(key))).toEqual([])
                }
                expect(turnFacts(turn)).toEqual(turnFacts(direct.turn(turn.id)))
            }
        })

        test('F18 the internal chat gets the records the run records, without credential ids (S01, S07; M2 recorded executions)', async () => {
            const withoutCredentialIds = (value: any): any =>
                Array.isArray(value)
                    ? value.map(withoutCredentialIds)
                    : value && typeof value === 'object'
                    ? Object.fromEntries(
                          Object.entries(value)
                              .filter(([key]) => key !== 'FLOWISE_CREDENTIAL_ID')
                              .map(([key, inner]) => [key, withoutCredentialIds(inner)])
                      )
                    : value
            for (const id of ['S01', 'S07']) {
                const internal = await runOf(id, 'M1-internal')
                const recorded = await runOf(id, 'M2')
                // A resume's recorded row continues the paused run's row (D10), while the turn's records start from the pending data
                for (const turn of internal.turns.filter((t) => !t.request.humanInput)) {
                    const recordedTurn = recorded.turn(turn.id)
                    const row = recordedTurn.db.executions.find((execution) => execution.id === recordedTurn.result?.executionId)
                    const records = await executionRecords(row)
                    expect(JSON.stringify(records)).toContain('FLOWISE_CREDENTIAL_ID')
                    expect({ id, turn: turn.id, records: normalizeValue(turn.executedData) }).toEqual({
                        id,
                        turn: turn.id,
                        records: normalizeValue(withoutCredentialIds(records))
                    })
                }
            }
        })
    })

    describe('F19 slim action (TS20)', () => {
        test('F19 the action event carries only id, mapping, elements, data.nodeId, data.nodeLabel and the feedback flag', async () => {
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
        })

        test('F19 a stopped Agent carried from a v1 token is announced again with the slim action; its stored prompt stays in the token only (S08, D4)', async () => {
            const paused = loadBeforeTrace('M1', loadScenario('S08').slug).turns.find((t) => t.id === 't1')!
            const conversation = await startConversation({ scenario: 'S08' })
            const gateFirst = await conversation.run({
                id: 't2',
                humanInput: { type: 'proceed', feedback: 'Approved by the store manager.', startNodeId: 'humanInputAgentflow_0' },
                token: encodeToken(paused.token.decoded)
            })
            expect([gateFirst.status, gateFirst.action?.data?.nodeId]).toEqual(['STOPPED', 'agentAgentflow_0'])
            expect(Object.keys(gateFirst.action).sort()).toEqual(['data', 'elements', 'id', 'mapping'])
            expect(Object.keys(gateFirst.action.data).sort()).toEqual(['nodeId', 'nodeLabel'])
            expect(countSentinels([gateFirst.action, gateFirst.executedData]).total).toBe(0)
            const carried = gateFirst.decoded!.state.pendingResume.nodes.find((entry: any) => entry.nodeId === 'agentAgentflow_0')
            expect(countSentinels(carried.legacyMessages).total).toBeGreaterThan(0)
        })
    })
})
