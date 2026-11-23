import { DataSource } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { cloneDeep, get } from 'lodash'
import TurndownService from 'turndown'
import {
    AnalyticHandler,
    ICommonObject,
    IHumanInput,
    IMessage,
    convertChatHistoryToText,
    generateFollowUpPrompts
} from 'flowise-components'
import {
    INodeData,
    IReactFlowObject,
    IFlowConfig,
    IAgentflowExecutedData,
    ExecutionState,
    IExecution,
    IChatMessage,
    ChatType,
    IReactFlowNode,
    IReactFlowEdge,
    IComponentNodes,
    IVariableOverride
} from '../Interface'
import {
    RUNTIME_MESSAGES_LENGTH_VAR_PREFIX,
    CHAT_HISTORY_VAR_PREFIX,
    databaseEntities,
    FILE_ATTACHMENT_PREFIX,
    getAppVersion,
    getGlobalVariable,
    getStartingNode,
    getTelemetryFlowObj,
    QUESTION_VAR_PREFIX,
    CURRENT_DATE_TIME_VAR_PREFIX,
    _removeCredentialId,
    validateHistorySchema,
    LOOP_COUNT_VAR_PREFIX
} from '.'
import { Variable } from '../database/entities/Variable'
import { replaceInputsWithConfig, constructGraphs, getAPIOverrideConfig } from './index'
import logger from './logger'
import { getErrorMessage } from '../errors/utils'
import { Compression, Execution } from '../database/entities/Execution'
import { ChatMessage } from '../database/entities/ChatMessage'
import { utilAddChatMessage } from './addChatMesage'
import { getWorkspaceSearchOptions } from '../enterprise/utils/ControllerServiceUtils'
import { generateTTSForResponseStream, shouldAutoPlayTTS } from './buildChatflow'
import { executionsUpdater } from '../DataSource'
import {
    IAgentflowNodeInstance,
    IAgentFlowRuntime,
    IExecuteAgentFlowParams,
    IExecuteNodeParams,
    IExecuteNodeResult,
    INodeQueue
} from './agentflow/types'
import { computeTopologicalLevels, createDependencyEngine } from './agentflow/dependencyEngine'
import {
    createExecutionAbortScope,
    createFaultRecorder,
    createSerializedTaskQueue,
    findResumeCheckpoint,
    findResumedHumanInputAction,
    selectPrimaryStoppedAction,
    selectPrimaryStoppedNode
} from './agentflow/faultCoordinator'
import { getMaxNodeConcurrency, runConcurrentNodeScheduler } from './agentflow/scheduler'
import {
    applyStateDelta,
    commitExecutedDataDelta,
    computeStateDelta,
    createNodeRuntimeSnapshot,
    reconcileRuntimeCommit
} from './agentflow/stateReconciler'
import {
    aggregateTerminalMetadata,
    createStreamCoordinator,
    ITerminalMetadata,
    resolveTerminalContent
} from './agentflow/terminalCoordinator'
import {
    PendingNode,
    PendingResume,
    TrustedHistoryMessage,
    buildPendingResume,
    buildTrustedState,
    findOutputReferences,
    logTurnTokens,
    readTurnInput,
    rehydratePendingResume,
    toNodeMessage,
    toSlimAction,
    writeToken
} from './agentflow/trustedState'
import { toClientExecutedData } from './agentflow/clientPayloads'

/**
 * Add execution to database
 * @param {DataSource} appDataSource
 * @param {string} agentflowId
 * @param {IAgentflowExecutedData[]} agentFlowExecutedData
 * @param {string} sessionId
 * @returns {Promise<Execution>}
 */
