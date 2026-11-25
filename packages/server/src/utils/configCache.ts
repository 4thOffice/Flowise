import cluster from 'node:cluster'
import {
    DataSource,
    EntitySubscriberInterface,
    InsertEvent,
    QueryRunner,
    RemoveEvent,
    TransactionCommitEvent,
    TransactionRollbackEvent,
    UpdateEvent
} from 'typeorm'
import { ChatFlow } from '../database/entities/ChatFlow'
import { Credential } from '../database/entities/Credential'
import { Variable } from '../database/entities/Variable'
import { Organization } from '../enterprise/database/entities/organization.entity'
import { Workspace } from '../enterprise/database/entities/workspace.entity'
import { getWorkspaceSearchOptions } from '../enterprise/utils/ControllerServiceUtils'
import { IReactFlowObject } from '../Interface'
import { getErrorMessage } from '../errors/utils'
import logger from './logger'

/*
 * The configuration a prediction reads is served from memory unless DISABLE_CONFIG_CACHE=true. Writes through TypeORM in this
 * process, or in another worker of `flowise multi`, reload the written kind, and predictions wait for that reload. A row another
 * instance or a queue worker's server created is read from the database on the first miss; its other changes only arrive with the
 * periodic reload (CONFIG_CACHE_REFRESH_SECONDS, default 30, 0 = never).
 */

type Kind = 'chatflows' | 'workspaces' | 'variables' | 'credentials'

interface ChatflowEntry {
    row: ChatFlow
    parsed?: IReactFlowObject
}

interface Snapshot {
    chatflows: Map<string, ChatflowEntry>
    workspaces: Map<string, Workspace>
    variables: Map<string, Variable[]>
    credentials: Map<string, Credential>
}

const KIND_BY_ENTITY = new Map<Function, Kind>([
    [ChatFlow, 'chatflows'],
    [Workspace, 'workspaces'],
    [Organization, 'workspaces'],
    [Variable, 'variables'],
    [Credential, 'credentials']
])

export const isConfigCacheEnabled = () => process.env.DISABLE_CONFIG_CACHE !== 'true'

const refreshSeconds = () => {
    const value = Number(process.env.CONFIG_CACHE_REFRESH_SECONDS ?? 30)
    return Number.isFinite(value) && value > 0 ? value : 0
}

// The one place that decides what is served from memory; per-flow or per-kind rules go here
const cachePolicy = (_kind: Kind, _id?: string): boolean => isConfigCacheEnabled()

const RELOAD = 'flowise:configCache:reload'
const RELAYED = 'flowise:configCache:relayed'

interface ReloadMessage {
    type: typeof RELOAD
    id: number
    kinds: Kind[]
}

/** How this process reaches the other processes serving the same database. */
export interface PeerChannel {
    send: (message: ReloadMessage) => void
    subscribe: (listener: (message: any) => void) => () => void
}

// The workers of `flowise multi`, through the primary (relayConfigCacheReloads)
const clusterPeers = (): PeerChannel | undefined =>
    cluster.isWorker
        ? {
              send: (message) => process.send?.(message),
              subscribe: (listener) => {
                  process.on('message', listener)
                  return () => void process.off('message', listener)
              }
          }
        : undefined

// A primary that never answers must not hold up saves
const RELAY_TIMEOUT_MS = 1000

let snapshot: Partial<Snapshot> = {}
let dataSource: DataSource | undefined
let refreshTimer: NodeJS.Timeout | undefined
const inFlight = new Map<Kind, Promise<void>>()
const queued = new Map<Kind, Promise<void>>()
const afterLocalWrite = new Map<Kind, Promise<void>>()
const pendingByQueryRunner = new WeakMap<QueryRunner, Set<Kind>>()
let peers: PeerChannel | undefined
let unsubscribe: (() => void) | undefined
let lastMessageId = 0
const awaitingRelay = new Map<number, () => void>()

const loaders: { [K in Kind]: (ds: DataSource) => Promise<Snapshot[K]> } = {
    chatflows: async (ds) => {
        const previous = snapshot.chatflows
        const rows = await ds.getRepository(ChatFlow).find()
        return new Map(
            rows.map((row) => {
                const kept = previous?.get(row.id)
                return [row.id, { row, parsed: kept?.row.flowData === row.flowData ? kept.parsed : undefined }]
            })
        )
    },
    workspaces: async (ds) => {
        const rows = await ds.getRepository(Workspace).find({ relations: { organization: true } })
        return new Map(rows.map((row) => [row.id, row]))
    },
    variables: async (ds) => {
        const byWorkspace = new Map<string, Variable[]>()
        for (const row of await ds.getRepository(Variable).find()) {
            const list = byWorkspace.get(row.workspaceId) ?? []
            list.push(row)
            byWorkspace.set(row.workspaceId, list)
        }
        return byWorkspace
    },
    credentials: async (ds) => {
        const rows = await ds.getRepository(Credential).find()
        return new Map(rows.map((row) => [row.id, row]))
    }
}

