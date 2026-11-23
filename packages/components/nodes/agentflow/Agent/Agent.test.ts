import fs from 'fs'
import os from 'os'
import path from 'path'
import { AIMessageChunk } from '@langchain/core/messages'
const { nodeClass: Agent_Agentflow } = require('./Agent')

const fakeModelPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-node-test-')), 'fakeChatModel.js')
fs.writeFileSync(fakeModelPath, `module.exports = { nodeClass: class { async init() { return global.__fakeAgentChatModel } } }`)

const prompts: any[][] = []
;(global as any).__fakeAgentChatModel = {
    invoke: async (messages: any[]) => {
        prompts.push(messages)
        return new AIMessageChunk('reply')
    }
}

const history = [
    { role: 'user', content: 'Živjo' },
    { role: 'assistant', content: 'Pozdravljeni, kako vam lahko pomagam?' }
]
const question = 'Kakšen je delovni čas?'
const systemMessage = { role: 'system', content: 'Knowledge base' }

const run = async ({
    agentMessages,
    enableMemory = false,
    historySource = 'token',
    returnResponseAs
}: {
    agentMessages: any[]
    enableMemory?: boolean
    historySource?: 'token' | 'client'
    returnResponseAs?: string
}) => {
    prompts.length = 0
    const warn = jest.fn()
    const result = await new Agent_Agentflow().run(
        {
            id: 'agentAgentflow_0',
            label: 'Agent 0',
            inputs: {
                agentModel: 'fakeModel',
                agentModelConfig: {},
                agentTools: [],
                agentKnowledgeDocumentStores: [],
                agentKnowledgeVSEmbeddings: [],
                agentEnableMemory: enableMemory,
                agentMemoryType: 'allMessages',
                agentMessages,
                agentReturnResponseAs: returnResponseAs
            }
        },
        question,
        {
            componentNodes: { fakeModel: { filePath: fakeModelPath, label: 'Fake' } },
            agentflowRuntime: { state: {}, chatHistory: [], form: {} },
            pastChatHistory: history,
            historySource,
            logger: { warn },
            chatId: 'chat',
            isLastNode: false
        }
    )
    return {
        prompt: prompts[0].map((m: any) => [m.role, m.content]),
        chatHistory: result.chatHistory.map((m: any) => [m.role, m.content]),
        warnings: warn.mock.calls.length
    }
}

describe('Agent node with an agentMessages override that repeats the turn history (D16)', () => {
    it('a memory-off node fed from the token history sends the override as it is', async () => {
        const { prompt, warnings } = await run({ agentMessages: [systemMessage, ...history] })
        expect([prompt, warnings]).toEqual([[['system', 'Knowledge base'], ...history.map((m) => [m.role, m.content])], 0])
    })

    it('with history accepted from the client, the repeated tail is removed and the question is added', async () => {
        expect(await run({ agentMessages: [systemMessage, ...history], historySource: 'client' })).toEqual({
            prompt: [
                ['system', 'Knowledge base'],
                ['user', question]
            ],
            chatHistory: [
                ['user', question],
                ['assistant', 'reply']
            ],
            warnings: 1
        })
    })

    it('a memory-on node gets the history once, through its memory', async () => {
        const { prompt, warnings } = await run({ agentMessages: [systemMessage, ...history], enableMemory: true })
        expect([prompt, warnings]).toEqual([
            [['system', 'Knowledge base'], ...history.map((m) => [m.role, m.content]), ['user', question]],
            1
        ])
    })
})

describe('Agent node Return Response As (TS25)', () => {
    it('appends the reply as an assistant message, also for a saved User Message value', async () => {
        for (const returnResponseAs of ['assistantMessage', 'userMessage', undefined]) {
            expect((await run({ agentMessages: [systemMessage], returnResponseAs })).chatHistory).toEqual([
                ['user', question],
                ['assistant', 'reply']
            ])
        }
    })

    it('appends nothing with "Do not append to chat history"', async () => {
        expect((await run({ agentMessages: [systemMessage], returnResponseAs: 'ignore' })).chatHistory).toEqual([['user', question]])
    })
})