const addExecution = async (
    appDataSource: DataSource,
    agentflowId: string,
    agentFlowExecutedData: IAgentflowExecutedData[],
    sessionId: string,
    workspaceId: string,
    zeroRetention: boolean,
    enqueueDbUpdate?: <T>(task: () => Promise<T>) => Promise<T>
) => {
    if (process.env.DISABLE_EXECUTION_RECORDING || zeroRetention) {
        return {
            id: `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            state: 'INPROGRESS',
            agentflowId,
            sessionId,
            workspaceId,
            executionData: JSON.stringify(agentFlowExecutedData),
            executionDataBlob: undefined,
            createdDate: new Date(),
            updatedDate: new Date()
        } as Execution
    }
    const newExecution = new Execution()
    let executionData = JSON.stringify(agentFlowExecutedData)
    let postDataAsync = process.env.EXECUTIONS_DB_THREAD_EARLY ? executionData.length > 2048 : false // if init data is > 2kb, just create entry and update data in worker thread...
    const bodyExecution = {
        agentflowId,
        state: 'INPROGRESS',
        sessionId,
        workspaceId,
        executionData: '[]', //postDataAsync ? '[]' : executionData,
        executionDataBlob: postDataAsync ? null : await Compression.compress(executionData)
        // executionData: JSON.stringify(agentFlowExecutedData)
    }
    Object.assign(newExecution, bodyExecution)

    let executionDB = await appDataSource.getRepository(Execution).save(appDataSource.getRepository(Execution).create(newExecution))
    if (postDataAsync) {
        const runPostUpdate = () => updateExecution(appDataSource, executionDB.id, workspaceId, { executionData }, zeroRetention)
        const pending = enqueueDbUpdate ? enqueueDbUpdate(runPostUpdate) : runPostUpdate()
        pending.catch((err) => {
            logger.warn(`addExecution async update err ${getErrorMessage(err)}`)
        })
    }
    return executionDB
}

/**
 * Update execution in database
 * @param {DataSource} appDataSource
 * @param {string} executionId
 * @param {Partial<IExecution>} data
 * @returns {Promise<boolean>} false when the row to update does not exist
 */
const updateExecution = async (
    appDataSource: DataSource,
    executionId: string,
    workspaceId: string,
    data?: Partial<IExecution>,
    zeroRetention?: boolean
): Promise<boolean> => {
    if (process.env.DISABLE_EXECUTION_RECORDING || zeroRetention) {
        return true
    }

    if (process.env.EXECUTIONS_DB_THREAD) {
        const payload = data ? { ...data } : undefined
        if (payload?.executionData && payload.executionData.length > 2) {
            payload.executionDataBlob = await Compression.compress(payload.executionData)
            payload.executionData = '[]'
        }
        try {
            await executionsUpdater?.run({ executionId, workspaceId, data: payload })
        } catch (err) {
            logger.warn(`updateExecution err ${err}`)
        }
        return true
    }
    const execution = await appDataSource.getRepository(Execution).findOneBy({
        id: executionId,
        workspaceId
    })

    if (!execution) {
        logger.warn(`[agentflow]: Execution ${executionId} not found; it is not updated`)
        return false
    }

    const updateExecution = new Execution()
    const bodyExecution: ICommonObject = {}
    if (data && data.executionDataBlob) {
        bodyExecution.executionDataBlob = data.executionDataBlob
        bodyExecution.executionData = '[]'
    } else if (data && data.executionData) {
        bodyExecution.executionDataBlob = await Compression.compress(data.executionData)
        bodyExecution.executionData = '[]'
    }
    if (data && data.state) {
        bodyExecution.state = data.state

        if (data.state === 'STOPPED') {
            bodyExecution.stoppedDate = new Date()
        }
    }

    Object.assign(updateExecution, bodyExecution)

    appDataSource.getRepository(Execution).merge(execution, updateExecution)
    await appDataSource.getRepository(Execution).save(execution)
    return true
}

// The records of the paused run's row, which the resume continues; they are written back and never reach the conversation (D10)
const readRecordedRun = async (
    appDataSource: DataSource,
    executionId: string,
    workspaceId: string
): Promise<IAgentflowExecutedData[] | undefined> => {
    const execution = await appDataSource.getRepository(Execution).findOneBy({ id: executionId, workspaceId })
    if (!execution) return undefined
    const json = execution.executionDataBlob ? await Compression.decompress(execution.executionDataBlob) : execution.executionData
    return JSON.parse(json || '[]')
}

export const resolveVariables = async (
    reactFlowNodeData: INodeData,
    question: string,
    form: Record<string, any>,
    flowConfig: IFlowConfig | undefined,
    availableVariables: Variable[],
    variableOverrides: IVariableOverride[],
    uploadedFilesContent: string,
    chatHistory: IMessage[],
    componentNodes: IComponentNodes,
    agentFlowExecutedData?: IAgentflowExecutedData[],
    iterationContext?: ICommonObject,
    loopCounts?: Map<string, number>
): Promise<INodeData> => {
    let flowNodeData = cloneDeep(reactFlowNodeData)
    const types = 'inputs'

    const resolveNodeReference = async (value: any): Promise<any> => {
        // If value is an array, process each element
        if (Array.isArray(value)) {
            return Promise.all(value.map((item) => resolveNodeReference(item)))
        }

        // If value is an object, process each property
        if (typeof value === 'object' && value !== null) {
            const resolvedObj: any = {}
            for (const [key, val] of Object.entries(value)) {
                resolvedObj[key] = await resolveNodeReference(val)
            }
            return resolvedObj
        }

        // If value is not a string, return as is
        if (typeof value !== 'string') return value

        const turndownService = new TurndownService()
        value = turndownService.turndown(value)
        // After conversion, replace any escaped underscores with regular underscores
        value = value.replace(/\\_/g, '_')

        const matches = value.match(/{{(.*?)}}/g)

        if (!matches) return value

        let resolvedValue = value
        for (const match of matches) {
            // Remove {{ }} and trim whitespace
            const reference = match.replace(/[{}]/g, '').trim()
            const variableFullPath = reference

            if (variableFullPath === QUESTION_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, question)
                resolvedValue = uploadedFilesContent ? `${uploadedFilesContent}\n\n${resolvedValue}` : resolvedValue
            }

            if (variableFullPath.startsWith('$form.')) {
                const variableValue = get(form, variableFullPath.replace('$form.', ''))
                if (variableValue != null) {
                    // For arrays and objects, stringify them to prevent toString() conversion issues
                    const formattedValue =
                        Array.isArray(variableValue) || (typeof variableValue === 'object' && variableValue !== null)
                            ? JSON.stringify(variableValue)
                            : variableValue
                    resolvedValue = resolvedValue.replace(match, formattedValue)
                }
            }

            if (variableFullPath === FILE_ATTACHMENT_PREFIX) {
                resolvedValue = resolvedValue.replace(match, uploadedFilesContent)
            }

            if (variableFullPath === CHAT_HISTORY_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, convertChatHistoryToText(chatHistory))
            }

            if (variableFullPath === RUNTIME_MESSAGES_LENGTH_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, flowConfig?.runtimeChatHistoryLength ?? 0)
            }

            if (variableFullPath === LOOP_COUNT_VAR_PREFIX) {
                // Get the current loop count from the most recent loopAgentflow node execution
                let currentLoopCount = 0
                if (loopCounts && agentFlowExecutedData) {
                    // Find the most recent loopAgentflow node execution to get its loop count
                    const loopNodes = [...agentFlowExecutedData].reverse().filter((data) => data.data?.name === 'loopAgentflow')
                    if (loopNodes.length > 0) {
                        const latestLoopNode = loopNodes[0]
                        currentLoopCount = loopCounts.get(latestLoopNode.nodeId) || 0
                    }
                }
                resolvedValue = resolvedValue.replace(match, currentLoopCount.toString())
            }

            if (variableFullPath === CURRENT_DATE_TIME_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, new Date().toISOString())
            }

            if (variableFullPath.startsWith('$iteration')) {
                if (iterationContext && iterationContext.value) {
                    if (variableFullPath === '$iteration') {
                        // If it's exactly $iteration, stringify the entire value
                        const formattedValue =
                            typeof iterationContext.value === 'object' ? JSON.stringify(iterationContext.value) : iterationContext.value
                        resolvedValue = resolvedValue.replace(match, formattedValue)
                    } else if (typeof iterationContext.value === 'string') {
                        resolvedValue = resolvedValue.replace(match, iterationContext?.value)
                    } else if (typeof iterationContext.value === 'object') {
                        const iterationValue = get(iterationContext.value, variableFullPath.replace('$iteration.', ''))
                        // For arrays and objects, stringify them to prevent toString() conversion issues
                        const formattedValue =
                            Array.isArray(iterationValue) || (typeof iterationValue === 'object' && iterationValue !== null)
                                ? JSON.stringify(iterationValue)
                                : iterationValue
                        resolvedValue = resolvedValue.replace(match, formattedValue)
                    }
                }
            }

            if (variableFullPath.startsWith('$vars.')) {
                const vars = await getGlobalVariable(flowConfig, availableVariables, variableOverrides)
                const variableValue = get(vars, variableFullPath.replace('$vars.', ''))
                if (variableValue != null) {
                    // For arrays and objects, stringify them to prevent toString() conversion issues
                    const formattedValue =
                        Array.isArray(variableValue) || (typeof variableValue === 'object' && variableValue !== null)
                            ? JSON.stringify(variableValue)
                            : variableValue
                    resolvedValue = resolvedValue.replace(match, formattedValue)
                }
            }

            if (variableFullPath.startsWith('$flow.') && flowConfig) {
                const variableValue = get(flowConfig, variableFullPath.replace('$flow.', ''))
                if (variableValue != null) {
                    // For arrays and objects, stringify them to prevent toString() conversion issues
                    const formattedValue =
                        Array.isArray(variableValue) || (typeof variableValue === 'object' && variableValue !== null)
                            ? JSON.stringify(variableValue)
                            : variableValue
                    resolvedValue = resolvedValue.replace(match, formattedValue)
                }
            }

            // Check if the variable is an output reference like `nodeId.output.path`
            const outputMatch = variableFullPath.match(/^(.*?)\.output\.(.+)$/)
            if (outputMatch && agentFlowExecutedData) {
                // Extract nodeId and outputPath from the match
                const [, nodeIdPart, outputPath] = outputMatch
                // Clean nodeId (handle escaped underscores)
                const cleanNodeId = nodeIdPart.replace('\\', '')

                // Find the last (most recent) matching node data instead of the first one
                const nodeData = [...agentFlowExecutedData].reverse().find((d) => d.nodeId === cleanNodeId)

                if (nodeData?.data?.output && outputPath.trim()) {
                    const variableValue = get(nodeData.data.output, outputPath)
                    if (variableValue !== undefined) {
                        // Replace the reference with actual value
                        const formattedValue =
                            Array.isArray(variableValue) || (typeof variableValue === 'object' && variableValue !== null)
                                ? JSON.stringify(variableValue)
                                : variableValue
                        // If the resolved value is exactly the match, replace it directly
                        if (resolvedValue === match) {
                            resolvedValue = formattedValue
                        } else {
                            // Otherwise do a standard string‐replace
                            resolvedValue = String(resolvedValue).replace(match, String(formattedValue))
                        }
                        // Skip fallback logic
                        continue
                    }
                }
            }

            // Find node data in executed data
            // sometimes turndown value returns a backslash like `llmAgentflow\_1`, remove the backslash
            const cleanNodeId = variableFullPath.replace('\\', '')
            // Find the last (most recent) matching node data instead of the first one
            const nodeData = agentFlowExecutedData
                ? [...agentFlowExecutedData].reverse().find((data) => data.nodeId === cleanNodeId)
                : undefined
            if (nodeData && nodeData.data) {
                // Replace the reference with actual value
                const nodeOutput = nodeData.data['output'] as ICommonObject
                const actualValue = nodeOutput?.content ?? nodeOutput?.http?.data
                // For arrays and objects, stringify them to prevent toString() conversion issues
                const formattedValue =
                    Array.isArray(actualValue) || (typeof actualValue === 'object' && actualValue !== null)
                        ? JSON.stringify(actualValue)
                        : actualValue?.toString() ?? match
                resolvedValue = resolvedValue.replace(match, formattedValue)
            }
        }

        return resolvedValue
    }

    const getParamValues = async (paramsObj: ICommonObject) => {
        /*
         * EXAMPLE SCENARIO:
         *
         * 1. Agent node has inputParam: { name: "agentTools", type: "array", array: [{ name: "agentSelectedTool", loadConfig: true }] }
         * 2. Inputs contain: { agentTools: [{ agentSelectedTool: "requestsGet", agentSelectedToolConfig: { requestsGetHeaders: "Bearer {{ $vars.TOKEN }}" } }] }
         * 3. We need to resolve the variable in requestsGetHeaders because RequestsGet node defines requestsGetHeaders with acceptVariable: true
         *
         * STEP 1: Find all parameters with loadConfig=true (e.g., "agentSelectedTool")
         * STEP 2: Find their values in inputs (e.g., "requestsGet")
         * STEP 3: Look up component node definition for "requestsGet"
         * STEP 4: Find which of its parameters have acceptVariable=true (e.g., "requestsGetHeaders")
         * STEP 5: Find the config object (e.g., "agentSelectedToolConfig")
         * STEP 6: Resolve variables in config parameters that accept variables
         */

        // Helper function to find params with loadConfig recursively
        // Example: Finds ["agentModel", "agentSelectedTool"] from the inputParams structure
        const findParamsWithLoadConfig = (inputParams: any[]): string[] => {
            const paramsWithLoadConfig: string[] = []

            for (const param of inputParams) {
                // Direct loadConfig param (e.g., agentModel with loadConfig: true)
                if (param.loadConfig === true) {
                    paramsWithLoadConfig.push(param.name)
                }

                // Check nested array parameters (e.g., agentTools.array contains agentSelectedTool with loadConfig: true)
                if (param.type === 'array' && param.array && Array.isArray(param.array)) {
                    const nestedParams = findParamsWithLoadConfig(param.array)
                    paramsWithLoadConfig.push(...nestedParams)
                }
            }

            return paramsWithLoadConfig
        }

        // Helper function to find value of a parameter recursively in nested objects/arrays
        // Example: Searches for "agentSelectedTool" value in complex nested inputs structure
        // Returns "requestsGet" when found in agentTools[0].agentSelectedTool
        const findParamValue = (obj: any, paramName: string): any => {
            if (typeof obj !== 'object' || obj === null) {
                return undefined
            }

            // Handle arrays (e.g., agentTools array)
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const result = findParamValue(item, paramName)
                    if (result !== undefined) {
                        return result
                    }
                }
                return undefined
            }

            // Direct property match
            if (Object.prototype.hasOwnProperty.call(obj, paramName)) {
                return obj[paramName]
            }

            // Recursively search nested objects
            for (const value of Object.values(obj)) {
                const result = findParamValue(value, paramName)
                if (result !== undefined) {
                    return result
                }
            }

            return undefined
        }

        // Helper function to process config parameters with acceptVariable
        // Example: Processes agentSelectedToolConfig object, resolving variables in requestsGetHeaders
        const processConfigParams = async (configObj: any, configParamWithAcceptVariables: string[]) => {
            if (typeof configObj !== 'object' || configObj === null) {
                return
            }

            // Handle arrays of config objects
            if (Array.isArray(configObj)) {
                for (const item of configObj) {
                    await processConfigParams(item, configParamWithAcceptVariables)
                }
                return
            }

            for (const [key, value] of Object.entries(configObj)) {
                // Only resolve variables for parameters that accept them
                // Example: requestsGetHeaders is in configParamWithAcceptVariables, so resolve "Bearer {{ $vars.TOKEN }}"
                if (configParamWithAcceptVariables.includes(key)) {
                    configObj[key] = await resolveNodeReference(value)
                }
            }
        }

        // STEP 1: Get all params with loadConfig from inputParams
        // Example result: ["agentModel", "agentSelectedTool"]
        const paramsWithLoadConfig = findParamsWithLoadConfig(reactFlowNodeData.inputParams)

        // STEP 2-6: Process each param with loadConfig
        for (const paramWithLoadConfig of paramsWithLoadConfig) {
            // STEP 2: Find the value of this parameter in the inputs
            // Example: paramWithLoadConfig="agentSelectedTool", paramValue="requestsGet"
            const paramValue = findParamValue(paramsObj, paramWithLoadConfig)

            if (paramValue && componentNodes[paramValue]) {
                // STEP 3: Get the node instance inputs to find params with acceptVariable
                // Example: componentNodes["requestsGet"] contains the RequestsGet node definition
                const nodeInstance = componentNodes[paramValue]
                const configParamWithAcceptVariables: string[] = []

                // STEP 4: Find which parameters of the component accept variables
                // Example: RequestsGet has inputs like { name: "requestsGetHeaders", acceptVariable: true }
                if (nodeInstance.inputs && Array.isArray(nodeInstance.inputs)) {
                    for (const input of nodeInstance.inputs) {
                        if (input.acceptVariable === true) {
                            configParamWithAcceptVariables.push(input.name)
                        }
                    }
                }
                // Example result: configParamWithAcceptVariables = ["requestsGetHeaders", "requestsGetUrl", ...]

                // STEP 5: Look for the config object (paramName + "Config")
                // Example: Look for "agentSelectedToolConfig" in the inputs
                const configParamName = paramWithLoadConfig + 'Config'

                // Find all config values (handle arrays)
                const findAllConfigValues = (obj: any, paramName: string): any[] => {
                    const results: any[] = []

                    if (typeof obj !== 'object' || obj === null) {
                        return results
                    }

                    // Handle arrays (e.g., agentTools array)
                    if (Array.isArray(obj)) {
                        for (const item of obj) {
                            results.push(...findAllConfigValues(item, paramName))
                        }
                        return results
                    }

                    // Direct property match
                    if (Object.prototype.hasOwnProperty.call(obj, paramName)) {
                        results.push(obj[paramName])
                    }

                    // Recursively search nested objects
                    for (const value of Object.values(obj)) {
                        results.push(...findAllConfigValues(value, paramName))
                    }

                    return results
                }

                const configValues = findAllConfigValues(paramsObj, configParamName)

                // STEP 6: Process all config objects to resolve variables
                // Example: Resolve "Bearer {{ $vars.TOKEN }}" in requestsGetHeaders
                if (configValues.length > 0 && configParamWithAcceptVariables.length > 0) {
                    for (const configValue of configValues) {
                        await processConfigParams(configValue, configParamWithAcceptVariables)
                    }
                }
            }
        }

        // Original logic for direct acceptVariable params (maintains backward compatibility)
        // Example: Direct params like agentUserMessage with acceptVariable: true
        for (const key in paramsObj) {
            const paramValue = paramsObj[key]
            const isAcceptVariable = reactFlowNodeData.inputParams.find((param) => param.name === key)?.acceptVariable ?? false
            if (isAcceptVariable) {
                paramsObj[key] = await resolveNodeReference(paramValue)
            }
        }
    }

    const paramsObj = flowNodeData[types] ?? {}
    await getParamValues(paramsObj)

    return flowNodeData
}

/**
 * Executes a single node in the workflow
 * @param params - Parameters needed for node execution
 * @returns The result of the node execution
 */
const executeNode = async ({
    nodeId,
    reactFlowNode,
    nodes,
    edges,
    graph,
    reversedGraph,
    incomingInput,
    chatflow,
    chatId,
    sessionId,
    apiMessageId,
    evaluationRunId,
    parentExecutionId,
    pastChatHistory,
    appDataSource,
    usageCacheManager,
    telemetry,
    componentNodes,
    cachePool,
    sseStreamer,
    baseURL,
    overrideConfig = {},
    apiOverrideStatus = false,
    nodeOverrides = {},
    variableOverrides = [],
    uploadedFilesContent = '',
    fileUploads,
    humanInput,
    agentFlowExecutedData = [],
    agentflowRuntime,
    abortController,
    parentTraceIds,
    analyticHandlers,
    isInternal,
    isRecursive,
    iterationContext,
    loopCounts,
    orgId,
    workspaceId,
    subscriptionId,
    productId,
    zeroRetention = false,
    nodeInstanceFactory,
    maxNodeConcurrency,
    enqueueDbUpdate,
    getRecordedData,
    getAvailableVariables,
    turnInput
}: IExecuteNodeParams): Promise<IExecuteNodeResult> => {
    try {
        if (abortController?.signal?.aborted) {
            throw new Error('Aborted')
        }

        // Stream progress event
        sseStreamer?.streamNextAgentFlowEvent(chatId, {
            nodeId,
            nodeLabel: reactFlowNode.data.label,
            status: 'INPROGRESS'
        })

        // Get node implementation
        let newNodeInstance: IAgentflowNodeInstance
        if (nodeInstanceFactory) {
            newNodeInstance = await nodeInstanceFactory(reactFlowNode.data.name, reactFlowNode, componentNodes)
        } else {
            const nodeInstanceFilePath = componentNodes[reactFlowNode.data.name].filePath as string
            const nodeModule = await import(nodeInstanceFilePath)
            newNodeInstance = new nodeModule.nodeClass()
        }

        // Prepare node data
        let flowNodeData = cloneDeep(reactFlowNode.data)

        // Apply config overrides if needed
        if (overrideConfig && apiOverrideStatus) {
            flowNodeData = replaceInputsWithConfig(flowNodeData, overrideConfig, nodeOverrides, variableOverrides)
        }

        // Get available variables and resolve them
        const availableVariables = await getAvailableVariables()

        // Snapshot read-only view of prior execution data and track incremental deltas to commit by caller
        const executedDataSnapshot = [...agentFlowExecutedData]
        const additionalExecutedData: IAgentflowExecutedData[] = []
        const removedExecutedNodeIds: string[] = []

        // Prepare flow config
        let updatedState = cloneDeep(agentflowRuntime.state)
        const runtimeChatHistory = agentflowRuntime.chatHistory || []
        const chatHistory = [...pastChatHistory, ...runtimeChatHistory]
        const flowConfig: IFlowConfig = {
            chatflowid: chatflow.id,
            chatflowId: chatflow.id,
            chatId,
            sessionId,
            apiMessageId,
            chatHistory,
            runtimeChatHistoryLength: Math.max(0, runtimeChatHistory.length - 1),
            state: updatedState,
            ...overrideConfig
        }
        if (
            iterationContext &&
            iterationContext.agentflowRuntime &&
            iterationContext.agentflowRuntime.state &&
            Object.keys(iterationContext.agentflowRuntime.state).length > 0
        ) {
            updatedState = {
                ...updatedState,
                ...cloneDeep(iterationContext.agentflowRuntime.state)
            }
            flowConfig.state = updatedState
        }

        // Resolve variables in node data
        const reactFlowNodeData: INodeData = await resolveVariables(
            flowNodeData,
            incomingInput.question ?? '',
            agentflowRuntime.form ?? {},
            flowConfig,
            availableVariables,
            variableOverrides,
            uploadedFilesContent,
            chatHistory,
            componentNodes,
            executedDataSnapshot,
            iterationContext,
            loopCounts
        )

        // Handle human input if present
        let humanInputAction: Record<string, any> | undefined
        let resumeCheckpoint: ICommonObject | undefined
        let updatedHumanInput = humanInput

        // This is when human in the loop is resumed (strictly scoped to the target startNodeId)
        const isResumedHumanInputNode = Boolean(humanInput && nodeId === humanInput.startNodeId)
        if (isResumedHumanInputNode && executedDataSnapshot.length) {
            humanInputAction = findResumedHumanInputAction(executedDataSnapshot, nodeId)
            resumeCheckpoint = findResumeCheckpoint(executedDataSnapshot, nodeId)
        }
        if (isResumedHumanInputNode && humanInput) {
            reactFlowNodeData.inputs = { ...reactFlowNodeData.inputs, humanInput }
            // Mark the stopped humanInput entry for removal when committing this node
            removedExecutedNodeIds.push(nodeId)

            // Clear humanInput after it's been consumed to prevent subsequent humanInputAgentflow nodes from proceeding
            logger.debug(`🧹 Clearing humanInput after consumption by node: ${nodeId}`)
            updatedHumanInput = undefined
        }

        // Check if this is the last node for streaming purpose
        const isLastNode =
            !isRecursive &&
            (!graph[nodeId] ||
                graph[nodeId].length === 0 ||
                (!isResumedHumanInputNode && reactFlowNode.data.name === 'humanInputAgentflow'))

        if (incomingInput.question && incomingInput.form) {
            throw new Error('Question and form cannot be provided at the same time')
        }

        let finalInput: string | Record<string, any> | undefined
        if (incomingInput.question) {
            // Prepare final question with uploaded content if any
            finalInput = uploadedFilesContent ? `${uploadedFilesContent}\n\n${incomingInput.question}` : incomingInput.question
        } else if (incomingInput.form) {
            finalInput = Object.entries(incomingInput.form || {})
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')
        }

        // Prepare run parameters
        const runParams = {
            orgId,
            workspaceId,
            subscriptionId,
            chatId,
            sessionId,
            chatflowid: chatflow.id,
            chatflowId: chatflow.id,
            apiMessageId: flowConfig.apiMessageId,
            logger,
            appDataSource,
            databaseEntities,
            usageCacheManager,
            componentNodes,
            cachePool,
            analytic: chatflow.analytic,
            uploads: fileUploads,
            baseURL,
            isLastNode,
            sseStreamer: isRecursive ? undefined : sseStreamer,
            pastChatHistory: cloneDeep(pastChatHistory),
            historySource: turnInput.historySource,
            agentflowRuntime,
            abortController,
            analyticHandlers,
            parentTraceIds,
            humanInputAction,
            resumeCheckpoint,
            iterationContext: iterationContext ? cloneDeep(iterationContext) : undefined,
            evaluationRunId,
            overrideConfig,
            childFlowToken: turnInput.childFlowTokens[nodeId]
        }

        // Execute node
        let results = await newNodeInstance.run(reactFlowNodeData, finalInput, runParams)

        if (results && typeof results === 'object') {
            const childFlowToken = results.childFlowToken
            delete results.childFlowToken
            if (childFlowToken?.token) {
                turnInput.childFlowTokens[nodeId] = { flowId: childFlowToken.flowId, token: childFlowToken.token }
            } else {
                delete turnInput.childFlowTokens[nodeId]
            }
        }

        // Handle iteration node with recursive execution
        if (
            reactFlowNode.data.name === 'iterationAgentflow' &&
            results?.input?.iterationInput &&
            Array.isArray(results.input.iterationInput)
        ) {
            logger.debug(`  🔄 Processing iteration node with ${results.input.iterationInput.length} items using recursive execution`)

            // Get child nodes for this iteration
            const childNodes = nodes.filter((node) => node.parentNode === nodeId)

            if (childNodes.length > 0) {
                logger.debug(`  📦 Found ${childNodes.length} child nodes for iteration`)

                // Create a new flow object containing only the nodes in this iteration block
                const iterationFlowData: IReactFlowObject = {
                    nodes: childNodes,
                    edges: edges.filter((edge: IReactFlowEdge) => {
                        const sourceNode = nodes.find((n) => n.id === edge.source)
                        const targetNode = nodes.find((n) => n.id === edge.target)
                        return sourceNode?.parentNode === nodeId && targetNode?.parentNode === nodeId
                    }),
                    viewport: { x: 0, y: 0, zoom: 1 }
                }

                // Create a modified chatflow for this iteration
                const iterationChatflow = {
                    ...chatflow,
                    flowData: JSON.stringify(iterationFlowData)
                }

                // Initialize array to collect results from iterations
                const iterationResults: string[] = []

                // Execute sub-flow for each item in the iteration array
                for (let i = 0; i < results.input.iterationInput.length; i++) {
                    if (abortController?.signal?.aborted) {
                        throw new Error('Aborted')
                    }
                    const item = results.input.iterationInput[i]
                    logger.debug(`  🔄 Processing iteration ${i + 1}/${results.input.iterationInput.length} recursively`)

                    // Create iteration context
                    const iterationContext = {
                        index: i,
                        value: item,
                        isFirst: i === 0,
                        isLast: i === results.input.iterationInput.length - 1,
                        sessionId: sessionId
                    }

                    try {
                        // Execute sub-flow recursively
                        const subFlowResult = await executeAgentFlow({
                            componentNodes,
                            incomingInput,
                            chatflow: iterationChatflow,
                            chatId,
                            evaluationRunId,
                            appDataSource,
                            usageCacheManager,
                            telemetry,
                            cachePool,
                            sseStreamer,
                            baseURL,
                            isInternal,
                            uploadedFilesContent,
                            fileUploads,
                            signal: abortController,
                            isRecursive: true,
                            parentExecutionId,
                            iterationContext: {
                                ...iterationContext,
                                agentflowRuntime: createNodeRuntimeSnapshot(agentflowRuntime).nodeRuntimeSnapshot
                            },
                            orgId,
                            workspaceId,
                            subscriptionId,
                            productId,
                            nodeInstanceFactory,
                            maxNodeConcurrency,
                            turnInput
                        })

                        // Store the result
                        if (subFlowResult?.text) {
                            iterationResults.push(subFlowResult.text)
                        }

                        // Add executed data from sub-flow to main execution data with appropriate iteration context
                        if (subFlowResult?.agentFlowExecutedData) {
                            const subflowExecutedData = subFlowResult.agentFlowExecutedData.map((data: IAgentflowExecutedData) => ({
                                ...data,
                                data: {
                                    ...data.data,
                                    iterationIndex: i,
                                    iterationContext,
                                    parentNodeId: reactFlowNode.data.id
                                }
                            }))

                            // Record subflow executed data incrementally for caller commit
                            additionalExecutedData.push(...subflowExecutedData)

                            // Update parent execution record with combined data if we have a parent execution ID
                            if (parentExecutionId && !zeroRetention) {
                                try {
                                    logger.debug(`  📝 Updating parent execution ${parentExecutionId} with iteration ${i + 1} data`)
                                    // Serialized when the queued write runs, so records committed by parallel siblings since launch are kept
                                    const persistIteration = () => {
                                        const committed = getRecordedData?.() ?? executedDataSnapshot
                                        const committedRecords = new Set(committed)
                                        const executionDataJson = JSON.stringify([
                                            ...committed,
                                            ...additionalExecutedData.filter((record) => !committedRecords.has(record))
                                        ])
                                        return updateExecution(
                                            appDataSource,
                                            parentExecutionId,
                                            workspaceId,
                                            { executionData: executionDataJson },
                                            zeroRetention
                                        )
                                    }
                                    const pendingUpdate = enqueueDbUpdate ? enqueueDbUpdate(persistIteration) : persistIteration()
                                    pendingUpdate.catch((error) => {
                                        console.error(`  ❌ Error updating parent execution: ${getErrorMessage(error)}`)
                                    })
                                } catch (error) {
                                    console.error(`  ❌ Error updating parent execution: ${getErrorMessage(error)}`)
                                }
                            }
                        }

                        // Merge the child iteration's runtime state back to parent
                        if (
                            subFlowResult?.agentflowRuntime &&
                            subFlowResult.agentflowRuntime.state &&
                            Object.keys(subFlowResult.agentflowRuntime.state).length > 0
                        ) {
                            logger.debug(`  🔄 Merging iteration ${i + 1} runtime state back to parent`)

                            updatedState = {
                                ...updatedState,
                                ...cloneDeep(subFlowResult.agentflowRuntime.state)
                            }

                            // Update next iteration's isolated runtime state
                            agentflowRuntime.state = cloneDeep(updatedState)

                            // Update parent execution's runtime state
                            results.state = updatedState
                        }
                    } catch (error) {
                        if (abortController?.signal?.aborted) {
                            throw error
                        }
                        console.error(`  ❌ Error in iteration ${i + 1}: ${getErrorMessage(error)}`)
                        iterationResults.push(`Error in iteration ${i + 1}: ${getErrorMessage(error)}`)
                    }
                }

                // Update the output with combined results
                results.output = {
                    ...(results.output || {}),
                    iterationResults,
                    content: iterationResults.join('\n')
                }

                logger.debug(`  📊 Completed all iterations. Total results: ${iterationResults.length}`)
            }
        }

        // Stop going through the current route if the node is a human task
        if (!isResumedHumanInputNode && reactFlowNode.data.name === 'humanInputAgentflow') {
            const humanInputAction = toSlimAction({
                id: uuidv4(),
                mapping: {
                    approve: 'Proceed',
                    reject: 'Reject'
                },
                elements: [
                    { type: 'agentflowv2-approve-button', label: reactFlowNodeData.inputs?.humanInputAcceptLabelText || 'Proceed' },
                    { type: 'agentflowv2-reject-button', label: reactFlowNodeData.inputs?.humanInputRejectLabelText || 'Reject' }
                ],
                data: {
                    nodeId,
                    nodeLabel: reactFlowNode.data.label,
                    input: results.input
                }
            })

            const newWorkflowExecutedData: IAgentflowExecutedData = {
                nodeId,
                nodeLabel: reactFlowNode.data.label,
                data: {
                    ...results,
                    output: {
                        ...results.output,
                        humanInputAction
                    }
                },
                previousNodeIds: reversedGraph[nodeId] || [],
                status: 'STOPPED'
            }

            return {
                result: results,
                shouldStop: true,
                additionalExecutedData,
                removedExecutedNodeIds,
                stoppedExecutedData: newWorkflowExecutedData,
                humanInputAction,
                humanInput: updatedHumanInput
            }
        }

        // Stop going through the current route if the node is a agent node waiting for human input before using the tool
        if (reactFlowNode.data.name === 'agentAgentflow' && results?.output?.isWaitingForHumanInput) {
            // The checkpoint's history references index this turn's history
            if (results.output.resumeCheckpoint) {
                results.output.resumeCheckpoint = { historyLength: pastChatHistory.length, ...results.output.resumeCheckpoint }
            }
            const humanInputAction = toSlimAction({
                id: uuidv4(),
                mapping: {
                    approve: 'Proceed',
                    reject: 'Reject'
                },
                elements: [
                    { type: 'agentflowv2-approve-button', label: 'Proceed' },
                    { type: 'agentflowv2-reject-button', label: 'Reject' }
                ],
                data: {
                    nodeId,
                    nodeLabel: reactFlowNode.data.label,
                    input: results.input
                }
            })

            const newWorkflowExecutedData: IAgentflowExecutedData = {
                nodeId,
                nodeLabel: reactFlowNode.data.label,
                data: {
                    ...results,
                    output: {
                        ...results.output,
                        humanInputAction
                    }
                },
                previousNodeIds: reversedGraph[nodeId] || [],
                status: 'STOPPED'
            }

            return {
                result: results,
                shouldStop: true,
                additionalExecutedData,
                removedExecutedNodeIds,
                stoppedExecutedData: newWorkflowExecutedData,
                humanInputAction,
                humanInput: updatedHumanInput
            }
        }

        return {
            result: results,
            additionalExecutedData,
            removedExecutedNodeIds,
            humanInput: updatedHumanInput
        }
    } catch (error) {
        logger.error(`[server]: Error executing node ${nodeId}: ${getErrorMessage(error)}`)
        throw error
    }
}

// With a HumanInput's history toggle off, the approval exchange leaves no trace in history (D8)
const isHistoryOff = (node?: IReactFlowNode) =>
    node?.data.name === 'humanInputAgentflow' && node.data.inputs?.humanInputHistoryToggle === false

const stoppedAction = (pending: PendingResume | undefined, nodeId: string | undefined) =>
    [...(pending?.nodes ?? [])].reverse().find((entry) => entry.nodeId === nodeId && entry.status === 'STOPPED')?.action

// The user message of a resume turn (TS15): the feedback, else the question the client sent, else the answered button's label
const resumeAnswer = (humanInput: IHumanInput, question: string | undefined, action?: PendingNode['action']): string => {
    if (humanInput.feedback?.trim()) return humanInput.feedback
    if (question?.trim()) return question
    const button = humanInput.type === 'reject' ? 'reject' : 'approve'
    return action?.elements?.find((element) => element.type?.includes(button))?.label ?? action?.mapping?.[button] ?? humanInput.type
}

const latestStoppedPrompt = (records: IAgentflowExecutedData[], nodeId: string | undefined): string | undefined => {
    const record = [...records].reverse().find((r) => r.nodeId === nodeId && r.status === 'STOPPED' && !r.data?.parentNodeId)
    const prompt = (record?.data?.output as ICommonObject | undefined)?.content
    return typeof prompt === 'string' ? prompt : undefined
}

// The answered stop message keeps no buttons (D11); with the history toggle off it goes, as the exchange leaves no trace
const clearStopMessage = async (appDataSource: DataSource, id: string, remove: boolean) => {
    try {
        const repository = appDataSource.getRepository(ChatMessage)
        if (remove) await repository.delete({ id })
        else await repository.update({ id }, { action: null })
    } catch (error) {
        logger.warn(`[agentflow]: Failed to update the answered stop message ${id}: ${getErrorMessage(error)}`)
    }
}

const checkForMultipleStartNodes = (startingNodeIds: string[], isRecursive: boolean, nodes: IReactFlowNode[]) => {
    // For non-recursive, loop through and check if each starting node is inside an iteration node, if yes, delete it
    const clonedStartingNodeIds = [...startingNodeIds]
    for (const nodeId of clonedStartingNodeIds) {
        const node = nodes.find((node) => node.id === nodeId)
        if (node?.extent === 'parent' && !isRecursive) {
            startingNodeIds.splice(startingNodeIds.indexOf(nodeId), 1)
        }
    }

    if (!isRecursive && startingNodeIds.length > 1) {
        const startAgentflowIds = startingNodeIds.filter((id) => nodes.find((node) => node.id === id)?.data?.name === 'startAgentflow')
        if (startAgentflowIds.length === 1) {
            // Allow disconnected non-start nodes on canvas; dependencyEngine pre-marks them SKIPPED
            startingNodeIds.splice(0, startingNodeIds.length, startAgentflowIds[0])
            return
        }
        throw new Error('Multiple starting nodes are not allowed')
    }
}

/*
 * Function to traverse the flow graph and execute the nodes
 */
export const executeAgentFlow = async ({
    componentNodes,
    incomingInput,
    chatflow,
    chatId,
    evaluationRunId,
    appDataSource,
    telemetry,
    usageCacheManager,
    cachePool,
    sseStreamer,
    baseURL,
    isInternal,
    uploadedFilesContent,
    fileUploads,
    signal: abortController,
    isRecursive = false,
    parentExecutionId,
    iterationContext,
    isTool = false,
    orgId,
    workspaceId,
    subscriptionId,
    productId,
    nodeInstanceFactory,
    maxNodeConcurrency,
    onNodeError,
    turnInput: parentTurnInput
}: IExecuteAgentFlowParams) => {
    logger.debug('\n🚀 Starting flow execution')

    const question = incomingInput.question
    const form = incomingInput.form
    let overrideConfig = incomingInput.overrideConfig ?? {}
    const uploads = incomingInput.uploads
    const userMessageDateTime = new Date()
    const chatflowid = chatflow.id
    const sessionId = iterationContext?.sessionId || overrideConfig.sessionId || chatId
    const humanInput: IHumanInput | undefined = incomingInput.humanInput

    // Validate history schema if provided
    if (incomingInput.history && incomingInput.history.length > 0) {
        if (!validateHistorySchema(incomingInput.history)) {
            throw new Error(
                'Invalid history format. Each history item must have: ' + '{ role: "apiMessage" | "userMessage", content: string }'
            )
        }
    }

    const apiMessageId = uuidv4()

    /*** Get chatflows and prepare data  ***/
    const flowData = chatflow.flowData
    const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
    const nodes = (parsedFlowData.nodes || []).filter((node) => node.data.name !== 'stickyNoteAgentflow')
    const edges = parsedFlowData.edges
    const { graph, nodeDependencies } = constructGraphs(nodes, edges)
    const { graph: reversedGraph } = constructGraphs(nodes, edges, { isReversed: true })
    const startInputType = nodes.find((node) => node.data.name === 'startAgentflow')?.data.inputs?.startInputType as
        | 'chatInput'
        | 'formInput'
    if (!startInputType && !isRecursive) {
        throw new Error('Start input type not found')
    }
    // @ts-ignore
    if (isTool) sseStreamer = undefined // If the request is from ChatflowTool, don't stream the response

    /*** Get API Config ***/
    const { nodeOverrides, variableOverrides, apiOverrideStatus } = getAPIOverrideConfig(chatflow)
    let chatflowConfig: ICommonObject = {}
    try {
        if (chatflow.chatbotConfig) {
            chatflowConfig = JSON.parse(chatflow.chatbotConfig)
        }
    } catch (e) {
        logger.error('[server]: Error parsing chatflow config:', e)
    }
    const disableChatMessageRecording: boolean = chatflowConfig.clientState?.enabled ?? incomingInput.enableTrustedState ?? false
    const zeroRetention: boolean = chatflowConfig.clientState?.enabledFull
    const outputReferences = isRecursive ? new Map<string, Set<string>>() : findOutputReferences(nodes)
    const turnInput =
        parentTurnInput ??
        (await readTurnInput(incomingInput, {
            acceptClientHistory: chatflowConfig.clientState?.acceptClientHistory === true,
            references: outputReferences
        }))
    const isResume = Boolean(humanInput) && !isRecursive
    let writtenToken: { token: string; historyLength: number; pending: boolean } | undefined
    let availableVariablesTask: Promise<Variable[]> | undefined
    const getAvailableVariables = () =>
        (availableVariablesTask ??= appDataSource.getRepository(Variable).findBy(getWorkspaceSearchOptions(workspaceId)))
    /*
    graph {
        startAgentflow_0: [ 'conditionAgentflow_0' ],
        conditionAgentflow_0: [ 'llmAgentflow_0', 'llmAgentflow_1' ],
        llmAgentflow_0: [ 'llmAgentflow_2' ],
        llmAgentflow_1: [ 'llmAgentflow_2' ],
        llmAgentflow_2: []
      }
    */

    /*
      nodeDependencies {
        startAgentflow_0: 0,
        conditionAgentflow_0: 1,
        llmAgentflow_0: 1,
        llmAgentflow_1: 1,
        llmAgentflow_2: 2
      }
    */

    let status: ExecutionState = 'INPROGRESS'
    const agentFlowExecutedData: IAgentflowExecutedData[] = []
    let newExecution: IExecution
    const startingNodeIds: string[] = []
    // A resume starts from records rehydrated from the pending data; they are never written to the Execution row (D10)
    const rehydratedRecords = new Map<IAgentflowExecutedData, PendingNode>()
    let recordedRun: IAgentflowExecutedData[] | undefined
    const removedRecordedNodeIds = new Set<string>()

    // Initialize execution queue
    const nodeExecutionQueue: INodeQueue[] = []
    const loopCounts: Map<string, number> = new Map()
    const dbUpdateQueue = createSerializedTaskQueue()
    const serializedUpdateExecution = (executionId: string, data?: Partial<IExecution>) =>
        dbUpdateQueue.enqueue(() => updateExecution(appDataSource, executionId, workspaceId, data, zeroRetention))
    const abortScope = createExecutionAbortScope(abortController)

    try {
        // Initialize runtime state for new execution
        let agentflowRuntime: IAgentFlowRuntime = {
            state: {},
            chatHistory: [],
            form: cloneDeep(turnInput.formValues)
        }

        const startAgentflowNode = nodes.find((node) => node.data.name === 'startAgentflow')
        if (!isRecursive && startAgentflowNode?.data.inputs?.startEphemeralMemory) {
            logger.warn("[agentflow]: Ephemeral Memory is no longer supported; each node's memory settings decide")
        }

        // A resume restores the state the run stopped with; iteration runs get the parent's state through their context
        if (!isRecursive && !humanInput) {
            let previousState: ICommonObject = cloneDeep(turnInput.flowState)

            // Check if startState has been overridden from overrideConfig.startState and is enabled
            const isStartStateEnabled =
                nodeOverrides && startAgentflowNode
                    ? nodeOverrides[startAgentflowNode.data.label]?.find((param: any) => param.name === 'startState')?.enabled ?? false
                    : false

            if (isStartStateEnabled && overrideConfig?.startState) {
                if (Array.isArray(overrideConfig.startState)) {
                    // Handle array format: [{"key": "foo", "value": "foo4"}]
                    const overrideStateObj: ICommonObject = {}
                    for (const item of overrideConfig.startState) {
                        if (item.key && item.value !== undefined) {
                            overrideStateObj[item.key] = item.value
                        }
                    }
                    previousState = { ...previousState, ...overrideStateObj }
                } else if (typeof overrideConfig.startState === 'object') {
                    // Object override: "startState": {...}
                    previousState = { ...previousState, ...overrideConfig.startState }
                }
            }

            agentflowRuntime.state = previousState
        }

        // Skip human input resumption for recursive iteration calls - they should start fresh
        if (humanInput && !(isRecursive && iterationContext)) {
            const pending = turnInput.pendingResume
            if (!pending) {
                throw new Error(`No previous execution found for session ${sessionId}: the trustedState holds no stopped run to resume`)
            }
            rehydratePendingResume(pending, nodes, reversedGraph).forEach((entry, record) => rehydratedRecords.set(record, entry))
            const executionData = [...rehydratedRecords.keys()]

            let startNodeId = humanInput.startNodeId

            // If startNodeId is not provided, deterministically pick the primary STOPPED node
            if (!startNodeId) {
                const resumeLevels = computeTopologicalLevels(nodes, edges)
                const stoppedNode = selectPrimaryStoppedNode(executionData, nodes, resumeLevels)

                if (!stoppedNode) {
                    throw new Error('No stopped node found in previous execution data to resume from')
                }

                startNodeId = stoppedNode.nodeId
                logger.debug(`  🔍 Auto-detected stopped node to resume from: ${startNodeId} (${stoppedNode.nodeLabel})`)
            }

            // Verify that the node exists in previous execution
            const nodeExists = executionData.some((data) => data.nodeId === startNodeId)

            if (!nodeExists) {
                throw new Error(
                    `Node ${startNodeId} not found in previous execution. ` +
                        `This could indicate an invalid resume attempt or a modified flow.`
                )
            }

            startingNodeIds.push(startNodeId)
            checkForMultipleStartNodes(startingNodeIds, isRecursive, nodes)

            agentFlowExecutedData.push(...executionData)
            agentflowRuntime.state = cloneDeep(turnInput.flowState)

            if (pending.executionId && !zeroRetention && !process.env.DISABLE_EXECUTION_RECORDING) {
                newExecution = { id: pending.executionId } as IExecution
                recordedRun = await readRecordedRun(appDataSource, pending.executionId, workspaceId)
                if (recordedRun) {
                    await serializedUpdateExecution(pending.executionId, { state: 'INPROGRESS' })
                } else {
                    logger.warn(`[agentflow]: Execution ${pending.executionId} not found; it is not updated`)
                }
            } else {
                newExecution = await addExecution(
                    appDataSource,
                    chatflowid,
                    [],
                    sessionId,
                    workspaceId,
                    zeroRetention,
                    dbUpdateQueue.enqueue
                )
            }
            parentExecutionId = newExecution.id

            // Update humanInput with the resolved startNodeId
            humanInput.startNodeId = startNodeId
        } else if (isRecursive && parentExecutionId) {
            const { startingNodeIds: startingNodeIdsFromFlow } = getStartingNode(nodeDependencies)
            startingNodeIds.push(...startingNodeIdsFromFlow)
            checkForMultipleStartNodes(startingNodeIds, isRecursive, nodes)

            // Recursive calls record into the parent's execution
            newExecution = { id: parentExecutionId } as IExecution
        } else {
            const { startingNodeIds: startingNodeIdsFromFlow } = getStartingNode(nodeDependencies)
            startingNodeIds.push(...startingNodeIdsFromFlow)
            checkForMultipleStartNodes(startingNodeIds, isRecursive, nodes)

            // Only create a new execution if this is not a recursive call
            newExecution = await addExecution(
                appDataSource,
                chatflowid,
                agentFlowExecutedData,
                sessionId,
                workspaceId,
                zeroRetention,
                dbUpdateQueue.enqueue
            )
            parentExecutionId = newExecution.id
        }

        const isMidGraphResumption = Boolean(humanInput && !(isRecursive && iterationContext))
        const dependencyEngine = createDependencyEngine({
            nodes,
            edges,
            startingNodeIds,
            executedData: isMidGraphResumption ? agentFlowExecutedData : undefined,
            isResuming: isMidGraphResumption
        })

        if (isMidGraphResumption) {
            dependencyEngine.getReplayLoopCounts().forEach((count, loopNodeId) => {
                loopCounts.set(loopNodeId, count)
            })
        }

        nodeExecutionQueue.push(...dependencyEngine.getInitialQueue())

        const maxIterations = process.env.MAX_ITERATIONS ? parseInt(process.env.MAX_ITERATIONS) : 1000

        const pastChatHistory: IMessage[] = turnInput.history.map(toNodeMessage)
        const tokenHistory: TrustedHistoryMessage[] = isRecursive ? [] : cloneDeep(turnInput.history)

        let currentHumanInput = humanInput

        // For iteration calls, clear human input since they should start fresh
        if (isRecursive && iterationContext && humanInput) {
            currentHumanInput = undefined
        }

        let analyticHandlers: AnalyticHandler | undefined
        let parentTraceIds: ICommonObject | undefined

        try {
            if (chatflow.analytic) {
                // Override config analytics
                let analyticInputs: ICommonObject = {}
                if (overrideConfig?.analytics && Object.keys(overrideConfig.analytics).length > 0) {
                    analyticInputs = {
                        ...overrideConfig.analytics
                    }
                }
                analyticHandlers = AnalyticHandler.getInstance({ inputs: { analytics: analyticInputs } } as any, {
                    orgId,
                    workspaceId,
                    appDataSource,
                    databaseEntities,
                    componentNodes,
                    analytic: chatflow.analytic,
                    chatId
                })
                await analyticHandlers.init()
                parentTraceIds = await analyticHandlers.onChainStart(
                    'Agentflow',
                    form && Object.keys(form).length > 0 ? JSON.stringify(form) : question || ''
                )
            }
        } catch (error) {
            logger.error(`[server]: Error initializing analytic handlers: ${getErrorMessage(error)}`)
        }

        const flowNodeIds = new Set(nodes.map((node) => node.id))
        const writeTurnToken = async (pendingResume?: PendingResume) => {
            const state = buildTrustedState({
                history: tokenHistory,
                flowState: agentflowRuntime.state,
                form: agentflowRuntime.form,
                childFlowTokens: turnInput.childFlowTokens,
                flowNodeIds,
                pendingResume
            })
            writtenToken = { token: await writeToken(state), historyLength: state.history.length, pending: Boolean(pendingResume) }
            return writtenToken.token
        }
        // A failed resume returns the incoming token, so answering again retries it (D6)
        const keepIncomingToken = () => {
            const token = incomingInput.trustedState as string
            writtenToken = { token, historyLength: turnInput.history.length, pending: Boolean(turnInput.pendingResume) }
            return token
        }
        // A resume continues the paused run's row: its records minus the resumed node's, then the turn's own (D10)
        const recordedData = () => [
            ...(recordedRun ?? []).filter((record) => !removedRecordedNodeIds.has(record.nodeId)),
            ...agentFlowExecutedData.filter((record) => !rehydratedRecords.has(record))
        ]

        const effectiveMaxNodeConcurrency = getMaxNodeConcurrency(maxNodeConcurrency)
        const streamCoordinator = !isRecursive && sseStreamer ? createStreamCoordinator(sseStreamer) : undefined
        const currentTurnNodeIds = new Set<string>()
        const excludedLoopNodeIds = new Set<string>()
        const resolveCurrentTerminalOutput = () => {
            streamCoordinator?.flushAll()
            const levels = dependencyEngine.getLevels()
            const streamOrder = streamCoordinator?.getStreamOrder()
            const resolved = resolveTerminalContent({
                agentFlowExecutedData,
                graph,
                nodes,
                levels,
                streamOrder,
                excludedLoopNodeIds,
                currentTurnNodeIds
            })
            const metadata = aggregateTerminalMetadata({
                agentFlowExecutedData,
                graph,
                nodes,
                levels,
                streamOrder,
                excludedLoopNodeIds,
                currentTurnNodeIds
            })
            return {
                content: resolved.content,
                terminalNodeIds: resolved.terminalNodeIds,
                metadata
            }
        }

        const faultRecorder = createFaultRecorder(abortScope)
        const skippedErrorNodeIds = new Set<string>()
        let hasStoppedNode = false
        let schedulerError: unknown
        let schedulerTerminalOutput: ReturnType<typeof resolveCurrentTerminalOutput> | undefined

        try {
            const schedulerResult = await runConcurrentNodeScheduler({
                nodeExecutionQueue,
                maxNodeConcurrency: effectiveMaxNodeConcurrency,
                maxIterations,
                canScheduleMore: () => status === 'INPROGRESS' && !faultRecorder.getRootError() && !abortScope.isAborted(),
                onBeforeFirstLaunch: () => {
                    if (!isRecursive) {
                        sseStreamer?.streamAgentFlowEvent(chatId, 'INPROGRESS')
                    }
                },
                shouldLaunchNode: (currentNode) => {
                    if (currentNode.epoch !== undefined && currentNode.epoch !== dependencyEngine.getNodeEpoch(currentNode.nodeId)) {
                        return false
                    }
                    const reactFlowNode = nodes.find((nd) => nd.id === currentNode.nodeId)
                    return Boolean(reactFlowNode && reactFlowNode.data.name !== 'stickyNoteAgentflow')
                },
                compareQueuedNodes: (a, b) => dependencyEngine.compareQueueItems(a, b),
                executeNodeTask: async (currentNode) => {
                    const reactFlowNode = nodes.find((nd) => nd.id === currentNode.nodeId)
                    if (!reactFlowNode) {
                        throw new Error(`Node ${currentNode.nodeId} not found`)
                    }

                    // Check for abort signal early before capturing snapshot or running node
                    if (abortScope.isAborted()) {
                        throw new Error('Aborted')
                    }

                    logger.debug(`   🎯 Executing node: ${reactFlowNode?.data.label}`)

                    // Capture immutable start state snapshot and isolated runtime clone at actual launch time
                    const { startStateSnapshot, startChatHistoryLength, nodeRuntimeSnapshot } = createNodeRuntimeSnapshot(agentflowRuntime)
                    const nodeSseStreamer = streamCoordinator ? streamCoordinator.createNodeStreamer(currentNode.nodeId) : sseStreamer

                    const executionResult = await executeNode({
                        nodeId: currentNode.nodeId,
                        reactFlowNode,
                        nodes,
                        edges,
                        graph,
                        reversedGraph,
                        incomingInput: { ...incomingInput },
                        chatflow,
                        chatId,
                        sessionId,
                        apiMessageId,
                        evaluationRunId,
                        parentExecutionId,
                        isInternal,
                        pastChatHistory: cloneDeep(pastChatHistory),
                        appDataSource,
                        usageCacheManager,
                        telemetry,
                        componentNodes,
                        cachePool,
                        sseStreamer: nodeSseStreamer,
                        baseURL,
                        overrideConfig,
                        apiOverrideStatus,
                        nodeOverrides,
                        variableOverrides,
                        uploadedFilesContent,
                        fileUploads,
                        humanInput:
                            currentHumanInput && currentNode.nodeId === currentHumanInput.startNodeId ? currentHumanInput : undefined,
                        agentFlowExecutedData: [...agentFlowExecutedData],
                        agentflowRuntime: nodeRuntimeSnapshot,
                        abortController: abortScope.abortController,
                        parentTraceIds,
                        analyticHandlers,
                        isRecursive,
                        iterationContext,
                        loopCounts: new Map(loopCounts),
                        orgId,
                        workspaceId,
                        subscriptionId,
                        productId,
                        zeroRetention,
                        nodeInstanceFactory,
                        maxNodeConcurrency,
                        enqueueDbUpdate: dbUpdateQueue.enqueue,
                        getRecordedData: recordedData,
                        getAvailableVariables,
                        turnInput
                    })

                    return {
                        executionResult,
                        startStateSnapshot,
                        startChatHistoryLength,
                        reactFlowNode,
                        nodeSseStreamer
                    }
                },
                onNodeComplete: (
                    currentNode,
                    { executionResult, startStateSnapshot, startChatHistoryLength, reactFlowNode, nodeSseStreamer }
                ) => {
                    let isStale = false
                    try {
                        if (currentNode.epoch !== undefined && currentNode.epoch !== dependencyEngine.getNodeEpoch(currentNode.nodeId)) {
                            logger.debug(
                                `[agentflow]: Ignoring stale completion from node ${currentNode.nodeId} (epoch ${
                                    currentNode.epoch
                                } !== ${dependencyEngine.getNodeEpoch(currentNode.nodeId)})`
                            )
                            isStale = true
                            return { shouldStop: false }
                        }

                        // Only clear currentHumanInput when consumed by its target startNodeId (never resurrect from non-consuming siblings)
                        if (currentHumanInput && currentNode.nodeId === currentHumanInput.startNodeId && !executionResult.humanInput) {
                            currentHumanInput = undefined
                        }

                        skippedErrorNodeIds.delete(currentNode.nodeId)

                        if (executionResult.shouldStop) {
                            dependencyEngine.markNodeStopped(currentNode.nodeId, currentNode.epoch)
                            if (
                                executionResult.result?.state &&
                                typeof executionResult.result.state === 'object' &&
                                !Array.isArray(executionResult.result.state)
                            ) {
                                const stoppedDelta = computeStateDelta(startStateSnapshot, executionResult.result.state)
                                agentflowRuntime.state = applyStateDelta(agentflowRuntime.state ?? {}, stoppedDelta)
                            }
                            if (executionResult.stoppedExecutedData?.data) {
                                executionResult.stoppedExecutedData.data = {
                                    ...executionResult.stoppedExecutedData.data,
                                    state: cloneDeep(agentflowRuntime.state ?? {})
                                }
                            }
                            commitExecutedDataDelta(agentFlowExecutedData, {
                                removedNodeIds: executionResult.removedExecutedNodeIds,
                                additionalRecords: executionResult.additionalExecutedData,
                                nodeRecord: executionResult.stoppedExecutedData
                            })
                            executionResult.removedExecutedNodeIds?.forEach((nodeId) => removedRecordedNodeIds.add(nodeId))
                            currentTurnNodeIds.add(currentNode.nodeId)
                            sseStreamer?.streamNextAgentFlowEvent(chatId, {
                                nodeId: currentNode.nodeId,
                                nodeLabel: reactFlowNode.data.label,
                                status: 'STOPPED'
                            })
                            if (!isRecursive) {
                                sseStreamer?.streamAgentFlowExecutedDataEvent(
                                    chatId,
                                    toClientExecutedData(agentFlowExecutedData, isInternal)
                                )
                            }
                            return { shouldStop: true }
                        }

                        const nodeResult = executionResult.result

                        // Reconcile runtime state delta and chat history atomically before committing record
                        reconcileRuntimeCommit({
                            agentflowRuntime,
                            startStateSnapshot,
                            startChatHistoryLength,
                            nodeResult
                        })

                        if (status === 'INPROGRESS' && !faultRecorder.getRootError() && !abortScope.isAborted()) {
                            // Synchronously settle DAG edges, cascade DPE, and handle loop subgraph reset
                            const processResult = dependencyEngine.processNodeCompletion({
                                nodeId: currentNode.nodeId,
                                nodeName: reactFlowNode.data.name,
                                result: nodeResult,
                                epoch: currentNode.epoch,
                                humanInput: currentHumanInput,
                                nodeExecutionQueue,
                                loopCounts,
                                sseStreamer: !isRecursive ? nodeSseStreamer : undefined,
                                chatId
                            })

                            if (reactFlowNode.data.name === 'loopAgentflow' && !processResult.loopHitMaxCount) {
                                excludedLoopNodeIds.add(currentNode.nodeId)
                            } else {
                                excludedLoopNodeIds.delete(currentNode.nodeId)
                            }

                            if (currentHumanInput && !processResult.humanInput) {
                                currentHumanInput = undefined
                            }
                        } else if (reactFlowNode.data.name === 'loopAgentflow') {
                            excludedLoopNodeIds.add(currentNode.nodeId)
                        }

                        const committedNodeData =
                            nodeResult && typeof nodeResult === 'object'
                                ? { ...nodeResult, state: cloneDeep(agentflowRuntime.state ?? {}) }
                                : nodeResult

                        commitExecutedDataDelta(agentFlowExecutedData, {
                            removedNodeIds: executionResult.removedExecutedNodeIds,
                            additionalRecords: executionResult.additionalExecutedData,
                            nodeRecord: {
                                nodeId: currentNode.nodeId,
                                nodeLabel: reactFlowNode.data.label,
                                data: committedNodeData,
                                previousNodeIds: reversedGraph[currentNode.nodeId],
                                status: 'FINISHED'
                            }
                        })
                        executionResult.removedExecutedNodeIds?.forEach((nodeId) => removedRecordedNodeIds.add(nodeId))
                        currentTurnNodeIds.add(currentNode.nodeId)

                        sseStreamer?.streamNextAgentFlowEvent(chatId, {
                            nodeId: currentNode.nodeId,
                            nodeLabel: reactFlowNode.data.label,
                            status: 'FINISHED'
                        })

                        if (!isRecursive) {
                            sseStreamer?.streamAgentFlowExecutedDataEvent(chatId, toClientExecutedData(agentFlowExecutedData, isInternal))
                        }

                        return { shouldStop: false }
                    } finally {
                        streamCoordinator?.releaseStream(currentNode.nodeId, {
                            discardBuffered: isStale || Boolean(faultRecorder.getRootError() || abortScope.isAborted())
                        })
                    }
                },
                handleNodeStopped: () => {
                    // Keep status === 'INPROGRESS' so non-blocked sibling branches continue draining naturally
                    hasStoppedNode = true
                },
                onNodeError: onNodeError ?? (() => 'abort'),
                handleNodeError: (currentNode, error, policy = 'abort') => {
                    streamCoordinator?.releaseStream(currentNode.nodeId, { discardBuffered: true })
                    const reactFlowNode = nodes.find((nd) => nd.id === currentNode.nodeId)

                    if (policy === 'skip-branch' && !faultRecorder.getRootError() && !abortScope.isAborted()) {
                        skippedErrorNodeIds.add(currentNode.nodeId)
                        const errorMessage = getErrorMessage(error)
                        if (reactFlowNode) {
                            agentFlowExecutedData.push({
                                nodeId: currentNode.nodeId,
                                nodeLabel: reactFlowNode.data.label,
                                previousNodeIds: reversedGraph[currentNode.nodeId] || [],
                                data: {
                                    id: currentNode.nodeId,
                                    name: reactFlowNode.data.name,
                                    error: errorMessage
                                },
                                status: 'ERROR'
                            })
                            sseStreamer?.streamNextAgentFlowEvent(chatId, {
                                nodeId: currentNode.nodeId,
                                nodeLabel: reactFlowNode.data.label,
                                status: 'ERROR',
                                error: errorMessage
                            })
                        }
                        dependencyEngine.markNodeSkipped(currentNode.nodeId, nodeExecutionQueue, currentNode.epoch)
                        return
                    }

                    const recorded = faultRecorder.recordNodeError(error)
                    status = recorded.rootError.errorStatus

                    if (reactFlowNode) {
                        agentFlowExecutedData.push({
                            nodeId: currentNode.nodeId,
                            nodeLabel: reactFlowNode.data.label,
                            previousNodeIds: reversedGraph[currentNode.nodeId] || [],
                            data: {
                                id: currentNode.nodeId,
                                name: reactFlowNode.data.name,
                                error: recorded.nodeMessage
                            },
                            status: recorded.nodeStatus
                        })

                        sseStreamer?.streamNextAgentFlowEvent(chatId, {
                            nodeId: currentNode.nodeId,
                            nodeLabel: reactFlowNode.data.label,
                            status: recorded.nodeStatus,
                            error: recorded.isAbort ? undefined : recorded.nodeMessage
                        })
                    }

                    abortScope.abortInternal(error)
                },
                selectTerminalOutput: () => {
                    if (faultRecorder.getRootError() || abortScope.isAborted()) {
                        return undefined
                    }
                    return resolveCurrentTerminalOutput()
                }
            })
            schedulerTerminalOutput = schedulerResult.terminalOutput
        } catch (error) {
            schedulerError = error
        }

        // By now the answer (or the root node error) is decided; a failed Execution write must neither replace it nor stop the final events
        const persistFinalExecution = async (finalState: ExecutionState) => {
            try {
                const updated = await serializedUpdateExecution(newExecution.id, {
                    executionData: JSON.stringify(recordedData()),
                    state: finalState
                })
                if (!updated) {
                    newExecution = await addExecution(
                        appDataSource,
                        chatflowid,
                        recordedData(),
                        sessionId,
                        workspaceId,
                        zeroRetention,
                        dbUpdateQueue.enqueue
                    )
                    await serializedUpdateExecution(newExecution.id, { state: finalState })
                }
            } catch (error) {
                logger.warn(
                    `[agentflow]: Failed to persist ${finalState} state for execution ${newExecution.id}: ${getErrorMessage(error)}`
                )
            }
            await dbUpdateQueue.drain()
        }

        const persistAndThrowFatalError = async (
            errorStatus: ExecutionState,
            errorMessage: string,
            errorToThrow: unknown
        ): Promise<never> => {
            status = errorStatus
            if (!isRecursive) {
                sseStreamer?.streamAgentFlowExecutedDataEvent(chatId, toClientExecutedData(agentFlowExecutedData, isInternal))

                await persistFinalExecution(errorStatus)

                sseStreamer?.streamTrustedStateDataEvent(chatId, isResume ? keepIncomingToken() : await writeTurnToken())

                sseStreamer?.streamAgentFlowEvent(chatId, errorStatus)
            } else {
                await dbUpdateQueue.drain()
            }

            if (parentTraceIds && analyticHandlers) {
                await analyticHandlers.onChainError(parentTraceIds, errorMessage, true)
            }

            throw errorToThrow
        }

        const finalFault = faultRecorder.finalizeForExternalAbort()
        if (finalFault) {
            await persistAndThrowFatalError(finalFault.errorStatus, finalFault.errorMessage, new Error(finalFault.errorMessage))
        }

        if (schedulerError) {
            const schedulerStatus: ExecutionState = abortScope.isAborted() ? 'TERMINATED' : 'ERROR'
            await persistAndThrowFatalError(schedulerStatus, getErrorMessage(schedulerError), schedulerError)
        }

        const levels = dependencyEngine.getLevels()
        const primaryStopped = selectPrimaryStoppedAction(agentFlowExecutedData, nodes, levels)
        // A stopped Agent carried from a v1 token holds its stored prompt in the action until it is resumed (D4)
        const announcedAction = primaryStopped.action ? toSlimAction(primaryStopped.action) : undefined

        const latestStatusByNodeId = new Map<string, ExecutionState>()
        for (const data of agentFlowExecutedData) {
            if (data.data?.parentNodeId) continue
            if (data.status) {
                latestStatusByNodeId.set(data.nodeId, data.status)
            }
        }
        const terminatedNode = Array.from(latestStatusByNodeId.values()).includes('TERMINATED')
        const errorNode = Array.from(latestStatusByNodeId.entries()).some(
            ([nodeId, nodeStatus]) => nodeStatus === 'ERROR' && !skippedErrorNodeIds.has(nodeId)
        )
        const hasActiveStoppedNode = primaryStopped.stoppedNodeIds.length > 0

        if (terminatedNode) {
            status = 'TERMINATED'
        } else if (errorNode) {
            status = 'ERROR'
        } else if (hasStoppedNode || hasActiveStoppedNode) {
            status = 'STOPPED'
        } else {
            status = 'FINISHED'
        }

        // Only update execution record if this is not a recursive call
        if (!isRecursive) {
            await persistFinalExecution(status)

            if (status === 'STOPPED' && announcedAction) {
                sseStreamer?.streamActionEvent(chatId, announcedAction)
            }
            sseStreamer?.streamAgentFlowEvent(chatId, status)
        }

        logger.debug(`\n🏁 Flow execution completed`)
        logger.debug(`   Status: ${status}`)

        const terminalOutput = schedulerTerminalOutput ?? resolveCurrentTerminalOutput()
        let content = terminalOutput.content
        const terminalMetadata: ITerminalMetadata = terminalOutput.metadata

        /* Check for post-processing settings */
        if (chatflowConfig?.postProcessing?.enabled === true && content) {
            try {
                const postProcessingFunction = JSON.parse(chatflowConfig?.postProcessing?.customFunction)
                const nodeInstanceFilePath = componentNodes['customFunctionAgentflow'].filePath as string
                const nodeModule = await import(nodeInstanceFilePath)
                //set the outputs.output to EndingNode to prevent json escaping of content...
                const nodeData = {
                    inputs: { customFunctionJavascriptFunction: postProcessingFunction }
                }
                const runtimeChatHistory = agentflowRuntime.chatHistory || []
                const chatHistory = [...pastChatHistory, ...runtimeChatHistory]
                const options: ICommonObject = {
                    chatflowid: chatflow.id,
                    sessionId,
                    chatId,
                    input: question || form,
                    postProcessing: {
                        rawOutput: content,
                        chatHistory: cloneDeep(chatHistory),
                        sourceDocuments: terminalMetadata.sourceDocuments ? cloneDeep(terminalMetadata.sourceDocuments) : undefined,
                        usedTools: terminalMetadata.usedTools ? cloneDeep(terminalMetadata.usedTools) : undefined,
                        artifacts: terminalMetadata.artifacts ? cloneDeep(terminalMetadata.artifacts) : undefined,
                        fileAnnotations: terminalMetadata.fileAnnotations ? cloneDeep(terminalMetadata.fileAnnotations) : undefined
                    },
                    appDataSource,
                    databaseEntities,
                    workspaceId,
                    orgId,
                    logger
                }
                const customFuncNodeInstance = new nodeModule.nodeClass()
                const customFunctionResponse = await customFuncNodeInstance.run(nodeData, question || form, options)
                const moderatedResponse = customFunctionResponse.output.content
                if (typeof moderatedResponse === 'string') {
                    content = moderatedResponse
                } else if (typeof moderatedResponse === 'object') {
                    content = '```json\n' + JSON.stringify(moderatedResponse, null, 2) + '\n```'
                } else {
                    content = moderatedResponse
                }
            } catch (e) {
                logger.error('[server]: Post Processing Error:', e)
            }
        }

        if (parentTraceIds && analyticHandlers) {
            await analyticHandlers.onChainEnd(parentTraceIds, content, true)
        }

        if (isRecursive) {
            return {
                agentFlowExecutedData: agentFlowExecutedData.map((data) => _removeCredentialId(data)),
                agentflowRuntime,
                status,
                text: content
            }
        }

        const isChatMessageRecorded = !disableChatMessageRecording && !process.env.DISABLE_CHAT_MESSAGE_RECORDING
        const resumedNode = isResume ? nodes.find((node) => node.id === humanInput?.startNodeId) : undefined
        const failedResume = isResume && (status === 'ERROR' || status === 'TERMINATED')

        let userMessageContent: string | undefined
        if (!isResume) {
            userMessageContent =
                startInputType === 'formInput' && form
                    ? Object.entries(form)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join('\n')
                    : question || ' '
        } else if (!failedResume && !isHistoryOff(resumedNode)) {
            userMessageContent = resumeAnswer(
                humanInput as IHumanInput,
                question,
                stoppedAction(turnInput.pendingResume, humanInput?.startNodeId)
            )
        }

        const primaryStoppedNode = status === 'STOPPED' ? nodes.find((node) => node.id === primaryStopped.primaryNodeId) : undefined
        const stopPrompt = status === 'STOPPED' ? latestStoppedPrompt(agentFlowExecutedData, primaryStopped.primaryNodeId) : undefined
        const botMessageContent = typeof content === 'string' && !content.trim() && stopPrompt ? stopPrompt : content

        const stopMessageId = turnInput.pendingResume?.stopMessageId
        if (isResume && !failedResume && stopMessageId && isChatMessageRecorded) {
            await clearStopMessage(appDataSource, stopMessageId, isHistoryOff(resumedNode))
        }

        if (userMessageContent !== undefined) {
            const userMessageStub: Omit<IChatMessage, 'id'> = {
                role: 'userMessage',
                content: userMessageContent,
                chatflowid,
                chatType: evaluationRunId ? ChatType.EVALUATION : isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
                chatId,
                sessionId,
                createdDate: userMessageDateTime,
                fileUploads: uploads ? JSON.stringify(fileUploads) : undefined,
                leadEmail: incomingInput.leadEmail,
                executionId: newExecution.id
            }
            await utilAddChatMessage(userMessageStub, appDataSource, disableChatMessageRecording)
            tokenHistory.push({
                role: 'userMessage',
                content: userMessageContent,
                ...(uploads && fileUploads !== undefined ? { fileUploads } : {})
            })
        }

        const apiMessage: Omit<IChatMessage, 'createdDate'> = {
            id: apiMessageId,
            role: 'apiMessage',
            content: botMessageContent,
            chatflowid,
            chatType: evaluationRunId ? ChatType.EVALUATION : isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
            chatId,
            sessionId,
            executionId: newExecution.id
        }
        if (terminalMetadata.sourceDocuments) apiMessage.sourceDocuments = JSON.stringify(terminalMetadata.sourceDocuments)
        if (terminalMetadata.usedTools) apiMessage.usedTools = JSON.stringify(terminalMetadata.usedTools)
        if (terminalMetadata.fileAnnotations) apiMessage.fileAnnotations = JSON.stringify(terminalMetadata.fileAnnotations)
        if (terminalMetadata.artifacts) apiMessage.artifacts = JSON.stringify(terminalMetadata.artifacts)
        if (chatflow.followUpPrompts) {
            const followUpPromptsConfig = JSON.parse(chatflow.followUpPrompts)
            const followUpPrompts = await generateFollowUpPrompts(followUpPromptsConfig, apiMessage.content, {
                orgId,
                workspaceId,
                chatId,
                chatflowid,
                appDataSource,
                databaseEntities
            })
            if (followUpPrompts?.questions) {
                apiMessage.followUpPrompts = JSON.stringify(followUpPrompts.questions)
            }
        }
        if (status === 'STOPPED' && announcedAction) apiMessage.action = JSON.stringify(announcedAction)

        const chatMessage = failedResume ? undefined : await utilAddChatMessage(apiMessage, appDataSource, disableChatMessageRecording)
        if (!failedResume && !isHistoryOff(primaryStoppedNode)) {
            tokenHistory.push({
                role: 'apiMessage',
                content: botMessageContent,
                ...(terminalMetadata.artifacts ? { artifacts: terminalMetadata.artifacts } : {})
            })
        }

        const pendingResume =
            status === 'STOPPED'
                ? buildPendingResume(agentFlowExecutedData, {
                      references: outputReferences,
                      carried: rehydratedRecords,
                      executionId: !zeroRetention && !process.env.DISABLE_EXECUTION_RECORDING ? newExecution.id : undefined,
                      stopMessageId: isChatMessageRecorded ? chatMessage?.id : undefined
                  })
                : undefined
        const trustedState = failedResume ? keepIncomingToken() : await writeTurnToken(pendingResume)
        sseStreamer?.streamTrustedStateDataEvent(chatId, trustedState)

        logger.debug(`[server]: Finished running agentflow ${chatflowid}`)

        await telemetry.sendTelemetry(
            'prediction_sent',
            {
                version: await getAppVersion(),
                chatflowId: chatflowid,
                chatId,
                type: evaluationRunId ? ChatType.EVALUATION : isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
                flowGraph: getTelemetryFlowObj(nodes, edges),
                productId,
                subscriptionId
            },
            orgId
        )

        /*** Prepare response ***/
        let result: ICommonObject = {}
        result.text = content
        result.question = incomingInput.question // return the question in the response, this is used when input text is empty but question is in audio format
        result.form = form
        result.chatId = chatId
        result.chatMessageId = chatMessage?.id
        result.followUpPrompts = JSON.stringify(apiMessage.followUpPrompts)
        result.executionId = newExecution.id
        result.agentFlowExecutedData = toClientExecutedData(agentFlowExecutedData, isInternal)
        result.trustedState = trustedState

        if (sessionId) result.sessionId = sessionId

        if (shouldAutoPlayTTS(chatflow.textToSpeech) && result.text && chatMessage) {
            const options = {
                orgId,
                chatflowid,
                chatId,
                appDataSource,
                databaseEntities
            }

            if (sseStreamer) {
                await generateTTSForResponseStream(
                    result.text,
                    chatflow.textToSpeech,
                    options,
                    chatId,
                    chatMessage.id,
                    sseStreamer,
                    abortScope.abortController
                )
            }
        }

        return result
    } finally {
        abortScope.cleanup()
        await dbUpdateQueue.drain()
        if (!isRecursive) logTurnTokens(chatId, turnInput, writtenToken)
    }
}
