#!/usr/bin/env node
// Regenerates flows/*.json from the node definitions served by a running Flowise (the baseline worktree).
// Usage: node build-flows.mjs [--base-url http://localhost:3100]
import fs from 'fs'
import path from 'path'
import { FlowiseClient, loadCaptureEnv, BASELINES_DIR } from './lib/flowise-client.mjs'
import { FlowBuilder, modelConfig, toolEntry, systemPromptHtml, flowIdPlaceholder } from './lib/flow-builder.mjs'

const NODE_NAMES = [
    'startAgentflow',
    'agentAgentflow',
    'llmAgentflow',
    'conditionAgentAgentflow',
    'conditionAgentflow',
    'customFunctionAgentflow',
    'directReplyAgentflow',
    'executeFlowAgentflow',
    'humanInputAgentflow',
    'iterationAgentflow',
    'loopAgentflow',
    'redirectFlowAgentflow'
]

const COMPANY = 'Northwind Outfitters'

function prompt(scenario, node, role, { header = [], footer = [] } = {}) {
    return systemPromptHtml({
        sentinel: `SYSPROMPT_SENTINEL_${scenario}_${node}`,
        route: `${scenario}-${node}`,
        role,
        header,
        footer
    })
}

const system = (scenario, node, role, extra) => [{ role: 'system', content: prompt(scenario, node, role, extra) }]

const agent = (scenario, node, role, { tools = [], memory = true, memoryType = 'allMessages', extra, ...inputs } = {}) => ({
    agentModel: 'chatOpenAI',
    agentModelConfig: modelConfig('agentModel'),
    agentMessages: system(scenario, node, role, extra),
    agentTools: tools,
    agentEnableMemory: memory,
    agentMemoryType: memoryType,
    agentReturnResponseAs: 'userMessage',
    ...inputs
})

const llm = (scenario, node, role, { memory = true, memoryType = 'allMessages', messages = [], extra, ...inputs } = {}) => ({
    llmModel: 'chatOpenAI',
    llmModelConfig: modelConfig('llmModel'),
    llmMessages: [...system(scenario, node, role, extra), ...messages],
    llmEnableMemory: memory,
    llmMemoryType: memoryType,
    llmReturnResponseAs: 'userMessage',
    ...inputs
})

const conditionAgent = (scenario, node, role, instructions, scenarios) => ({
    conditionAgentModel: 'chatOpenAI',
    conditionAgentModelConfig: modelConfig('conditionAgentModel'),
    conditionAgentInstructions: instructions,
    conditionAgentScenarios: scenarios.map((scenarioName) => ({ scenario: scenarioName })),
    conditionAgentOverrideSystemPrompt: true,
    conditionAgentSystemPrompt: prompt(scenario, node, role, {
        footer: [
            'Answer only with a JSON object in a markdown code block, in the form {"output": "<one of the scenarios, verbatim>"}.'
        ]
    })
})

