/**
 * Pure client-side execution wave & topological order helper for Agentflow V2.
 * Mirrors `computeTopologicalLevels` and `compareNodesDeterministically` in
 * `packages/server/src/utils/agentflow/dependencyEngine.ts` without mutating flow data.
 */

const UNREACHABLE_ENTRY = Object.freeze({
    wave: null,
    level: null,
    waveSize: 0,
    isParallel: false,
    indexInWave: null,
    label: 'Unreachable',
    tooltip: 'Unreachable from Start node (disconnected or cyclic)',
    unreachable: true
})

/**
 * Computes the forward-reachable node set from `rootNodeIds` via iterative BFS.
 */
export function computeReachableNodes(rootNodeIds, outgoingAdjacency, validNodeIds) {
    const visited = new Set()
    const queue = []

    for (const rootId of rootNodeIds || []) {
        if (validNodeIds && !validNodeIds.has(rootId)) continue
        if (visited.has(rootId)) continue
        visited.add(rootId)
        queue.push(rootId)
    }

    let head = 0
    while (head < queue.length) {
        const currentId = queue[head++]
        const neighbors = outgoingAdjacency.get(currentId) || []
        for (const nextId of neighbors) {
            if (validNodeIds && !validNodeIds.has(nextId)) continue
            if (visited.has(nextId)) continue
            visited.add(nextId)
            queue.push(nextId)
        }
    }

    return visited
}

/**
 * Computes longest-path topological levels (`level(v) = max_{u -> v}(level(u) + 1)`) using Kahn's algorithm.
 * Sticky notes are ignored. When `startingNodeIds` is provided, only nodes reachable from those roots are leveled.
 */
