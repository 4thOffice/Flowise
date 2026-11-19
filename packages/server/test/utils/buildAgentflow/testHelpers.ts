import fs from 'fs'
import path from 'path'
import { cloneDeep } from 'lodash'
import { DataSource } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { ICommonObject, IServerSideEventStreamer } from 'flowise-components'
import { executeAgentFlow } from '../../../src/utils/buildAgentflow'
import {
    IAgentflowNodeInstance,
    NodeInstanceFactory
} from '../../../src/utils/agentflow/types'
import {
    IComponentNodes,
    IncomingAgentflowInput,
    INodeData,
    IReactFlowEdge,
    IReactFlowNode,
    IReactFlowObject
} from '../../../src/Interface'
import { ChatFlow } from '../../../src/database/entities/ChatFlow'
import { CachePool } from '../../../src/CachePool'
import { UsageCacheManager } from '../../../src/UsageCacheManager'
import { Telemetry } from '../../../src/utils/telemetry'

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const AGENTFLOW_NODES_DIR = path.join(REPO_ROOT, 'packages/components/dist/nodes/agentflow')
const BASELINE_FLOWS_DIR = path.join(REPO_ROOT, 'plans/agentflow-concurrent-execution/baselines/flows')

export interface Deferred<T = void> {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: any) => void
    isSettled: () => boolean
}

export function createDeferred<T = void>(): Deferred<T> {
    let settled = false
    let resolveFn!: (value: T | PromiseLike<T>) => void
    let rejectFn!: (reason?: any) => void
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = (value) => {
            settled = true
            resolve(value)
        }
        rejectFn = (reason) => {
            settled = true
            reject(reason)
        }
    })
    return {
        promise,
        resolve: resolveFn,
        reject: rejectFn,
        isSettled: () => settled
    }
}

export interface Barrier {
    arrive: () => Promise<void>
    arrivedCount: () => number
    release: () => void
}

export function createBarrier(count: number, timeoutMs = 2000): Barrier {
    let arrived = 0
    let released = false
    let failedError: Error | undefined
    let timer: NodeJS.Timeout | undefined
    const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
    }

    const release = () => {
        if (released || failedError) return
        released = true
        clearTimer()
        while (waiters.length > 0) {
            waiters.shift()!.resolve()
        }
    }

    const fail = (err: Error) => {
        if (released || failedError) return
        failedError = err
        clearTimer()
        while (waiters.length > 0) {
            waiters.shift()!.reject(err)
        }
    }

    const arrive = () => {
        if (failedError) return Promise.reject(failedError)
        if (released) return Promise.resolve()
        arrived += 1
        if (arrived >= count) {
            release()
            return Promise.resolve()
        }
        if (!timer && timeoutMs > 0) {
            timer = setTimeout(() => {
                fail(new Error(`Barrier timed out after ${timeoutMs}ms (${arrived}/${count} arrived)`))
            }, timeoutMs)
            timer.unref?.()
        }
        return new Promise<void>((resolve, reject) => {
            waiters.push({ resolve, reject })
        })
    }

    return {
        arrive,
        arrivedCount: () => arrived,
        release
    }
}

export interface ConcurrencyEvent {
    nodeId: string
    type: 'start' | 'end' | 'error'
    order: number
    timestamp: number
}

export interface ConcurrencyTiming {
    startTime: number
    endTime?: number
}

export class ConcurrencyTracker {
    active = 0
    maxObserved = 0
    events: ConcurrencyEvent[] = []
    timings: Map<string, ConcurrencyTiming[]> = new Map()
    private sequence = 0

    enter(nodeId: string): void {
        const now = Date.now()
        this.active += 1
        if (this.active > this.maxObserved) {
            this.maxObserved = this.active
        }
        this.events.push({ nodeId, type: 'start', order: this.sequence++, timestamp: now })
        const list = this.timings.get(nodeId) ?? []
        list.push({ startTime: now })
        this.timings.set(nodeId, list)
    }

    leave(nodeId: string): void {
        const now = Date.now()
        this.active = Math.max(0, this.active - 1)
        this.events.push({ nodeId, type: 'end', order: this.sequence++, timestamp: now })
        const list = this.timings.get(nodeId)
        const latest = list?.[list.length - 1]
        if (latest && latest.endTime === undefined) {
            latest.endTime = now
        }
    }

    fail(nodeId: string): void {
        const now = Date.now()
        this.active = Math.max(0, this.active - 1)
        this.events.push({ nodeId, type: 'error', order: this.sequence++, timestamp: now })
        const list = this.timings.get(nodeId)
        const latest = list?.[list.length - 1]
        if (latest && latest.endTime === undefined) {
            latest.endTime = now
        }
    }