const reload = (kind: Kind): Promise<void> => {
    const ds = dataSource
    if (!ds) return Promise.resolve()
    const running = inFlight.get(kind)
    if (running) {
        // A write committed while this load was reading may be missing from it, so load once more after it
        let next = queued.get(kind)
        if (!next) {
            next = running.then(() => {
                queued.delete(kind)
                return reload(kind)
            })
            queued.set(kind, next)
        }
        return next
    }
    const task = (async () => {
        try {
            const loaded = await loaders[kind](ds)
            // Stopped while loading
            if (dataSource === ds) (snapshot as any)[kind] = loaded
        } catch (error) {
            logger.warn(`[configCache]: Failed to load ${kind}: ${getErrorMessage(error)}`)
        } finally {
            inFlight.delete(kind)
        }
    })()
    inFlight.set(kind, task)
    return task
}

// Registered during the commit, so a prediction sent after the save resolves waits for it; the save itself does not wait
const reloadAfterWrite = (kind: Kind) => {
    const task = reload(kind)
    afterLocalWrite.set(kind, task)
    void task.then(() => {
        if (afterLocalWrite.get(kind) === task) afterLocalWrite.delete(kind)
    })
}

const KINDS = Object.keys(loaders) as Kind[]

const reloadAll = () => Promise.all(KINDS.map(reload)).then(() => undefined)

// Resolves once the primary has passed the reload on. With round-robin scheduling (the default except on Windows) it hands new
// connections to a worker over the same channel, so a request sent after the save returns reaches the worker after the reload.
const tellPeers = (kinds: Kind[]): Promise<void> | void => {
    const channel = peers
    if (!channel) return
    return new Promise((resolve) => {
        const id = ++lastMessageId
        const done = () => {
            clearTimeout(timer)
            awaitingRelay.delete(id)
            resolve()
        }
        const timer = setTimeout(done, RELAY_TIMEOUT_MS)
        awaitingRelay.set(id, done)
        try {
            channel.send({ type: RELOAD, id, kinds })
        } catch (error) {
            logger.warn(`[configCache]: Failed to tell the other processes about a write: ${getErrorMessage(error)}`)
            done()
        }
    })
}

const committed = (kinds: Kind[]) => {
    kinds.forEach(reloadAfterWrite)
    return tellPeers(kinds)
}

const onPeerMessage = (message: any) => {
    if (message?.type === RELAYED) awaitingRelay.get(message.id)?.()
    else if (message?.type === RELOAD) (message.kinds as Kind[]).filter((kind) => KINDS.includes(kind)).forEach(reloadAfterWrite)
}

/** Runs in the `flowise multi` primary: passes each worker's reloads on to the other workers, then answers the sender. */
export const relayConfigCacheReloads = () => {
    // A worker that is going away misses the message; its replacement loads everything when it starts
    const ignoreGone = () => undefined
    cluster.on('message', (sender, message) => {
        if (message?.type !== RELOAD) return
        for (const worker of Object.values(cluster.workers ?? {})) {
            if (worker && worker !== sender && worker.isConnected()) worker.send(message, undefined, ignoreGone)
        }
        if (sender.isConnected()) sender.send({ type: RELAYED, id: message.id }, undefined, ignoreGone)
    })
}

class ConfigCacheSubscriber implements EntitySubscriberInterface {
    private written({ queryRunner, metadata }: InsertEvent<any> | UpdateEvent<any> | RemoveEvent<any>) {
        const target = metadata.target
        const kind = typeof target === 'function' ? KIND_BY_ENTITY.get(target) : undefined
        if (!kind) return
        if (!queryRunner.isTransactionActive) return committed([kind])
        const kinds = pendingByQueryRunner.get(queryRunner) ?? new Set<Kind>()
        kinds.add(kind)
        pendingByQueryRunner.set(queryRunner, kinds)
    }
    afterInsert = this.written
    afterUpdate = this.written
    afterRemove = this.written
    afterSoftRemove = this.written
    afterRecover = this.written
    private ended({ queryRunner }: TransactionCommitEvent | TransactionRollbackEvent): Kind[] | undefined {
        // A nested transaction is not durable until the outermost one commits. On SQLite every request shares one
        // connection, so a save made while another request's transaction is open is nested in it.
        if (queryRunner.isTransactionActive) return
        const kinds = pendingByQueryRunner.get(queryRunner)
        pendingByQueryRunner.delete(queryRunner)
        return kinds && [...kinds]
    }
    afterTransactionCommit = (event: TransactionCommitEvent) => {
        const kinds = this.ended(event)
        if (kinds) return committed(kinds)
    }
    // A load on that same connection may have read the rows it rolled back; other processes never saw them
    afterTransactionRollback = (event: TransactionRollbackEvent) => this.ended(event)?.forEach(reloadAfterWrite)
}

