import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { getCredentialData } from '../../../src/utils'
const { nodeClass: ChatOpenAI_ChatModels } = require('./ChatOpenAI')
const { nodeClass: ChatOpenAICustom_ChatModels } = require('../ChatOpenAICustom/ChatOpenAICustom')

jest.mock('../../../src/utils', () => ({
    ...jest.requireActual('../../../src/utils'),
    getCredentialData: jest.fn()
}))

const DEPLOYMENT_URL = 'https://llm.example.test/v1'

const COMPLETION = {
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'my-deployment',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}

const withServer = async (run: (basepath: string, connections: () => number) => Promise<void>) => {
    let connections = 0
    const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.setHeader('content-type', 'application/json')
            res.setHeader('connection', 'keep-alive')
            res.end(JSON.stringify(COMPLETION))
        })
    })
    server.on('connection', () => connections++)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, () => connections)
    } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
}

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

describe.each([
    ['ChatOpenAI', ChatOpenAI_ChatModels],
    ['ChatOpenAI Custom', ChatOpenAICustom_ChatModels]
])('%s connection pool', (_, NodeClass) => {
    it('gives every run the same keep-alive agents, picked by the request protocol', async () => {
        const first = await init(NodeClass)
        const second = await init(NodeClass, { basepath: 'http://localhost:1234/v1' })
        const agentFor = first.clientConfig.httpAgent
        expect(second.clientConfig.httpAgent).toBe(agentFor)
        expect(agentFor(new URL('https://api.openai.com/v1'))).toBeInstanceOf(https.Agent)
        expect(agentFor(new URL('http://localhost:1234/v1'))).not.toBeInstanceOf(https.Agent)
        expect(agentFor(new URL('http://localhost:1234/v1')).keepAlive).toBe(true)
    })

    it('reuses one connection across runs', async () => {
        await withServer(async (basepath, connections) => {
            for (let run = 0; run < 3; run++) {
                const model = await init(NodeClass, { basepath, streaming: false })
                await model.invoke('hi')
            }
            expect(connections()).toBe(1)
        })
    })

    it('works with an http base URL taken from OPENAI_BASE_URL', async () => {
        await withServer(async (basepath, connections) => {
            process.env.OPENAI_BASE_URL = basepath
            try {
                for (let run = 0; run < 2; run++) {
                    const model = await init(NodeClass, { basepath: '', streaming: false })
                    expect((await model.invoke('hi')).content).toBe('hello')
                }
            } finally {
                delete process.env.OPENAI_BASE_URL
            }
            expect(connections()).toBe(1)
        })
    })
})

describe('ChatOpenAI proxy', () => {
    it('keeps one agent per proxy URL', async () => {
        const first = await init(ChatOpenAI_ChatModels, { proxyUrl: 'http://proxy-a.example.test:3128' })
        const again = await init(ChatOpenAI_ChatModels, { proxyUrl: 'http://proxy-a.example.test:3128' })
        const other = await init(ChatOpenAI_ChatModels, { proxyUrl: 'http://proxy-b.example.test:3128' })
        expect(first.clientConfig.httpAgent).toBe(again.clientConfig.httpAgent)
        expect(first.clientConfig.httpAgent).not.toBe(other.clientConfig.httpAgent)
        expect(first.clientConfig.httpAgent.keepAlive).toBe(true)
    })
})
