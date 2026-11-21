const { nodeClass: RedirectFlow_Agentflow } = require('./RedirectFlow')
const { nodeClass: ExecuteFlow_Agentflow } = require('../ExecuteFlow/ExecuteFlow')
import { listFlows } from '../utils'

const chatflows = [
    { id: 'id-v1', name: 'Support V1', type: 'MULTIAGENT' },
    { id: 'id-chat', name: 'Answers', type: 'CHATFLOW' },
    { id: 'id-v2', name: 'Support V2', type: 'AGENTFLOW' }
]

const optionsWith = (rows: any[], searchOptions?: Record<string, any>) => {
    const findBy = jest.fn().mockResolvedValue(rows)
    const getRepository = jest.fn(() => ({ findBy }))
    return {
        options: { appDataSource: { getRepository }, databaseEntities: { ChatFlow: 'ChatFlowEntity' }, searchOptions },
        findBy,
        getRepository
    }
}

describe('RedirectFlow_Agentflow', () => {
    const node = new RedirectFlow_Agentflow()

    it('is an Agent Flows node with only a flow picker and no output', () => {
        expect(node.name).toBe('redirectFlowAgentflow')
        expect(node.category).toBe('Agent Flows')
        expect(node.hideOutput).toBe(true)
        expect(node.inputs).toEqual([
            { label: 'Select Flow', name: 'redirectFlowSelectedFlow', type: 'asyncOptions', loadMethod: 'listFlows' }
        ])
    })

    it('throws when run, because the server should have swapped in the target flow', async () => {
        await expect(node.run()).rejects.toThrow('Redirect to Flow must be the only node connected to Start')
    })

    it('lists flows through the shared listFlows', async () => {
        const { options } = optionsWith(chatflows)
        await expect(node.loadMethods.listFlows({}, options)).resolves.toEqual(await listFlows(options))
    })
})

describe('listFlows', () => {
    it('scopes the query with searchOptions', async () => {
        const { options, findBy, getRepository } = optionsWith([], { workspaceId: 'ws-1' })
        await listFlows(options)
        expect(getRepository).toHaveBeenCalledWith('ChatFlowEntity')
        expect(findBy).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    })

    it('labels flow types and sorts by name', async () => {
        const { options } = optionsWith(chatflows)
        await expect(listFlows(options)).resolves.toEqual([
            { label: 'Answers', name: 'id-chat', description: 'Chatflow' },
            { label: 'Support V1', name: 'id-v1', description: 'Agentflow V1' },
            { label: 'Support V2', name: 'id-v2', description: 'Agentflow V2' }
        ])
    })

    it('returns no flows without a data source', async () => {
        await expect(listFlows({})).resolves.toEqual([])
    })

    it('backs Execute Flow’s flow picker unchanged', async () => {
        const { options } = optionsWith(chatflows)
        await expect(new ExecuteFlow_Agentflow().loadMethods.listFlows({}, options)).resolves.toEqual(await listFlows(options))
    })
})
