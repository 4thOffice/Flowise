import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net, { AddressInfo } from 'node:net'
import { getKeepAliveProxyAgent, withIdleCap } from 'flowise-components'
import { bootstrapGlobalAgentForProxy } from '../../src/utils/outboundHttp'

const mockGlobalAgentLoaded = jest.fn()
jest.mock('global-agent/bootstrap', () => {
    mockGlobalAgentLoaded()
    return {}
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Like the provider APIs: keeps idle connections for minutes and sends no Keep-Alive timeout hint
const startServer = async (delayMs = 0) => {
    let connections = 0
    const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () =>
            setTimeout(() => {
                res.setHeader('connection', 'keep-alive')
                res.end('ok')
            }, delayMs)
        )
    })
    server.keepAliveTimeout = 120_000
    server.on('connection', () => connections++)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        connections: () => connections,
        close: async () => {
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    }
}

const get = (url: string, agent: http.Agent) =>
    new Promise<string>((resolve, reject) => {
        http.get(url, { agent }, (res) => {
            let body = ''
            res.on('data', (chunk) => (body += chunk))
            res.on('end', () => resolve(body))
        }).on('error', reject)
    })

describe('bootstrapGlobalAgentForProxy', () => {
    it('leaves http.request alone when no proxy is configured', () => {
        expect(bootstrapGlobalAgentForProxy({})).toBe(false)
        expect(mockGlobalAgentLoaded).not.toHaveBeenCalled()
    })

    it('loads global-agent for a configured proxy', () => {
        expect(bootstrapGlobalAgentForProxy({ GLOBAL_AGENT_HTTPS_PROXY: 'http://proxy.example.test:3128' })).toBe(true)
        expect(bootstrapGlobalAgentForProxy({ GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE: 'CORP_', CORP_HTTP_PROXY: 'http://p:1' })).toBe(
            true
        )
        expect(mockGlobalAgentLoaded).toHaveBeenCalled()
    })
})

describe('idle-capped agent', () => {
    const IDLE_MS = 300
    const Agent = withIdleCap(http.Agent, IDLE_MS)

    it('reuses a connection while idle time is under the cap and opens a new one after', async () => {
        const server = await startServer()
        const agent = new Agent({ keepAlive: true })
        try {
            await get(server.url, agent)
            await sleep(IDLE_MS / 3)
            await get(server.url, agent)
            expect(server.connections()).toBe(1)
            await sleep(IDLE_MS * 2)
            await get(server.url, agent)
            expect(server.connections()).toBe(2)
        } finally {
            agent.destroy()
            await server.close()
        }
    })

    it('does not cut a reused connection whose response takes longer than the cap', async () => {
        const server = await startServer(IDLE_MS * 3)
        const agent = new Agent({ keepAlive: true })
        try {
            await get(server.url, agent)
            expect(await get(server.url, agent)).toBe('ok')
            expect(server.connections()).toBe(1)
        } finally {
            agent.destroy()
            await server.close()
        }
    })
})

describe('getKeepAliveProxyAgent', () => {
    it('tunnels several requests through one CONNECT', async () => {
        const server = await startServer()
        let connects = 0
        const proxy = http.createServer()
        proxy.on('connect', (req, clientSocket, head) => {
            connects++
            const [host, port] = (req.url ?? '').split(':')
            const upstream = net.connect(Number(port), host, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                upstream.write(head)
                upstream.pipe(clientSocket)
                clientSocket.pipe(upstream)
            })
            upstream.on('error', () => clientSocket.destroy())
            clientSocket.on('error', () => upstream.destroy())
        })
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
        const agent = getKeepAliveProxyAgent(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`)
        try {
            for (let i = 0; i < 3; i++) expect(await get(server.url, agent)).toBe('ok')
            expect(connects).toBe(1)
            expect(server.connections()).toBe(1)
        } finally {
            agent.destroy()
            proxy.closeAllConnections()
            await new Promise((resolve) => proxy.close(resolve))
            await server.close()
        }
    })
})

// Node's fetch reads its dispatcher from the real global object, which jest's sandbox hides, so this runs in a child process
const FETCH_SCRIPT = `
const http = require('node:http')
const { configureFetchKeepAlive } = require(process.argv[1])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let connections = 0
const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
        res.setHeader('connection', 'keep-alive')
        res.end('ok')
    })
})
server.keepAliveTimeout = 120000
server.on('connection', () => connections++)
server.listen(0, '127.0.0.1', async () => {
    const url = 'http://127.0.0.1:' + server.address().port + '/'
    configureFetchKeepAlive(300)
    await (await fetch(url)).text()
    await sleep(100)
    await (await fetch(url)).text()
    const shortGap = connections
    await sleep(600)
    await (await fetch(url)).text()
    console.log(JSON.stringify({ shortGap, longGap: connections }))
    process.exit(0)
})
`

describe('configureFetchKeepAlive', () => {
    it('sets the idle time of the pool behind the global fetch', () => {
        const out = execFileSync(process.execPath, ['-e', FETCH_SCRIPT, require.resolve('flowise-components/dist/src/httpKeepAlive')], {
            encoding: 'utf8',
            timeout: 30_000
        })
        // undici's own default keeps an idle socket for 4 s, so the second connection shows the configured pool is in use
        expect(JSON.parse(out)).toEqual({ shortGap: 1, longGap: 2 })
    })
})
