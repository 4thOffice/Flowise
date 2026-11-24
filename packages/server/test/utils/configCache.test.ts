import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { entities } from '../../src/database/entities'
import { ChatFlow } from '../../src/database/entities/ChatFlow'
import { Credential } from '../../src/database/entities/Credential'
import { Variable } from '../../src/database/entities/Variable'
import { Organization } from '../../src/enterprise/database/entities/organization.entity'
import { Workspace } from '../../src/enterprise/database/entities/workspace.entity'
import {
    getChatflow,
    getCredential,
    getParsedFlow,
    getVariables,
    getWorkspaceWithOrganization,
    settleConfigCache,
    startConfigCache,
    stopConfigCache
} from '../../src/utils/configCache'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const FLOW = '44444444-4444-4444-8444-444444444444'
const CRED = '55555555-5555-4555-8555-555555555555'
const USER = '66666666-6666-4666-8666-666666666666'

const flowData = (label: string) => JSON.stringify({ nodes: [{ id: 'start_0', data: { label, inputs: { a: [1] } } }], edges: [] })

const seed = async (ds: DataSource) => {
    await ds.getRepository(Organization).save({ id: ORG, name: 'Org', subscriptionId: 'sub-1', createdBy: USER, updatedBy: USER })
    await ds.getRepository(Workspace).save({ id: WS, name: 'WS', organizationId: ORG, createdBy: USER, updatedBy: USER })
    await ds.getRepository(ChatFlow).save({ id: FLOW, name: 'Flow', flowData: flowData('v1'), type: 'AGENTFLOW', workspaceId: WS })
    await ds.getRepository(Variable).save({ name: 'greeting', value: 'hi', type: 'static', workspaceId: WS })
    await ds.getRepository(Credential).save({ id: CRED, name: 'Key', credentialName: 'openAIApi', encryptedData: 'enc-1', workspaceId: WS })
}

// A write the cache cannot see: no TypeORM entity events, as when another instance writes
const writeBehindItsBack = (ds: DataSource, label: string) =>
    ds.query('UPDATE chat_flow SET "flowData" = ? WHERE id = ?', [flowData(label), FLOW])

const labelOf = (chatflow: ChatFlow | null) => chatflow && JSON.parse(chatflow.flowData).nodes[0].data.label