const FLOWS = {
    'S01-single-agent-memory': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'agentAgentflow',
            'agentAgentflow_0',
            'Support Agent',
            agent('S01', 'agent', `You are the Support Agent for ${COMPANY}. Answer order questions; use the calculator for arithmetic.`, {
                tools: [toolEntry('calculator'), toolEntry('currentDateTime')]
            }),
            { x: 300 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
    },

    'S01r-redirect-mapping': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'redirectFlowAgentflow',
            'redirectFlowAgentflow_0',
            'Redirect to Support',
            { redirectFlowSelectedFlow: flowIdPlaceholder('S01-single-agent-memory') },
            { x: 300 }
        )
        f.connect('startAgentflow_0', 'redirectFlowAgentflow_0')
    },

    'S02-router-mixed-memory': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'conditionAgentAgentflow',
            'conditionAgentAgentflow_0',
            'Router',
            conditionAgent(
                'S02',
                'router',
                `You route ${COMPANY} customer messages to the right team.`,
                'Decide which team should handle the latest customer message.',
                ['billing question', 'technical issue', 'anything else']
            ),
            { x: 300, outputCount: 3 }
        )
        f.add('agentAgentflow', 'agentAgentflow_0', 'Billing Agent', agent('S02', 'billing', `You are the ${COMPANY} billing agent.`), {
            x: 600,
            y: -150
        })
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'Tech Support',
            llm('S02', 'tech', `You are ${COMPANY} technical support. Keep answers short.`, {
                memoryType: 'windowSize',
                llmMemoryWindowSize: 2
            }),
            { x: 600 }
        )
        f.add(
            'directReplyAgentflow',
            'directReplyAgentflow_0',
            'Fallback Reply',
            { directReplyMessage: 'I can help with billing or technical questions. Could you tell me a bit more?' },
            { x: 600, y: 150 }
        )
        f.connect('startAgentflow_0', 'conditionAgentAgentflow_0')
        f.connect('conditionAgentAgentflow_0', 'agentAgentflow_0', { output: 0, label: 'billing question' })
        f.connect('conditionAgentAgentflow_0', 'llmAgentflow_0', { output: 1, label: 'technical issue' })
        f.connect('conditionAgentAgentflow_0', 'directReplyAgentflow_0', { output: 2, label: 'anything else' })
    },

    'S03-parallel-agents-join': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'chatInput',
            startState: [
                { key: 'topic', value: 'warranty claims' },
                { key: 'findings', value: '' }
            ]
        })
        f.add(
            'agentAgentflow',
            'agentAgentflow_0',
            'Researcher',
            agent('S03', 'researcher', `You research ${COMPANY} policies for the composer.`, {
                agentUpdateState: [{ key: 'findings', value: '{{ output }}' }]
            }),
            { x: 300, y: -100 }
        )
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'Critic',
            llm('S03', 'critic', `You critique draft answers for ${COMPANY}.`, {
                memoryType: 'conversationSummaryBuffer',
                llmMemoryMaxTokenLimit: 120,
                extra: { header: ['Conversation so far:', '{{chat_history}}'] }
            }),
            { x: 300, y: 100 }
        )
        f.add(
            'llmAgentflow',
            'llmAgentflow_1',
            'Composer',
            llm('S03', 'composer', `You compose the final ${COMPANY} answer from research and critique.`, {
                llmUserMessage:
                    '<p>Research: {{ agentAgentflow_0 }}</p>\n<p>Critique: {{ llmAgentflow_0 }}</p>\n<p>Topic: {{ $flow.state.topic }}. Findings on record: {{ $flow.state.findings }}</p>'
            }),
            { x: 600 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('startAgentflow_0', 'llmAgentflow_0')
        f.connect('agentAgentflow_0', 'llmAgentflow_1')
        f.connect('llmAgentflow_0', 'llmAgentflow_1')
    },

    'S04a-state-carry-persist-on': (f) => stateCarryFlow(f, 'S04a', true),
    'S04b-state-carry-persist-off': (f) => stateCarryFlow(f, 'S04b', false),

    'S05-form-then-chat': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'formInput',
            formTitle: 'Support request',
            formDescription: 'Tell us who you are and what the request is about',
            formInputTypes: [
                { type: 'string', label: 'Name', name: 'name', addOptions: '' },
                { type: 'options', label: 'Topic', name: 'topic', addOptions: [{ option: 'billing' }, { option: 'shipping' }] }
            ]
        })
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'Form Assistant',
            llm('S05', 'assistant', `You help ${COMPANY} customers after they fill in the support form.`, {
                extra: { header: ['Customer name: {{ $form.name }}. Topic: {{ $form.topic }}.'] }
            }),
            { x: 300 }
        )
        f.connect('startAgentflow_0', 'llmAgentflow_0')
    },

    'S06-human-review-with-feedback': (f) => humanReviewFlow(f, 'S06', true),
    'S06b-human-review-history-off': (f) => humanReviewFlow(f, 'S06b', false),

    'S07-agent-tool-approval': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'agentAgentflow',
            'agentAgentflow_0',
            'Ops Agent',
            agent('S07', 'agent', `You are the ${COMPANY} operations agent. Calculations need a human approval.`, {
                tools: [toolEntry('calculator', true), toolEntry('currentDateTime', false)]
            }),
            { x: 300 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
    },

    'S08-parallel-stops': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'agentAgentflow',
            'agentAgentflow_0',
            'Policy Check',
            agent('S08', 'policy', `You check ${COMPANY} refund requests against policy.`, { tools: [toolEntry('calculator', true)] }),
            { x: 300, y: -100 }
        )
        f.add(
            'humanInputAgentflow',
            'humanInputAgentflow_0',
            'Manager Gate',
            {
                humanInputDescriptionType: 'fixed',
                humanInputDescription: 'Manager approval is required for this refund.',
                humanInputAcceptLabelText: 'Approve refund',
                humanInputRejectLabelText: 'Deny refund',
                humanInputHistoryToggle: true,
                humanInputEnableFeedback: true
            },
            { x: 300, y: 100 }
        )
        f.add('llmAgentflow', 'llmAgentflow_0', 'Summary', llm('S08', 'summary', `You summarise the ${COMPANY} refund decision.`), {
            x: 600
        })
        f.add(
            'directReplyAgentflow',
            'directReplyAgentflow_0',
            'Rejected Reply',
            { directReplyMessage: 'The manager denied this refund request.' },
            { x: 600, y: 200 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('startAgentflow_0', 'humanInputAgentflow_0')
        f.connect('agentAgentflow_0', 'llmAgentflow_0')
        f.connect('humanInputAgentflow_0', 'llmAgentflow_0', { output: 0, label: 'proceed' })
        f.connect('humanInputAgentflow_0', 'directReplyAgentflow_0', { output: 1, label: 'reject' })
    },

    'S09-iteration-and-loop': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'customFunctionAgentflow',
            'customFunctionAgentflow_0',
            'Split Items',
            { customFunctionJavascriptFunction: 'return JSON.stringify(["invoice", "shipping", "returns"]);' },
            { x: 250 }
        )
        f.add('iterationAgentflow', 'iterationAgentflow_0', 'For Each Item', { iterationInput: '{{ customFunctionAgentflow_0 }}' }, { x: 500 })
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'Item Analyst',
            llm('S09', 'item', `You analyse one ${COMPANY} case item at a time.`, {
                memory: false,
                messages: [{ role: 'user', content: '<p>Analyse the item: {{ $iteration }}</p>' }]
            }),
            { x: 40, y: 80, parentNode: 'iterationAgentflow_0' }
        )
        f.add(
            'agentAgentflow',
            'agentAgentflow_0',
            'Aggregator',
            agent('S09', 'aggregator', `You merge per-item analyses into one ${COMPANY} answer.`, {
                agentUserMessage: '<p>Item analyses:</p>\n<p>{{ iterationAgentflow_0 }}</p>'
            }),
            { x: 1050 }
        )
        f.add(
            'conditionAgentAgentflow',
            'conditionAgentAgentflow_0',
            'Quality Check',
            conditionAgent(
                'S09',
                'quality',
                `You decide whether a ${COMPANY} answer needs another pass.`,
                'Check whether the aggregated answer is complete.',
                ['needs another pass', 'complete']
            ),
            { x: 1300, outputCount: 2 }
        )
        f.add(
            'loopAgentflow',
            'loopAgentflow_0',
            'Retry Loop',
            { loopBackToNode: 'agentAgentflow_0-Aggregator', maxLoopCount: 2, fallbackMessage: 'Stopped: the review loop reached its maximum count.' },
            { x: 1550, y: -80 }
        )
        f.add(
            'directReplyAgentflow',
            'directReplyAgentflow_0',
            'Final Reply',
            { directReplyMessage: '<p>Analysis complete: {{ agentAgentflow_0 }}</p>' },
            { x: 1550, y: 80 }
        )
        f.connect('startAgentflow_0', 'customFunctionAgentflow_0')
        f.connect('customFunctionAgentflow_0', 'iterationAgentflow_0')
        f.connect('iterationAgentflow_0', 'agentAgentflow_0')
        f.connect('agentAgentflow_0', 'conditionAgentAgentflow_0')
        f.connect('conditionAgentAgentflow_0', 'loopAgentflow_0', { output: 0, label: 'needs another pass' })
        f.connect('conditionAgentAgentflow_0', 'directReplyAgentflow_0', { output: 1, label: 'complete' })
    },

    'S10a-client-history-field': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'Quick Answer',
            llm('S10a', 'quick', `You give a one-line ${COMPANY} answer.`, { memory: false }),
            { x: 300, y: -100 }
        )
        f.add('agentAgentflow', 'agentAgentflow_0', 'Context Agent', agent('S10a', 'context', `You answer with full ${COMPANY} context.`), {
            x: 300,
            y: 100
        })
        f.add(
            'llmAgentflow',
            'llmAgentflow_1',
            'Joiner',
            llm('S10a', 'joiner', `You merge two ${COMPANY} answers into one.`, {
                memory: false,
                messages: [{ role: 'user', content: '<p>Quick answer: {{ llmAgentflow_0 }}</p>\n<p>Context answer: {{ agentAgentflow_0 }}</p>' }]
            }),
            { x: 600 }
        )
        f.connect('startAgentflow_0', 'llmAgentflow_0')
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('llmAgentflow_0', 'llmAgentflow_1')
        f.connect('agentAgentflow_0', 'llmAgentflow_1')
        return { apiConfig: { overrideConfig: { status: true, nodes: { 'Quick Answer': [{ name: 'llmMessages', enabled: true }] }, variables: [] } } }
    },

    'S10b-ephemeral-with-state': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'chatInput',
            startEphemeralMemory: true,
            startPersistState: true,
            startState: [{ key: 'counter', value: '0' }]
        })
        f.add('agentAgentflow', 'agentAgentflow_0', 'Ephemeral Agent', agent('S10b', 'agent', `You are a stateless ${COMPANY} helper.`), {
            x: 300
        })
        f.add(
            'customFunctionAgentflow',
            'customFunctionAgentflow_0',
            'Counter',
            {
                customFunctionJavascriptFunction: 'return String(Number($flow.state.counter || 0) + 1);',
                customFunctionUpdateState: [{ key: 'counter', value: '{{ output }}' }]
            },
            { x: 600 }
        )
        f.add(
            'directReplyAgentflow',
            'directReplyAgentflow_0',
            'Reply',
            { directReplyMessage: '<p>{{ agentAgentflow_0 }}</p>\n<p>(turn counter {{ $flow.state.counter }})</p>' },
            { x: 900 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('agentAgentflow_0', 'customFunctionAgentflow_0')
        f.connect('customFunctionAgentflow_0', 'directReplyAgentflow_0')
    },

    'S11-error-and-recovery': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'chatInput',
            startPersistState: true,
            startState: [{ key: 'b_note', value: '' }]
        })
        f.add('agentAgentflow', 'agentAgentflow_0', 'Agent A', agent('S11', 'agentA', `You draft the main ${COMPANY} answer.`), {
            x: 300,
            y: -100
        })
        f.add(
            'llmAgentflow',
            'llmAgentflow_0',
            'LLM B',
            llm('S11', 'llmB', `You write a short ${COMPANY} side note.`, { llmUpdateState: [{ key: 'b_note', value: '{{ output }}' }] }),
            { x: 300, y: 100 }
        )
        f.add(
            'llmAgentflow',
            'llmAgentflow_1',
            'Joiner',
            llm('S11', 'joiner', `You merge the ${COMPANY} answer and side note.`, {
                memory: false,
                messages: [{ role: 'user', content: '<p>Answer: {{ agentAgentflow_0 }}</p>\n<p>Side note: {{ llmAgentflow_0 }}</p>' }]
            }),
            { x: 600 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('startAgentflow_0', 'llmAgentflow_0')
        f.connect('agentAgentflow_0', 'llmAgentflow_1')
        f.connect('llmAgentflow_0', 'llmAgentflow_1')
    },

    'S12-child-flow': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'chatInput',
            startPersistState: true,
            startState: [{ key: 'child_count', value: '0' }]
        })
        f.add(
            'customFunctionAgentflow',
            'customFunctionAgentflow_0',
            'Child Counter',
            {
                customFunctionJavascriptFunction: 'return String(Number($flow.state.child_count || 0) + 1);',
                customFunctionUpdateState: [{ key: 'child_count', value: '{{ output }}' }]
            },
            { x: 300 }
        )
        f.add('agentAgentflow', 'agentAgentflow_0', 'Specialist', agent('S12', 'specialist', `You are the ${COMPANY} returns specialist.`), {
            x: 600
        })
        f.connect('startAgentflow_0', 'customFunctionAgentflow_0')
        f.connect('customFunctionAgentflow_0', 'agentAgentflow_0')
    },

    'S12-execute-flow-child-memory': (f) => {
        f.add('startAgentflow', 'startAgentflow_0', 'Start', {
            startInputType: 'chatInput',
            startState: [{ key: 'child_count', value: '0' }]
        })
        f.add('agentAgentflow', 'agentAgentflow_0', 'Parent Agent', agent('S12', 'parent', `You are the ${COMPANY} front desk.`), {
            x: 300
        })
        f.add(
            'executeFlowAgentflow',
            'executeFlowAgentflow_0',
            'Ask Specialist',
            {
                executeFlowSelectedFlow: flowIdPlaceholder('S12-child-flow'),
                executeFlowInput: '<p>{{ question }}</p>',
                executeFlowReturnResponseAs: 'userMessage',
                executeFlowMergeState: [{ variable: 'child_count' }]
            },
            { x: 600 }
        )
        f.add(
            'directReplyAgentflow',
            'directReplyAgentflow_0',
            'Reply',
            {
                directReplyMessage:
                    '<p>{{ agentAgentflow_0 }}</p>\n<p>Specialist: {{ executeFlowAgentflow_0 }} (specialist turn {{ $flow.state.child_count }})</p>'
            },
            { x: 900 }
        )
        f.connect('startAgentflow_0', 'agentAgentflow_0')
        f.connect('agentAgentflow_0', 'executeFlowAgentflow_0')
        f.connect('executeFlowAgentflow_0', 'directReplyAgentflow_0')
    }
}

