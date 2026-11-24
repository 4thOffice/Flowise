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

    const seed = [{ id: 'var-1', name: 'greeting', value: 'hi', type: 'static', workspaceId: 'ws-1' }]
    const messageParams = [{ label: 'Message', name: 'message', type: 'string', acceptVariable: true }]
    const varsNode = (id: string) =>
        createNode(id, 'mockWorker', { inputParams: messageParams, inputs: { message: '{{ $vars.greeting }}' } })
    const echo = async (nd: any) => ({ id: nd.id, name: nd.name, output: { content: nd.inputs.message } })
    const outputOf = (result: any, nodeId: string) =>
        result.agentFlowExecutedData.find((record: any) => record.nodeId === nodeId)?.data?.output?.content

    it('does not query workspace variables when no node uses them', async () => {
        const { appDataSource } = createMockDataSource(seed)
        const calls = countVariableQueries(appDataSource)

        await runTestAgentFlow({ flow, appDataSource, componentNodes: realComponentNodes, nodeInstanceFactory: factory() })

        expect(calls.count).toBe(0)
    })

    it('queries workspace variables once per run, not once per node that uses them', async () => {
        const varsFlow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                varsNode('A'),
                varsNode('B'),
                varsNode('C')
            ],
            [createEdge('start_0', 'A'), createEdge('start_0', 'B'), createEdge('A', 'C'), createEdge('B', 'C')]
        )
        const { appDataSource } = createMockDataSource(seed)
        const calls = countVariableQueries(appDataSource)

        const result = await runTestAgentFlow({
            flow: varsFlow,
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory: createMockNodeFactory({ A: echo, B: echo, C: echo })
        })

        expect(['A', 'B', 'C'].map((nodeId) => outputOf(result, nodeId))).toEqual(['hi', 'hi', 'hi'])
        expect(calls.count).toBe(1)
    })

    it('gives every node its own copies of the variables', async () => {
        const varsFlow = createFlow(
            [
                createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes),
                createNode('A', 'mockWorker'),
                varsNode('B')
            ],
            [createEdge('start_0', 'A'), createEdge('A', 'B')]
        )
        const rewrite = async (nd: any, _input: unknown, options: any) => {
            const variables = await options.getAvailableVariables()
            variables[0].value = 'rewritten'
            return { id: nd.id, name: nd.name, output: { content: variables[0].value } }
        }
        const { appDataSource } = createMockDataSource(seed)

        const result = await runTestAgentFlow({
            flow: varsFlow,
            appDataSource,
            componentNodes: realComponentNodes,
            nodeInstanceFactory: createMockNodeFactory({ A: rewrite, B: echo })
        })

        expect(outputOf(result, 'A')).toBe('rewritten')
        expect(outputOf(result, 'B')).toBe('hi')
    })

    it("lets Custom Function nodes read the run's variables without querying again", async () => {
        const fn = (id: string) =>
            createNode(
                id,
                'customFunctionAgentflow',
                { inputs: { customFunctionJavascriptFunction: 'return $vars.greeting' } },
                realComponentNodes
            )
        const fnFlow = createFlow(
            [createNode('start_0', 'startAgentflow', { inputs: { startInputType: 'chatInput' } }, realComponentNodes), fn('F1'), fn('F2')],
            [createEdge('start_0', 'F1'), createEdge('F1', 'F2')]
        )
        const { appDataSource } = createMockDataSource(seed)
        const calls = countVariableQueries(appDataSource)

        const result = await runTestAgentFlow({ flow: fnFlow, appDataSource, componentNodes: realComponentNodes })

        expect([outputOf(result, 'F1'), outputOf(result, 'F2')]).toEqual(['hi', 'hi'])
        expect(calls.count).toBe(1)
    })
})