    async track<T>(nodeId: string, fn: () => Promise<T> | T): Promise<T> {
        this.enter(nodeId)
        try {
            const res = await fn()
            this.leave(nodeId)
            return res
        } catch (err) {
            this.fail(nodeId)
            throw err
        }
    }

    reset(): void {
        this.active = 0
        this.maxObserved = 0
        this.events = []
        this.timings.clear()
        this.sequence = 0
    }
}

function unwrapFindValue(val: any): any {
    if (val && typeof val === 'object' && '_value' in val) {
        return val._value
    }
    return val
}

export function createMockDataSource(seedVariables: Array<Record<string, any>> = []) {
    const executions: any[] = []
    const chatMessages: any[] = []
    const variables = seedVariables.map((v) => ({ ...v }))

    const executionRepo = {
        create: (obj: any) => ({ ...obj }),
        save: async (obj: any) => {
            const now = new Date()
            const existingIdx = executions.findIndex((e) => e.id && e.id === obj.id)
            if (existingIdx >= 0) {
                executions[existingIdx] = { ...executions[existingIdx], ...obj, updatedDate: now }
                return executions[existingIdx]
            }
            const record = {
                ...obj,
                id: obj.id || uuidv4(),
                createdDate: obj.createdDate || now,
                updatedDate: now
            }
            executions.push(record)
            return record
        },
        findOneBy: async (where: Record<string, any>) => {
            return (
                executions.find((row) =>
                    Object.entries(where).every(([k, v]) => unwrapFindValue(v) === undefined || row[k] === unwrapFindValue(v))
                ) || null
            )
        },
        findOne: async ({ where, order }: { where: Record<string, any>; order?: Record<string, 'ASC' | 'DESC'> }) => {
            let matched = executions.filter((row) =>
                Object.entries(where || {}).every(([k, v]) => unwrapFindValue(v) === undefined || row[k] === unwrapFindValue(v))
            )
            if (order?.createdDate === 'DESC') {
                matched = [...matched].reverse()
            }
            return matched[0] || null
        },
        merge: (target: any, source: any) => Object.assign(target, source)
    }

    const chatMessageRepo = {
        create: (obj: any) => ({ ...obj }),
        save: async (obj: any) => {
            const existingIdx = chatMessages.findIndex((m) => m.id && m.id === obj.id)
            if (existingIdx >= 0) {
                chatMessages[existingIdx] = { ...chatMessages[existingIdx], ...obj }
                return chatMessages[existingIdx]
            }
            const record = {
                ...obj,
                id: obj.id || uuidv4(),
                createdDate: obj.createdDate || new Date()
            }
            chatMessages.push(record)
            return record
        },
        remove: async (obj: any) => {
            const idx = chatMessages.findIndex((m) => m.id === obj.id)
            if (idx >= 0) chatMessages.splice(idx, 1)
            return obj
        },
        find: async ({ where, order }: { where: Record<string, any>; order?: Record<string, 'ASC' | 'DESC'> }) => {
            let matched = chatMessages.filter((row) =>
                Object.entries(where || {}).every(([k, v]) => unwrapFindValue(v) === undefined || row[k] === unwrapFindValue(v))
            )
            if (order?.createdDate === 'DESC') {
                matched = [...matched].reverse()
            }
            return matched
        },
        createQueryBuilder: () => {
            const filters: Array<{ field: string; value: any }> = []
            let sortDir: 'ASC' | 'DESC' = 'ASC'
            const qb = {
                where: (clause: string, params: Record<string, any>) => {
                    const key = Object.keys(params)[0]
                    if (clause.includes(key)) filters.push({ field: key, value: params[key] })
                    return qb
                },
                orWhere: (clause: string, params: Record<string, any>) => {
                    const key = Object.keys(params)[0]
                    if (clause.includes(key)) filters.push({ field: key, value: params[key] })
                    return qb
                },
                orderBy: (_col: string, dir: 'ASC' | 'DESC') => {
                    sortDir = dir
                    return qb
                },
                getMany: async () => {
                    const matched = chatMessages.filter((row) => filters.some((f) => row[f.field] === f.value))
                    return sortDir === 'DESC' ? [...matched].reverse() : matched
                }
            }
            return qb
        }
    }

    const variableRepo = {
        findBy: async (where: Record<string, any>) => {
            return variables
                .filter((row) =>
                    Object.entries(where || {}).every(([k, v]) => unwrapFindValue(v) === undefined || row[k] === unwrapFindValue(v))
                )
                .map((v) => ({ ...v }))
        }
    }

    const appDataSource = {
        getRepository: (entity: any) => {
            const entityName = typeof entity === 'function' ? entity.name : entity?.name
            if (entityName === 'Execution') return executionRepo
            if (entityName === 'ChatMessage') return chatMessageRepo
            if (entityName === 'Variable') return variableRepo
            throw new Error(`Unexpected repository request: ${String(entityName)}`)
        }
    } as unknown as DataSource

    return { appDataSource, executions, chatMessages }
}

