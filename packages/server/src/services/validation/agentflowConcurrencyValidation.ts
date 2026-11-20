import { IReactFlowEdge, IReactFlowNode } from '../../Interface'
import {
    compareNodesDeterministically,
    computeReachableNodes,
    computeTopologicalLevels,
    DECISION_NODE_NAMES,
    parseDecisionOutputIndex
} from '../../utils/agentflow/dependencyEngine'

export interface IValidationResult {
    id: string
    label: string
    name: string
    issues: string[]
}

const BUILTIN_VAR_NAMES = new Set<string>([
    'question',
    'chat_history',
    'file_attachment',
    'current_date_time',
    'loop_count',
    'runtime_messages_length',
    'output'
])

const BUILTIN_VAR_PREFIXES = ['$vars', '$flow', '$form', '$iteration']

const CONTENT_BEARING_TERMINAL_NODE_NAMES = new Set<string>([
    'directReplyAgentflow',
    'llmAgentflow',
    'agentAgentflow',
    'executeFlowAgentflow'
])

interface ISubgraphContext {
    nodeIds: Set<string>
    forwardAdj: Map<string, string[]>
    reverseAdj: Map<string, string[]>
    outgoingEdges: Map<string, IReactFlowEdge[]>
    roots: string[]
}

function compareStringsCodePoint(a: string, b: string): number {
    if (a < b) return -1
    if (a > b) return 1
    return 0
}

function collectTemplateMatches(value: unknown, matches: string[], seen: Set<object>): void {
    if (typeof value === 'string') {
        const regex = /{{(.*?)}}/g
        let match: RegExpExecArray | null
        while ((match = regex.exec(value)) !== null) {
            matches.push(match[1])
        }
        return
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) return
        seen.add(value)
        for (const item of value) {
            collectTemplateMatches(item, matches, seen)
        }
        return
    }

    if (value && typeof value === 'object') {
        if (seen.has(value)) return
        seen.add(value)
        for (const nested of Object.values(value)) {
            collectTemplateMatches(nested, matches, seen)
        }
    }
}

function extractReferencedNodeIds(inputs: unknown, validNodeIds: Set<string>): string[] {
    const rawMatches: string[] = []
    collectTemplateMatches(inputs, rawMatches, new Set<object>())

    const referencedIds: string[] = []
    const seenIds = new Set<string>()

    for (const rawMatch of rawMatches) {
        const expr = rawMatch.trim().replace(/\\_/g, '_')
        if (!expr) continue
        if (BUILTIN_VAR_NAMES.has(expr)) continue
        if (BUILTIN_VAR_PREFIXES.some((prefix) => expr === prefix || expr.startsWith(`${prefix}.`))) {
            continue
        }

        const outputMatch = expr.match(/^(.+?)\.output(?:\..+)?$/)
        const candidateNodeId = (outputMatch ? outputMatch[1].trim() : expr).replace(/\\/g, '')
        if (!candidateNodeId || !validNodeIds.has(candidateNodeId) || seenIds.has(candidateNodeId)) {
            continue
        }

        seenIds.add(candidateNodeId)
        referencedIds.push(candidateNodeId)
    }

    return referencedIds
}

function extractWrittenStateKeys(inputs: Record<string, any> | undefined): string[] {
    if (!inputs || typeof inputs !== 'object') return []

    const keys: string[] = []
    const seen = new Set<string>()

    for (const [inputKey, rawValue] of Object.entries(inputs)) {
        const isUpdateState = inputKey === 'startState' || inputKey.endsWith('UpdateState')
        const isMergeState = inputKey === 'executeFlowMergeState'
        if (!isUpdateState && !isMergeState) {
            continue
        }

        let entries: unknown[] = []
        if (Array.isArray(rawValue)) {
            entries = rawValue
        } else if (typeof rawValue === 'string' && rawValue.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(rawValue)
                if (Array.isArray(parsed)) {
                    entries = parsed
                }
            } catch {
                continue
            }
        }

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue
            const entryObj = entry as Record<string, unknown>
            const rawKey = isMergeState ? entryObj.variable : entryObj.key
            if (typeof rawKey !== 'string') continue
            const trimmedKey = rawKey.trim()
            if (!trimmedKey || seen.has(trimmedKey)) continue
            seen.add(trimmedKey)
            keys.push(trimmedKey)
        }
    }

    return keys
}

