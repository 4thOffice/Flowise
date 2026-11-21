import fs from 'fs'
import path from 'path'
import { InternalFlowiseError } from '../../../src/errors/internalFlowiseError'
import { getRunningExpressApp } from '../../../src/utils/getRunningExpressApp'
import validationService from '../../../src/services/validation'

jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const AGENTFLOW_NODES_DIR = path.join(REPO_ROOT, 'packages/components/dist/nodes/agentflow')
const BASELINE_FLOWS_DIR = path.join(REPO_ROOT, 'plans/agentflow-concurrent-execution/baselines/flows')

function loadCompiledNodeInstance(relPath: string) {
    const mod = require(path.join(AGENTFLOW_NODES_DIR, relPath))
    return new mod.nodeClass()
}

function buildComponentNodesPool(): Record<string, any> {
    const start = loadCompiledNodeInstance('Start/Start.js')
    const customFn = loadCompiledNodeInstance('CustomFunction/CustomFunction.js')
    const condition = loadCompiledNodeInstance('Condition/Condition.js')
    const directReply = loadCompiledNodeInstance('DirectReply/DirectReply.js')
    const humanInput = loadCompiledNodeInstance('HumanInput/HumanInput.js')
    const loop = loadCompiledNodeInstance('Loop/Loop.js')

    return {
        [start.name]: start,
        [customFn.name]: customFn,
        [condition.name]: condition,
        [directReply.name]: directReply,
        [humanInput.name]: humanInput,
        [loop.name]: loop
    }
}

function makeNode(componentNode: any, id: string, label: string, inputOverrides: Record<string, any> = {}) {
    const defaultInputs: Record<string, any> = {}
    const inputParams = (componentNode.inputs || []).map((param: any) => {
        defaultInputs[param.name] = param.default !== undefined ? param.default : ''
        return { ...param, id: `${id}-input-${param.name}-${param.type}` }
    })
    if (componentNode.credential) {
        inputParams.unshift({
            ...componentNode.credential,
            id: `${id}-input-${componentNode.credential.name}-${componentNode.credential.type}`
        })
        defaultInputs[componentNode.credential.name] = ''
    }
    return {
        id,
        type: 'agentFlow',
        position: { x: 0, y: 0 },
        data: {
            id,
            label,
            name: componentNode.name,
            version: componentNode.version,
            inputParams,
            inputs: { ...defaultInputs, ...inputOverrides }
        }
    }
}

function makeEdge(source: string, target: string, sourceHandle?: string) {
    return {
        id: `${source}-${target}`,
        source,
        sourceHandle: sourceHandle || `${source}-output`,
        target,
        targetHandle: target
    }
}

