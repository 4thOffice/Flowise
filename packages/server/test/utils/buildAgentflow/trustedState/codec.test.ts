import logger from '../../../../src/utils/logger'
import {
    TRUSTED_STATE_VERSION,
    TrustedHistoryMessage,
    buildTrustedState,
    readTurnInput,
    toNodeMessage,
    writeToken
} from '../../../../src/utils/agentflow/trustedState'
import { decodeToken, encodeToken, loadBeforeTrace, loadScenario } from './harness'

/*
 * The v2 token codec of Task 05 (plans/agentflow-trusted-state, 04 §2.1-2.5): round trip, the turn input, and the upgrade
 * of v1 tokens captured in traces/before/.
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

describe('v2 token', () => {
    const history: TrustedHistoryMessage[] = [
        { role: 'userMessage', content: 'Here is a photo', fileUploads: [UPLOAD as any] },
        { role: 'apiMessage', content: 'Here is a chart', artifacts: [ARTIFACT] },
        { role: 'userMessage', content: 'Thanks' }
    ]

    test('round trip: the token the builder writes is the turn input of the next request', async () => {
        const pendingResume = { legacyExecution: { id: 'e1', state: 'STOPPED', executionData: '[]' } as any, actionMessageIndex: 1 }
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
                pendingResume: { legacyExecution: { id: 'e1', state: 'STOPPED', executionData: '[]' } as any }
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
            const actionIndex = v1.pastChatHistory.findIndex((message: any) => message.action)
            expect(actionIndex).toBe(v1.pastChatHistory.length - 1)
            expect(input.pendingResume).toEqual({ legacyExecution: v1.previousExecution, actionMessageIndex: actionIndex })
        } else {
            expect(input.pendingResume).toBeUndefined()
        }
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

    test('an error right after a stop stays resumable, other failed runs do not', async () => {
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
        expect(await pendingOf('ERROR', ['FINISHED', 'STOPPED', 'ERROR'])).toBeDefined()
        expect(await pendingOf('ERROR', ['FINISHED', 'ERROR'])).toBeUndefined()
        expect(await pendingOf('TERMINATED', ['STOPPED', 'TERMINATED'])).toBeUndefined()
        expect(await pendingOf('FINISHED', ['FINISHED'])).toBeUndefined()
    })
})
