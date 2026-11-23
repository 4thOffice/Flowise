jest.mock('axios', () => jest.fn())
import axios from 'axios'
const { nodeClass: ExecuteFlow_Agentflow } = require('./ExecuteFlow')

const post = axios as unknown as jest.Mock

const childResponse = (fields: Record<string, any> = {}) => ({
    text: 'Boots can be returned within 30 days.',
    chatId: 'chat-1',
    agentFlowExecutedData: [{ nodeId: 'agentAgentflow_0', data: { state: { child_count: '2' } } }],
    trustedState: 'child-token-2',
    ...fields
})

const run = async ({
    inputs = {},
    childFlowToken,
    response = childResponse()
}: {
    inputs?: Record<string, any>
    childFlowToken?: { flowId: string; token: string }
    response?: any
} = {}) => {
    post.mockReset()
    post.mockResolvedValue({ data: response })
    const result = await new ExecuteFlow_Agentflow().run(
        {
            id: 'executeFlowAgentflow_0',
            label: 'Ask Specialist',
            inputs: {
                executeFlowSelectedFlow: 'child-flow',
                executeFlowInput: 'I want to return a pair of boots.',
                executeFlowMergeState: [{ variable: 'child_count' }],
                ...inputs
            }
        },
        '',
        {
            baseURL: 'http://flowise.test',
            chatflowid: 'parent-flow',
            chatId: 'chat-1',
            agentflowRuntime: { state: { child_count: '0' }, chatHistory: [{ role: 'user', content: 'Hi' }] },
            overrideConfig: { vars: { region: 'EU' } },
            ...(childFlowToken ? { childFlowToken } : {})
        }
    )
    return { result, request: post.mock.calls[0][0] }
}

describe('Execute Flow node (TS16, TS25)', () => {
    it('offers Assistant Message as the default and no User Message', () => {
        const node = new ExecuteFlow_Agentflow()
        const returnResponseAs = node.inputs.find((input: any) => input.name === 'executeFlowReturnResponseAs')
        expect(node.version).toBe(1.3)
        expect(returnResponseAs.options.map((option: any) => option.name)).toEqual(['assistantMessage', 'ignore'])
        expect(returnResponseAs.default).toBe('assistantMessage')
    })

    it('sends the stored child token only when it belongs to the selected flow, with the request otherwise unchanged', async () => {
        const fields = { question: 'I want to return a pair of boots.', chatId: 'chat-1', overrideConfig: { vars: { region: 'EU' } } }
        const own = await run({ childFlowToken: { flowId: 'child-flow', token: 'child-token-1' } })
        expect(own.request.url).toBe('http://flowise.test/api/v1/prediction/child-flow')
        expect(own.request.data).toEqual({ ...fields, trustedState: 'child-token-1' })
        expect((await run({ childFlowToken: { flowId: 'earlier-flow', token: 'earlier-token' } })).request.data).toEqual(fields)
        expect((await run()).request.data).toEqual(fields)
    })

    it("returns the child's token for the server to keep, and none when the response has none", async () => {
        const { result } = await run({ childFlowToken: { flowId: 'earlier-flow', token: 'earlier-token' } })
        expect(result.childFlowToken).toEqual({ flowId: 'child-flow', token: 'child-token-2' })
        expect(result.state).toEqual({ child_count: '2' })
        expect((await run({ response: childResponse({ trustedState: undefined }) })).result).not.toHaveProperty('childFlowToken')
    })

    it('leaves the token out of the whole-JSON fallback text', async () => {
        const { trustedState, ...rest } = childResponse({ text: undefined })
        const { result } = await run({ response: { ...rest, trustedState } })
        expect(result.output.content).toBe(JSON.stringify(rest, null, 2))
        expect(result.childFlowToken).toEqual({ flowId: 'child-flow', token: 'child-token-2' })
    })

    it('appends the reply as an assistant message, a stored User Message included, unless set to ignore', async () => {
        const reply = { role: 'assistant', content: 'Boots can be returned within 30 days.', name: 'ask_specialist' }
        for (const returnResponseAs of [undefined, 'assistantMessage', 'userMessage']) {
            expect((await run({ inputs: { executeFlowReturnResponseAs: returnResponseAs } })).result.chatHistory).toEqual([reply])
        }
        expect((await run({ inputs: { executeFlowReturnResponseAs: 'ignore' } })).result.chatHistory).toEqual([])
    })
})
