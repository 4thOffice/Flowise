import { getCredentialData } from '../../../src/utils'
const { nodeClass: ChatOpenAI_ChatModels } = require('./ChatOpenAI')
const { nodeClass: ChatOpenAICustom_ChatModels } = require('../ChatOpenAICustom/ChatOpenAICustom')

jest.mock('../../../src/utils', () => ({
    ...jest.requireActual('../../../src/utils'),
    getCredentialData: jest.fn()
}))

const DEPLOYMENT_URL = 'https://llm.example.test/v1'

const init = (NodeClass: any, inputs: Record<string, any> = {}, credential: Record<string, any> = {}) => {
    ;(getCredentialData as jest.Mock).mockResolvedValue({ openAIApiKey: 'test-key', ...credential })
    return new NodeClass().init(
        { id: 'chatOpenAI_0', credential: 'cred-id', inputs: { modelName: 'my-deployment', temperature: '0.9', ...inputs } },
        '',
        {}
    )
}

describe.each([
    ['ChatOpenAI', ChatOpenAI_ChatModels],
    ['ChatOpenAI Custom', ChatOpenAICustom_ChatModels]
])('%s base URL', (_, NodeClass) => {
    it('uses the base URL stored on the credential', async () => {
        const model = await init(NodeClass, { basepath: '' }, { openAIBaseUrl: DEPLOYMENT_URL })
        expect(model.clientConfig.baseURL).toBe(DEPLOYMENT_URL)
    })

    it('prefers the BasePath set on the node', async () => {
        const model = await init(NodeClass, { basepath: 'https://node.example.test/v1' }, { openAIBaseUrl: DEPLOYMENT_URL })
        expect(model.clientConfig.baseURL).toBe('https://node.example.test/v1')
    })

    it('keeps the OpenAI default for credentials saved without a base URL', async () => {
        const model = await init(NodeClass, { basepath: '' })
        expect(model.clientConfig.baseURL).toBeUndefined()
    })
})

describe('ChatOpenAI with a custom model name', () => {
    it('passes the typed name through', async () => {
        const model = await init(ChatOpenAI_ChatModels)
        expect(model.model).toBe('my-deployment')
    })

    it('treats it as a reasoning model when Reasoning is switched on', async () => {
        const model = await init(ChatOpenAI_ChatModels, { reasoning: true, reasoningEffort: 'high', stopSequence: 'END' })
        expect(model.reasoning).toEqual({ effort: 'high' })
        expect(model.temperature).toBeUndefined()
        expect(model.stop).toBeUndefined()
    })

    it('keeps temperature and sends no reasoning params when Reasoning is off', async () => {
        const model = await init(ChatOpenAI_ChatModels)
        expect(model.reasoning).toBeUndefined()
        expect(model.temperature).toBe(0.9)
    })
})
