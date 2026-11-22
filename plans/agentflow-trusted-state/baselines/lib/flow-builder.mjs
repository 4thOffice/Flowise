// Builds importable Agentflow V2 canvas JSON from the server's node definitions, the same way the UI's
// initNode() does, so flows can be loaded in the canvas as well as seeded through the API.
import crypto from 'crypto'

export const CREDENTIAL_PLACEHOLDER = '{{TS00B_CREDENTIAL_ID}}'
export const flowIdPlaceholder = (flowSlug) => `{{TS00B_FLOW_ID:${flowSlug}}}`

const PARAM_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs',
    'conditionFunction'
])

const clone = (value) => JSON.parse(JSON.stringify(value))

export function modelConfig(modelField) {
    return {
        credential: CREDENTIAL_PLACEHOLDER,
        cache: '',
        modelName: 'fake-model',
        temperature: 0.9,
        streaming: true,
        maxTokens: '',
        topP: '',
        frequencyPenalty: '',
        presencePenalty: '',
        timeout: '',
        dontSetStoreParam: '',
        strictToolCalling: '',
        stopSequence: '',
        basepath: '',
        proxyUrl: '',
        baseOptions: '',
        allowImageUploads: '',
        imageResolution: 'low',
        reasoning: '',
        reasoningEffort: '',
        reasoningSummary: '',
        [modelField]: 'chatOpenAI',
        FLOWISE_CREDENTIAL_ID: CREDENTIAL_PLACEHOLDER
    }
}

export function toolEntry(toolName, requiresHumanInput = false) {
    return {
        agentSelectedTool: toolName,
        agentSelectedToolRequiresHumanInput: requiresHumanInput,
        agentSelectedToolConfig: { agentSelectedTool: toolName }
    }
}

export class FlowBuilder {
    constructor(defs) {
        this.defs = defs
        this.nodes = []
        this.edges = []
    }

    add(name, id, label, inputs = {}, { x = 0, y = 0, parentNode, outputCount, width, height } = {}) {
        const def = this.defs[name]
        if (!def) throw new Error(`No node definition for ${name}`)
        const inputParams = []
        const inputAnchors = []
        for (const param of def.inputs ?? []) {
            const withId = { ...clone(param), id: `${id}-input-${param.name}-${param.type}` }
            if (PARAM_TYPES.has(param.type)) inputParams.push(withId)
            else inputAnchors.push(withId)
        }
        if (def.credential) inputParams.unshift({ ...clone(def.credential), id: `${id}-input-${def.credential.name}-${def.credential.type}` })

        const defaults = {}
        for (const param of def.inputs ?? []) defaults[param.name] = param.default ?? ''
        for (const key of Object.keys(inputs)) {
            if (!(key in defaults) && !key.endsWith('Config') && key !== 'humanInput') {
                throw new Error(`${id}: unknown input ${key} for ${name}`)
            }
        }

        let outputAnchors = []
        if (!def.hideOutput) {
            const count = outputCount ?? (def.outputs?.length || 0)
            outputAnchors = count
                ? Array.from({ length: count }, (_, i) => ({ id: `${id}-output-${i}`, label: def.label, name: def.name }))
                : [{ id: `${id}-output-${def.name}`, label: def.label, name: def.name }]
        }

        const node = {
            id,
            type: name === 'iterationAgentflow' ? 'iteration' : 'agentFlow',
            position: { x, y },
            positionAbsolute: { x, y },
            width: width ?? (name === 'iterationAgentflow' ? 480 : 200),
            height: height ?? (name === 'iterationAgentflow' ? 260 : 72),
            selected: false,
            dragging: false,
            data: {
                id,
                label,
                version: def.version,
                name: def.name,
                type: def.type,
                color: def.color,
                ...(def.hideInput ? { hideInput: true } : {}),
                ...(def.hideOutput ? { hideOutput: true } : {}),
                baseClasses: def.baseClasses,
                category: def.category,
                description: def.description,
                inputParams,
                inputAnchors,
                inputs: { ...defaults, ...clone(inputs) },
                outputAnchors,
                outputs: {},
                selected: false
            }
        }
        if (name === 'iterationAgentflow') node.style = { width: node.width, height: node.height }
        if (parentNode) {
            node.parentNode = parentNode
            node.extent = 'parent'
        }
        this.nodes.push(node)
        return node
    }

    connect(source, target, { output, label } = {}) {
        const sourceNode = this.nodes.find((n) => n.id === source)
        const targetNode = this.nodes.find((n) => n.id === target)
        if (!sourceNode || !targetNode) throw new Error(`connect: unknown node ${source} or ${target}`)
        const sourceHandle = output === undefined ? `${source}-output-${sourceNode.data.name}` : `${source}-output-${output}`
        if (!sourceNode.data.outputAnchors.some((anchor) => anchor.id === sourceHandle)) {
            throw new Error(`connect: ${source} has no output ${sourceHandle}`)
        }
        const edge = {
            source,
            sourceHandle,
            target,
            targetHandle: target,
            data: {
                sourceColor: sourceNode.data.color,
                targetColor: targetNode.data.color,
                ...(label ? { edgeLabel: label } : {}),
                isHumanInput: sourceNode.data.name === 'humanInputAgentflow'
            },
            type: 'agentFlow',
            id: `${source}-${sourceHandle}-${target}-${target}`
        }
        this.edges.push(edge)
        return edge
    }

    toJSON(extra = {}) {
        return { nodes: this.nodes, edges: this.edges, viewport: { x: 0, y: 0, zoom: 0.8 }, ...extra }
    }
}

