import { ICondition, IHumanInput } from 'flowise-components'
import { IReactFlowEdge, IReactFlowNode } from '../../Interface'
import logger from '../logger'
import { IProcessNodeOutputsParams, IWaitingNode } from './types'

export const MAX_LOOP_COUNT = process.env.MAX_LOOP_COUNT ? parseInt(process.env.MAX_LOOP_COUNT) : 10

/*
 * Gets all input connections for a specific node
 * @param {IEdge[]} edges - Array of all edges (connections) in the workflow
 * @param {string} nodeId - ID of the node to get input connections for
 * @returns {IEdge[]} Array of input connections for the specified node
 *
 * @example
 * // For llmAgentflow_2 which has two inputs from llmAgentflow_0 and llmAgentflow_1
 * const connections = getNodeInputConnections(nodes, edges, 'llmAgentflow_2');
 * // Returns array of two edge objects connecting to llmAgentflow_2
 */
export function getNodeInputConnections(edges: IReactFlowEdge[], nodeId: string): IReactFlowEdge[] {
    // Filter edges where target matches the nodeId
    const inputConnections = edges.filter((edge) => edge.target === nodeId)

    // Sort connections by sourceHandle to maintain consistent order
    // This is important for nodes that have multiple inputs that need to be processed in order
    inputConnections.sort((a, b) => {
        // Extract index from sourceHandle (e.g., "output-0" vs "output-1")
        const indexA = parseInt(a.sourceHandle.split('-').find((part) => !isNaN(parseInt(part))) || '0')
        const indexB = parseInt(b.sourceHandle.split('-').find((part) => !isNaN(parseInt(part))) || '0')
        return indexA - indexB
    })

    return inputConnections
}

/**
 * Analyzes node dependencies and sets up expected inputs
 */
export function setupNodeDependencies(nodeId: string, edges: IReactFlowEdge[], nodes: IReactFlowNode[]): IWaitingNode {
    logger.debug(`\n🔍 Analyzing dependencies for node: ${nodeId}`)
    const inputConnections = getNodeInputConnections(edges, nodeId)
    const waitingNode: IWaitingNode = {
        nodeId,
        receivedInputs: new Map(),
        expectedInputs: new Set(),
        isConditional: false,
        conditionalGroups: new Map()
    }

    // Group inputs by their parent condition nodes
    const inputsByCondition = new Map<string | null, string[]>()

    for (const connection of inputConnections) {
        const sourceNode = nodes.find((n) => n.id === connection.source)
        if (!sourceNode) continue

        // Find if this input comes from a conditional branch
        const conditionParent = findConditionParent(connection.source, edges, nodes)

        if (conditionParent) {
            logger.debug(`  📌 Found conditional input from ${connection.source} (condition: ${conditionParent})`)
            waitingNode.isConditional = true
            const group = inputsByCondition.get(conditionParent) || []
            group.push(connection.source)
            inputsByCondition.set(conditionParent, group)
        } else {
            logger.debug(`  📌 Found required input from ${connection.source}`)
            waitingNode.expectedInputs.add(connection.source)
        }
    }

    // Set up conditional groups
    inputsByCondition.forEach((sources, conditionId) => {
        if (conditionId) {
            logger.debug(`  📋 Conditional group ${conditionId}: [${sources.join(', ')}]`)
            waitingNode.conditionalGroups.set(conditionId, sources)
        }
    })

    return waitingNode
}

/**
 * Finds the parent condition node for a given node, if any
 */
export function findConditionParent(nodeId: string, edges: IReactFlowEdge[], nodes: IReactFlowNode[]): string | null {
    const currentNode = nodes.find((n) => n.id === nodeId)
    if (!currentNode) return null
    if (
        currentNode.data.name === 'conditionAgentflow' ||
        currentNode.data.name === 'conditionAgentAgentflow' ||
        currentNode.data.name === 'humanInputAgentflow'
    ) {
        return currentNode.id
    }

    let currentId = nodeId
    const visited = new Set<string>()

    let shouldContinue = true
    while (shouldContinue) {
        if (visited.has(currentId)) {
            shouldContinue = false
            continue
        }
        visited.add(currentId)

        const parentEdge = edges.find((edge) => edge.target === currentId)
        if (!parentEdge) {
            shouldContinue = false
            continue
        }

        const parentNode = nodes.find((n) => n.id === parentEdge.source)
        if (!parentNode) {
            shouldContinue = false
            continue
        }

        if (
            parentNode.data.name === 'conditionAgentflow' ||
            parentNode.data.name === 'conditionAgentAgentflow' ||
            parentNode.data.name === 'humanInputAgentflow'
        ) {
            return parentNode.id
        }

        currentId = parentNode.id
    }

    return null
}

