// Mirror of packages/server/src/utils/trustedStateHelper.ts: base64( iv | authTag | AES-256-GCM( gzip( JSON ) ) )
import crypto from 'crypto'
import zlib from 'zlib'

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

const keyFrom = (secretHex) => {
    const key = Buffer.from(secretHex, 'hex')
    if (key.length !== 32) throw new Error('CLIENT_STATE_SERVER_SECRET must be 32 bytes of hex')
    return key
}

export function decodeTrustedState(token, secretHex) {
    const payload = Buffer.from(token, 'base64')
    const iv = payload.subarray(0, IV_LENGTH)
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secretHex), iv)
    decipher.setAuthTag(authTag)
    const gzipped = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const json = zlib.gunzipSync(gzipped).toString('utf8')
    return {
        json,
        state: JSON.parse(json),
        sizes: {
            base64Length: token.length,
            payloadBytes: payload.length,
            gzipBytes: gzipped.length,
            rawJsonBytes: Buffer.byteLength(json, 'utf8')
        }
    }
}

export function encodeTrustedState(state, secretHex) {
    const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(state), 'utf8'))
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secretHex), iv)
    const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}
