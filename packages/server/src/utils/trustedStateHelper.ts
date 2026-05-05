import { gzip, gunzip } from 'node:zlib'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promisify } from 'util'
import { TrustedState } from '../Interface'
import logger from './logger'
import path from 'path'
import fs from 'fs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
// Configuration
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

const secretFilePath = path.join(__dirname, '.client-state-server-secret')

function getOrCreateSecret() {
    if (process.env.CLIENT_STATE_SERVER_SECRET) {
        return Buffer.from(process.env.CLIENT_STATE_SERVER_SECRET, 'hex')
    }
    if (fs.existsSync(secretFilePath)) {
        return Buffer.from(fs.readFileSync(secretFilePath, 'utf8').trim(), 'hex')
    }

    // If it doesn't exist, generate and store a new secure 256-bit key
    const newSecret = randomBytes(32)
    fs.writeFileSync(secretFilePath, newSecret.toString('hex'), 'utf8')
    logger.info('New secret key generated and saved!')

    return newSecret
}

const SECRET_KEY = getOrCreateSecret()

async function compressAndEncrypt(data: string): Promise<string> {
    const compressedBuffer = await gzipAsync(Buffer.from(data, 'utf8'))
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, SECRET_KEY, iv)
    const encryptedBuffer = Buffer.concat([cipher.update(compressedBuffer), cipher.final()])
    const authTag = cipher.getAuthTag()
    const payloadBuffer = Buffer.concat([iv, authTag, encryptedBuffer])
    return payloadBuffer.toString('base64')
}

async function decryptAndDecompress(base64Payload: string): Promise<string> {
    const payloadBuffer = Buffer.from(base64Payload, 'base64')
    const iv = payloadBuffer.subarray(0, IV_LENGTH)
    const authTag = payloadBuffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encryptedBuffer = payloadBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, SECRET_KEY, iv)
    decipher.setAuthTag(authTag) // Required for GCM to verify data integrity
    const compressedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()])
    const decompressedBuffer = await gunzipAsync(compressedBuffer)
    return decompressedBuffer.toString('utf8')
}

export async function trusted_state_to_string(trustedState: TrustedState): Promise<string> {
    return await compressAndEncrypt(JSON.stringify(trustedState))
}

export async function trusted_state_from_string(trustedStateString: string): Promise<TrustedState | undefined> {
    try {
        return JSON.parse(await decryptAndDecompress(trustedStateString)) as TrustedState
    } catch (e) {
        logger.warn(e)
    }
    return undefined
}