function stateCarryFlow(f, scenario, persist) {
    f.add('startAgentflow', 'startAgentflow_0', 'Start', {
        startInputType: 'chatInput',
        startPersistState: persist,
        startState: [
            { key: 'stage', value: 'new' },
            { key: 'count', value: '0' }
        ]
    })
    f.add(
        'customFunctionAgentflow',
        'customFunctionAgentflow_0',
        'Count Turns',
        {
            customFunctionJavascriptFunction: 'return String(Number($flow.state.count || 0) + 1);',
            customFunctionUpdateState: [{ key: 'count', value: '{{ output }}' }]
        },
        { x: 250 }
    )
    f.add(
        'conditionAgentflow',
        'conditionAgentflow_0',
        'Stage Check',
        { conditions: [{ type: 'string', value1: '<p>{{ $flow.state.stage }}</p>', operation: 'equal', value2: '<p>new</p>' }] },
        { x: 500, outputCount: 2 }
    )
    f.add(
        'agentAgentflow',
        'agentAgentflow_0',
        'Intake Agent',
        agent(scenario, 'intake', `You run the ${COMPANY} intake interview.`, {
            agentUpdateState: [{ key: 'stage', value: 'qualified' }]
        }),
        { x: 750, y: -80 }
    )
    f.add('llmAgentflow', 'llmAgentflow_0', 'Follow Up', llm(scenario, 'followup', `You handle ${COMPANY} follow-up questions.`), {
        x: 750,
        y: 80
    })
    f.connect('startAgentflow_0', 'customFunctionAgentflow_0')
    f.connect('customFunctionAgentflow_0', 'conditionAgentflow_0')
    f.connect('conditionAgentflow_0', 'agentAgentflow_0', { output: 0, label: 'stage is new' })
    f.connect('conditionAgentflow_0', 'llmAgentflow_0', { output: 1, label: 'else' })
    return { apiConfig: { overrideConfig: { status: true, nodes: { Start: [{ name: 'startState', enabled: true }] }, variables: [] } } }
}

