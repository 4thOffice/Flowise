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

describe('Agent node tool approval checkpoint (D5, D4)', () => {
    const { DynamicStructuredTool } = require('@langchain/core/tools')
    const { z } = require('zod')
    const { fromCheckpointConversation, toCheckpointConversation } = require('../utils')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-approval-test-'))
    const toolModelPath = path.join(dir, 'fakeToolModel.js')
    const toolPath = path.join(dir, 'fakeTool.js')
    fs.writeFileSync(toolModelPath, `module.exports = { nodeClass: class { async init() { return global.__fakeToolChatModel } } }`)
    fs.writeFileSync(toolPath, `module.exports = { nodeClass: class { async init() { return global.__fakeTool() } } }`)

    const toolCall = { id: 'call_1', name: 'calculator', args: { input: '2+2' }, type: 'tool_call' as const }
    const toolPrompts: any[][] = []
    let replies: AIMessageChunk[] = []
    const model: any = {
        bindTools: () => model,
        invoke: async (messages: any[]) => {
            toolPrompts.push(messages)
            return replies.shift()
        }
    }
    ;(global as any).__fakeToolChatModel = model
    ;(global as any).__fakeTool = () =>
        new DynamicStructuredTool({
            name: 'calculator',
            description: 'Calculates',
            schema: z.object({ input: z.string() }),
            func: async () => '4'
        })

    const runAgent = (system: string, question: string | undefined, options: Record<string, any> = {}) =>
        new Agent_Agentflow().run(
            {
                id: 'agentAgentflow_0',
                label: 'Agent 0',
                inputs: {
                    agentModel: 'fakeToolModel',
                    agentModelConfig: {},
                    agentTools: [{ agentSelectedTool: 'fakeTool', agentSelectedToolConfig: {}, agentSelectedToolRequiresHumanInput: true }],
                    agentKnowledgeDocumentStores: [],
                    agentKnowledgeVSEmbeddings: [],
                    agentEnableMemory: true,
                    agentMemoryType: 'allMessages',
                    agentMessages: [{ role: 'system', content: system }],
                    ...(options.humanInput ? { humanInput: options.humanInput } : {})
                }
            },
            question,
            {
                componentNodes: { fakeToolModel: { filePath: toolModelPath, label: 'Fake' }, fakeTool: { filePath: toolPath } },
                agentflowRuntime: { state: {}, chatHistory: [], form: {} },
                pastChatHistory: history,
                chatId: 'chat',
                isLastNode: false,
                ...options
            }
        )

    const stop = async () => {
        replies = [new AIMessageChunk({ content: '', tool_calls: [toolCall] })]
        return runAgent('Knowledge base', question)
    }

    it('at a tool approval stop, keeps the prompt after its Messages list with the history as references', async () => {
        const result = await stop()
        expect(result.output.isWaitingForHumanInput).toBe(true)
        expect(result.output.resumeCheckpoint.conversation).toEqual([{ history: [0, 2] }, { role: 'user', content: question }])
        expect(result.output.resumeCheckpoint.toolCallMessage).toMatchObject({ role: 'assistant', content: '', tool_calls: [toolCall] })
        expect(JSON.stringify(result.output.resumeCheckpoint)).not.toContain('Knowledge base')
    })

    it('on resume, rebuilds the prompt on the current Messages list and the history, then runs the approved tool', async () => {
        const { resumeCheckpoint } = (await stop()).output
        toolPrompts.length = 0
        replies = [new AIMessageChunk('It is 4.')]
        const result = await runAgent('Knowledge base, edited while paused', undefined, {
            humanInput: { type: 'proceed', startNodeId: 'agentAgentflow_0' },
            resumeCheckpoint: { historyLength: 2, ...resumeCheckpoint },
            humanInputAction: { id: 'a1', data: { nodeId: 'agentAgentflow_0', nodeLabel: 'Agent 0' } }
        })
        expect(result.output.content).toBe('It is 4.')
        expect(toolPrompts[0].map((m: any) => [m.role, m.content])).toEqual([
            ['system', 'Knowledge base, edited while paused'],
            ...history.map((m) => [m.role, m.content]),
            ['user', question],
            ['assistant', ''],
            ['tool', '4']
        ])
    })

    it('a prompt stored before token v2 is replayed as it is', async () => {
        const stored = [
            { role: 'system', content: 'Knowledge base' },
            { role: 'user', content: question },
            { role: 'assistant', content: '', tool_calls: [toolCall] }
        ]
        toolPrompts.length = 0
        replies = [new AIMessageChunk('It is 4.')]
        await runAgent('Knowledge base, edited while paused', undefined, {
            humanInput: { type: 'proceed', startNodeId: 'agentAgentflow_0' },
            humanInputAction: { id: 'a1', data: { nodeId: 'agentAgentflow_0', nodeLabel: 'Agent 0', input: { messages: stored } } }
        })
        expect(toolPrompts[0].map((m: any) => [m.role, m.content])).toEqual([
            ['system', 'Knowledge base'],
            ['user', question],
            ['assistant', ''],
            ['tool', '4']
        ])
    })

    it('history references round trip; only exact copies of history runs become references', () => {
        const longer = [...history, { role: 'user', content: 'Hvala' }, { role: 'assistant', content: 'Prosim' }]
        const messages = [longer[2], longer[3], { role: 'user', content: 'new' }, longer[0], { ...longer[1], name: 'agent' }]
        const conversation = toCheckpointConversation(messages, longer)
        expect(conversation).toEqual([
            { history: [2, 4] },
            { role: 'user', content: 'new' },
            { history: [0, 1] },
            { ...longer[1], name: 'agent' }
        ])
        expect(fromCheckpointConversation(conversation, longer)).toEqual(messages)
        expect(() => fromCheckpointConversation(conversation, history)).toThrow('refers to history messages 2-4')
    })
})
