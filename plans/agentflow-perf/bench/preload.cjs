// Timing preload for the Flowise server (NODE_OPTIONS="-r preload.cjs"). Wraps exported functions (compiled CJS call
// sites read them from the exports object at call time), TypeORM repository methods and node run() methods, and writes
// one JSON line per prediction request to $BENCH_OUT: inclusive ms and call count per span. Module-local functions
// (executeNode, resolveVariables, addExecution) cannot be wrapped and show up in their callers' time.
// BENCH_FIXES=appversion,turndown,logger emulates the candidate fixes without changing the build.
// GET /__bench/prof/start?us=100 and /__bench/prof/stop?file=<abs path> record a CPU profile.
const fs = require('fs')
const http = require('http')
const Module = require('module')
const { performance } = require('perf_hooks')
const { AsyncLocalStorage } = require('async_hooks')

const OUT = process.env.BENCH_OUT
const als = new AsyncLocalStorage()

function record(name, ms) {
    const store = als.getStore()
    if (!store) return
    const s = store.spans[name] || (store.spans[name] = { n: 0, ms: 0 })
    s.n++
    s.ms += ms
}

function wrapFn(fn, name) {
    if (typeof fn !== 'function' || fn.__benchWrapped) return fn
    const wrapped = function (...args) {
        if (!als.getStore()) return fn.apply(this, args)
        const t0 = performance.now()
        let out
        try {
            out = fn.apply(this, args)
        } catch (e) {
            record(name, performance.now() - t0)
            throw e
        }
        if (out && typeof out.then === 'function') {
            return out.then(
                (v) => (record(name, performance.now() - t0), v),
                (e) => {
                    record(name, performance.now() - t0)
                    throw e
                }
            )
        }
        record(name, performance.now() - t0)
        return out
    }
    wrapped.__benchWrapped = true
    Object.defineProperty(wrapped, 'name', { value: fn.name })
    return wrapped
}

function patchProp(obj, key, name) {
    if (!obj) return
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc) return
    if (desc.get) {
        const value = obj[key]
        if (typeof value !== 'function') return
        try {
            Object.defineProperty(obj, key, { configurable: true, enumerable: desc.enumerable, value: wrapFn(value, name), writable: true })
        } catch {
            /* non-configurable re-export */
        }
        return
    }
    if (typeof desc.value === 'function') obj[key] = wrapFn(desc.value, name)
}

const SERVER_PATCHES = {
    'controllers/predictions/index.js': { default: ['createPrediction'] },
    'services/chatflows/index.js': { default: ['getChatflowById', 'getStreamingSupport'] },
    'services/predictions/index.js': { default: ['buildChatflow'] },
    'utils/flowRedirect.js': ['resolveFlowRedirect'],
    'utils/buildChatflow.js': ['utilBuildChatflow'],
    'utils/validateKey.js': ['validateFlowAPIKey', 'validateAPIKey'],
    'utils/quotaUsage.js': ['checkPredictions', 'updatePredictionsUsage', 'checkStorage'],
    'utils/buildAgentflow.js': ['executeAgentFlow'],
    'utils/agentflow/trustedState.js': [
        'readTurnInput',
        'writeToken',
        'buildTrustedState',
        'findOutputReferences',
        'logTurnTokens',
        'buildPendingResume'
    ],
    'utils/index.js': [
        'constructGraphs',
        'getAPIOverrideConfig',
        'getStartingNode',
        'getTelemetryFlowObj',
        'getAppVersion',
        'replaceInputsWithConfig',
        'getGlobalVariable',
        'validateHistorySchema',
        '_removeCredentialId'
    ],
    'utils/agentflow/dependencyEngine.js': ['createDependencyEngine', 'computeTopologicalLevels'],
    'utils/agentflow/scheduler.js': ['runConcurrentNodeScheduler'],
    'utils/agentflow/stateReconciler.js': ['createNodeRuntimeSnapshot', 'reconcileRuntimeCommit', 'commitExecutedDataDelta'],
    'utils/agentflow/terminalCoordinator.js': ['resolveTerminalContent', 'aggregateTerminalMetadata'],
    'utils/agentflow/clientPayloads.js': ['toClientExecutedData'],
    'utils/agentflow/faultCoordinator.js': ['selectPrimaryStoppedAction'],
    'utils/addChatMesage.js': ['utilAddChatMessage']
}

const FIXES = new Set((process.env.BENCH_FIXES || '').split(',').filter(Boolean))