export interface RecordedSSEStreamerEvent {
    type: string
    chatId: string
    data?: any
}

export function createMockSSEStreamer() {
    const events: RecordedSSEStreamerEvent[] = []
    const record = (type: string, chatId: string, data?: any) => {
        events.push({ type, chatId, data })
    }

    const sseStreamer: IServerSideEventStreamer = {
        streamStartEvent: (chatId, data) => record('start', chatId, data),
        streamTokenEvent: (chatId, data) => record('token', chatId, data),
        streamCustomEvent: (chatId, eventType, data) => record(eventType, chatId, data),
        streamSourceDocumentsEvent: (chatId, data) => record('sourceDocuments', chatId, data),
        streamUsedToolsEvent: (chatId, data) => record('usedTools', chatId, data),
        streamCalledToolsEvent: (chatId, data) => record('calledTools', chatId, data),
        streamFileAnnotationsEvent: (chatId, data) => record('fileAnnotations', chatId, data),
        streamToolEvent: (chatId, data) => record('tool', chatId, data),
        streamAgentReasoningEvent: (chatId, data) => record('agentReasoning', chatId, data),
        streamAgentFlowExecutedDataEvent: (chatId, data) => record('agentFlowExecutedData', chatId, cloneDeep(data)),
        streamTrustedStateDataEvent: (chatId, data) => record('trustedStateData', chatId, data),
        streamAgentFlowEvent: (chatId, data) => record('agentFlowEvent', chatId, data),
        streamNextAgentEvent: (chatId, data) => record('nextAgent', chatId, data),
        streamNextAgentFlowEvent: (chatId, data) => record('nextAgentFlow', chatId, data),
        streamActionEvent: (chatId, data) => record('action', chatId, data),
        streamArtifactsEvent: (chatId, data) => record('artifacts', chatId, data),
        streamAbortEvent: (chatId) => record('abort', chatId),
        streamEndEvent: (chatId) => record('end', chatId),
        streamUsageMetadataEvent: (chatId, data) => record('usageMetadata', chatId, data),
        streamTTSStartEvent: (chatId, chatMessageId, format) => record('tts_start', chatId, { chatMessageId, format }),
        streamTTSDataEvent: (chatId, chatMessageId, audioChunk) => record('tts_data', chatId, { chatMessageId, audioChunk }),
        streamTTSEndEvent: (chatId, chatMessageId) => record('tts_end', chatId, { chatMessageId })
    }

    return {
        sseStreamer,
        events,
        getEvents: (type?: string) => (type ? events.filter((e) => e.type === type) : events)
    }
}

export function loadRealComponentNodes(): IComponentNodes {
    const specs: Array<[string, string]> = [
        ['startAgentflow', 'Start/Start.js'],
        ['customFunctionAgentflow', 'CustomFunction/CustomFunction.js'],
        ['conditionAgentflow', 'Condition/Condition.js'],
        ['directReplyAgentflow', 'DirectReply/DirectReply.js'],
        ['humanInputAgentflow', 'HumanInput/HumanInput.js'],
        ['loopAgentflow', 'Loop/Loop.js'],
        ['iterationAgentflow', 'Iteration/Iteration.js']
    ]

    const componentNodes: IComponentNodes = {}
    for (const [name, relPath] of specs) {
        const filePath = path.join(AGENTFLOW_NODES_DIR, relPath)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(filePath)
        const instance = new mod.nodeClass()
        componentNodes[name] = Object.assign(instance, { filePath })
    }
    return componentNodes
}

export interface CreateNodeOptions {
    label?: string
    inputs?: Record<string, any>
    inputParams?: any[]
    position?: { x: number; y: number }
    parentNode?: string
    extent?: string
    outputs?: Record<string, any>
}

