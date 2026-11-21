import fs from 'fs'
import net, { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import * as Server from '../src'
import { getRunningExpressApp } from '../src/utils/getRunningExpressApp'
import { organizationUserRouteTest } from './routes/v1/organization-user.route.test'
import { userRouteTest } from './routes/v1/user.route.test'
import { apiKeyTest } from './utils/api-key.util.test'

// ⏱️ Extend test timeout to 6 minutes for long setups (increase as tests grow)
jest.setTimeout(360000)

let isolatedDataDir: string | undefined

const findFreePort = () =>
    new Promise<number>((resolve, reject) => {
        const probe = net.createServer()
        probe.once('error', reject)
        probe.listen(0, () => {
            const { port } = probe.address() as AddressInfo
            probe.close(() => resolve(port))
        })
    })

beforeAll(async () => {
    // `pnpm --filter flowise test` runs this suite twice at once (root turbo pipeline + package script),
    // so each run needs its own port and database rather than sharing :3000 and ~/.flowise
    if (!process.env.PORT) {
        process.env.PORT = String(await findFreePort())
    }
    if (!process.env.DATABASE_PATH) {
        isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowise-jest-server-'))
        process.env.DATABASE_PATH = isolatedDataDir
        process.env.SECRETKEY_PATH = process.env.SECRETKEY_PATH || isolatedDataDir
        process.env.BLOB_STORAGE_PATH = process.env.BLOB_STORAGE_PATH || path.join(isolatedDataDir, 'storage')
    }

    await Server.start()

    // ⏳ Wait 3 minutes for full server and database init (esp. on lower end hardware)
    await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1000))
})

afterAll(async () => {
    await getRunningExpressApp().stopApp()
    if (isolatedDataDir) {
        fs.rmSync(isolatedDataDir, { recursive: true, force: true })
    }
})

describe('Routes Test', () => {
    userRouteTest()
    organizationUserRouteTest()
})

describe('Utils Test', () => {
    apiKeyTest()
})
