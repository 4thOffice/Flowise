import { getRunningExpressApp } from '../../src/utils/getRunningExpressApp'
import chatflowsService from '../../src/services/chatflows'
import chatMessagesService from '../../src/services/chat-messages'

jest.mock('../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

const WORKSPACE = 'ws-1'

const node = (id: string, name: string, inputs: Record<string, any> = {}) => ({ id, data: { id, name, inputs } })
const flowData = (...nodes: any[]) => JSON.stringify({ nodes, edges: [] })
const startNode = node('startAgentflow_0', 'startAgentflow')
const redirectTo = (target: string) => node('redirectFlowAgentflow_0', 'redirectFlowAgentflow', { redirectFlowSelectedFlow: target })
const directReply = node('directReplyAgentflow_0', 'directReplyAgentflow')

const flows: Record<string, any> = {
    mapping: { id: 'mapping', type: 'AGENTFLOW', workspaceId: WORKSPACE, flowData: flowData(startNode, redirectTo('target')) },
    mappingToPostProcessed: {
        id: 'mappingToPostProcessed',
        type: 'AGENTFLOW',
        workspaceId: WORKSPACE,
        flowData: flowData(startNode, redirectTo('postProcessed'))
    },
    brokenMapping: {
        id: 'brokenMapping',
        type: 'AGENTFLOW',
        workspaceId: WORKSPACE,
        flowData: flowData(startNode, redirectTo('target'), directReply)
    },
    target: { id: 'target', type: 'AGENTFLOW', workspaceId: WORKSPACE, flowData: flowData(startNode, directReply) },
    postProcessed: {
        id: 'postProcessed',
        type: 'AGENTFLOW',
        workspaceId: WORKSPACE,
        flowData: flowData(startNode, directReply),
        chatbotConfig: JSON.stringify({ postProcessing: { enabled: true } })
    }
}

const abort = jest.fn()
const publishEvent = jest.fn()

beforeEach(() => {
    abort.mockReset()
    publishEvent.mockReset()
    delete process.env.MODE
    ;(getRunningExpressApp as jest.Mock).mockReturnValue({
        AppDataSource: {
            getRepository: () => ({ findOneBy: jest.fn(async ({ id }: { id: string }) => (flows[id] ? { ...flows[id] } : null)) })
        },
        abortControllerPool: { abort },
        queueManager: { getPredictionQueueEventsProducer: () => ({ publishEvent }) }
    })
})

afterAll(() => {
    delete process.env.MODE
})

describe('checkIfChatflowIsValidForStreaming with Redirect to Flow', () => {
    it('streams a mapping to an agentflow target', async () => {
        await expect(chatflowsService.checkIfChatflowIsValidForStreaming('mapping')).resolves.toEqual({ isStreaming: true })
    })

    it("uses the target's post-processing setting", async () => {
        await expect(chatflowsService.checkIfChatflowIsValidForStreaming('mappingToPostProcessed')).resolves.toEqual({
            isStreaming: false
        })
    })

    it('surfaces a broken mapping', async () => {
        await expect(chatflowsService.checkIfChatflowIsValidForStreaming('brokenMapping')).rejects.toThrow(/only node connected to Start/)
    })
})

describe('abortChatMessage with Redirect to Flow', () => {
    it('aborts the target run when stopped through the mapping id', async () => {
        await chatMessagesService.abortChatMessage('chat-1', 'mapping')
        expect(abort).toHaveBeenCalledWith('target_chat-1')
    })

    it('aborts a plain flow by its own id', async () => {
        await chatMessagesService.abortChatMessage('chat-1', 'target')
        expect(abort).toHaveBeenCalledWith('target_chat-1')
    })

    it('keeps the requested id when the flow is unknown', async () => {
        await chatMessagesService.abortChatMessage('chat-1', 'missing')
        expect(abort).toHaveBeenCalledWith('missing_chat-1')
    })

    it('publishes the target id in queue mode', async () => {
        process.env.MODE = 'queue'
        await chatMessagesService.abortChatMessage('chat-1', 'mapping')
        expect(publishEvent).toHaveBeenCalledWith({ eventName: 'abort', id: 'target_chat-1' })
        expect(abort).not.toHaveBeenCalled()
    })
})