describe('validationService.checkFlowValidation', () => {
    const componentNodes = buildComponentNodesPool()
    let storedFlows: Map<string, any>

    beforeEach(() => {
        storedFlows = new Map()
        ;(getRunningExpressApp as jest.Mock).mockReturnValue({
            nodesPool: { componentNodes },
            AppDataSource: {
                getRepository: () => ({
                    findOne: async ({ where }: { where: { id: string; workspaceId?: string } }) => {
                        const flow = storedFlows.get(where.id)
                        if (!flow) return null
                        if (where.workspaceId && flow.workspaceId !== where.workspaceId) return null
                        return flow
                    }
                })
            }
        })
    })

    it('returns an empty list for a valid single-path Agentflow V2', async () => {
        const flowData = {
            nodes: [
                makeNode(componentNodes.startAgentflow, 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                makeNode(componentNodes.customFunctionAgentflow, 'customFunctionAgentflow_0', 'Worker', {
                    customFunctionJavascriptFunction: 'return "ok";'
                }),
                makeNode(componentNodes.directReplyAgentflow, 'directReplyAgentflow_0', 'Reply', {
                    directReplyMessage: 'Done'
                })
            ],
            edges: [
                makeEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                makeEdge('customFunctionAgentflow_0', 'directReplyAgentflow_0')
            ]
        }
        storedFlows.set('flow-valid', { id: 'flow-valid', type: 'AGENTFLOW', workspaceId: 'ws-1', flowData: JSON.stringify(flowData) })

        const results = await validationService.checkFlowValidation('flow-valid', 'ws-1')
        expect(results).toEqual([])
    })

    it('throws InternalFlowiseError when flow is not found or outside workspace', async () => {
        storedFlows.set('flow-other-ws', {
            id: 'flow-other-ws',
            type: 'AGENTFLOW',
            workspaceId: 'ws-2',
            flowData: '{"nodes":[],"edges":[]}'
        })

        await expect(validationService.checkFlowValidation('missing-id', 'ws-1')).rejects.toThrow(InternalFlowiseError)
        await expect(validationService.checkFlowValidation('missing-id', 'ws-1')).rejects.toThrow(/flow not found/i)
        await expect(validationService.checkFlowValidation('flow-other-ws', 'ws-1')).rejects.toThrow(/flow not found/i)
    })

    it('flags disconnected nodes while ignoring stickyNoteAgentflow', async () => {
        const flowData = {
            nodes: [
                makeNode(componentNodes.startAgentflow, 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                makeNode(componentNodes.directReplyAgentflow, 'directReplyAgentflow_0', 'Reply', {
                    directReplyMessage: 'Hi'
                }),
                makeNode(componentNodes.directReplyAgentflow, 'directReplyAgentflow_1', 'Orphan Reply', {
                    directReplyMessage: 'Never connected'
                }),
                {
                    id: 'stickyNoteAgentflow_0',
                    type: 'agentFlow',
                    position: { x: 0, y: 0 },
                    data: { id: 'stickyNoteAgentflow_0', label: 'Note', name: 'stickyNoteAgentflow', inputParams: [], inputs: {} }
                }
            ],
            edges: [makeEdge('startAgentflow_0', 'directReplyAgentflow_0')]
        }
        storedFlows.set('flow-orphan', { id: 'flow-orphan', type: 'AGENTFLOW', flowData: JSON.stringify(flowData) })

        const results = await validationService.checkFlowValidation('flow-orphan')
        expect(results).toEqual([
            {
                id: 'directReplyAgentflow_1',
                label: 'Orphan Reply',
                name: 'directReplyAgentflow',
                issues: ['This node is not connected to anything']
            }
        ])
    })

    it('validates required inputs while respecting parameter show conditions', async () => {
        const flowData = {
            nodes: [
                makeNode(componentNodes.startAgentflow, 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                makeNode(componentNodes.humanInputAgentflow, 'humanInputAgentflow_0', 'Approval', {
                    humanInputDescriptionType: 'fixed',
                    humanInputDescription: '',
                    humanInputAcceptLabelText: '',
                    humanInputRejectLabelText: 'Reject'
                }),
                makeNode(componentNodes.directReplyAgentflow, 'directReplyAgentflow_0', 'Reply', {
                    directReplyMessage: 'Approved'
                })
            ],
            edges: [
                makeEdge('startAgentflow_0', 'humanInputAgentflow_0'),
                makeEdge('humanInputAgentflow_0', 'directReplyAgentflow_0', 'humanInputAgentflow_0-output-0')
            ]
        }
        storedFlows.set('flow-inputs', { id: 'flow-inputs', type: 'AGENTFLOW', flowData: JSON.stringify(flowData) })

        const results = await validationService.checkFlowValidation('flow-inputs')
        expect(results).toHaveLength(1)
        expect(results[0].id).toBe('humanInputAgentflow_0')
        expect(results[0].issues).toContain('Description is required')
        expect(results[0].issues).toContain('Proceed text is required')
        expect(results[0].issues).not.toContain('Model is required')
        expect(results[0].issues).not.toContain('Prompt is required')
    })

    it('validates $index array subfield show/hide conditions on conditionAgentflow', async () => {
        const flowData = {
            nodes: [
                makeNode(componentNodes.startAgentflow, 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                makeNode(componentNodes.conditionAgentflow, 'conditionAgentflow_0', 'Condition Missing Value2', {
                    conditions: [{ type: 'string', value1: '{{ question }}', operation: 'equal', value2: '' }]
                }),
                makeNode(componentNodes.conditionAgentflow, 'conditionAgentflow_1', 'Condition IsEmpty', {
                    conditions: [{ type: 'string', value1: '{{ question }}', operation: 'isEmpty', value2: '' }]
                })
            ],
            edges: [
                makeEdge('startAgentflow_0', 'conditionAgentflow_0'),
                makeEdge('conditionAgentflow_0', 'conditionAgentflow_1', 'conditionAgentflow_0-output-0')
            ]
        }
        storedFlows.set('flow-cond-array', { id: 'flow-cond-array', type: 'AGENTFLOW', flowData: JSON.stringify(flowData) })

        const results = await validationService.checkFlowValidation('flow-cond-array')
        expect(results).toEqual([
            {
                id: 'conditionAgentflow_0',
                label: 'Condition Missing Value2',
                name: 'conditionAgentflow',
                issues: ['Conditions item #1: Value 2 is required']
            }
        ])
    })

    it('detects hanging edges pointing to or from non-existent nodes', async () => {
        const flowData = {
            nodes: [
                makeNode(componentNodes.startAgentflow, 'startAgentflow_0', 'Start', { startInputType: 'chatInput' }),
                makeNode(componentNodes.directReplyAgentflow, 'directReplyAgentflow_0', 'Reply', {
                    directReplyMessage: 'Hi'
                })
            ],
            edges: [
                makeEdge('startAgentflow_0', 'directReplyAgentflow_0'),
                makeEdge('startAgentflow_0', 'ghost_target'),
                makeEdge('ghost_source', 'directReplyAgentflow_0'),
                makeEdge('ghost_a', 'ghost_b')
            ]
        }
        storedFlows.set('flow-hanging', { id: 'flow-hanging', type: 'AGENTFLOW', flowData: JSON.stringify(flowData) })

        const results = await validationService.checkFlowValidation('flow-hanging')
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'startAgentflow_0',
                    issues: expect.arrayContaining(['Connected to non-existent target node ghost_target'])
                }),
                expect.objectContaining({
                    id: 'directReplyAgentflow_0',
                    issues: expect.arrayContaining(['Connected to non-existent source node ghost_source'])
                }),
                expect.objectContaining({
                    id: 'ghost_a-ghost_b',
                    issues: ['Disconnected edge - both source and target nodes do not exist']
                })
            ])
        )
    })

    it('validates non-AGENTFLOW flows using standard structural checks', async () => {
        const chatflowData = {
            nodes: [
                {
                    id: 'chatOpenAI_0',
                    type: 'customNode',
                    position: { x: 0, y: 0 },
                    data: {
                        id: 'chatOpenAI_0',
                        label: 'ChatOpenAI',
                        name: 'chatOpenAI',
                        inputParams: [{ label: 'Model Name', name: 'modelName', type: 'string', optional: false }],
                        inputs: { modelName: '' }
                    }
                }
            ],
            edges: []
        }
        storedFlows.set('chatflow-1', { id: 'chatflow-1', type: 'CHATFLOW', flowData: JSON.stringify(chatflowData) })

        const results = await validationService.checkFlowValidation('chatflow-1')
        expect(results).toEqual([
            {
                id: 'chatOpenAI_0',
                label: 'ChatOpenAI',
                name: 'chatOpenAI',
                issues: ['This node is not connected to anything', 'Model Name is required']
            }
        ])
    })

    it('finds zero structural or missing-input errors across all 6 baseline flow fixtures', async () => {
        const fixtureFiles = fs
            .readdirSync(BASELINE_FLOWS_DIR)
            .filter((f) => f.endsWith('.json'))
            .sort()
        expect(fixtureFiles).toHaveLength(6)

        for (const file of fixtureFiles) {
            const rawFlow = fs.readFileSync(path.join(BASELINE_FLOWS_DIR, file), 'utf8')
            storedFlows.set(file, { id: file, type: 'AGENTFLOW', flowData: rawFlow })

            const results = await validationService.checkFlowValidation(file)
            for (const item of results) {
                for (const issue of item.issues) {
                    expect(issue).not.toMatch(/is required|not connected|non-existent|Disconnected edge/i)
                }
            }
        }
    })
})