/**
 * Checks if a node has received all required inputs
 */
export function hasReceivedRequiredInputs(waitingNode: IWaitingNode): boolean {
    logger.debug(`\n✨ Checking inputs for node: ${waitingNode.nodeId}`)

    // Check non-conditional required inputs
    for (const required of waitingNode.expectedInputs) {
        const hasInput = waitingNode.receivedInputs.has(required)
        logger.debug(`  📊 Required input ${required}: ${hasInput ? '✅' : '❌'}`)
        if (!hasInput) return false
    }

    // Check conditional groups
    for (const [groupId, possibleSources] of waitingNode.conditionalGroups) {
        // Need at least one input from each conditional group
        const hasInputFromGroup = possibleSources.some((source) => waitingNode.receivedInputs.has(source))
        logger.debug(`  📊 Conditional group ${groupId}: ${hasInputFromGroup ? '✅' : '❌'}`)
        if (!hasInputFromGroup) return false
    }

    return true
}

/**
 * Determines which nodes should be ignored based on condition results
 * @param currentNode - The node being processed
 * @param result - The execution result from the node
 * @param edges - All edges in the workflow
 * @param nodeId - Current node ID
 * @returns Array of node IDs that should be ignored
 */
export async function determineNodesToIgnore(
    currentNode: IReactFlowNode,
    result: any,
    edges: IReactFlowEdge[],
    nodeId: string
): Promise<string[]> {
    const ignoreNodeIds: string[] = []

    // Check if this is a decision node
    const isDecisionNode =
        currentNode.data.name === 'conditionAgentflow' ||
        currentNode.data.name === 'conditionAgentAgentflow' ||
        currentNode.data.name === 'humanInputAgentflow'

    if (isDecisionNode && result.output?.conditions) {
        const outputConditions: ICondition[] = result.output.conditions

        // Find indexes of unfulfilled conditions
        const unfulfilledIndexes = outputConditions
            .map((condition: any, index: number) =>
                condition.isFulfilled === false || !Object.prototype.hasOwnProperty.call(condition, 'isFulfilled') ? index : -1
            )
            .filter((index: number) => index !== -1)

        // Find nodes to ignore based on unfulfilled conditions
        for (const index of unfulfilledIndexes) {
            const ignoreEdge = edges.find((edge) => edge.source === nodeId && edge.sourceHandle === `${nodeId}-output-${index}`)

            if (ignoreEdge) {
                ignoreNodeIds.push(ignoreEdge.target)
            }
        }
    }

    return ignoreNodeIds
}

/**
 * Process node outputs and handle branching logic
 */