function applyServerPatch(rel, exp) {
    if (rel === 'utils/index.js' && FIXES.has('appversion')) {
        const orig = exp.getAppVersion
        let cached
        exp.getAppVersion = () => (cached ??= orig())
    }
    const spec = SERVER_PATCHES[rel]
    const prefix = rel
        .replace(/\/index\.js$/, '')
        .replace(/\.js$/, '')
        .replace(/^.*\//, '')
    if (Array.isArray(spec)) {
        for (const key of spec) patchProp(exp, key, `${prefix}.${key}`)
    } else {
        for (const [objKey, keys] of Object.entries(spec)) for (const key of keys) patchProp(exp[objKey], key, `${prefix}.${key}`)
    }
}

function timedConstructor(Cls, name) {
    return new Proxy(Cls, {
        construct(target, args, newTarget) {
            if (!als.getStore()) return Reflect.construct(target, args, newTarget)
            const t0 = performance.now()
            try {
                return Reflect.construct(target, args, newTarget)
            } finally {
                record(name, performance.now() - t0)
            }
        }
    })
}

const patched = new Set()
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    const exp = origLoad.apply(this, arguments)
    let filename
    try {
        filename = Module._resolveFilename(request, parent, isMain)
    } catch {
        return exp
    }
    if (patched.has(filename)) return exp
    // A cyclic require returns partial exports before the module finished; patch on the completing load
    if (Module._cache[filename] && !Module._cache[filename].loaded) return exp
    const serverMatch = filename.match(/packages\/server\/dist\/(.+)$/)
    if (serverMatch && SERVER_PATCHES[serverMatch[1]]) {
        patched.add(filename)
        applyServerPatch(serverMatch[1], exp)
    } else if (serverMatch && serverMatch[1] === 'utils/telemetry.js') {
        patched.add(filename)
        patchProp(exp.Telemetry?.prototype, 'sendTelemetry', 'telemetry.sendTelemetry')
    } else if (serverMatch && serverMatch[1] === 'IdentityManager.js') {
        patched.add(filename)
        patchProp(exp.IdentityManager?.prototype, 'getProductIdFromSubscription', 'identity.getProductIdFromSubscription')
    } else if (serverMatch && serverMatch[1] === 'utils/logger.js') {
        patched.add(filename)
        if (FIXES.has('logger')) {
            for (const level of ['info', 'debug', 'warn', 'error', 'verbose']) {
                const orig = exp.default[level]
                exp.default[level] = function (...args) {
                    if (!this.isLevelEnabled(level)) return this
                    return orig.apply(this, args)
                }
            }
        }
        for (const level of ['info', 'debug', 'warn', 'error']) patchProp(exp.default, level, `logger.${level}`)
    } else if (/packages\/components\/dist\/nodes\/agentflow\/[^/]+\/[^/]+\.js$/.test(filename) && exp?.nodeClass?.prototype?.run) {
        patched.add(filename)
        const nodeName = filename.match(/agentflow\/([^/]+)\//)[1]
        patchProp(exp.nodeClass.prototype, 'run', `node:${nodeName}.run`)
    } else if (/packages\/components\/dist\/src\/utils\.js$/.test(filename)) {
        patched.add(filename)
        for (const key of [
            'executeJavaScriptCode',
            'getVars',
            'getCredentialData',
            'createCodeExecutionSandbox',
            'processTemplateVariables'
        ])
            patchProp(exp, key, `components.${key}`)
    } else if (/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?typeorm\/repository\/Repository\.js$/.test(filename)) {
        patched.add(filename)
        const proto = exp.Repository?.prototype
        for (const m of [
            'find',
            'findBy',
            'findOne',
            'findOneBy',
            'save',
            'update',
            'insert',
            'delete',
            'count',
            'countBy',
            'exists',
            'existsBy',
            'query',
            'upsert'
        ]) {
            const orig = proto?.[m]
            if (typeof orig !== 'function') continue
            proto[m] = function (...args) {
                if (!als.getStore()) return orig.apply(this, args)
                const entity = this.metadata?.name ?? 'unknown'
                return wrapFn(orig, `db:${entity}.${m}`).apply(this, args)
            }
        }
    } else if (/turndown\/lib\/turndown\.cjs\.js$/.test(filename)) {
        patched.add(filename)
        if (FIXES.has('turndown')) {
            const orig = exp.prototype.turndown
            const cache = new Map()
            exp.prototype.turndown = function (input) {
                if (typeof input !== 'string') return orig.call(this, input)
                let out = cache.get(input)
                if (out === undefined) {
                    out = orig.call(this, input)
                    if (cache.size > 5000) cache.clear()
                    cache.set(input, out)
                }
                return out
            }
        }
        patchProp(exp.prototype, 'turndown', 'turndown.turndown')
        const proxy = timedConstructor(exp, 'turndown.new TurndownService')
        Module._cache[filename].exports = proxy
        return proxy
    } else if (/@flowiseai\/nodevm\/index\.js$/.test(filename)) {
        patched.add(filename)
        patchProp(exp.NodeVM?.prototype, 'run', 'vm2.NodeVM.run')
        try {
            exp.NodeVM = timedConstructor(exp.NodeVM, 'vm2.new NodeVM')
        } catch (e) {
            console.error('[bench] NodeVM patch failed', e.message)
        }
    } else if (/lodash\/lodash\.js$/.test(filename)) {
        patched.add(filename)
        patchProp(exp, 'cloneDeep', 'lodash.cloneDeep')
    }
    return exp
}

const inspector = require('inspector')
let profSession
function profControl(req, res) {
    const url = new URL(req.url, 'http://x')
    const done = (body) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(body)
    }
    if (url.pathname === '/__bench/prof/start') {
        profSession = new inspector.Session()
        profSession.connect()
        profSession.post('Profiler.enable', () =>
            profSession.post('Profiler.setSamplingInterval', { interval: Number(url.searchParams.get('us') || 200) }, () =>
                profSession.post('Profiler.start', () => done('started'))
            )
        )
    } else if (url.pathname === '/__bench/prof/stop') {
        profSession.post('Profiler.stop', (err, { profile }) => {
            fs.writeFileSync(url.searchParams.get('file'), JSON.stringify(profile))
            profSession.disconnect()
            done('written')
        })
    }
}

const origEmit = http.Server.prototype.emit
http.Server.prototype.emit = function (event, req, res) {
    if (event === 'request' && req.url.startsWith('/__bench/prof/')) return profControl(req, res), true
    if (event !== 'request' || !OUT || !/\/api\/v1\/(internal-)?prediction\//.test(req.url)) return origEmit.apply(this, arguments)
    const store = { spans: {}, t0: performance.now(), url: req.url, id: req.headers['x-bench-id'] }
    res.on('finish', () => {
        const line = { id: store.id, url: store.url, status: res.statusCode, totalMs: performance.now() - store.t0, spans: store.spans }
        fs.appendFileSync(OUT, JSON.stringify(line) + '\n')
    })
    return als.run(store, () => origEmit.apply(this, arguments))
}
