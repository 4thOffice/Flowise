import { DataSource } from 'typeorm'
import { ChatFlow } from '../../src/database/entities/ChatFlow'
import { InternalFlowiseError } from '../../src/errors/internalFlowiseError'
import { getRedirectTargetId, resolveFlowRedirect } from '../../src/utils/flowRedirect'

const WORKSPACE = 'ws-1'

const node = (id: string, name: string, inputs: Record<string, any> = {}) => ({ id, data: { id, name, inputs } })
const startNode = node('startAgentflow_0', 'startAgentflow')
const stickyNote = node('stickyNoteAgentflow_0', 'stickyNoteAgentflow')
const redirectNode = (target?: string) =>
    node('redirectFlowAgentflow_0', 'redirectFlowAgentflow', target === undefined ? {} : { redirectFlowSelectedFlow: target })

const flow = (id: string, nodes: any[], overrides: Partial<ChatFlow> = {}): ChatFlow =>
    ({
        id,
        name: id,
        type: 'AGENTFLOW',
        workspaceId: WORKSPACE,
        flowData: JSON.stringify({ nodes, edges: [] }),
        ...overrides
    } as ChatFlow)

const mapping = (target: string | undefined, extraNodes: any[] = []) => flow('mapping', [startNode, redirectNode(target), ...extraNodes])
const target = (overrides: Partial<ChatFlow> = {}) =>
    flow('target', [startNode, node('directReplyAgentflow_0', 'directReplyAgentflow')], overrides)

const dataSourceReturning = (result: ChatFlow | null) => {
    const findOneBy = jest.fn().mockResolvedValue(result)
    return { appDataSource: { getRepository: jest.fn(() => ({ findOneBy })) } as unknown as DataSource, findOneBy }
}

const expectFlowiseError = async (promise: Promise<unknown>, statusCode: number, message: RegExp) => {
    const error = (await promise.then(
        () => undefined,
        (e) => e
    )) as InternalFlowiseError
    expect(error).toBeInstanceOf(InternalFlowiseError)
    expect(error.statusCode).toBe(statusCode)
    expect(error.message).toMatch(message)
}

describe('getRedirectTargetId', () => {
    it.each([
        ['a chatflow', flow('cf', [redirectNode('target')], { type: 'CHATFLOW' })],
        ['an agentflow without a Redirect node', target()],
        ['invalid flowData', flow('bad', [], { flowData: 'not json redirectFlowAgentflow' })],
        ['empty flowData', flow('empty', [], { flowData: '' })]
    ])('returns undefined for %s', (_label, chatflow) => {
        expect(getRedirectTargetId(chatflow)).toBeUndefined()
    })

    it('returns the selected target for Start + Redirect + sticky notes', () => {
        expect(getRedirectTargetId(mapping('target', [stickyNote]))).toBe('target')
    })

    it('rejects a mapping with another node', () => {
        expect(() => getRedirectTargetId(mapping('target', [node('directReplyAgentflow_0', 'directReplyAgentflow')]))).toThrow(
            /only node connected to Start/
        )
    })

    it('rejects two Redirect nodes', () => {
        expect(() => getRedirectTargetId(mapping('target', [node('redirectFlowAgentflow_1', 'redirectFlowAgentflow')]))).toThrow(
            /only node connected to Start/
        )
    })

    it.each([undefined, ''])('rejects a mapping with no target selected (%p)', (selected) => {
        expect(() => getRedirectTargetId(mapping(selected))).toThrow(/no target flow selected/)
    })
})

describe('resolveFlowRedirect', () => {
    it('returns a non-mapping flow unchanged without a DB call', async () => {
        const { appDataSource, findOneBy } = dataSourceReturning(null)
        const plain = target()
        await expect(resolveFlowRedirect(plain, appDataSource)).resolves.toBe(plain)
        expect(findOneBy).not.toHaveBeenCalled()
    })

    it('returns the target flow for a valid mapping', async () => {
        const resolved = target()
        const { appDataSource, findOneBy } = dataSourceReturning(resolved)
        await expect(resolveFlowRedirect(mapping('target'), appDataSource)).resolves.toBe(resolved)
        expect(findOneBy).toHaveBeenCalledWith({ id: 'target' })
    })

    it('rejects a missing target with 404', async () => {
        const { appDataSource } = dataSourceReturning(null)
        await expectFlowiseError(resolveFlowRedirect(mapping('target'), appDataSource), 404, /not found/)
    })

    it('rejects a target in another workspace', async () => {
        const { appDataSource } = dataSourceReturning(target({ workspaceId: 'ws-2' }))
        await expectFlowiseError(resolveFlowRedirect(mapping('target'), appDataSource), 400, /same workspace/)
    })

    it('rejects a mapping that targets itself', async () => {
        const { appDataSource, findOneBy } = dataSourceReturning(null)
        await expectFlowiseError(resolveFlowRedirect(mapping('mapping'), appDataSource), 400, /its own flow/)
        expect(findOneBy).not.toHaveBeenCalled()
    })

    it('rejects a chained mapping', async () => {
        const chained = flow('target', [startNode, redirectNode('other')])
        const { appDataSource } = dataSourceReturning(chained)
        await expectFlowiseError(resolveFlowRedirect(mapping('target'), appDataSource), 400, /cannot itself be/)
    })
})
