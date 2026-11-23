import path from 'path'
import { Response } from 'express'
import { DataSource } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { executeAgentFlow, resolveVariables } from '../../../src/utils/buildAgentflow'
import { SSEStreamer } from '../../../src/utils/SSEStreamer'
import { trusted_state_from_string } from '../../../src/utils/trustedStateHelper'
import { CachePool } from '../../../src/CachePool'
import { UsageCacheManager } from '../../../src/UsageCacheManager'
import { ChatFlow } from '../../../src/database/entities/ChatFlow'
import { IComponentNodes, INodeData } from '../../../src/Interface'

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => {
        throw new Error('getRunningExpressApp should not be called when appDataSource is injected')
    })
}))

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const AGENTFLOW_NODES_DIR = path.join(REPO_ROOT, 'packages/components/dist/nodes/agentflow')

function loadLocalAgentflowComponentNodes(): IComponentNodes {
    const specs: Array<[string, string]> = [
        ['startAgentflow', 'Start/Start.js'],
        ['customFunctionAgentflow', 'CustomFunction/CustomFunction.js'],
        ['conditionAgentflow', 'Condition/Condition.js'],
        ['directReplyAgentflow', 'DirectReply/DirectReply.js'],
        ['humanInputAgentflow', 'HumanInput/HumanInput.js'],
        ['loopAgentflow', 'Loop/Loop.js']
    ]

    const componentNodes: IComponentNodes = {}
    for (const [name, relPath] of specs) {
        const filePath = path.join(AGENTFLOW_NODES_DIR, relPath)
        const mod = require(filePath)
        const instance = new mod.nodeClass()
        componentNodes[name] = Object.assign(instance, { filePath })
    }
    return componentNodes
}

function unwrapFindValue(val: any): any {
    if (val && typeof val === 'object' && '_value' in val) {
        return val._value
    }
    return val
}

function createMockDataSource(seedVariables: Array<Record<string, any>> = []) {
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
                id: obj.id || uuidv4(),
                createdDate: obj.createdDate || now,
                updatedDate: now,
                ...obj
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
                id: obj.id || uuidv4(),
                createdDate: obj.createdDate || new Date(),
                ...obj
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

function createNode(componentNodes: IComponentNodes, name: string, id: string, label: string, inputOverrides: Record<string, any> = {}) {
    const comp = componentNodes[name]
    const defaultInputs: Record<string, any> = {}
    const inputParams = (comp.inputs || []).map((param: any) => {
        defaultInputs[param.name] = param.default !== undefined ? param.default : ''
        return { ...param, id: `${id}-input-${param.name}-${param.type}` }
    })
    return {
        id,
        type: 'agentFlow',
        position: { x: 0, y: 0 },
        data: {
            id,
            label,
            name: comp.name,
            version: comp.version,
            inputParams,
            inputs: { ...defaultInputs, ...inputOverrides }
        }
    }
}

function createEdge(source: string, target: string, sourceHandle?: string) {
    return {
        id: `${source}-${sourceHandle || 'out'}-${target}`,
        source,
        sourceHandle: sourceHandle || `${source}-output`,
        target,
        targetHandle: target,
        type: 'agentFlow'
    }
}

function createStreamingRecorder(chatId: string) {
    const sseStreamer = new SSEStreamer()
    const rawChunks: string[] = []
    const mockRes = {
        write: (chunk: string) => {
            rawChunks.push(chunk)
            return true
        },
        end: (chunk?: string) => {
            if (chunk) rawChunks.push(chunk)
        }
    } as unknown as Response
    sseStreamer.addClient(chatId, mockRes)

    const getEvents = () => {
        const events: Array<{ event: string; data: any }> = []
        for (const frame of rawChunks.join('').split('\n\n')) {
            if (!frame.trim()) continue
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                const payload = line.slice(5).trim()
                if (payload) events.push(JSON.parse(payload))
            }
        }
        return events
    }

    return { sseStreamer, getEvents }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 5))
    }
}

