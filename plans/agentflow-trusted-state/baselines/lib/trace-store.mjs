// Lossless, compact trace storage: nested JSON strings are expanded as {"$json": value} and long strings
// (system prompts, rendered histories) are stored once per trace directory under blobs/<sha256>.txt.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export const SENTINEL_RE = /SYSPROMPT_SENTINEL_[A-Za-z0-9]+_[A-Za-z0-9]+/g
export const BLOB_MIN_LENGTH = 2048

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

export function countSentinels(text) {
    const bySentinel = {}
    let total = 0
    if (typeof text !== 'string') text = text === undefined ? '' : JSON.stringify(text)
    for (const match of text.matchAll(SENTINEL_RE)) {
        bySentinel[match[0]] = (bySentinel[match[0]] ?? 0) + 1
        total += 1
    }
    return { total, bySentinel }
}

function tryParseJsonString(value) {
    if (typeof value !== 'string' || value.length < 2) return undefined
    const first = value[0]
    if (first !== '{' && first !== '[') return undefined
    try {
        const parsed = JSON.parse(value)
        if (parsed === null || typeof parsed !== 'object') return undefined
        return JSON.stringify(parsed) === value ? parsed : undefined
    } catch {
        return undefined
    }
}

// Replace JSON-encoded strings with {"$json": parsed} wherever JSON.stringify(parsed) restores them exactly.
export function expandJsonStrings(value) {
    if (Array.isArray(value)) return value.map(expandJsonStrings)
    if (value && typeof value === 'object') {
        const out = {}
        for (const [key, inner] of Object.entries(value)) out[key] = expandJsonStrings(inner)
        return out
    }
    const parsed = tryParseJsonString(value)
    return parsed === undefined ? value : { $json: expandJsonStrings(parsed) }
}

export function collapseJsonStrings(value) {
    if (Array.isArray(value)) return value.map(collapseJsonStrings)
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && '$json' in value) return JSON.stringify(collapseJsonStrings(value.$json))
        const out = {}
        for (const [key, inner] of Object.entries(value)) out[key] = collapseJsonStrings(inner)
        return out
    }
    return value
}

export class BlobStore {
    constructor(dir) {
        this.dir = dir
        this.written = new Set()
    }

    put(text) {
        const hash = sha256(text)
        if (!this.written.has(hash)) {
            fs.mkdirSync(this.dir, { recursive: true })
            const file = path.join(this.dir, `${hash}.txt`)
            if (!fs.existsSync(file)) fs.writeFileSync(file, text)
            this.written.add(hash)
        }
        const sentinels = Object.keys(countSentinels(text).bySentinel)
        return { $blob: hash, length: text.length, ...(sentinels.length ? { sentinels } : {}), head: text.slice(0, 120) }
    }

    externalize(value) {
        if (Array.isArray(value)) return value.map((item) => this.externalize(item))
        if (value && typeof value === 'object') {
            const out = {}
            for (const [key, inner] of Object.entries(value)) out[key] = this.externalize(inner)
            return out
        }
        if (typeof value === 'string' && value.length >= BLOB_MIN_LENGTH) return this.put(value)
        return value
    }
}

export function isBlobRef(value) {
    return Boolean(value && typeof value === 'object' && typeof value.$blob === 'string')
}

export function makeBlobReader(traceRootDir) {
    const cache = new Map()
    return (ref) => {
        if (!cache.has(ref.$blob)) cache.set(ref.$blob, fs.readFileSync(path.join(traceRootDir, 'blobs', `${ref.$blob}.txt`), 'utf8'))
        return cache.get(ref.$blob)
    }
}

// Restore the exact original value: blob refs become their text and {"$json": x} becomes the JSON string again.
export function inflate(value, readBlob) {
    if (Array.isArray(value)) return value.map((item) => inflate(item, readBlob))
    if (isBlobRef(value)) return readBlob(value)
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && '$json' in value) return JSON.stringify(inflate(value.$json, readBlob))
        const out = {}
        for (const [key, inner] of Object.entries(value)) out[key] = inflate(inner, readBlob)
        return out
    }
    return value
}

// Byte sizes of every subtree of at least minBytes, as it is serialized inside its parent; nested JSON strings
// report both the escaped string size and the parsed size.
export function pathBytes(value, { minBytes = 512, maxDepth = 9 } = {}) {
    const rows = []
    const walk = (node, pathLabel, depth) => {
        const serialized = JSON.stringify(collapseJsonStrings(node))
        const bytes = Buffer.byteLength(serialized ?? '', 'utf8')
        if (bytes < minBytes) return
        const row = { path: pathLabel || '$', bytes }
        if (node && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 1 && '$json' in node) {
            row.parsedBytes = Buffer.byteLength(JSON.stringify(collapseJsonStrings(node.$json)), 'utf8')
            row.jsonString = true
            rows.push(row)
            if (depth < maxDepth) walk(node.$json, `${pathLabel}<json>`, depth + 1)
            return
        }
        rows.push(row)
        if (depth >= maxDepth || !node || typeof node !== 'object') return
        if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${pathLabel}[${i}]`, depth + 1))
        else for (const [key, inner] of Object.entries(node)) walk(inner, pathLabel ? `${pathLabel}.${key}` : key, depth + 1)
    }
    walk(value, '', 0)
    return rows
}