export async function processNodeOutputs({
    nodeId,
    nodeName,
    result,
    humanInput,
    graph,
    nodes,
    edges,
    nodeExecutionQueue,
    waitingNodes,
    loopCounts,
    sseStreamer,
    chatId
}: IProcessNodeOutputsParams): Promise<{ humanInput?: IHumanInput }> {
    logger.debug(`\n🔄 Processing outputs from node: ${nodeId}`)

    let updatedHumanInput = humanInput

    const childNodeIds = graph[nodeId] || []
    logger.debug(`  👉 Child nodes: [${childNodeIds.join(', ')}]`)

    const currentNode = nodes.find((n) => n.id === nodeId)
    if (!currentNode) return { humanInput: updatedHumanInput }

    // Get nodes to ignore based on conditions
    const ignoreNodeIds = await determineNodesToIgnore(currentNode, result, edges, nodeId)
    if (ignoreNodeIds.length) {
        logger.debug(`  ⏭️  Skipping nodes: [${ignoreNodeIds.join(', ')}]`)
    }

    for (const childId of childNodeIds) {
        if (ignoreNodeIds.includes(childId)) continue

        const childNode = nodes.find((n) => n.id === childId)
        if (!childNode) continue

        logger.debug(`  📝 Processing child node: ${childId}`)

        let waitingNode = waitingNodes.get(childId)

        if (!waitingNode) {
            logger.debug(`    🆕 First time seeing node ${childId} - analyzing dependencies`)
            waitingNode = setupNodeDependencies(childId, edges, nodes)
            waitingNodes.set(childId, waitingNode)
        }

        waitingNode.receivedInputs.set(nodeId, result)
        logger.debug(`    ➕ Added input from ${nodeId}`)

        // Check if node is ready to execute
        if (hasReceivedRequiredInputs(waitingNode)) {
            logger.debug(`    ✅ Node ${childId} ready for execution!`)
            waitingNodes.delete(childId)
            nodeExecutionQueue.push({
                nodeId: childId,
                data: combineNodeInputs(waitingNode.receivedInputs),
                inputs: Object.fromEntries(waitingNode.receivedInputs)
            })
        } else {
            logger.debug(`    ⏳ Node ${childId} still waiting for inputs`)
            logger.debug(`      Has: [${Array.from(waitingNode.receivedInputs.keys()).join(', ')}]`)
            logger.debug(`      Needs: [${Array.from(waitingNode.expectedInputs).join(', ')}]`)
            if (waitingNode.conditionalGroups.size > 0) {
                logger.debug('      Conditional groups:')
                waitingNode.conditionalGroups.forEach((sources, groupId) => {
                    logger.debug(`        ${groupId}: [${sources.join(', ')}]`)
                })
            }
        }
    }

    if (nodeName === 'loopAgentflow' && result.output?.nodeID) {
        logger.debug(`  🔄 Looping back to node: ${result.output.nodeID}`)

        const loopCount = (loopCounts.get(nodeId) || 0) + 1
        const maxLoop = result.output.maxLoopCount || MAX_LOOP_COUNT

        if (loopCount < maxLoop) {
            logger.debug(`    Loop count: ${loopCount}/${maxLoop}`)
            loopCounts.set(nodeId, loopCount)
            nodeExecutionQueue.push({
                nodeId: result.output.nodeID,
                data: result.output,
                inputs: {}
            })

            // Clear humanInput when looping to prevent it from being reused
            if (updatedHumanInput) {
                logger.debug(`    🧹 Clearing humanInput for loop iteration`)
                updatedHumanInput = undefined
            }
        } else {
            logger.debug(`    ⚠️ Maximum loop count (${maxLoop}) reached, stopping loop`)
            const fallbackMessage = result.output.fallbackMessage || `Loop completed after reaching maximum iteration count of ${maxLoop}.`
            if (sseStreamer) {
                sseStreamer.streamTokenEvent(chatId, fallbackMessage)
            }
            result.output = { ...result.output, content: fallbackMessage }
        }
    }

    return { humanInput: updatedHumanInput }
}

/**
 * Combines inputs from multiple source nodes into a single input object
 * @param {Map<string, any>} receivedInputs - Map of inputs received from different nodes
 * @returns {any} Combined input data
 *
 * @example
 * const inputs = new Map();
 * inputs.set('node1', { json: { value: 1 }, text: 'Hello' });
 * inputs.set('node2', { json: { value: 2 }, text: 'World' });
 *
 * const combined = combineNodeInputs(inputs);
 *  Result:
 *  {
 *    json: {
 *      node1: { value: 1 },
 *      node2: { value: 2 }
 *    },
 *    text: 'Hello\nWorld'
 *  }
 */
export function combineNodeInputs(receivedInputs: Map<string, any>): any {
    // Filter out null/undefined inputs
    const validInputs = new Map(Array.from(receivedInputs.entries()).filter(([_, value]) => value !== null && value !== undefined))

    if (validInputs.size === 0) {
        return null
    }

    if (validInputs.size === 1) {
        return Array.from(validInputs.values())[0]
    }

    // Initialize result object to store combined data
    const result: {
        json: any
        text?: string
        binary?: any
        error?: Error
    } = {
        json: {}
    }

    // Sort inputs by source node ID to ensure consistent ordering
    const sortedInputs = Array.from(validInputs.entries()).sort((a, b) => a[0].localeCompare(b[0]))

    for (const [sourceNodeId, inputData] of sortedInputs) {
        if (!inputData) continue

        try {
            // Handle different types of input data
            if (typeof inputData === 'object') {
                // Merge JSON data
                if (inputData.json) {
                    result.json = {
                        ...result.json,
                        [sourceNodeId]: inputData.json
                    }
                }

                // Combine text data if present
                if (inputData.text) {
                    result.text = result.text ? `${result.text}\n${inputData.text}` : inputData.text
                }

                // Merge binary data if present
                if (inputData.binary) {
                    result.binary = {
                        ...result.binary,
                        [sourceNodeId]: inputData.binary
                    }
                }

                // Handle error data
                if (inputData.error) {
                    result.error = inputData.error
                }
            } else {
                // Handle primitive data types
                result.json[sourceNodeId] = inputData
            }
        } catch (error) {
            // Log error but continue processing other inputs
            console.error(`Error combining input from node ${sourceNodeId}:`, error)
            result.error = error as Error
        }
    }

    // Special handling for text-only nodes
    if (Object.keys(result.json).length === 0 && result.text) {
        result.json = { text: result.text }
    }

    return result
}
