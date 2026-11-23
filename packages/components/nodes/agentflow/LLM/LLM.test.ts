import fs from 'fs'
import os from 'os'
import path from 'path'
import { AIMessageChunk } from '@langchain/core/messages'
import { countTrailingHistoryCopy } from '../utils'
const { nodeClass: LLM_Agentflow } = require('./LLM')

const fakeModelPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-node-test-')), 'fakeChatModel.js')
fs.writeFileSync(fakeModelPath, `module.exports = { nodeClass: class { async init() { return global.__fakeChatModel } } }`)

const prompts: any[][] = []
;(global as any).__fakeChatModel = {
    invoke: async (messages: any[]) => {
        prompts.push(messages)
        return new AIMessageChunk('reply')
    }
}

// The turn history as nodes receive it (pastChatHistory) and the same messages as a client repeats them in an override
const history = [
    { role: 'user', content: 'Živjo' },
    { role: 'assistant', content: 'Pozdravljeni, kako vam lahko pomagam?' }
]
const historyOverride = [
    { role: 'user', content: 'Živjo' },
    { role: 'assistant', content: 'Pozdravljeni, kako vam lahko pomagam?' }
]
const nodeMessages = [{ role: 'system', content: 'Knowledge base' }]
const question = 'Kakšen je delovni čas?'

const run = async ({
    llmMessages,
    enableMemory = false,
    historySource = 'token',
    returnResponseAs = 'assistantMessage',
    runtimeChatHistory = [] as any[]
}: {
    llmMessages: any[]
    enableMemory?: boolean
    historySource?: 'token' | 'client'
    returnResponseAs?: string
    runtimeChatHistory?: any[]
}) => {
    prompts.length = 0
    const warn = jest.fn()
    const node = new LLM_Agentflow()
    const result = await node.run(
        {
            id: 'llmAgentflow_0',
            label: 'LLM 0',
            inputs: {
                llmModel: 'fakeModel',
                llmModelConfig: {},
                llmEnableMemory: enableMemory,
                llmMemoryType: 'allMessages',
                llmMessages,
                llmReturnResponseAs: returnResponseAs
            }
        },
        question,
        {
            componentNodes: { fakeModel: { filePath: fakeModelPath, label: 'Fake' } },
            agentflowRuntime: { state: {}, chatHistory: runtimeChatHistory, form: {} },
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

describe('LLM node with an llmMessages override that repeats the turn history (D16)', () => {
    it('a memory-off node fed from the token history sends the override as it is (VoIP)', async () => {
        expect(await run({ llmMessages: [...nodeMessages, ...historyOverride] })).toEqual({
            prompt: [['system', 'Knowledge base'], ...historyOverride.map((m) => [m.role, m.content])],
            chatHistory: [
                ['user', 'Živjo'],
                ['assistant', 'reply']
            ],
            warnings: 0
        })
    })

    it('with history accepted from the client, the repeated tail is removed and the question is added', async () => {
        expect(await run({ llmMessages: [...nodeMessages, ...historyOverride], historySource: 'client' })).toEqual({
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
        const { prompt, warnings } = await run({ llmMessages: [...nodeMessages, ...historyOverride], enableMemory: true })
        expect([prompt, warnings]).toEqual([
            [['system', 'Knowledge base'], ...history.map((m) => [m.role, m.content]), ['user', question]],
            1
        ])
    })

    it('keeps an override that does not repeat the whole history', async () => {
        const partial = [historyOverride[1]]
        const { prompt, warnings } = await run({ llmMessages: [...nodeMessages, ...partial], historySource: 'client' })
        expect([prompt, warnings]).toEqual([
            [
                ['system', 'Knowledge base'],
                ['assistant', 'Pozdravljeni, kako vam lahko pomagam?'],
                ['user', question]
            ],
            0
        ])
    })
})

describe('LLM node Return Response As (TS25)', () => {
    it('appends the reply as an assistant message, also for a saved User Message value', async () => {
        for (const returnResponseAs of ['assistantMessage', 'userMessage', undefined]) {
            const { chatHistory } = await run({ llmMessages: nodeMessages, returnResponseAs: returnResponseAs as any })
            expect(chatHistory).toEqual([
                ['user', question],
                ['assistant', 'reply']
            ])
        }
    })

    it('appends nothing with "Do not append to chat history"', async () => {
        expect((await run({ llmMessages: nodeMessages, returnResponseAs: 'ignore' })).chatHistory).toEqual([['user', question]])
    })
})

describe('countTrailingHistoryCopy', () => {
    const requestHistory = [
        { role: 'userMessage', content: 'Živjo' },
        { role: 'apiMessage', content: 'Pozdravljeni, kako vam lahko pomagam?' }
    ]
    const withQuestion = [...nodeMessages, { role: 'user', content: question }]

    it('matches contents that turndown escaped or reflowed', () => {
        const escaped = [
            { role: 'user', content: '2\\. kartica \\*nujno\\*' },
            { role: 'assistant', content: 'Razumem.   Kaj še?' }
        ]
        const raw = [
            { role: 'userMessage', content: '2. kartica *nujno*' },
            { role: 'apiMessage', content: 'Razumem.\nKaj še?' }
        ]
        expect(countTrailingHistoryCopy(escaped, raw as any)).toBe(2)
    })

    it('matches history in request form and in node form', () => {
        expect(countTrailingHistoryCopy([...withQuestion, ...historyOverride], requestHistory as any)).toBe(2)
        expect(countTrailingHistoryCopy([...withQuestion, ...historyOverride], history as any)).toBe(2)
    })

    it('ignores history messages with empty content, which clients leave out of the override', () => {
        const raw = [...requestHistory, { role: 'apiMessage', content: '' }]
        expect(countTrailingHistoryCopy([...withQuestion, ...historyOverride], raw as any)).toBe(2)
    })

    it('finds no copy when any message differs', () => {
        const different = [historyOverride[0], { role: 'assistant', content: 'Something else' }]
        expect(countTrailingHistoryCopy([...withQuestion, ...different], requestHistory as any)).toBe(0)
    })

    it('finds no copy when roles differ', () => {
        const swapped = historyOverride.map((m) => ({ ...m, role: m.role === 'user' ? 'assistant' : 'user' }))
        expect(countTrailingHistoryCopy([...withQuestion, ...swapped], requestHistory as any)).toBe(0)
    })

    it('finds no copy without history', () => {
        expect(countTrailingHistoryCopy([...withQuestion, ...historyOverride], [])).toBe(0)
    })
})
