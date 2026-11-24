/**
 * global-agent replaces the agent of every http.request with its own, and Node sends Connection: close for that agent,
 * so every OpenAI SDK call would open a new TLS connection. It is only needed to route through a proxy.
 */
export const bootstrapGlobalAgentForProxy = (env: NodeJS.ProcessEnv = process.env): boolean => {
    const namespace = env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE ?? 'GLOBAL_AGENT_'
    if (!env[`${namespace}HTTP_PROXY`] && !env[`${namespace}HTTPS_PROXY`]) return false
    require('global-agent/bootstrap')
    return true
}