function humanReviewFlow(f, scenario, historyToggle) {
    f.add('startAgentflow', 'startAgentflow_0', 'Start', { startInputType: 'chatInput' })
    f.add('agentAgentflow', 'agentAgentflow_0', 'Drafter', agent(scenario, 'drafter', `You draft ${COMPANY} customer replies for review.`), {
        x: 300,
        y: -80
    })
    f.add(
        'directReplyAgentflow',
        'directReplyAgentflow_0',
        'Companion',
        { directReplyMessage: 'A reviewer will check the draft before it goes out.' },
        { x: 300, y: 120 }
    )
    f.add(
        'humanInputAgentflow',
        'humanInputAgentflow_0',
        'Review Gate',
        {
            humanInputDescriptionType: 'fixed',
            humanInputDescription: 'Approve this draft?',
            humanInputAcceptLabelText: 'Approve',
            humanInputRejectLabelText: 'Request changes',
            humanInputHistoryToggle: historyToggle,
            humanInputEnableFeedback: true
        },
        { x: 600, y: -80 }
    )
    f.add('llmAgentflow', 'llmAgentflow_0', 'Finalizer', llm(scenario, 'finalizer', `You polish approved ${COMPANY} drafts.`), {
        x: 900,
        y: -160
    })
    f.add('loopAgentflow', 'loopAgentflow_0', 'Revise Loop', { loopBackToNode: 'agentAgentflow_0-Drafter', maxLoopCount: 2 }, { x: 900, y: 0 })
    f.connect('startAgentflow_0', 'agentAgentflow_0')
    f.connect('startAgentflow_0', 'directReplyAgentflow_0')
    f.connect('agentAgentflow_0', 'humanInputAgentflow_0')
    f.connect('humanInputAgentflow_0', 'llmAgentflow_0', { output: 0, label: 'proceed' })
    f.connect('humanInputAgentflow_0', 'loopAgentflow_0', { output: 1, label: 'reject' })
}

async function main() {
    const args = process.argv.slice(2)
    const env = loadCaptureEnv()
    const baseUrl = args.includes('--base-url') ? args[args.indexOf('--base-url') + 1] : env.FLOWISE_BASE_URL
    const client = new FlowiseClient(baseUrl)
    await client.login(env.FLOWISE_EMAIL, env.FLOWISE_PASSWORD)
    const defs = {}
    for (const name of NODE_NAMES) defs[name] = await client.api(`/api/v1/nodes/${name}`)

    const outDir = path.join(BASELINES_DIR, 'flows')
    fs.mkdirSync(outDir, { recursive: true })
    for (const [slug, build] of Object.entries(FLOWS)) {
        const builder = new FlowBuilder(defs)
        const chatflowSettings = build(builder) ?? {}
        const json = builder.toJSON(Object.keys(chatflowSettings).length ? { chatflowSettings } : {})
        fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(json, null, 2) + '\n')
        const bytes = Buffer.byteLength(JSON.stringify(json))
        console.log(`${slug}: ${builder.nodes.length} nodes, ${builder.edges.length} edges, ${(bytes / 1024).toFixed(1)} KiB`)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
