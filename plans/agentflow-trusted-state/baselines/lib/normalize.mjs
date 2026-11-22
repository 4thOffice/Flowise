// Stabilises run-specific values for comparison. Traces keep the raw values; only compare-traces.mjs uses this.
import { inflate, makeBlobReader } from './trace-store.mjs'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const CHAT_ID_RE = /ts00b-[a-z0-9]+-M[0-9](?:-[a-z]+)?-S[0-9]+[a-z]?/g
const MOCK_EXECUTION_RE = /mock-\d{10,}-[a-z0-9]+/g
const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g
const SQL_DATETIME_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?/g
const CURRENT_DATE_TIME_RE = /\{"date":"[^"]*","time":"[^"]*","day":"[^"]*","timezone":"[^"]*","timezoneOffset":"[^"]*","iso8601":"[^"]*","unix_timestamp":\d+\}/g

const VOLATILE_KEYS = new Set([
    'timeMetadata',
    'durationMs',
    'offsetMs',
    'createdDate',
    'updatedDate',
    'stoppedDate',
    'capturedAt',
    'seq',
    'sha256',
    'runTag'
])

export function normalizeString(text) {
    return text
        .replace(CURRENT_DATE_TIME_RE, '<current_date_time output>')
        .replace(CHAT_ID_RE, '<chatId>')
        .replace(MOCK_EXECUTION_RE, '<mock-execution-id>')
        .replace(UUID_RE, '<uuid>')
        .replace(ISO_DATETIME_RE, '<iso-datetime>')
        .replace(SQL_DATETIME_RE, '<datetime>')
}

export function normalizeValue(value) {
    if (typeof value === 'string') return normalizeString(value)
    if (Array.isArray(value)) return value.map(normalizeValue)
    if (value && typeof value === 'object') {
        if ('iso8601' in value && 'unix_timestamp' in value) return '<current_date_time output>'
        const out = {}
        for (const key of Object.keys(value).sort()) {
            if (VOLATILE_KEYS.has(key)) continue
            out[key] = normalizeValue(value[key])
        }
        return out
    }
    return value
}

// Trace values with blob refs resolved and nested JSON strings parsed, ready for normalizeValue().
export function traceReader(traceRootDir) {
    const readBlob = makeBlobReader(traceRootDir)
    const parseJsonStrings = (value) => {
        if (Array.isArray(value)) return value.map(parseJsonStrings)
        if (value && typeof value === 'object') {
            if (Object.keys(value).length === 1 && '$json' in value) return parseJsonStrings(value.$json)
            if (typeof value.$blob === 'string') return parseJsonStrings(tryParse(readBlob(value)))
            const out = {}
            for (const [key, inner] of Object.entries(value)) out[key] = parseJsonStrings(inner)
            return out
        }
        return value
    }
    return {
        resolve: parseJsonStrings,
        exact: (value) => inflate(value, readBlob)
    }
}

function tryParse(text) {
    if (typeof text !== 'string' || (text[0] !== '{' && text[0] !== '[')) return text
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}
