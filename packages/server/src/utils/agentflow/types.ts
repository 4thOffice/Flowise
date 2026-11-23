import { DataSource } from 'typeorm'
import { Variable } from '../../database/entities/Variable'
import { AnalyticHandler, ICommonObject, IFileUpload, IHumanInput, IMessage, IServerSideEventStreamer } from 'flowise-components'
import {
    IAgentflowExecutedData,
    IComponentNodes,
    IExecuteFlowParams,
    IncomingAgentflowInput,
    INodeData,
    INodeDirectedGraph,
    INodeOverrides,
    IReactFlowEdge,
    IReactFlowNode,
    IVariableOverride
} from '../../Interface'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { CachePool } from '../../CachePool'
import { Telemetry } from '../telemetry'
import { UsageCacheManager } from '../../UsageCacheManager'
import { TrustedTurnInput } from './trustedState'

export interface IWaitingNode {
    nodeId: string
    receivedInputs: Map<string, any>
    expectedInputs: Set<string>
    isConditional: boolean
    conditionalGroups: Map<string, string[]>
}

export interface INodeQueue {
    nodeId: string
    data: any
    inputs: Record<string, any>
    epoch?: number
}

export interface IProcessNodeOutputsParams {
    nodeId: string
    nodeName: string
    result: any
    humanInput?: IHumanInput
    graph: Record<string, string[]>
    nodes: IReactFlowNode[]
    edges: IReactFlowEdge[]
    nodeExecutionQueue: INodeQueue[]
    waitingNodes: Map<string, IWaitingNode>
    loopCounts: Map<string, number>
    abortController?: AbortController
    sseStreamer?: IServerSideEventStreamer
    chatId: string
}

export interface IAgentFlowRuntime {
    state?: ICommonObject
    chatHistory?: IMessage[]
    form?: Record<string, any>
}

export interface IAgentflowNodeInstance {
    run: (nodeData: INodeData, input: string | Record<string, any> | undefined, options: ICommonObject) => Promise<any>
}

export type NodeInstanceFactory = (
    nodeName: string,
    reactFlowNode: IReactFlowNode,
    componentNodes: IComponentNodes
) => Promise<IAgentflowNodeInstance> | IAgentflowNodeInstance

export type NodeErrorPolicy = 'abort' | 'skip-branch'

export interface INodeErrorContext {
    inFlightCount: number
    queuedCount: number
}

export type NodeErrorPolicyHook = (node: INodeQueue, error: unknown, context: INodeErrorContext) => NodeErrorPolicy

export interface IExecuteNodeParams {
    nodeId: string
    reactFlowNode: IReactFlowNode
    nodes: IReactFlowNode[]
    edges: IReactFlowEdge[]
    graph: INodeDirectedGraph
    reversedGraph: INodeDirectedGraph
    incomingInput: IncomingAgentflowInput
    chatflow: ChatFlow
    chatId: string
    sessionId: string
    apiMessageId: string
    evaluationRunId?: string
    isInternal: boolean
    pastChatHistory: IMessage[]
    prependedChatHistory: IMessage[]
    appDataSource: DataSource
    usageCacheManager: UsageCacheManager
    telemetry: Telemetry
    componentNodes: IComponentNodes
    cachePool: CachePool
    sseStreamer: IServerSideEventStreamer
    baseURL: string
    overrideConfig?: ICommonObject
    apiOverrideStatus?: boolean
    nodeOverrides?: INodeOverrides
    variableOverrides?: IVariableOverride[]
    uploadedFilesContent?: string
    fileUploads?: IFileUpload[]
    humanInput?: IHumanInput
    agentFlowExecutedData?: IAgentflowExecutedData[]
    agentflowRuntime: IAgentFlowRuntime
    abortController?: AbortController
    parentTraceIds?: ICommonObject
    analyticHandlers?: AnalyticHandler
    parentExecutionId?: string
    isRecursive?: boolean
    iterationContext?: ICommonObject
    loopCounts?: Map<string, number>
    orgId: string
    workspaceId: string
    subscriptionId: string
    productId: string
    zeroRetention: boolean
    nodeInstanceFactory?: NodeInstanceFactory
    maxNodeConcurrency?: number
    enqueueDbUpdate?: <T>(task: () => Promise<T>) => Promise<T>
    getExecutedData?: () => IAgentflowExecutedData[]
    getAvailableVariables: () => Promise<Variable[]>
    turnInput: TrustedTurnInput
}

export interface IExecuteNodeResult {
    result: any
    shouldStop?: boolean
    additionalExecutedData?: IAgentflowExecutedData[]
    removedExecutedNodeIds?: string[]
    stoppedExecutedData?: IAgentflowExecutedData
    humanInputAction?: Record<string, any>
    humanInput?: IHumanInput
}

export interface IExecuteAgentFlowParams extends Omit<IExecuteFlowParams, 'incomingInput'> {
    incomingInput: IncomingAgentflowInput
    nodeInstanceFactory?: NodeInstanceFactory
    maxNodeConcurrency?: number
    onNodeError?: NodeErrorPolicyHook
    turnInput?: TrustedTurnInput
}