describe('configCache', () => {
    let ds: DataSource
    const env = { ...process.env }

    beforeEach(async () => {
        ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: Object.values(entities), synchronize: true })
        await ds.initialize()
        await ds.query('PRAGMA foreign_keys = OFF')
        await seed(ds)
    })

    afterEach(async () => {
        stopConfigCache()
        process.env = { ...env }
        await ds.destroy()
    })

    const start = async (refreshSeconds = '0') => {
        delete process.env.DISABLE_CONFIG_CACHE
        process.env.CONFIG_CACHE_REFRESH_SECONDS = refreshSeconds
        await startConfigCache(ds)
    }

    it('reads the database on every call when it is off', async () => {
        process.env.DISABLE_CONFIG_CACHE = 'true'
        await startConfigCache(ds)
        await writeBehindItsBack(ds, 'v2')

        expect(labelOf(await getChatflow(ds, FLOW))).toBe('v2')
        expect(Object.isFrozen(getParsedFlow((await getChatflow(ds, FLOW))!))).toBe(false)
    })

    it('serves the loaded configuration from memory', async () => {
        await start()
        await writeBehindItsBack(ds, 'v2')

        expect(labelOf(await getChatflow(ds, FLOW))).toBe('v1')
        expect(await getChatflow(ds, FLOW, OTHER_WS)).toBeNull()
        expect(await getChatflow(ds, '77777777-7777-4777-8777-777777777777')).toBeNull()
        expect((await getWorkspaceWithOrganization(ds, WS))?.organization?.subscriptionId).toBe('sub-1')
        expect((await getVariables(ds, WS)).map((v) => v.value)).toEqual(['hi'])
        expect(await getVariables(ds, OTHER_WS)).toEqual([])
        expect((await getCredential(ds, CRED))?.encryptedData).toBe('enc-1')
    })

    it('reloads a kind after a local write commits', async () => {
        await start()
        const repo = ds.getRepository(ChatFlow)

        await repo.save({ ...(await repo.findOneByOrFail({ id: FLOW })), flowData: flowData('v2') })
        await ds.getRepository(Variable).update({ name: 'greeting' }, { value: 'hello' })
        await ds.getRepository(Organization).update({ id: ORG }, { subscriptionId: 'sub-2' })
        await ds.getRepository(Credential).delete({ id: CRED })
        await settleConfigCache()

        expect(labelOf(await getChatflow(ds, FLOW))).toBe('v2')
        expect((await getVariables(ds, WS)).map((v) => v.value)).toEqual(['hello'])
        expect((await getWorkspaceWithOrganization(ds, WS))?.organization?.subscriptionId).toBe('sub-2')
        expect(await getCredential(ds, CRED)).toBeNull()

        await repo.delete({ id: FLOW })
        await settleConfigCache()
        expect(await getChatflow(ds, FLOW)).toBeNull()
    })

    it('serves a local write as soon as the write resolves', async () => {
        await start()
        const repo = ds.getRepository(ChatFlow)

        await repo.save({ ...(await repo.findOneByOrFail({ id: FLOW })), flowData: flowData('v2') })
        expect(labelOf(await getChatflow(ds, FLOW))).toBe('v2')

        const created = await repo.save({ name: 'Copy', flowData: flowData('copy'), type: 'AGENTFLOW', workspaceId: WS })
        await ds.getRepository(Variable).update({ name: 'greeting' }, { value: 'hello' })
        expect(labelOf(await getChatflow(ds, created.id, WS))).toBe('copy')
        expect((await getVariables(ds, WS)).map((v) => v.value)).toEqual(['hello'])
    })

    it('reads rows another instance created from the database on a miss', async () => {
        await start()
        const NEW = '88888888-8888-4888-8888-888888888888'
        await ds.query('INSERT INTO chat_flow (id, name, "flowData", type, "workspaceId") VALUES (?, ?, ?, ?, ?)', [
            NEW,
            'Elsewhere',
            flowData('elsewhere'),
            'AGENTFLOW',
            WS
        ])

        expect(labelOf(await getChatflow(ds, NEW, WS))).toBe('elsewhere')
        expect(await getChatflow(ds, NEW, OTHER_WS)).toBeNull()

        // The miss reloads the chatflows, so the next read comes from memory
        await settleConfigCache()
        await ds.query('DELETE FROM chat_flow WHERE id = ?', [NEW])
        expect(labelOf(await getChatflow(ds, NEW))).toBe('elsewhere')
    })

    it('ignores writes of a rolled back transaction', async () => {
        await start()

        await ds
            .transaction(async (manager) => {
                await manager.getRepository(Variable).update({ name: 'greeting' }, { value: 'rolled back' })
                throw new Error('rollback')
            })
            .catch(() => undefined)
        await settleConfigCache()

        expect((await getVariables(ds, WS)).map((v) => v.value)).toEqual(['hi'])
    })

    it('picks up writes it cannot see on the periodic refresh', async () => {
        await start('0.05')
        await writeBehindItsBack(ds, 'v2')

        await new Promise((resolve) => setTimeout(resolve, 200))
        await settleConfigCache()

        expect(labelOf(await getChatflow(ds, FLOW))).toBe('v2')
    })

    it('hands out copies, so a caller changing a row does not change the cache', async () => {
        await start()

        const chatflow = (await getChatflow(ds, FLOW))!
        chatflow.analytic = 'changed'
        const variables = await getVariables(ds, WS)
        variables[0].value = 'changed'
        const workspace = (await getWorkspaceWithOrganization(ds, WS))!
        workspace.organization!.subscriptionId = 'changed'

        expect((await getChatflow(ds, FLOW))?.analytic).toBeFalsy()
        expect((await getVariables(ds, WS))[0].value).toBe('hi')
        expect((await getWorkspaceWithOrganization(ds, WS))?.organization?.subscriptionId).toBe('sub-1')
    })

    it('parses a cached chatflow once, frozen, until its flowData changes', async () => {
        await start()

        const parsed = getParsedFlow((await getChatflow(ds, FLOW))!)
        expect(getParsedFlow((await getChatflow(ds, FLOW))!)).toBe(parsed)
        expect(() => {
            ;(parsed.nodes[0].data.inputs as any).a.push(2)
        }).toThrow(TypeError)

        const changed = { ...(await getChatflow(ds, FLOW))!, flowData: flowData('iteration') } as ChatFlow
        expect(getParsedFlow(changed)).not.toBe(parsed)
        expect(Object.isFrozen(getParsedFlow(changed))).toBe(false)

        await ds.getRepository(ChatFlow).update({ id: FLOW }, { flowData: flowData('v2') })
        await settleConfigCache()
        expect(getParsedFlow((await getChatflow(ds, FLOW))!).nodes[0].data.label).toBe('v2')
    })
})