export function createNode(
    id: string,
    name: string,
    options: CreateNodeOptions = {},
    componentNodes?: IComponentNodes
): IReactFlowNode {
    const comp = componentNodes?.[name]
    const defaultInputs: Record<string, any> = {}
    const inputParams =
        options.inputParams ??
        (comp?.inputs || []).map((param: any) => {
            defaultInputs[param.name] = param.default !== undefined ? param.default : ''
            return { ...param, id: `${id}-input-${param.name}-${param.type}` }
        })
    const position = options.position ?? { x: 0, y: 0 }

    return {
        id,
        type: 'agentFlow',
        position,
        positionAbsolute: position,
        z: 0,
        handleBounds: { source: null, target: null },
        width: 300,
        height: 150,
        selected: false,
        dragging: false,
        ...(options.parentNode ? { parentNode: options.parentNode } : {}),
        ...(options.extent ? { extent: options.extent } : {}),
        data: {
            id,
            label: options.label ?? comp?.label ?? id,
            name,
            version: comp?.version ?? 1,
            type: comp?.type ?? name,
            icon: comp?.icon ?? '',
            category: comp?.category ?? 'Agent Flows',
            baseClasses: comp?.baseClasses ?? [name],
            inputAnchors: [],
            outputAnchors: [],
            outputs: options.outputs ?? {},
            inputParams,
            inputs: { ...defaultInputs, ...(options.inputs ?? {}) }
        }
    }
}

export function createEdge(source: string, target: string, sourceHandle?: string, id?: string): IReactFlowEdge {
    return {
        id: id ?? `${source}-${sourceHandle || 'out'}-${target}`,
        source,
        sourceHandle: sourceHandle ?? `${source}-output`,
        target,
        targetHandle: target,
        type: 'agentFlow',
        data: { label: '' }
    }
}

export function createFlow(nodes: IReactFlowNode[], edges: IReactFlowEdge[]): IReactFlowObject {
    return {
        nodes,
        edges,
        viewport: { x: 0, y: 0, zoom: 1 }
    }
}

export function createChatflow(flow: IReactFlowObject, extra: Partial<ChatFlow> = {}): ChatFlow {
    return {
        id: 'cf-test-1',
        name: 'Agentflow Test Flow',
        type: 'AGENTFLOW',
        flowData: JSON.stringify(flow),
        workspaceId: 'ws-1',
        ...extra
    } as ChatFlow
}

export type MockNodeHandler = (
    nodeData: INodeData,
    input: string | Record<string, any> | undefined,
    options: ICommonObject
) => Promise<any> | any

export function createMockNodeFactory(
    handlers: Record<string, MockNodeHandler>,
    fallbackComponentNodes?: IComponentNodes
): NodeInstanceFactory {
    return async (nodeName: string, reactFlowNode: IReactFlowNode, componentNodes: IComponentNodes): Promise<IAgentflowNodeInstance> => {
        const handler = handlers[reactFlowNode.id] ?? handlers[nodeName]
        if (handler) {
            return {
                run: async (nodeData, input, options) => handler(nodeData, input, options)
            }
        }

        const targetComponent = componentNodes?.[nodeName] ?? fallbackComponentNodes?.[nodeName]
        if (targetComponent?.filePath) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(targetComponent.filePath)
            return new mod.nodeClass()
        }

        throw new Error(`No mock handler or component node registered for ${reactFlowNode.id} (${nodeName})`)
    }
}

export interface RunTestAgentFlowOptions {
    flow?: IReactFlowObject
    chatflow?: ChatFlow
    incomingInput?: IncomingAgentflowInput
    appDataSource?: DataSource
    componentNodes?: IComponentNodes
    sseStreamer?: IServerSideEventStreamer
    chatId?: string
    signal?: AbortController
    nodeInstanceFactory?: NodeInstanceFactory
    isInternal?: boolean
}

export async function runTestAgentFlow({
    flow,
    chatflow,
    incomingInput = { question: 'test' },
    appDataSource,
    componentNodes = {},
    sseStreamer,
    chatId = `chat-${uuidv4()}`,
    signal,
    nodeInstanceFactory,
    isInternal = false
}: RunTestAgentFlowOptions) {
    const resolvedChatflow = chatflow ?? (flow ? createChatflow(flow) : undefined)
    if (!resolvedChatflow) {
        throw new Error('runTestAgentFlow requires either flow or chatflow')
    }
    const resolvedDataSource = appDataSource ?? createMockDataSource().appDataSource
    const telemetry = { sendTelemetry: jest.fn().mockResolvedValue(undefined) } as unknown as Telemetry

    return executeAgentFlow({
        componentNodes,
        incomingInput,
        chatflow: resolvedChatflow,
        chatId,
        appDataSource: resolvedDataSource,
        telemetry,
        usageCacheManager: {} as UsageCacheManager,
        cachePool: {} as CachePool,
        sseStreamer: sseStreamer as IServerSideEventStreamer,
        baseURL: 'http://localhost:3000',
        isInternal,
        signal,
        orgId: 'org-1',
        workspaceId: 'ws-1',
        subscriptionId: '',
        productId: '',
        nodeInstanceFactory
    })
}

export function loadBaselineFlow(filename: string): IReactFlowObject {
    const filePath = path.join(BASELINE_FLOWS_DIR, filename)
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as IReactFlowObject
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}