export function computeTopologicalLevels(nodes, edges, startingNodeIds) {
    const activeNodes = (nodes || []).filter((n) => n && n.data?.name !== 'stickyNoteAgentflow')
    const allNodeIds = new Set(activeNodes.map((n) => n.id))

    const adjacency = new Map()
    for (const id of allNodeIds) {
        adjacency.set(id, [])
    }

    const validEdges = (edges || []).filter((e) => e && allNodeIds.has(e.source) && allNodeIds.has(e.target))
    for (const edge of validEdges) {
        adjacency.get(edge.source).push(edge.target)
    }

    const activeNodeIds = startingNodeIds !== undefined ? computeReachableNodes(startingNodeIds, adjacency, allNodeIds) : allNodeIds

    const inDegree = new Map()
    const activeAdjacency = new Map()
    for (const id of activeNodeIds) {
        inDegree.set(id, 0)
        activeAdjacency.set(id, [])
    }

    for (const edge of validEdges) {
        if (!activeNodeIds.has(edge.source) || !activeNodeIds.has(edge.target)) continue
        activeAdjacency.get(edge.source).push(edge.target)
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const levels = {}
    const queue = []
    for (const [id, deg] of inDegree.entries()) {
        if (deg === 0) {
            levels[id] = 0
            queue.push(id)
        }
    }

    let head = 0
    while (head < queue.length) {
        const u = queue[head++]
        const uLevel = levels[u] ?? 0
        for (const v of activeAdjacency.get(u) || []) {
            levels[v] = Math.max(levels[v] ?? 0, uLevel + 1)
            const nextDeg = (inDegree.get(v) ?? 0) - 1
            inDegree.set(v, nextDeg)
            if (nextDeg === 0) {
                queue.push(v)
            }
        }
    }

    return levels
}

function getExplicitOrCanvasOrder(node) {
    const explicitOrder = node?.data?.executionOrder
    if (typeof explicitOrder === 'number' && Number.isFinite(explicitOrder)) {
        return explicitOrder
    }
    const posY = node?.position?.y
    if (typeof posY === 'number' && Number.isFinite(posY)) {
        return posY
    }
    return 0
}

function compareNodeIdsCodePoint(aId, bId) {
    if (aId < bId) return -1
    if (aId > bId) return 1
    return 0
}

/**
 * Deterministic comparator: `(executionOrder ?? position.y ?? 0)`, then topological `level`, then code-point `node.id`.
 */
export function compareNodesDeterministically(a, b, levels = {}) {
    const orderDiff = getExplicitOrCanvasOrder(a) - getExplicitOrCanvasOrder(b)
    if (orderDiff !== 0) {
        return orderDiff
    }

    const levelA = levels[a.id] ?? Number.MAX_SAFE_INTEGER
    const levelB = levels[b.id] ?? Number.MAX_SAFE_INTEGER
    if (levelA !== levelB) {
        return levelA - levelB
    }

    return compareNodeIdsCodePoint(a.id, b.id)
}

/**
 * Resolves starting node IDs for top-level Agentflow V2 nodes, preferring `startAgentflow`
 * when present so disconnected non-start nodes become `Unreachable` rather than `Step 1`.
 */
export function resolveStartingNodeIds(nodes, edges) {
    const activeNodes = (nodes || []).filter((n) => n && n.data?.name !== 'stickyNoteAgentflow' && !n.parentNode && n.extent !== 'parent')
    const nodeIds = new Set(activeNodes.map((n) => n.id))
    const inDegree = new Map()
    for (const id of nodeIds) {
        inDegree.set(id, 0)
    }

    for (const edge of edges || []) {
        if (!edge || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const inDegreeZero = activeNodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    const startInDegreeZero = inDegreeZero.filter((n) => n.data?.name === 'startAgentflow')
    if (startInDegreeZero.length > 0) {
        return startInDegreeZero.map((n) => n.id)
    }

    const anyStart = activeNodes.filter((n) => n.data?.name === 'startAgentflow')
    if (anyStart.length > 0) {
        return anyStart.map((n) => n.id)
    }

    return inDegreeZero.map((n) => n.id)
}

function populateWavesForGroup(groupNodes, groupEdges, startingIds, targetMap) {
    const levels = computeTopologicalLevels(groupNodes, groupEdges, startingIds)
    const buckets = new Map()
    const unreachableNodes = []

    for (const node of groupNodes) {
        const level = levels[node.id]
        if (typeof level === 'number' && Number.isFinite(level)) {
            if (!buckets.has(level)) {
                buckets.set(level, [])
            }
            buckets.get(level).push(node)
        } else {
            unreachableNodes.push(node)
        }
    }

    for (const [level, bucket] of buckets.entries()) {
        const sortedBucket = [...bucket].sort((a, b) => compareNodesDeterministically(a, b, levels))
        const wave = level + 1
        const waveSize = sortedBucket.length
        const isParallel = waveSize > 1

        sortedBucket.forEach((node, idx) => {
            const indexInWave = idx + 1
            const label = isParallel ? `Step ${wave}.${indexInWave} (Parallel)` : `Step ${wave}`
            const tooltip = isParallel
                ? `Execution Wave ${wave} (${indexInWave} of ${waveSize}) — Runs concurrently with other active Wave ${wave} nodes`
                : `Execution Wave ${wave} — Runs sequentially in this wave`

            targetMap[node.id] = {
                wave,
                level,
                waveSize,
                isParallel,
                indexInWave,
                label,
                tooltip,
                unreachable: false
            }
        })
    }

    for (const node of unreachableNodes) {
        targetMap[node.id] = { ...UNREACHABLE_ENTRY }
    }
}

/**
 * Derives read-only execution wave metadata keyed by `node.id`.
 * Never mutates input `nodes` or `edges`.
 */
export function computeExecutionWaveMap(nodes, edges) {
    const waveMap = {}
    const nonStickyNodes = (nodes || []).filter((n) => n && n.data?.name !== 'stickyNoteAgentflow')
    const topLevelNodes = []
    const childrenByParent = new Map()
    const orphanChildNodes = []

    for (const node of nonStickyNodes) {
        if (!node.parentNode && node.extent !== 'parent') {
            topLevelNodes.push(node)
        } else if (node.parentNode) {
            if (!childrenByParent.has(node.parentNode)) {
                childrenByParent.set(node.parentNode, [])
            }
            childrenByParent.get(node.parentNode).push(node)
        } else {
            orphanChildNodes.push(node)
        }
    }

    const topLevelIds = new Set(topLevelNodes.map((n) => n.id))
    const topLevelEdges = (edges || []).filter((e) => e && topLevelIds.has(e.source) && topLevelIds.has(e.target))
    const topStartingIds = resolveStartingNodeIds(topLevelNodes, topLevelEdges)
    populateWavesForGroup(topLevelNodes, topLevelEdges, topStartingIds, waveMap)

    for (const [parentId, childGroup] of childrenByParent.entries()) {
        const parentEntry = waveMap[parentId]
        if (!parentEntry || parentEntry.unreachable) {
            for (const child of childGroup) {
                waveMap[child.id] = { ...UNREACHABLE_ENTRY }
            }
            continue
        }

        const childIds = new Set(childGroup.map((n) => n.id))
        const childEdges = (edges || []).filter((e) => e && childIds.has(e.source) && childIds.has(e.target))
        const childInDegree = new Map()
        for (const id of childIds) {
            childInDegree.set(id, 0)
        }
        for (const edge of childEdges) {
            childInDegree.set(edge.target, (childInDegree.get(edge.target) ?? 0) + 1)
        }
        const childStartingIds = childGroup.filter((n) => (childInDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
        populateWavesForGroup(childGroup, childEdges, childStartingIds, waveMap)
    }

    for (const orphan of orphanChildNodes) {
        waveMap[orphan.id] = { ...UNREACHABLE_ENTRY }
    }

    return waveMap
}
