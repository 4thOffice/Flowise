import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici'

// Under the 60 s idle timeout common on load balancers. OpenAI and Anthropic close idle connections after 400 s, Google after 240 s.
export const KEEP_ALIVE_IDLE_MS = 55_000

type AgentConstructor = new (...args: any[]) => http.Agent

// Node closes free sockets after the agent timeout, but the OpenAI SDK raises that timeout to its request timeout
// (10 min, longer than providers keep idle connections), so the limit goes on the socket. A shorter server Keep-Alive hint still wins.
export const withIdleCap = <T extends AgentConstructor>(Base: T, idleMs: number) =>
    class IdleCappedAgent extends Base {
        keepSocketAlive(socket: Duplex): boolean {
            const keep = super.keepSocketAlive(socket) as unknown as boolean
            const s = socket as Socket
            if (keep && (!s.timeout || s.timeout > idleMs)) s.setTimeout(idleMs)
            return keep
        }
    }

const IdleCappedHttpAgent = withIdleCap(http.Agent, KEEP_ALIVE_IDLE_MS)
const IdleCappedHttpsAgent = withIdleCap(https.Agent, KEEP_ALIVE_IDLE_MS)
const IdleCappedProxyAgent = withIdleCap(HttpsProxyAgent, KEEP_ALIVE_IDLE_MS)

let sharedHttpAgent: http.Agent | undefined
let sharedHttpsAgent: http.Agent | undefined
const proxyAgents = new Map<string, http.Agent>()

/** Process-wide pool for SDKs that send through http.request, such as the OpenAI SDK. The agent must match the URL's protocol. */
export const getKeepAliveAgent = (url?: string): http.Agent => {
    if (url && /^http:/i.test(url)) return (sharedHttpAgent ??= new IdleCappedHttpAgent({ keepAlive: true, scheduling: 'lifo' }))
    return (sharedHttpsAgent ??= new IdleCappedHttpsAgent({ keepAlive: true, scheduling: 'lifo' }))
}

export const getKeepAliveProxyAgent = (proxyUrl: string): http.Agent => {
    let agent = proxyAgents.get(proxyUrl)
    if (!agent) {
        agent = new IdleCappedProxyAgent(proxyUrl, { keepAlive: true, scheduling: 'lifo' })
        proxyAgents.set(proxyUrl, agent)
    }
    return agent
}

/** Sets the pool behind the global fetch, which the Anthropic and Google SDKs use. undici's default drops idle sockets after 4 s. */
export const configureFetchKeepAlive = (idleMs: number = KEEP_ALIVE_IDLE_MS): void => {
    setGlobalDispatcher(new UndiciAgent({ keepAliveTimeout: idleMs, keepAliveMaxTimeout: idleMs }))
}