describe('Agentflow V2 public interface contract', () => {
    const componentNodes = loadLocalAgentflowComponentNodes()
    const telemetry = { sendTelemetry: jest.fn().mockResolvedValue(undefined) } as any

    function makeChatflow(flowObj: { nodes: any[]; edges: any[] }, extra: Partial<ChatFlow> = {}): ChatFlow {
        return {
            id: 'cf-test-1',
            name: 'Public Contract Flow',
            type: 'AGENTFLOW',
            flowData: JSON.stringify(flowObj),
            workspaceId: 'ws-1',
            ...extra
        } as ChatFlow
    }

    function runFlow({
        chatflow,
        incomingInput,
        appDataSource,
        chatId = `chat-${uuidv4()}`,
        sseStreamer,
        signal
    }: {
        chatflow: ChatFlow
        incomingInput: Record<string, any>
        appDataSource: DataSource
        chatId?: string
        sseStreamer?: SSEStreamer
        signal?: AbortController
    }) {
        return executeAgentFlow({
            componentNodes,
            incomingInput: incomingInput as any,
            chatflow,
            chatId,
            appDataSource,
            telemetry,
            usageCacheManager: {} as UsageCacheManager,
            cachePool: {} as CachePool,
            sseStreamer: sseStreamer as any,
            baseURL: 'http://localhost:3000',
            isInternal: false,
            signal,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: '',
            productId: ''
        })
    }

    it('executes a linear flow, ignores sticky notes, persists execution/messages, and streams SSE lifecycle', async () => {
        const { appDataSource, executions, chatMessages } = createMockDataSource()
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', {
                    startInputType: 'chatInput',
                    startState: [{ key: 'tag', value: 'init' }]
                }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Echo Worker', {
                    customFunctionJavascriptFunction: 'return `echo:${$flow.input}:${$flow.state.tag}`;',
                    customFunctionUpdateState: [{ key: 'tag', value: '{{ output }}' }]
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Final Reply', {
                    directReplyMessage: 'Out={{customFunctionAgentflow_0}} State={{$flow.state.tag}}'
                }),
                {
                    id: 'stickyNoteAgentflow_0',
                    type: 'agentFlow',
                    position: { x: 0, y: 200 },
                    data: { id: 'stickyNoteAgentflow_0', label: 'Note', name: 'stickyNoteAgentflow', inputParams: [], inputs: {} }
                }
            ],
            edges: [
                createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                createEdge('customFunctionAgentflow_0', 'directReplyAgentflow_0')
            ]
        }

        const chatId = 'chat-linear-1'
        const { sseStreamer, getEvents } = createStreamingRecorder(chatId)
        const result = await runFlow({
            chatflow: makeChatflow(flow),
            incomingInput: { question: 'hello' },
            appDataSource,
            chatId,
            sseStreamer
        })
        sseStreamer.removeClient(chatId)

        expect(result.text).toBe('Out=echo:hello:init State=echo:hello:init')
        expect(result.question).toBe('hello')
        expect(result.chatId).toBe(chatId)
        expect(result.sessionId).toBe(chatId)
        expect(result.executionId).toBeTruthy()
        expect(result.chatMessageId).toBeTruthy()
        expect(result.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual([
            'startAgentflow_0',
            'customFunctionAgentflow_0',
            'directReplyAgentflow_0'
        ])
        expect(result.agentFlowExecutedData.every((d: any) => d.status === 'FINISHED')).toBe(true)

        expect(executions).toHaveLength(1)
        expect(executions[0].state).toBe('FINISHED')
        expect(chatMessages.map((m) => m.role)).toEqual(['userMessage', 'apiMessage'])
        expect(chatMessages[1].content).toBe(result.text)

        const events = getEvents()
        expect(events.filter((e) => e.event === 'agentFlowEvent').map((e) => e.data)).toEqual(['INPROGRESS', 'FINISHED'])
        expect(
            events
                .filter((e) => e.event === 'token')
                .map((e) => e.data)
                .join('')
        ).toBe(result.text)
        expect(events.some((e) => e.event === 'agentFlowExecutedData')).toBe(true)
        expect(events[events.length - 1]).toEqual({ event: 'end', data: '[DONE]' })
    })

    it('persists flow state across turns when startPersistState is enabled', async () => {
        const { appDataSource } = createMockDataSource()
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', {
                    startInputType: 'chatInput',
                    startPersistState: true,
                    startState: [{ key: 'acc', value: '' }]
                }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Accumulate', {
                    customFunctionJavascriptFunction: 'return ($flow.state.acc ? $flow.state.acc + "," : "") + $flow.input;',
                    customFunctionUpdateState: [{ key: 'acc', value: '{{ output }}' }]
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Reply', {
                    directReplyMessage: 'acc={{$flow.state.acc}}'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                createEdge('customFunctionAgentflow_0', 'directReplyAgentflow_0')
            ]
        }
        const chatflow = makeChatflow(flow)
        const sessionId = 'persist-session-1'

        const turn1 = await runFlow({
            chatflow,
            incomingInput: { question: 'one', overrideConfig: { sessionId } },
            appDataSource,
            chatId: 'chat-turn-1'
        })
        expect(turn1.text).toBe('acc=one')

        const turn2 = await runFlow({
            chatflow,
            incomingInput: { question: 'two', overrideConfig: { sessionId }, trustedState: turn1.trustedState },
            appDataSource,
            chatId: 'chat-turn-2'
        })
        expect(turn2.text).toBe('acc=one,two')
    })

    it('routes single-choice conditionAgentflow branches exclusively to the matching output handle', async () => {
        const { appDataSource } = createMockDataSource()
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'conditionAgentflow', 'conditionAgentflow_0', 'Cond', {
                    conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: 'yes' }]
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Yes Reply', {
                    directReplyMessage: 'Matched yes'
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_1', 'Else Reply', {
                    directReplyMessage: 'Fell into else'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'conditionAgentflow_0'),
                createEdge('conditionAgentflow_0', 'directReplyAgentflow_0', 'conditionAgentflow_0-output-0'),
                createEdge('conditionAgentflow_0', 'directReplyAgentflow_1', 'conditionAgentflow_0-output-1')
            ]
        }
        const chatflow = makeChatflow(flow)

        const trueRun = await runFlow({ chatflow, incomingInput: { question: 'yes' }, appDataSource })
        expect(trueRun.text).toBe('Matched yes')
        expect(trueRun.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual([
            'startAgentflow_0',
            'conditionAgentflow_0',
            'directReplyAgentflow_0'
        ])

        const elseRun = await runFlow({ chatflow, incomingInput: { question: 'no' }, appDataSource })
        expect(elseRun.text).toBe('Fell into else')
        expect(elseRun.agentFlowExecutedData.map((d: any) => d.nodeId)).toEqual([
            'startAgentflow_0',
            'conditionAgentflow_0',
            'directReplyAgentflow_1'
        ])
    })

    it('converges an unconditional fork-join with disjoint state keys once after both branches', async () => {
        const { appDataSource } = createMockDataSource()
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', {
                    startInputType: 'chatInput',
                    startState: [
                        { key: 'a', value: '' },
                        { key: 'b', value: '' }
                    ]
                }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Branch A', {
                    customFunctionJavascriptFunction: 'await new Promise((r) => setTimeout(r, 10)); return "valA";',
                    customFunctionUpdateState: [{ key: 'a', value: '{{ output }}' }]
                }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_1', 'Branch B', {
                    customFunctionJavascriptFunction: 'await new Promise((r) => setTimeout(r, 10)); return "valB";',
                    customFunctionUpdateState: [{ key: 'b', value: '{{ output }}' }]
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Join', {
                    directReplyMessage: 'a={{$flow.state.a}}|b={{$flow.state.b}}'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                createEdge('startAgentflow_0', 'customFunctionAgentflow_1'),
                createEdge('customFunctionAgentflow_0', 'directReplyAgentflow_0'),
                createEdge('customFunctionAgentflow_1', 'directReplyAgentflow_0')
            ]
        }

        const result = await runFlow({
            chatflow: makeChatflow(flow),
            incomingInput: { question: 'go' },
            appDataSource
        })

        expect(result.text).toBe('a=valA|b=valB')
        const executedIds = result.agentFlowExecutedData.map((d: any) => d.nodeId)
        expect(executedIds.filter((id: string) => id === 'directReplyAgentflow_0')).toHaveLength(1)
        const idxA = executedIds.indexOf('customFunctionAgentflow_0')
        const idxB = executedIds.indexOf('customFunctionAgentflow_1')
        const idxJoin = executedIds.indexOf('directReplyAgentflow_0')
        expect(idxA).toBeGreaterThan(0)
        expect(idxB).toBeGreaterThan(0)
        expect(idxJoin).toBeGreaterThan(idxA)
        expect(idxJoin).toBeGreaterThan(idxB)
    })

    it('supports bounded loopAgentflow cycles and maxLoopCount fallback termination', async () => {
        const { appDataSource } = createMockDataSource()
        const exitFlow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Step', {
                    customFunctionJavascriptFunction: 'return "ok";'
                }),
                createNode(componentNodes, 'conditionAgentflow', 'conditionAgentflow_0', 'Check', {
                    conditions: [{ type: 'number', value1: '{{ loop_count }}', operation: 'smaller', value2: '2' }]
                }),
                createNode(componentNodes, 'loopAgentflow', 'loopAgentflow_0', 'Loop Back', {
                    loopBackToNode: 'customFunctionAgentflow_0-Step',
                    maxLoopCount: 5,
                    fallbackMessage: 'Max reached'
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Done', {
                    directReplyMessage: 'Exited at {{ loop_count }}'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                createEdge('customFunctionAgentflow_0', 'conditionAgentflow_0'),
                createEdge('conditionAgentflow_0', 'loopAgentflow_0', 'conditionAgentflow_0-output-0'),
                createEdge('conditionAgentflow_0', 'directReplyAgentflow_0', 'conditionAgentflow_0-output-1')
            ]
        }

        const exitRes = await runFlow({
            chatflow: makeChatflow(exitFlow),
            incomingInput: { question: 'loop' },
            appDataSource
        })
        expect(exitRes.text).toBe('Exited at 2')
        expect(exitRes.agentFlowExecutedData.filter((d: any) => d.nodeId === 'customFunctionAgentflow_0')).toHaveLength(3)

        const cappedFlow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Body', {
                    customFunctionJavascriptFunction: 'return "tick";'
                }),
                createNode(componentNodes, 'loopAgentflow', 'loopAgentflow_0', 'Loop Forever', {
                    loopBackToNode: 'customFunctionAgentflow_0-Body',
                    maxLoopCount: 2,
                    fallbackMessage: 'Loop limit hit'
                })
            ],
            edges: [createEdge('startAgentflow_0', 'customFunctionAgentflow_0'), createEdge('customFunctionAgentflow_0', 'loopAgentflow_0')]
        }

        const cappedRes = await runFlow({
            chatflow: makeChatflow(cappedFlow),
            incomingInput: { question: 'cap' },
            appDataSource
        })
        expect(cappedRes.text).toBe('Loop limit hit')
        expect(cappedRes.agentFlowExecutedData.filter((d: any) => d.nodeId === 'customFunctionAgentflow_0')).toHaveLength(2)
    })

    it('handles humanInputAgentflow STOPPED checkpoints and proceed/reject resumes', async () => {
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'humanInputAgentflow', 'humanInputAgentflow_0', 'Gate', {
                    humanInputDescriptionType: 'fixed',
                    humanInputDescription: 'Proceed?',
                    humanInputAcceptLabelText: 'Yes',
                    humanInputRejectLabelText: 'No'
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Approved', {
                    directReplyMessage: 'Approved!'
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_1', 'Rejected', {
                    directReplyMessage: 'Rejected.'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'humanInputAgentflow_0'),
                createEdge('humanInputAgentflow_0', 'directReplyAgentflow_0', 'humanInputAgentflow_0-output-0'),
                createEdge('humanInputAgentflow_0', 'directReplyAgentflow_1', 'humanInputAgentflow_0-output-1')
            ]
        }
        const chatflow = makeChatflow(flow)

        // Proceed flow with SSE verification
        const { appDataSource, executions, chatMessages } = createMockDataSource()
        const sessionProceed = 'hitl-proceed-1'
        const sseTurn1 = createStreamingRecorder('chat-hitl-1')
        const stopRes = await runFlow({
            chatflow,
            incomingInput: { question: 'review', overrideConfig: { sessionId: sessionProceed } },
            appDataSource,
            chatId: 'chat-hitl-1',
            sseStreamer: sseTurn1.sseStreamer
        })
        sseTurn1.sseStreamer.removeClient('chat-hitl-1')

        expect(stopRes.text).toContain('Proceed?')
        expect(executions[0].state).toBe('STOPPED')
        const stoppedRecord = stopRes.agentFlowExecutedData.find((d: any) => d.nodeId === 'humanInputAgentflow_0')
        expect(stoppedRecord.status).toBe('STOPPED')
        expect(stoppedRecord.data.output.humanInputAction).toBeTruthy()
        expect(chatMessages.find((m) => m.role === 'apiMessage')?.action).toBeTruthy()
        expect(sseTurn1.getEvents().some((e) => e.event === 'action')).toBe(true)
        expect(sseTurn1.getEvents().some((e) => e.event === 'agentFlowEvent' && e.data === 'STOPPED')).toBe(true)

        const resumeProceed = await runFlow({
            chatflow,
            incomingInput: {
                humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0', feedback: 'looks good' },
                overrideConfig: { sessionId: sessionProceed },
                trustedState: stopRes.trustedState
            },
            appDataSource,
            chatId: 'chat-hitl-2'
        })
        expect(resumeProceed.text).toBe('Approved!')
        expect(executions[0].state).toBe('FINISHED')
        // Task 07 (D11) clears the recorded pending action button by the stop message's id; until then the row keeps it
        expect(chatMessages.filter((m) => Boolean(m.action))).toHaveLength(1)

        // Reject flow
        const rejectSession = 'hitl-reject-1'
        const stopForReject = await runFlow({
            chatflow,
            incomingInput: { question: 'review', overrideConfig: { sessionId: rejectSession } },
            appDataSource,
            chatId: 'chat-hitl-r1'
        })
        const resumeReject = await runFlow({
            chatflow,
            incomingInput: {
                humanInput: { type: 'reject', startNodeId: 'humanInputAgentflow_0' },
                overrideConfig: { sessionId: rejectSession },
                trustedState: stopForReject.trustedState
            },
            appDataSource,
            chatId: 'chat-hitl-r2'
        })
        expect(resumeReject.text).toBe('Rejected.')

        // Resuming without a stopped run in the token throws
        await expect(
            runFlow({
                chatflow,
                incomingInput: { humanInput: { type: 'proceed' }, overrideConfig: { sessionId: 'no-such-session' } },
                appDataSource
            })
        ).rejects.toThrow(/No previous execution found/i)
    })

    it('enforces error, abort, and invalid input contracts', async () => {
        const { appDataSource, executions } = createMockDataSource()
        const failingFlow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'customFunctionAgentflow', 'customFunctionAgentflow_0', 'Explode', {
                    customFunctionJavascriptFunction: 'throw new Error("boom");'
                })
            ],
            edges: [createEdge('startAgentflow_0', 'customFunctionAgentflow_0')]
        }
        const chatId = 'chat-err-1'
        const { sseStreamer, getEvents } = createStreamingRecorder(chatId)

        await expect(
            runFlow({
                chatflow: makeChatflow(failingFlow),
                incomingInput: { question: 'go' },
                appDataSource,
                chatId,
                sseStreamer
            })
        ).rejects.toThrow(/boom/)
        sseStreamer.removeClient(chatId)
        await waitUntil(() => executions[0]?.state === 'ERROR')
        expect(executions[0].state).toBe('ERROR')
        expect(getEvents().some((e) => e.event === 'agentFlowEvent' && e.data === 'ERROR')).toBe(true)

        // Pre-aborted signal terminates cleanly
        const abortCtrl = new AbortController()
        abortCtrl.abort()
        const validFlow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Reply', { directReplyMessage: 'ok' })
            ],
            edges: [createEdge('startAgentflow_0', 'directReplyAgentflow_0')]
        }
        await expect(
            runFlow({
                chatflow: makeChatflow(validFlow),
                incomingInput: { question: 'go' },
                appDataSource,
                signal: abortCtrl
            })
        ).rejects.toThrow(/cancelled/i)
        await waitUntil(() => executions[1]?.state === 'TERMINATED')
        expect(executions[1].state).toBe('TERMINATED')

        // Multiple start nodes rejected
        const multiStart = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start 1', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_1', 'Start 2', { startInputType: 'chatInput' })
            ],
            edges: []
        }
        await expect(runFlow({ chatflow: makeChatflow(multiStart), incomingInput: { question: 'go' }, appDataSource })).rejects.toThrow(
            /Multiple starting nodes are not allowed/i
        )

        // Invalid history schema rejected
        await expect(
            runFlow({
                chatflow: makeChatflow(validFlow),
                incomingInput: { question: 'go', history: [{ role: 'invalidRole', content: 'x' }] },
                appDataSource
            })
        ).rejects.toThrow(/Invalid history format/i)

        // Both question and form rejected
        await expect(
            runFlow({
                chatflow: makeChatflow(validFlow),
                incomingInput: { question: 'go', form: { field: 'val' } },
                appDataSource
            })
        ).rejects.toThrow(/Question and form cannot be provided at the same time/i)
    })

    it('supports stateless trustedState / zero-retention human-input round-trip without DB writes', async () => {
        const { appDataSource, executions, chatMessages } = createMockDataSource()
        const flow = {
            nodes: [
                createNode(componentNodes, 'startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                createNode(componentNodes, 'humanInputAgentflow', 'humanInputAgentflow_0', 'Gate', {
                    humanInputDescriptionType: 'fixed',
                    humanInputDescription: 'Confirm?',
                    humanInputAcceptLabelText: 'Go',
                    humanInputRejectLabelText: 'Stop'
                }),
                createNode(componentNodes, 'directReplyAgentflow', 'directReplyAgentflow_0', 'Done', {
                    directReplyMessage: 'Confirmed!'
                })
            ],
            edges: [
                createEdge('startAgentflow_0', 'humanInputAgentflow_0'),
                createEdge('humanInputAgentflow_0', 'directReplyAgentflow_0', 'humanInputAgentflow_0-output-0')
            ]
        }
        const chatflow = makeChatflow(flow, {
            chatbotConfig: JSON.stringify({ clientState: { enabled: true, enabledFull: true } })
        })

        const sse1 = createStreamingRecorder('chat-ts-1')
        await runFlow({
            chatflow,
            incomingInput: { question: 'start', overrideConfig: { sessionId: 'ts-sess-1' } },
            appDataSource,
            chatId: 'chat-ts-1',
            sseStreamer: sse1.sseStreamer
        })
        sse1.sseStreamer.removeClient('chat-ts-1')

        expect(executions).toHaveLength(0)
        expect(chatMessages).toHaveLength(0)

        const trustedEvt = sse1.getEvents().find((e) => e.event === 'trustedStateData')
        expect(trustedEvt?.data).toBeTruthy()
        const decoded = (await trusted_state_from_string(trustedEvt!.data)) as any
        expect(decoded.version).toBe(2)
        expect(decoded.pendingResume.legacyExecution.state).toBe('STOPPED')

        const turn2 = await runFlow({
            chatflow,
            incomingInput: {
                humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0' },
                trustedState: trustedEvt!.data,
                overrideConfig: { sessionId: 'ts-sess-1' }
            },
            appDataSource,
            chatId: 'chat-ts-2'
        })
        expect(turn2.text).toBe('Confirmed!')
        expect(executions).toHaveLength(0)
        expect(chatMessages).toHaveLength(0)
    })

    it('resolves template variables via resolveVariables while preserving {{ output }} and non-acceptVariable fields', async () => {
        const nodeData: INodeData = {
            id: 'customFunctionAgentflow_1',
            label: 'Test',
            name: 'customFunctionAgentflow',
            version: 1.2,
            type: 'CustomFunction',
            icon: '',
            category: 'Agent Flows',
            baseClasses: ['CustomFunction'],
            inputAnchors: [],
            outputAnchors: [],
            outputs: {},
            inputParams: [
                { label: 'Msg', name: 'msg', type: 'string', acceptVariable: true },
                { label: 'Code', name: 'code', type: 'code' },
                {
                    label: 'State',
                    name: 'customFunctionUpdateState',
                    type: 'array',
                    acceptVariable: true,
                    array: [
                        { label: 'Key', name: 'key', type: 'string' },
                        { label: 'Val', name: 'value', type: 'string', acceptVariable: true }
                    ]
                }
            ],
            inputs: {
                msg: '<p>q={{ question }}|s={{ $flow.state.color }}|f={{ $form.user }}|v={{ $vars.API_MODE }}|l={{ loop_count }}|n={{ customFunctionAgentflow_0 }}|p={{ customFunctionAgentflow_0.output.content }}</p>',
                code: 'return "{{ question }}";',
                customFunctionUpdateState: [{ key: 'saved', value: '{{ output }}' }]
            }
        }

        const resolved = await resolveVariables(
            nodeData,
            'hello',
            { user: 'alice' },
            {
                chatflowid: 'cf-1',
                chatflowId: 'cf-1',
                chatId: 'c-1',
                sessionId: 's-1',
                apiMessageId: 'm-1',
                chatHistory: [],
                state: { color: 'blue' },
                vars: { API_MODE: 'override-mode' }
            } as any,
            [
                {
                    id: 'v-1',
                    name: 'API_MODE',
                    type: 'static',
                    value: 'default-mode',
                    workspaceId: 'ws-1',
                    createdDate: new Date(),
                    updatedDate: new Date()
                }
            ],
            [{ id: 'v-1', name: 'API_MODE', type: 'static', enabled: true }],
            '',
            [],
            componentNodes,
            [
                {
                    nodeId: 'customFunctionAgentflow_0',
                    nodeLabel: 'Upstream',
                    previousNodeIds: [],
                    status: 'FINISHED',
                    data: { id: 'customFunctionAgentflow_0', name: 'customFunctionAgentflow', output: { content: 'upstream-val' } }
                },
                {
                    nodeId: 'loopAgentflow_0',
                    nodeLabel: 'Loop',
                    previousNodeIds: ['customFunctionAgentflow_0'],
                    status: 'FINISHED',
                    data: { id: 'loopAgentflow_0', name: 'loopAgentflow' }
                }
            ],
            undefined,
            new Map([['loopAgentflow_0', 3]])
        )

        expect(resolved.inputs?.msg).toBe('q=hello|s=blue|f=alice|v=override-mode|l=3|n=upstream-val|p=upstream-val')
        expect(resolved.inputs?.code).toBe('return "{{ question }}";')
        expect(resolved.inputs?.customFunctionUpdateState).toEqual([{ key: 'saved', value: '{{ output }}' }])
    })
})
