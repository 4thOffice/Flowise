import { DataSource } from 'typeorm'
import {
    createEdge,
    createFlow,
    createMockDataSource,
    createMockNodeFactory,
    createNode,
    loadRealComponentNodes,
    runTestAgentFlow
} from './testHelpers'

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => {
        throw new Error('getRunningExpressApp should not be called when appDataSource is injected')
    })
}))

const countVariableQueries = (appDataSource: DataSource) => {
    const calls = { count: 0 }
    const getRepository = appDataSource.getRepository.bind(appDataSource)
    ;(appDataSource as any).getRepository = (entity: any) => {
        const repo: any = getRepository(entity)
        if (entity?.name !== 'Variable') return repo
        return {
            ...repo,
            findBy: async (where: any) => {
                calls.count++
                return repo.findBy(where)
            }
        }
    }
    return calls
}

describe('Agentflow variables loading', () => {
    const realComponentNodes = loadRealComponentNodes()
    const flow = createFlow(
        [
            createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
            createNode('A', 'mockWorker'),
            createNode('B', 'mockWorker'),
            createNode('C', 'mockWorker')
        ],
        [createEdge('start_0', 'A'), createEdge('start_0', 'B'), createEdge('A', 'C'), createEdge('B', 'C')]
    )
    const worker = async (nd: any) => ({ id: nd.id, name: nd.name, output: { content: nd.id } })
    const factory = () => createMockNodeFactory({ A: worker, B: worker, C: worker })

    it('queries workspace variables once per run, not once per node', async () => {
        const { appDataSource } = createMockDataSource()
        const calls = countVariableQueries(appDataSource)

        await runTestAgentFlow({ flow, appDataSource, componentNodes: realComponentNodes, nodeInstanceFactory: factory() })

        expect(calls.count).toBe(1)
    })
})
