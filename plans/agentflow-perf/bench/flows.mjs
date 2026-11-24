import { FlowBuilder } from '../../agentflow-trusted-state/baselines/lib/flow-builder.mjs'

export const NODE_NAMES = ['startAgentflow', 'directReplyAgentflow', 'conditionAgentflow', 'customFunctionAgentflow']

const start = (f) => f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
const reply = (f, id, label, message) => f.add('directReplyAgentflow', id, label, { directReplyMessage: message })
const fn = (f, i, code) =>
    f.add('customFunctionAgentflow', `customFunctionAgentflow_${i}`, `Function ${i}`, {
        customFunctionInputVariables: [],
        customFunctionJavascriptFunction: code,
        customFunctionUpdateState: []
    })
const cond = (f, i, value1, operation, value2) =>
    f.add('conditionAgentflow', `conditionAgentflow_${i}`, `Condition ${i}`, {
        conditions: [{ type: 'string', value1, operation, value2 }]
    })

// Start → Direct Reply
export function directFlow(defs) {
    const f = new FlowBuilder(defs)
    start(f)
    reply(f, 'directReplyAgentflow_0', 'Fixed Answer', 'Thanks, we received your message.')
    f.connect('startAgentflow_0', 'directReplyAgentflow_0')
    return f
}

// 150 nodes, every node runs: Start → (Function i → Condition i on the function's output) × 74 → Direct Reply
export function chain150(defs) {
    const f = new FlowBuilder(defs)
    start(f)
    let prev = 'startAgentflow_0'
    let prevOutput
    for (let i = 0; i < 74; i++) {
        fn(f, i, `return 'step ${i}';`)
        f.connect(prev, `customFunctionAgentflow_${i}`, prevOutput === undefined ? {} : { output: prevOutput })
        cond(f, i, `{{ customFunctionAgentflow_${i} }}`, 'equal', `step ${i}`)
        f.connect(`customFunctionAgentflow_${i}`, `conditionAgentflow_${i}`)
        prev = `conditionAgentflow_${i}`
        prevOutput = 0
    }
    reply(f, 'directReplyAgentflow_0', 'Fixed Answer', 'Thanks, we received your message.')
    f.connect(prev, 'directReplyAgentflow_0', { output: 0 })
    return f
}

// 150 nodes, every node runs, no functions: Start → Condition × 148 → Direct Reply
export function conditions150(defs) {
    const f = new FlowBuilder(defs)
    start(f)
    let prev = 'startAgentflow_0'
    let prevOutput
    for (let i = 0; i < 148; i++) {
        cond(f, i, '{{ question }}', 'contains', 'hello')
        f.connect(prev, `conditionAgentflow_${i}`, prevOutput === undefined ? {} : { output: prevOutput })
        prev = `conditionAgentflow_${i}`
        prevOutput = 0
    }
    reply(f, 'directReplyAgentflow_0', 'Fixed Answer', 'Thanks, we received your message.')
    f.connect(prev, 'directReplyAgentflow_0', { output: 0 })
    return f
}

// 150 nodes, 3 run: Start → Condition (never true) → 147-node Function/Condition branch; else → Direct Reply
export function skip150(defs) {
    const f = new FlowBuilder(defs)
    start(f)
    cond(f, 'gate', '{{ question }}', 'contains', 'never-matches-zzz')
    f.connect('startAgentflow_0', 'conditionAgentflow_gate')
    reply(f, 'directReplyAgentflow_0', 'Fixed Answer', 'Thanks, we received your message.')
    f.connect('conditionAgentflow_gate', 'directReplyAgentflow_0', { output: 1 })
    let prev = 'conditionAgentflow_gate'
    let prevOutput = 0
    let n = 3
    for (let i = 0; n < 150; i++) {
        fn(f, i, `return 'step ${i}';`)
        f.connect(prev, `customFunctionAgentflow_${i}`, { output: prevOutput })
        n++
        prev = `customFunctionAgentflow_${i}`
        prevOutput = undefined
        if (n >= 150) break
        cond(f, i, `{{ customFunctionAgentflow_${i} }}`, 'equal', `step ${i}`)
        f.connect(prev, `conditionAgentflow_${i}`)
        n++
        prev = `conditionAgentflow_${i}`
        prevOutput = 0
    }
    return f
}

export const FLOWS = { direct: directFlow, chain150, conditions150, skip150 }
