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

const history = [
    { role: 'userMessage', content: 'Živjo' },
    { role: 'apiMessage', content: 'Pozdravljeni, kako vam lahko pomagam?' }
]
const historyOverride = [
    { role: 'user', content: 'Živjo' },
    { role: 'assistant', content: 'Pozdravljeni, kako vam lahko pomagam?' }
]
const nodeMessages = [
    { role: 'system', content: 'Knowledge base' },
    { role: 'user', content: 'Kakšen je delovni čas?' }
]

const run = async ({
    llmMessages,
    prepended = history,
    runtimeChatHistory = [] as any[]
}: {
    llmMessages: any[]
    prepended?: any[]
    runtimeChatHistory?: any[]
}) => {
    prompts.length = 0
    const node = new LLM_Agentflow()
    const result = await node.run(
        {
            id: 'llmAgentflow_0',
            label: 'LLM 0',
            inputs: {
                llmModel: 'fakeModel',
                llmModelConfig: {},
                llmEnableMemory: false,
                llmMessages,
                llmReturnResponseAs: 'assistantMessage'
            }
        },
        'Kakšen je delovni čas?',
        {
            componentNodes: { fakeModel: { filePath: fakeModelPath, label: 'Fake' } },
            agentflowRuntime: { state: {}, chatHistory: runtimeChatHistory, form: {} },
            pastChatHistory: [],
            prependedChatHistory: prepended,
            chatId: 'chat',
            isLastNode: false
        }
    )
    return { prompt: prompts[0].map((m: any) => [m.role, m.content]), chatHistory: result.chatHistory }
}

describe('LLM node with history sent in both the history field and an llmMessages override', () => {
    it('sends the history once when the node includes the history field', async () => {
        const { prompt } = await run({ llmMessages: [...nodeMessages, ...historyOverride] })
        expect(prompt).toEqual([
            ['system', 'Knowledge base'],
            ['user', 'Živjo'],
            ['assistant', 'Pozdravljeni, kako vam lahko pomagam?'],
            ['user', 'Kakšen je delovni čas?']
        ])
    })

    it('keeps the in-run history it returns exactly as before', async () => {
        const { chatHistory } = await run({ llmMessages: [...nodeMessages, ...historyOverride] })
        expect(chatHistory.map((m: any) => [m.role, m.content])).toEqual([
            ['user', 'Kakšen je delovni čas?'],
            ['user', 'Živjo'],
            ['assistant', 'reply']
        ])
    })

    it('keeps the override when an earlier node already ran, since the history field is not added there', async () => {
        const { prompt } = await run({
            llmMessages: [...nodeMessages, ...historyOverride],
            runtimeChatHistory: [{ role: 'user', content: 'Kakšen je delovni čas?' }]
        })
        expect(prompt).toEqual([
            ['system', 'Knowledge base'],
            ['user', 'Kakšen je delovni čas?'],
            ['user', 'Živjo'],
            ['assistant', 'Pozdravljeni, kako vam lahko pomagam?']
        ])
    })

    it('changes nothing when only the history field is sent', async () => {
        const { prompt } = await run({ llmMessages: nodeMessages })
        expect(prompt).toEqual([
            ['system', 'Knowledge base'],
            ['user', 'Živjo'],
            ['assistant', 'Pozdravljeni, kako vam lahko pomagam?'],
            ['user', 'Kakšen je delovni čas?']
        ])
    })

    it('changes nothing when only the override is sent', async () => {
        const { prompt } = await run({ llmMessages: [...nodeMessages, ...historyOverride], prepended: [] })
        expect(prompt).toEqual([
            ['system', 'Knowledge base'],
            ['user', 'Kakšen je delovni čas?'],
            ['user', 'Živjo'],
            ['assistant', 'Pozdravljeni, kako vam lahko pomagam?']
        ])
    })
})

describe('countTrailingHistoryCopy', () => {
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

    it('ignores history messages with empty content, which clients leave out of the override', () => {
        const raw = [...history, { role: 'apiMessage', content: '' }]
        expect(countTrailingHistoryCopy([...nodeMessages, ...historyOverride], raw as any)).toBe(2)
    })

    it('finds no copy when any message differs', () => {
        const different = [historyOverride[0], { role: 'assistant', content: 'Something else' }]
        expect(countTrailingHistoryCopy([...nodeMessages, ...different], history as any)).toBe(0)
    })

    it('finds no copy when roles differ', () => {
        const swapped = historyOverride.map((m) => ({ ...m, role: m.role === 'user' ? 'assistant' : 'user' }))
        expect(countTrailingHistoryCopy([...nodeMessages, ...swapped], history as any)).toBe(0)
    })

    it('finds no copy without history', () => {
        expect(countTrailingHistoryCopy([...nodeMessages, ...historyOverride], [])).toBe(0)
    })
})