/** Loads everything and starts keeping it current; a no-op when DISABLE_CONFIG_CACHE=true. */
export const startConfigCache = async (appDataSource: DataSource, channel: PeerChannel | undefined = clusterPeers()): Promise<void> => {
    if (!isConfigCacheEnabled() || dataSource) return
    dataSource = appDataSource
    appDataSource.subscribers.push(new ConfigCacheSubscriber())
    peers = channel
    unsubscribe = channel?.subscribe(onPeerMessage)
    await reloadAll()
    const seconds = refreshSeconds()
    if (seconds) {
        refreshTimer = setInterval(() => void reloadAll(), seconds * 1000)
        refreshTimer.unref()
    }
    logger.info(
        `🗂️ [server]: Config cache loaded (${snapshot.chatflows?.size ?? 0} chatflows), ` +
            (seconds ? `refreshing every ${seconds}s` : 'periodic refresh off') +
            (channel ? ', reloading on writes in the other workers' : '')
    )
}

export const stopConfigCache = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = undefined
    unsubscribe?.()
    unsubscribe = undefined
    peers = undefined
    ;[...awaitingRelay.values()].forEach((done) => done())
    if (dataSource) {
        const index = dataSource.subscribers.findIndex((subscriber) => subscriber instanceof ConfigCacheSubscriber)
        if (index >= 0) dataSource.subscribers.splice(index, 1)
    }
    dataSource = undefined
    snapshot = {}
}

/** Waits for reloads already triggered by writes; for tests. */
export const settleConfigCache = async () => {
    while (inFlight.size || queued.size) await Promise.all([...inFlight.values(), ...queued.values()])
}

const servedNow = <K extends Kind>(kind: K, id?: string): Snapshot[K] | undefined => (cachePolicy(kind, id) ? snapshot[kind] : undefined)

const served = async <K extends Kind>(kind: K, id?: string): Promise<Snapshot[K] | undefined> => {
    const pending = afterLocalWrite.get(kind)
    if (pending) await pending
    return servedNow(kind, id)
}

// A miss may be a row another instance or a queue worker's server wrote since the last load
const readMissed = async <T>(kind: Kind, read: () => Promise<T | null>): Promise<T | null> => {
    const row = await read()
    if (row) void reload(kind)
    return row
}

// Callers get copies so a change they make to a row (an evaluation run sets chatflow.analytic) stays in their request
const copy = <T extends object>(Entity: new () => T, row: T): T => Object.assign(new Entity(), row)

export const getChatflow = async (appDataSource: DataSource, id: string, workspaceId?: string): Promise<ChatFlow | null> => {
    const read = () => appDataSource.getRepository(ChatFlow).findOneBy({ id, ...(workspaceId ? { workspaceId } : {}) })
    const chatflows = await served('chatflows', id)
    if (!chatflows) return read()
    const entry = chatflows.get(id)
    if (!entry) return readMissed('chatflows', read)
    if (workspaceId && entry.row.workspaceId !== workspaceId) return null
    return copy(ChatFlow, entry.row)
}

export const getWorkspaceWithOrganization = async (appDataSource: DataSource, id: string): Promise<Workspace | null> => {
    const read = () => appDataSource.getRepository(Workspace).findOne({ where: { id }, relations: { organization: true } })
    const workspaces = await served('workspaces', id)
    if (!workspaces) return read()
    const row = workspaces.get(id)
    if (!row) return readMissed('workspaces', read)
    return Object.assign(copy(Workspace, row), { organization: row.organization && copy(Organization, row.organization) })
}

export const getVariables = async (appDataSource: DataSource, workspaceId?: string): Promise<Variable[]> => {
    const where = getWorkspaceSearchOptions(workspaceId)
    const variables = await served('variables', workspaceId)
    if (!variables) return appDataSource.getRepository(Variable).findBy(where)
    return (variables.get(workspaceId!) ?? []).map((row) => copy(Variable, row))
}

export const getCredential = async (appDataSource: DataSource, id: string): Promise<Credential | null> => {
    const read = () => appDataSource.getRepository(Credential).findOneBy({ id })
    const credentials = await served('credentials', id)
    if (!credentials) return read()
    const row = credentials.get(id)
    return row ? copy(Credential, row) : readMissed('credentials', read)
}

const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

/**
 * The chatflow's parsed flowData. For a chatflow served from the cache it is parsed once and shared by every request,
 * so it is frozen: copy before changing any part of it.
 */
export const getParsedFlow = (chatflow: ChatFlow): IReactFlowObject => {
    const entry = servedNow('chatflows', chatflow.id)?.get(chatflow.id)
    if (!entry || entry.row.flowData !== chatflow.flowData) return JSON.parse(chatflow.flowData)
    return (entry.parsed ??= deepFreeze(JSON.parse(entry.row.flowData)))
}
