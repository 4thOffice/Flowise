import { StatusCodes } from 'http-status-codes'
import { DataSource } from 'typeorm'
import { IReactFlowNode } from '../Interface'
import { ChatFlow, EnumChatflowType } from '../database/entities/ChatFlow'
import { InternalFlowiseError } from '../errors/internalFlowiseError'

export const REDIRECT_FLOW_NODE_NAME = 'redirectFlowAgentflow'
const REDIRECT_FLOW_TARGET_INPUT = 'redirectFlowSelectedFlow'
const NODES_ALLOWED_BESIDE_REDIRECT = new Set(['startAgentflow', 'stickyNoteAgentflow'])

type RedirectCandidate = Pick<ChatFlow, 'type' | 'flowData'>

const parseNodes = (flowData: string): IReactFlowNode[] => {
    try {
        const parsed = JSON.parse(flowData)
        return Array.isArray(parsed?.nodes) ? parsed.nodes : []
    } catch {
        return []
    }
}

const findRedirectNodes = (chatflow: RedirectCandidate): { redirectNodes: IReactFlowNode[]; nodes: IReactFlowNode[] } => {
    if (chatflow.type !== EnumChatflowType.AGENTFLOW || !chatflow.flowData?.includes(REDIRECT_FLOW_NODE_NAME)) {
        return { redirectNodes: [], nodes: [] }
    }
    const nodes = parseNodes(chatflow.flowData)
    return { redirectNodes: nodes.filter((node) => node.data?.name === REDIRECT_FLOW_NODE_NAME), nodes }
}

export const getRedirectTargetId = (chatflow: RedirectCandidate): string | undefined => {
    const { redirectNodes, nodes } = findRedirectNodes(chatflow)
    if (!redirectNodes.length) return undefined

    const hasOtherNodes = nodes.some(
        (node) => node.data?.name !== REDIRECT_FLOW_NODE_NAME && !NODES_ALLOWED_BESIDE_REDIRECT.has(node.data?.name)
    )
    if (redirectNodes.length > 1 || hasOtherNodes) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Redirect to Flow must be the only node connected to Start')
    }

    const targetId = redirectNodes[0].data.inputs?.[REDIRECT_FLOW_TARGET_INPUT]
    if (typeof targetId !== 'string' || !targetId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Redirect to Flow has no target flow selected')
    }
    return targetId
}

export const resolveFlowRedirect = async (chatflow: ChatFlow, appDataSource: DataSource): Promise<ChatFlow> => {
    const targetId = getRedirectTargetId(chatflow)
    if (!targetId) return chatflow

    if (targetId === chatflow.id) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Redirect to Flow cannot target its own flow')
    }

    const target = await appDataSource.getRepository(ChatFlow).findOneBy({ id: targetId })
    if (!target) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Redirect target flow ${targetId} not found`)
    }
    if (target.workspaceId !== chatflow.workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Redirect target flow must be in the same workspace')
    }
    if (findRedirectNodes(target).redirectNodes.length) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Redirect target flow cannot itself be a Redirect to Flow mapping')
    }
    return target
}
