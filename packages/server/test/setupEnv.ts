import os from 'os'
import path from 'path'

if (!process.env.CLIENT_STATE_SERVER_SECRET) {
    process.env.CLIENT_STATE_SERVER_SECRET = '0'.repeat(64)
}

if (!process.env.LOG_PATH) {
    process.env.LOG_PATH = path.join(os.tmpdir(), 'flowise-jest-logs')
}