// Deterministic, natural-looking filler so gzip sees ordinary prose rather than a repeated block.
function prng(seedText) {
    let seed = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0)
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const SUBJECTS = [
    'the agent', 'a customer', 'the account owner', 'the duty manager', 'the billing team', 'a reviewer', 'the warehouse',
    'the carrier', 'the support lead', 'the finance desk', 'a regional partner', 'the returns clerk', 'the night shift',
    'a premium member', 'the fraud desk', 'the store manager', 'a first-time buyer', 'the logistics planner', 'the auditor',
    'a corporate client', 'the quality team', 'the courier hub', 'a marketplace seller', 'the legal contact'
]
const VERBS = [
    'must confirm', 'should verify', 'may request', 'needs to record', 'is expected to explain', 'will escalate', 'can offer',
    'has to document', 'should never promise', 'must double-check', 'is allowed to waive', 'ought to summarise',
    'cannot change', 'should restate', 'needs approval to adjust', 'must attach', 'may postpone', 'has to reconcile',
    'should look up', 'is required to cancel', 'can split', 'must not disclose'
]
const OBJECTS = [
    'the order reference', 'the refund amount', 'the delivery window', 'the warranty status', 'the invoice date',
    'the replacement part', 'the shipping address', 'the loyalty balance', 'the return label', 'the service level',
    'the gift card code', 'the customs declaration', 'the tracking history', 'the store credit', 'the restocking fee',
    'the payment authorisation', 'the bundle discount', 'the size exchange', 'the pickup slot', 'the damage photos',
    'the subscription renewal', 'the tax receipt', 'the price match', 'the backorder estimate'
]
const QUALIFIERS = [
    'before closing the case', 'within one business day', 'unless a supervisor approves otherwise', 'when the customer asks twice',
    'for orders above the regional threshold', 'after checking the latest note', 'in the language the customer used',
    'without sharing internal codes', 'if the payment is still pending', 'once the identity check passes',
    'during the holiday peak', 'for marketplace orders only', 'when the parcel is marked lost', 'after the carrier scan',
    'if the item was opened', 'for business accounts', 'when a voucher was applied', 'before the cut-off at noon',
    'whenever stock is reserved', 'if the address is outside the zone'
]
const TOPICS = [
    'Refunds', 'Shipping', 'Warranty', 'Invoices', 'Returns', 'Escalations', 'Loyalty', 'Privacy', 'Tone of voice',
    'Payments', 'Subscriptions', 'Accessibility', 'Fraud', 'Customs', 'Vouchers', 'Pickups', 'Repairs', 'Exchanges'
]
const REGIONS = ['EU-West', 'EU-North', 'UK', 'US-East', 'US-West', 'APAC', 'LATAM', 'Nordics', 'Iberia', 'Benelux']
const ADJECTIVES = (
    'open pending urgent partial late early damaged missing duplicate verified expired annual monthly weekly signed unsigned ' +
    'manual automatic external internal regional local domestic foreign bulky fragile seasonal refurbished sealed unsealed ' +
    'priority standard express economy flagged cleared disputed confirmed reserved archived recent previous upcoming written'
).split(' ')
const NOUNS = (
    'receipt invoice parcel label voucher ledger timestamp courier address postcode carton pallet barcode signature photo ' +
    'serial warranty claim ticket note fee surcharge discount credit balance refund chargeback mandate consent profile ' +
    'contract quote estimate slot window depot locker route manifest declaration permit inspection repair part battery ' +
    'charger cable strap buckle zipper seam sole lining hood sleeve collar pocket button'
).split(' ')

export function systemPromptHtml({ sentinel, route, role, header = [], footer = [], targetBytes = 40960 }) {
    const rand = prng(sentinel)
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const digits = (n) => String(Math.floor(rand() * 10 ** n)).padStart(n, '0')
    const paragraphs = [`<p>[[route:${route}]] ${sentinel}</p>`, `<p>${role}</p>`, ...header.map((line) => `<p>${line}</p>`)]
    const tail = footer.map((line) => `<p>${line}</p>`)
    let size = Buffer.byteLength(paragraphs.join('\n') + tail.join('\n'))
    let section = 1
    while (size < targetBytes) {
        const sentences = []
        const count = 3 + Math.floor(rand() * 4)
        for (let i = 0; i < count; i++) {
            const extras = [
                `case NW-${digits(5)}`,
                `limit ${digits(3)}.${digits(2)} EUR`,
                `${1 + Math.floor(rand() * 45)} days`,
                `region ${pick(REGIONS)}`,
                `SKU ${digits(2)}-${digits(4)}`,
                `${Math.floor(rand() * 60)}% of the value`
            ]
            const detail = Array.from({ length: 3 + Math.floor(rand() * 5) }, () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`).join(', ')
            sentences.push(
                `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(QUALIFIERS)} (${pick(extras)}, ${pick(extras)}); check ${detail}.`
            )
        }
        const paragraph = `<p>Section ${section} - ${pick(TOPICS)} for ${pick(REGIONS)}. ${sentences
            .map((sentence) => sentence[0].toUpperCase() + sentence.slice(1))
            .join(' ')}</p>`
        paragraphs.push(paragraph)
        size += Buffer.byteLength(paragraph) + 1
        section += 1
    }
    return [...paragraphs, ...tail].join('\n')
}

export function deterministicUuid(text) {
    const hex = crypto.createHash('sha256').update(text).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