function buildSubgraphContext(subgraphNodes: IReactFlowNode[], subgraphEdges: IReactFlowEdge[], roots: string[]): ISubgraphContext {
    const nodeIds = new Set(subgraphNodes.map((n) => n.id))
    const forwardAdj = new Map<string, string[]>()
    const reverseAdj = new Map<string, string[]>()
    const outgoingEdges = new Map<string, IReactFlowEdge[]>()

    for (const id of nodeIds) {
        forwardAdj.set(id, [])
        reverseAdj.set(id, [])
        outgoingEdges.set(id, [])
    }

    for (const edge of subgraphEdges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        forwardAdj.get(edge.source)!.push(edge.target)
        reverseAdj.get(edge.target)!.push(edge.source)
        outgoingEdges.get(edge.source)!.push(edge)
    }

    return {
        nodeIds,
        forwardAdj,
        reverseAdj,
        outgoingEdges,
        roots
    }
}

function resolveTopLevelStartingIds(topLevelNodes: IReactFlowNode[], topLevelEdges: IReactFlowEdge[]): string[] {
    const nodeIds = new Set(topLevelNodes.map((n) => n.id))
    const inDegree = new Map<string, number>()
    for (const id of nodeIds) {
        inDegree.set(id, 0)
    }

    for (const edge of topLevelEdges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const inDegreeZero = topLevelNodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    const startInDegreeZero = inDegreeZero.filter((n) => n.data?.name === 'startAgentflow')
    if (startInDegreeZero.length > 0) {
        return startInDegreeZero.map((n) => n.id)
    }

    const anyStart = topLevelNodes.filter((n) => n.data?.name === 'startAgentflow')
    if (anyStart.length > 0) {
        return anyStart.map((n) => n.id)
    }

    return inDegreeZero.map((n) => n.id)
}

function computeStrictAncestorsInAdjacency(nodeId: string, reverseAdj: Map<string, string[]>): Set<string> {
    const ancestors = new Set<string>()
    const queue: string[] = [...(reverseAdj.get(nodeId) || [])]
    let head = 0

    while (head < queue.length) {
        const current = queue[head++]
        if (current === nodeId || ancestors.has(current)) continue
        ancestors.add(current)
        for (const parent of reverseAdj.get(current) || []) {
            if (parent !== nodeId && !ancestors.has(parent)) {
                queue.push(parent)
            }
        }
    }

    return ancestors
}

function computeReachableSkippingNode(
    roots: string[],
    forwardAdj: Map<string, string[]>,
    validNodeIds: Set<string>,
    blockedNodeId: string
): Set<string> {
    const visited = new Set<string>()
    const queue: string[] = []

    for (const rootId of roots) {
        if (rootId === blockedNodeId || !validNodeIds.has(rootId) || visited.has(rootId)) continue
        visited.add(rootId)
        queue.push(rootId)
    }

    let head = 0
    while (head < queue.length) {
        const currentId = queue[head++]
        for (const nextId of forwardAdj.get(currentId) || []) {
            if (nextId === blockedNodeId || !validNodeIds.has(nextId) || visited.has(nextId)) continue
            visited.add(nextId)
            queue.push(nextId)
        }
    }

    return visited
}

/**
 * Performs Agentflow V2 concurrency-aware static validation checks:
 * 1. Unlinked `{{nodeId}}` / `{{nodeId.output...}}` references to non-ancestor nodes.
 * 2. Concurrent writes to the same runtime `state` key across non-ordered, non-mutually-exclusive nodes.
 * 3. Multiple concurrent content-bearing terminal nodes notice with deterministic tie-break order.
 */
export function validateAgentflowConcurrency(nodes: IReactFlowNode[], edges: IReactFlowEdge[]): IValidationResult[] {
    const activeNodes = (nodes || []).filter((n) => n && n.data?.name !== 'stickyNoteAgentflow')
    if (activeNodes.length === 0) {
        return []
    }

    const nodeById = new Map<string, IReactFlowNode>()
    for (const node of activeNodes) {
        nodeById.set(node.id, node)
    }

    const validEdges = (edges || []).filter((e) => e && nodeById.has(e.source) && nodeById.has(e.target))

    const fullReverseAdj = new Map<string, string[]>()
    for (const id of nodeById.keys()) {
        fullReverseAdj.set(id, [])
    }
    for (const edge of validEdges) {
        fullReverseAdj.get(edge.target)!.push(edge.source)
    }

    const topLevelNodes: IReactFlowNode[] = []
    const childrenByParent = new Map<string, IReactFlowNode[]>()
    for (const node of activeNodes) {
        if (!node.parentNode && node.extent !== 'parent') {
            topLevelNodes.push(node)
        } else if (node.parentNode && nodeById.has(node.parentNode)) {
            if (!childrenByParent.has(node.parentNode)) {
                childrenByParent.set(node.parentNode, [])
            }
            childrenByParent.get(node.parentNode)!.push(node)
        }
    }

    const topLevelIds = new Set(topLevelNodes.map((n) => n.id))
    const topLevelEdges = validEdges.filter((e) => topLevelIds.has(e.source) && topLevelIds.has(e.target))
    const startingNodeIds = resolveTopLevelStartingIds(topLevelNodes, topLevelEdges)
    const topContext = buildSubgraphContext(topLevelNodes, topLevelEdges, startingNodeIds)

    const reachableTopLevelIds = computeReachableNodes(startingNodeIds, topContext.forwardAdj, topLevelIds)
    const topLevelLevels = computeTopologicalLevels(topLevelNodes, topLevelEdges, startingNodeIds)

    const reachableNodeIds = new Set<string>(reachableTopLevelIds)
    const childContextByParent = new Map<string, ISubgraphContext>()

    for (const [parentId, childGroup] of childrenByParent.entries()) {
        const childIds = new Set(childGroup.map((n) => n.id))
        const childEdges = validEdges.filter((e) => childIds.has(e.source) && childIds.has(e.target))
        const childInDegree = new Map<string, number>()
        for (const id of childIds) {
            childInDegree.set(id, 0)
        }
        for (const edge of childEdges) {
            childInDegree.set(edge.target, (childInDegree.get(edge.target) ?? 0) + 1)
        }
        const childRoots = childGroup.filter((n) => (childInDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
        const childCtx = buildSubgraphContext(childGroup, childEdges, childRoots)
        childContextByParent.set(parentId, childCtx)

        if (reachableTopLevelIds.has(parentId)) {
            const reachableChildren = computeReachableNodes(childRoots, childCtx.forwardAdj, childIds)
            for (const childId of reachableChildren) {
                reachableNodeIds.add(childId)
            }
        }
    }

    const strictAncestorCache = new Map<string, Set<string>>()
    const getStrictAncestors = (nodeId: string, visiting: Set<string> = new Set()): Set<string> => {
        const cached = strictAncestorCache.get(nodeId)
        if (cached) return cached
        if (visiting.has(nodeId)) return new Set<string>()

        visiting.add(nodeId)
        const ancestors = computeStrictAncestorsInAdjacency(nodeId, fullReverseAdj)
        const node = nodeById.get(nodeId)
        if (node?.parentNode && nodeById.has(node.parentNode) && !visiting.has(node.parentNode)) {
            for (const parentAncestor of getStrictAncestors(node.parentNode, visiting)) {
                if (parentAncestor !== nodeId) {
                    ancestors.add(parentAncestor)
                }
            }
        }
        visiting.delete(nodeId)

        strictAncestorCache.set(nodeId, ancestors)
        return ancestors
    }

    const getEnclosingParentIds = (nodeId: string): string[] => {
        const parents: string[] = []
        const seen = new Set<string>([nodeId])
        let current = nodeById.get(nodeId)
        while (current?.parentNode && nodeById.has(current.parentNode) && !seen.has(current.parentNode)) {
            seen.add(current.parentNode)
            parents.push(current.parentNode)
            current = nodeById.get(current.parentNode)
        }
        return parents
    }

    const areNodesOrderedInExecution = (idA: string, idB: string): boolean => {
        const ancestorsA = getStrictAncestors(idA)
        const ancestorsB = getStrictAncestors(idB)
        if (ancestorsB.has(idA) || ancestorsA.has(idB)) {
            return true
        }
        const parentsA = getEnclosingParentIds(idA)
        if (parentsA.some((parentId) => parentId === idB || ancestorsB.has(parentId))) {
            return true
        }
        const parentsB = getEnclosingParentIds(idB)
        if (parentsB.some((parentId) => parentId === idA || ancestorsA.has(parentId))) {
            return true
        }
        return false
    }

    const areNodesMutuallyExclusive = (nodeA: IReactFlowNode, nodeB: IReactFlowNode): boolean => {
        let context: ISubgraphContext
        let proxyA: string
        let proxyB: string

        if (nodeA.parentNode && nodeA.parentNode === nodeB.parentNode && childContextByParent.has(nodeA.parentNode)) {
            context = childContextByParent.get(nodeA.parentNode)!
            proxyA = nodeA.id
            proxyB = nodeB.id
        } else {
            context = topContext
            proxyA = nodeA.parentNode && topLevelIds.has(nodeA.parentNode) ? nodeA.parentNode : nodeA.id
            proxyB = nodeB.parentNode && topLevelIds.has(nodeB.parentNode) ? nodeB.parentNode : nodeB.id
            if (proxyA === proxyB) {
                return false
            }
        }

        const ancestorsA = computeStrictAncestorsInAdjacency(proxyA, context.reverseAdj)
        const ancestorsB = computeStrictAncestorsInAdjacency(proxyB, context.reverseAdj)

        for (const candidateId of ancestorsA) {
            if (!ancestorsB.has(candidateId)) continue
            const candidateNode = nodeById.get(candidateId)
            if (!candidateNode || !DECISION_NODE_NAMES.has(candidateNode.data?.name || '')) continue

            // Decision node must dominate both targets so no parallel bypass path can still run both
            const reachableWithoutD = computeReachableSkippingNode(context.roots, context.forwardAdj, context.nodeIds, candidateId)
            if (reachableWithoutD.has(proxyA) || reachableWithoutD.has(proxyB)) {
                continue
            }

            const targetsByHandle = new Map<number | null, string[]>()
            for (const edge of context.outgoingEdges.get(candidateId) || []) {
                const handleIdx = parseDecisionOutputIndex(candidateId, edge.sourceHandle)
                if (!targetsByHandle.has(handleIdx)) {
                    targetsByHandle.set(handleIdx, [])
                }
                targetsByHandle.get(handleIdx)!.push(edge.target)
            }

            const handlesA = new Set<number | null>()
            const handlesB = new Set<number | null>()
            for (const [handleIdx, targets] of targetsByHandle.entries()) {
                const reach = computeReachableNodes(targets, context.forwardAdj, context.nodeIds)
                if (reach.has(proxyA)) {
                    handlesA.add(handleIdx)
                }
                if (reach.has(proxyB)) {
                    handlesB.add(handleIdx)
                }
            }

            if (handlesA.size === 0 || handlesB.size === 0 || handlesA.has(null) || handlesB.has(null)) {
                continue
            }

            let hasOverlap = false
            for (const h of handlesA) {
                if (handlesB.has(h)) {
                    hasOverlap = true
                    break
                }
            }

            if (!hasOverlap) {
                return true
            }
        }

        return false
    }

    const issuesByNodeId = new Map<string, string[]>()
    const addNodeIssue = (nodeId: string, issue: string) => {
        if (!issuesByNodeId.has(nodeId)) {
            issuesByNodeId.set(nodeId, [])
        }
        const list = issuesByNodeId.get(nodeId)!
        if (!list.includes(issue)) {
            list.push(issue)
        }
    }

    // 1. Unlinked Variable Reference Warning
    for (const node of activeNodes) {
        const referencedNodeIds = extractReferencedNodeIds(node.data?.inputs, new Set(nodeById.keys()))
        if (referencedNodeIds.length === 0) continue

        const ancestors = getStrictAncestors(node.id)
        for (const sourceNodeId of referencedNodeIds) {
            if (ancestors.has(sourceNodeId)) continue
            const sourceLabel = nodeById.get(sourceNodeId)?.data?.label || sourceNodeId
            addNodeIssue(
                node.id,
                `References output from '${sourceLabel}' (${sourceNodeId}), which is not an upstream ancestor. Under concurrent execution, this node may run before '${sourceLabel}' finishes — connect an edge from '${sourceLabel}' to guarantee ordering.`
            )
        }
    }

    // 2. Concurrent State-Key Write Conflict Warning
    const writersByStateKey = new Map<string, Set<string>>()
    for (const node of activeNodes) {
        if (!reachableNodeIds.has(node.id)) continue
        const writtenKeys = extractWrittenStateKeys(node.data?.inputs)
        for (const stateKey of writtenKeys) {
            if (!writersByStateKey.has(stateKey)) {
                writersByStateKey.set(stateKey, new Set())
            }
            writersByStateKey.get(stateKey)!.add(node.id)
        }
    }

    const sortedStateKeys = Array.from(writersByStateKey.keys()).sort(compareStringsCodePoint)
    for (const stateKey of sortedStateKeys) {
        const writerIds = Array.from(writersByStateKey.get(stateKey)!).sort(compareStringsCodePoint)
        if (writerIds.length < 2) continue

        for (let i = 0; i < writerIds.length; i += 1) {
            for (let j = i + 1; j < writerIds.length; j += 1) {
                const idA = writerIds[i]
                const idB = writerIds[j]
                if (areNodesOrderedInExecution(idA, idB)) {
                    continue
                }

                const nodeA = nodeById.get(idA)!
                const nodeB = nodeById.get(idB)!
                if (areNodesMutuallyExclusive(nodeA, nodeB)) {
                    continue
                }

                const labelA = nodeA.data?.label || idA
                const labelB = nodeB.data?.label || idB
                addNodeIssue(
                    idA,
                    `Shares runtime state key '${stateKey}' with potentially concurrent node '${labelB}'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins.`
                )
                addNodeIssue(
                    idB,
                    `Shares runtime state key '${stateKey}' with potentially concurrent node '${labelA}'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins.`
                )
            }
        }
    }

    const results: IValidationResult[] = []
    for (const node of activeNodes) {
        const issues = issuesByNodeId.get(node.id)
        if (issues && issues.length > 0) {
            results.push({
                id: node.id,
                label: node.data?.label || node.id,
                name: node.data?.name || '',
                issues
            })
        }
    }

    // 3. Multiple Content-Bearing Terminal Nodes Notice
    const contentTerminals = topLevelNodes.filter(
        (node) =>
            reachableTopLevelIds.has(node.id) &&
            (topContext.forwardAdj.get(node.id) || []).length === 0 &&
            CONTENT_BEARING_TERMINAL_NODE_NAMES.has(node.data?.name || '')
    )

    const concurrentTerminals = contentTerminals.filter((terminal) =>
        contentTerminals.some((other) => other.id !== terminal.id && !areNodesMutuallyExclusive(terminal, other))
    )

    if (concurrentTerminals.length > 1) {
        const sortedTerminals = [...concurrentTerminals].sort((a, b) => compareNodesDeterministically(a, b, topLevelLevels))
        const labelCounts = new Map<string, number>()
        for (const node of sortedTerminals) {
            const baseLabel = node.data?.label || node.id
            labelCounts.set(baseLabel, (labelCounts.get(baseLabel) ?? 0) + 1)
        }
        const orderedLabels = sortedTerminals.map((node) => {
            const baseLabel = node.data?.label || node.id
            return (labelCounts.get(baseLabel) ?? 0) > 1 && baseLabel !== node.id ? `${baseLabel} (${node.id})` : baseLabel
        })
        const firstLabel = orderedLabels[0]
        const orderSummary = orderedLabels.join(' -> ')
        results.push({
            id: 'agentflow-multiple-terminals',
            label: 'Multiple Terminal Nodes',
            name: 'multipleTerminals',
            issues: [
                `Multiple content-producing terminal nodes (${orderedLabels.join(', ')}) can run in this flow. ` +
                    `Active terminals stream consecutively separated by a blank line (\\n\\n); ` +
                    `deterministic tie-break order (executionOrder ?? position.y) is ${orderSummary} ('${firstLabel}' first if finishing together).`
            ]
        })
    }

    return results
}
