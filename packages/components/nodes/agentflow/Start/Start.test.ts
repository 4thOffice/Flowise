const { nodeClass: Start_Agentflow } = require('./Start')

const run = (inputs: Record<string, any>, input: any, agentflowRuntime: Record<string, any>) =>
    new Start_Agentflow().run({ id: 'startAgentflow_0', inputs }, input, { agentflowRuntime })

describe('Start node (TS11, TS12, TS17)', () => {
    it('offers neither Persist State nor Ephemeral Memory', () => {
        const node = new Start_Agentflow()
        expect(node.version).toBe(1.2)
        expect(node.inputs.map((input: any) => input.name)).not.toEqual(expect.arrayContaining(['startPersistState']))
        expect(node.inputs.map((input: any) => input.name)).not.toEqual(expect.arrayContaining(['startEphemeralMemory']))
    })

    it('puts the carried state over its defaults, whatever a saved Persist State or Ephemeral Memory value says', async () => {
        const result = await run(
            {
                startInputType: 'chatInput',
                startState: [
                    { key: 'stage', value: 'new' },
                    { key: 'count', value: '0' }
                ],
                startPersistState: false,
                startEphemeralMemory: true
            },
            'Hi',
            { state: { count: '3' }, form: {} }
        )
        expect(result.state).toEqual({ stage: 'new', count: '3' })
        expect(result.output).toEqual({ question: 'Hi' })
    })

    it('returns the form values of the turn', async () => {
        const result = await run({ startInputType: 'formInput' }, 'name: Grace Hopper', {
            state: {},
            form: { name: 'Grace Hopper', topic: 'shipping' }
        })
        expect(result.output).toEqual({ form: { name: 'Grace Hopper', topic: 'shipping' } })
    })
})
