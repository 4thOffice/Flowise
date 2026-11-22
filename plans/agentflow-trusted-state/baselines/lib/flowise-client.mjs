import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BASELINES_DIR = path.resolve(HERE, '..')

export function loadCaptureEnv(file = path.join(BASELINES_DIR, 'capture.env')) {
    const env = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return { ...env, ...pickDefined(process.env, Object.keys(env)) }
}

function pickDefined(source, keys) {
    const out = {}
    for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
    return out
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForServer(baseUrl, maxWaitMs = 120000) {
    const deadline = Date.now() + maxWaitMs
    let lastError
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/v1/ping`)
            if (res.ok) return
            lastError = new Error(`HTTP ${res.status}`)
        } catch (err) {
            lastError = err
        }
        await sleep(500)
    }
    throw new Error(`Flowise at ${baseUrl} not ready after ${maxWaitMs}ms: ${lastError?.message}`)
}

function readSetCookies(res, cookieMap) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    for (const item of raw) {
        if (!item) continue
        const pair = item.split(';')[0]
        const eq = pair.indexOf('=')
        if (eq > 0) cookieMap.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
}

export class FlowiseClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/+$/, '')
        this.cookies = new Map()
    }

    get cookieHeader() {
        return Array.from(this.cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ')
    }

    async login(email, password) {
        const resolveRes = await fetch(`${this.baseUrl}/api/v1/auth/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        })
        if (!resolveRes.ok) throw new Error(`auth/resolve: HTTP ${resolveRes.status} ${await resolveRes.text()}`)
        const resolved = await resolveRes.json()
        if (resolved.redirectUrl === '/organization-setup') {
            const reg = await fetch(`${this.baseUrl}/api/v1/account/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: { name: 'Trusted State Baseline', email, type: 'pro', credential: password } })
            })
            if (!reg.ok) throw new Error(`account/register: HTTP ${reg.status} ${await reg.text()}`)
        }
        const loginRes = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        })
        if (!loginRes.ok) throw new Error(`auth/login: HTTP ${loginRes.status} ${await loginRes.text()}`)
        readSetCookies(loginRes, this.cookies)
        if (!this.cookies.size) throw new Error('login returned no cookies')
        return await loginRes.json().catch(() => ({}))
    }

    async api(urlPath, { method = 'GET', body } = {}) {
        const headers = { 'x-request-from': 'internal' }
        if (this.cookies.size) headers.Cookie = this.cookieHeader
        if (body !== undefined) headers['Content-Type'] = 'application/json'
        const res = await fetch(`${this.baseUrl}${urlPath}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        })
        readSetCookies(res, this.cookies)
        const text = await res.text()
        let parsed
        try {
            parsed = text ? JSON.parse(text) : null
        } catch {
            parsed = text
        }
        if (!res.ok) {
            throw new Error(`${method} ${urlPath}: HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)
        }
        return parsed
    }
}
