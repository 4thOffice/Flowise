jest.mock('../../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

import validationService from '../../../src/services/validation'
import { validateAgentflowConcurrency } from '../../../src/services/validation/agentflowConcurrencyValidation'
import { getRunningExpressApp } from '../../../src/utils/getRunningExpressApp'
import { createEdge, createFlow, createNode, loadBaselineFlow } from './testHelpers'

const mockedGetRunningExpressApp = getRunningExpressApp as jest.MockedFunction<typeof getRunningExpressApp>

function withExecutionOrder(node: ReturnType<typeof createNode>, executionOrder: number) {
    return {
        ...node,
        data: {
            ...node.data,
            executionOrder
        }
    }
}

describe('Agentflow V2 Concurrency Validation (Task 08)', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    describe('Check 1: Unlinked Variable References', () => {
        it('warns when a node references parallel sibling outputs ({{id}}, {{id.output.*}}, escaped underscores) and deduplicates per source', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const siblingA = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', { label: 'Sibling A' })
            const siblingB = createNode('httpAgentflow_0', 'httpAgentflow', { label: 'HTTP B' })
            const consumer = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'Reply Consumer',
                inputs: {
                    directReplyMessage:
                        '{{customFunctionAgentflow_0}} and {{customFunctionAgentflow\\_0.output.content}} and {{httpAgentflow_0.output.http.data}}'
                }
            })

            const results = validateAgentflowConcurrency(
                [start, siblingA, siblingB, consumer],
                [
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                    createEdge('startAgentflow_0', 'httpAgentflow_0'),
                    createEdge('startAgentflow_0', 'directReplyAgentflow_0')
                ]
            )

            const consumerResult = results.find((r) => r.id === 'directReplyAgentflow_0')
            expect(consumerResult).toBeDefined()
            expect(consumerResult!.issues).toHaveLength(2)
            expect(consumerResult!.issues[0]).toContain("References output from 'Sibling A' (customFunctionAgentflow_0)")
            expect(consumerResult!.issues[1]).toContain("References output from 'HTTP B' (httpAgentflow_0)")
        })

        it('detects unlinked references inside nested inputs (conditions, llmMessages, customFunctionInputVariables, UpdateState, *Config)', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const sibling = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', { label: 'Worker' })
            const cond = createNode('conditionAgentflow_0', 'conditionAgentflow', {
                label: 'Cond',
                inputs: {
                    conditions: [
                        { type: 'string', value1: '{{customFunctionAgentflow_0.output.content}}', operation: 'equal', value2: 'ok' }
                    ]
                }
            })
            const llm = createNode('llmAgentflow_0', 'llmAgentflow', {
                label: 'LLM',
                inputs: {
                    llmMessages: [{ role: 'user', content: '{{customFunctionAgentflow_0}}' }],
                    llmModel: 'chatOpenAI',
                    llmModelConfig: { systemMessage: '{{customFunctionAgentflow_0.output.text}}' },
                    llmUpdateState: [{ key: 'k', value: '{{customFunctionAgentflow_0}}' }]
                }
            })
            const fn = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'Fn',
                inputs: {
                    customFunctionInputVariables: [{ variableName: 'v', variableValue: '{{customFunctionAgentflow_0}}' }]
                }
            })

            const results = validateAgentflowConcurrency(
                [start, sibling, cond, llm, fn],
                [
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                    createEdge('startAgentflow_0', 'conditionAgentflow_0'),
                    createEdge('startAgentflow_0', 'llmAgentflow_0'),
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_1')
                ]
            )

            for (const id of ['conditionAgentflow_0', 'llmAgentflow_0', 'customFunctionAgentflow_1']) {
                const entry = results.find((r) => r.id === id)
                expect(entry).toBeDefined()
                expect(entry!.issues).toHaveLength(1)
                expect(entry!.issues[0]).toContain("References output from 'Worker' (customFunctionAgentflow_0)")
            }
        })

        it('warns on downstream/reverse references and self-references', () => {
            const nodeA = createNode('llmAgentflow_0', 'llmAgentflow', {
                label: 'Node A',
                inputs: {
                    llmUserMessage: 'Self={{llmAgentflow_0}} Downstream={{directReplyAgentflow_0.output.content}}'
                }
            })
            const nodeB = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'Node B'
            })

            const results = validateAgentflowConcurrency([nodeA, nodeB], [createEdge('llmAgentflow_0', 'directReplyAgentflow_0')])
            const resultA = results.find((r) => r.id === 'llmAgentflow_0')
            expect(resultA).toBeDefined()
            expect(resultA!.issues).toHaveLength(2)
            expect(resultA!.issues.some((i) => i.includes('(llmAgentflow_0)'))).toBe(true)
            expect(resultA!.issues.some((i) => i.includes('(directReplyAgentflow_0)'))).toBe(true)
        })

        it('produces zero warnings for valid upstream ancestors, iteration ancestors, built-in templates, unknown placeholders, and sticky notes', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const upstream = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', { label: 'Upstream' })
            const mid = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'Mid',
                inputs: {
                    customFunctionInputVariables: [{ variableName: 'a', variableValue: '{{customFunctionAgentflow_0.output.content}}' }]
                }
            })
            const iteration = createNode('iterationAgentflow_0', 'iterationAgentflow', { label: 'Iter' })
            const iterChild = createNode('customFunctionAgentflow_2', 'customFunctionAgentflow', {
                label: 'Iter Child',
                parentNode: 'iterationAgentflow_0',
                extent: 'parent',
                inputs: {
                    customFunctionJavascriptFunction: 'return "{{customFunctionAgentflow_0}} {{$iteration.name}}";'
                }
            })
            const sticky = createNode('stickyNoteAgentflow_0', 'stickyNoteAgentflow', {
                label: 'Note',
                inputs: { note: '{{directReplyAgentflow_0}}' }
            })
            const reply = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'Final',
                inputs: {
                    directReplyMessage: [
                        '{{customFunctionAgentflow_0}}',
                        '{{customFunctionAgentflow_1.output.content}}',
                        '{{question}}',
                        '{{$vars.API_KEY}}',
                        '{{$flow.state.foo}}',
                        '{{$form.email}}',
                        '{{$iteration}}',
                        '{{$iteration.item}}',
                        '{{chat_history}}',
                        '{{file_attachment}}',
                        '{{current_date_time}}',
                        '{{loop_count}}',
                        '{{runtime_messages_length}}',
                        '{{output}}',
                        '{{unknownPlaceholder}}'
                    ].join(' ')
                }
            })

            const results = validateAgentflowConcurrency(
                [start, upstream, mid, iteration, iterChild, sticky, reply],
                [
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                    createEdge('customFunctionAgentflow_0', 'customFunctionAgentflow_1'),
                    createEdge('customFunctionAgentflow_1', 'iterationAgentflow_0'),
                    createEdge('iterationAgentflow_0', 'directReplyAgentflow_0')
                ]
            )

            expect(results).toEqual([])
        })
    })

    describe('Check 2: Concurrent State-Key Write Conflicts', () => {
        it('warns on both parallel nodes sharing the same state key across all *UpdateState fields and JSON-stringified arrays', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const specs: Array<[string, string, any]> = [
                ['customFunctionAgentflow', 'customFunctionUpdateState', [{ key: 'shared', value: '1' }]],
                ['llmAgentflow', 'llmUpdateState', JSON.stringify([{ key: 'shared', value: '2' }])],
                ['agentAgentflow', 'agentUpdateState', [{ key: 'shared', value: '3' }]],
                ['toolAgentflow', 'toolUpdateState', [{ key: 'shared', value: '4' }]],
                ['retrieverAgentflow', 'retrieverUpdateState', [{ key: 'shared', value: '5' }]],
                ['executeFlowAgentflow', 'executeFlowUpdateState', [{ key: 'shared', value: '6' }]],
                ['loopAgentflow', 'loopUpdateState', [{ key: 'shared', value: '7' }]]
            ]

            for (let i = 0; i < specs.length; i += 1) {
                const [nodeType, fieldName, fieldVal] = specs[i]
                const nodeA = createNode(`${nodeType}_A`, nodeType, {
                    label: `Writer A ${i}`,
                    inputs: { [fieldName]: fieldVal }
                })
                const nodeB = createNode('customFunctionAgentflow_B', 'customFunctionAgentflow', {
                    label: 'Writer B',
                    inputs: { customFunctionUpdateState: [{ key: 'shared', value: 'b' }] }
                })
                const results = validateAgentflowConcurrency(
                    [start, nodeA, nodeB],
                    [createEdge('startAgentflow_0', nodeA.id), createEdge('startAgentflow_0', nodeB.id)]
                )

                const resA = results.find((r) => r.id === nodeA.id)
                const resB = results.find((r) => r.id === nodeB.id)
                expect(resA?.issues).toContain(
                    "Shares runtime state key 'shared' with potentially concurrent node 'Writer B'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins."
                )
                expect(resB?.issues).toContain(
                    `Shares runtime state key 'shared' with potentially concurrent node 'Writer A ${i}'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins.`
                )
            }
        })

        it('warns on same-handle multi-edge condition fan-out and on bypass paths that defeat condition dominance', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const cond = createNode('conditionAgentflow_0', 'conditionAgentflow', { label: 'Cond' })
            const sameHandleA = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', {
                label: 'Same Handle A',
                inputs: { customFunctionUpdateState: [{ key: 'k1', value: 'a' }] }
            })
            const sameHandleB = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'Same Handle B',
                inputs: { customFunctionUpdateState: [{ key: 'k1', value: 'b' }] }
            })

            const fanoutResults = validateAgentflowConcurrency(
                [start, cond, sameHandleA, sameHandleB],
                [
                    createEdge('startAgentflow_0', 'conditionAgentflow_0'),
                    createEdge('conditionAgentflow_0', 'customFunctionAgentflow_0', 'conditionAgentflow_0-output-1', 'e1'),
                    createEdge('conditionAgentflow_0', 'customFunctionAgentflow_1', 'conditionAgentflow_0-output-1', 'e2')
                ]
            )
            expect(fanoutResults.find((r) => r.id === 'customFunctionAgentflow_0')?.issues).toHaveLength(1)
            expect(fanoutResults.find((r) => r.id === 'customFunctionAgentflow_1')?.issues).toHaveLength(1)

            // Bypass path: Start -> Cond (out-0 -> X, out-1 -> Y) AND Start -> X
            const branchX = createNode('customFunctionAgentflow_2', 'customFunctionAgentflow', {
                label: 'Branch X',
                inputs: { customFunctionUpdateState: [{ key: 'k2', value: 'x' }] }
            })
            const branchY = createNode('customFunctionAgentflow_3', 'customFunctionAgentflow', {
                label: 'Branch Y',
                inputs: { customFunctionUpdateState: [{ key: 'k2', value: 'y' }] }
            })

            const bypassResults = validateAgentflowConcurrency(
                [start, cond, branchX, branchY],
                [
                    createEdge('startAgentflow_0', 'conditionAgentflow_0'),
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_2'),
                    createEdge('conditionAgentflow_0', 'customFunctionAgentflow_2', 'conditionAgentflow_0-output-0'),
                    createEdge('conditionAgentflow_0', 'customFunctionAgentflow_3', 'conditionAgentflow_0-output-1')
                ]
            )
            expect(bypassResults.find((r) => r.id === 'customFunctionAgentflow_2')?.issues).toHaveLength(1)
            expect(bypassResults.find((r) => r.id === 'customFunctionAgentflow_3')?.issues).toHaveLength(1)
        })

        it('produces zero warnings for sequential writes, disjoint parallel writes, mutually exclusive decision branches, and unreachable nodes', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', {
                label: 'Start',
                inputs: {
                    startState: [
                        { key: 'seq', value: '' },
                        { key: 'disjointA', value: '' },
                        { key: 'disjointB', value: '' }
                    ]
                }
            })
            const seqA = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', {
                label: 'Seq A',
                inputs: {
                    customFunctionUpdateState: [
                        { key: 'seq', value: '1' },
                        { key: 'disjointA', value: 'a' }
                    ]
                }
            })
            const seqB = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'Seq B',
                inputs: {
                    customFunctionUpdateState: [
                        { key: 'seq', value: '2' },
                        { key: 'disjointB', value: 'b' }
                    ]
                }
            })
            const condAgent = createNode('conditionAgentAgentflow_0', 'conditionAgentAgentflow', { label: 'CondAgent' })
            const human = createNode('humanInputAgentflow_0', 'humanInputAgentflow', { label: 'Human' })
            const exclusiveA = createNode('customFunctionAgentflow_2', 'customFunctionAgentflow', {
                label: 'Exclusive A',
                inputs: { customFunctionUpdateState: [{ key: 'branchKey', value: 'a' }] }
            })
            const exclusiveB = createNode('customFunctionAgentflow_3', 'customFunctionAgentflow', {
                label: 'Exclusive B',
                inputs: { customFunctionUpdateState: [{ key: 'branchKey', value: 'b' }] }
            })
            const exclusiveC = createNode('customFunctionAgentflow_4', 'customFunctionAgentflow', {
                label: 'Exclusive C',
                inputs: { customFunctionUpdateState: [{ key: 'branchKey', value: 'c' }] }
            })
            const unreachable = createNode('customFunctionAgentflow_99', 'customFunctionAgentflow', {
                label: 'Disconnected',
                inputs: {
                    customFunctionUpdateState: [
                        { key: 'seq', value: 'z' },
                        { key: 'branchKey', value: 'z' }
                    ]
                }
            })

            const results = validateAgentflowConcurrency(
                [start, seqA, seqB, condAgent, human, exclusiveA, exclusiveB, exclusiveC, unreachable],
                [
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_1'),
                    createEdge('customFunctionAgentflow_0', 'customFunctionAgentflow_1'),
                    createEdge('customFunctionAgentflow_1', 'conditionAgentAgentflow_0'),
                    createEdge('conditionAgentAgentflow_0', 'humanInputAgentflow_0', 'conditionAgentAgentflow_0-output-0'),
                    createEdge('conditionAgentAgentflow_0', 'customFunctionAgentflow_4', 'conditionAgentAgentflow_0-output-1'),
                    createEdge('humanInputAgentflow_0', 'customFunctionAgentflow_2', 'humanInputAgentflow_0-output-0'),
                    createEdge('humanInputAgentflow_0', 'customFunctionAgentflow_3', 'humanInputAgentflow_0-output-1')
                ]
            )

            expect(results).toEqual([])
        })

        it('stays silent when an iteration child and a post-iteration downstream node write the same key, yet warns against a parallel sibling', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const iter = createNode('iterationAgentflow_0', 'iterationAgentflow', { label: 'Iter' })
            const iterChild = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', {
                label: 'Iter Child',
                parentNode: 'iterationAgentflow_0',
                extent: 'parent',
                inputs: { customFunctionUpdateState: [{ key: 'acc', value: 'child' }] }
            })
            const afterIter = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'After Iter',
                inputs: { customFunctionUpdateState: [{ key: 'acc', value: 'after' }] }
            })

            const orderedResults = validateAgentflowConcurrency(
                [start, iter, iterChild, afterIter],
                [createEdge('startAgentflow_0', 'iterationAgentflow_0'), createEdge('iterationAgentflow_0', 'customFunctionAgentflow_1')]
            )
            expect(orderedResults).toEqual([])

            const parallelSibling = createNode('executeFlowAgentflow_0', 'executeFlowAgentflow', {
                label: 'Parallel Subflow',
                inputs: { executeFlowMergeState: [{ variable: 'acc' }] }
            })
            const parallelResults = validateAgentflowConcurrency(
                [start, iter, iterChild, afterIter, parallelSibling],
                [
                    createEdge('startAgentflow_0', 'iterationAgentflow_0'),
                    createEdge('iterationAgentflow_0', 'customFunctionAgentflow_1'),
                    createEdge('startAgentflow_0', 'executeFlowAgentflow_0')
                ]
            )

            expect(parallelResults.find((r) => r.id === 'customFunctionAgentflow_0')?.issues).toEqual([
                "Shares runtime state key 'acc' with potentially concurrent node 'Parallel Subflow'. Disjoint keys merge safely, but concurrent writes to the same key follow last-finisher-wins."
            ])
            expect(parallelResults.find((r) => r.id === 'executeFlowAgentflow_0')?.issues).toHaveLength(2)
        })

        it('handles circular parentNode metadata without stack overflow', () => {
            const nodeA = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', {
                label: 'Cycle A',
                parentNode: 'customFunctionAgentflow_1',
                inputs: { customFunctionUpdateState: [{ key: 'k', value: '1' }] }
            })
            const nodeB = createNode('customFunctionAgentflow_1', 'customFunctionAgentflow', {
                label: 'Cycle B',
                parentNode: 'customFunctionAgentflow_0',
                inputs: { customFunctionUpdateState: [{ key: 'k', value: '2' }] }
            })

            expect(() => validateAgentflowConcurrency([nodeA, nodeB], [])).not.toThrow()
        })
    })

    describe('Check 3: Multiple Content-Bearing Terminal Nodes', () => {
        it('disambiguates identical terminal labels with node IDs in the tie-break summary', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const replyA = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'Direct Reply',
                position: { x: 200, y: 100 }
            })
            const replyB = createNode('directReplyAgentflow_1', 'directReplyAgentflow', {
                label: 'Direct Reply',
                position: { x: 200, y: 200 }
            })

            const results = validateAgentflowConcurrency(
                [start, replyA, replyB],
                [createEdge('startAgentflow_0', 'directReplyAgentflow_0'), createEdge('startAgentflow_0', 'directReplyAgentflow_1')]
            )
            expect(results).toHaveLength(1)
            expect(results[0].issues[0]).toContain('Direct Reply (directReplyAgentflow_0) -> Direct Reply (directReplyAgentflow_1)')
        })
        it('emits an informational notice with deterministic ordering (executionOrder ?? position.y, level, id)', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start', position: { x: 0, y: 100 } })
            const llm = withExecutionOrder(
                createNode('llmAgentflow_0', 'llmAgentflow', { label: 'LLM Second By Order', position: { x: 200, y: 10 } }),
                20
            )
            const agent = withExecutionOrder(
                createNode('agentAgentflow_0', 'agentAgentflow', { label: 'Agent First By Order', position: { x: 200, y: 300 } }),
                5
            )
            const execFlow = createNode('executeFlowAgentflow_0', 'executeFlowAgentflow', {
                label: 'Subflow Third By Y',
                position: { x: 200, y: 150 }
            })

            const results = validateAgentflowConcurrency(
                [start, llm, agent, execFlow],
                [
                    createEdge('startAgentflow_0', 'llmAgentflow_0'),
                    createEdge('startAgentflow_0', 'agentAgentflow_0'),
                    createEdge('startAgentflow_0', 'executeFlowAgentflow_0')
                ]
            )

            expect(results).toHaveLength(1)
            expect(results[0]).toEqual({
                id: 'agentflow-multiple-terminals',
                label: 'Multiple Terminal Nodes',
                name: 'multipleTerminals',
                issues: [
                    "Multiple content-producing terminal nodes (Agent First By Order, LLM Second By Order, Subflow Third By Y) can run in this flow. Active terminals stream consecutively separated by a blank line (\\n\\n); deterministic tie-break order (executionOrder ?? position.y) is Agent First By Order -> LLM Second By Order -> Subflow Third By Y ('Agent First By Order' first if finishing together)."
                ]
            })
        })

        it('stays silent for single terminal, silent non-content leaves, mutually exclusive condition terminals, and unreachable terminals', () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start' })
            const cond = createNode('conditionAgentflow_0', 'conditionAgentflow', { label: 'Cond' })
            const yesReply = createNode('directReplyAgentflow_0', 'directReplyAgentflow', { label: 'Yes Reply' })
            const noReply = createNode('directReplyAgentflow_1', 'directReplyAgentflow', { label: 'No Reply' })
            const silentFn = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', { label: 'Silent Fn' })
            const silentHttp = createNode('httpAgentflow_0', 'httpAgentflow', { label: 'Silent HTTP' })
            const unreachableReply = createNode('directReplyAgentflow_99', 'directReplyAgentflow', { label: 'Unreachable Reply' })

            const results = validateAgentflowConcurrency(
                [start, cond, yesReply, noReply, silentFn, silentHttp, unreachableReply],
                [
                    createEdge('startAgentflow_0', 'conditionAgentflow_0'),
                    createEdge('startAgentflow_0', 'customFunctionAgentflow_0'),
                    createEdge('startAgentflow_0', 'httpAgentflow_0'),
                    createEdge('conditionAgentflow_0', 'directReplyAgentflow_0', 'conditionAgentflow_0-output-0'),
                    createEdge('conditionAgentflow_0', 'directReplyAgentflow_1', 'conditionAgentflow_0-output-1')
                ]
            )

            expect(results).toEqual([])
        })
    })

    describe('Baseline Flows Regression Suite', () => {
        it('produces expected validation results across all 6 canonical baseline flow fixtures', () => {
            const flow01 = loadBaselineFlow('01-parallel-fork-join-timing-and-state.json')
            expect(validateAgentflowConcurrency(flow01.nodes, flow01.edges)).toEqual([])

            const flow02 = loadBaselineFlow('02-multi-hop-and-nested-conditions.json')
            expect(validateAgentflowConcurrency(flow02.nodes, flow02.edges)).toEqual([])

            const flow03 = loadBaselineFlow('03-condition-multi-edge-fanout.json')
            const res03 = validateAgentflowConcurrency(flow03.nodes, flow03.edges)
            expect(res03).toHaveLength(1)
            expect(res03[0].id).toBe('agentflow-multiple-terminals')
            expect(res03[0].issues[0]).toContain('(Else Target A, Else Target B)')

            const flow04 = loadBaselineFlow('04-multi-terminal-streaming-and-silent-leaf.json')
            const res04 = validateAgentflowConcurrency(flow04.nodes, flow04.edges)
            expect(res04).toHaveLength(1)
            expect(res04[0].id).toBe('agentflow-multiple-terminals')
            expect(res04[0].issues[0]).toContain('(Fast Ack, Final Result)')

            const flow05 = loadBaselineFlow('05-human-input-with-companion-text.json')
            const res05 = validateAgentflowConcurrency(flow05.nodes, flow05.edges)
            expect(res05).toHaveLength(1)
            expect(res05[0].id).toBe('agentflow-multiple-terminals')
            expect(res05[0].issues[0]).toContain('(Companion Summary, Approved Reply, Rejected Reply)')

            const flow06 = loadBaselineFlow('06-loop-over-parallel-subgraph.json')
            expect(validateAgentflowConcurrency(flow06.nodes, flow06.edges)).toEqual([])
        })
    })

    describe('validationService.checkFlowValidation scoping & merging', () => {
        function setupMockFlow(type: string, flowObj: ReturnType<typeof createFlow>) {
            const findOne = jest.fn().mockResolvedValue({
                id: 'flow-1',
                type,
                flowData: JSON.stringify(flowObj)
            })
            mockedGetRunningExpressApp.mockReturnValue({
                nodesPool: { componentNodes: {} },
                AppDataSource: {
                    getRepository: jest.fn().mockReturnValue({ findOne })
                }
            } as any)
        }

        it('merges concurrency warnings into existing node entries when flow.type === AGENTFLOW without duplicating node cards', async () => {
            const start = createNode('startAgentflow_0', 'startAgentflow', { label: 'Start', position: { x: 0, y: 100 } })
            const replyA = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'Reply A',
                position: { x: 200, y: 50 },
                inputParams: [{ label: 'Message', name: 'directReplyMessage', type: 'string' } as any],
                inputs: { directReplyMessage: '' } // triggers existing required check AND multi-terminal notice
            })
            const replyB = createNode('directReplyAgentflow_1', 'directReplyAgentflow', {
                label: 'Reply B',
                position: { x: 200, y: 200 },
                inputParams: [{ label: 'Message', name: 'directReplyMessage', type: 'string' } as any],
                inputs: { directReplyMessage: '{{directReplyAgentflow_0}}' } // triggers unlinked sibling warning
            })
            const disconnectedFn = createNode('customFunctionAgentflow_0', 'customFunctionAgentflow', {
                label: 'Disconnected With Ref',
                inputs: { customFunctionJavascriptFunction: '{{directReplyAgentflow_0}}' }
            })

            setupMockFlow(
                'AGENTFLOW',
                createFlow(
                    [start, replyA, replyB, disconnectedFn],
                    [createEdge('startAgentflow_0', 'directReplyAgentflow_0'), createEdge('startAgentflow_0', 'directReplyAgentflow_1')]
                )
            )

            const results = await validationService.checkFlowValidation('flow-1', 'ws-1')

            expect(results.find((r) => r.id === 'directReplyAgentflow_0')?.issues).toEqual(['Message is required'])
            expect(results.find((r) => r.id === 'directReplyAgentflow_1')?.issues).toEqual([
                "References output from 'Reply A' (directReplyAgentflow_0), which is not an upstream ancestor. Under concurrent execution, this node may run before 'Reply A' finishes — connect an edge from 'Reply A' to guarantee ordering."
            ])
            const disconnectedEntries = results.filter((r) => r.id === 'customFunctionAgentflow_0')
            expect(disconnectedEntries).toHaveLength(1)
            expect(disconnectedEntries[0].issues).toEqual([
                'This node is not connected to anything',
                "References output from 'Reply A' (directReplyAgentflow_0), which is not an upstream ancestor. Under concurrent execution, this node may run before 'Reply A' finishes — connect an edge from 'Reply A' to guarantee ordering."
            ])
            expect(results.find((r) => r.id === 'agentflow-multiple-terminals')).toBeDefined()
        })

        it('leaves non-AGENTFLOW flows (CHATFLOW, MULTIAGENT) completely untouched by concurrency checks', async () => {
            const start = createNode('start_0', 'startAgentflow', { label: 'Start' })
            const nodeA = createNode('customFunction_0', 'customFunctionAgentflow', {
                label: 'A',
                inputs: {
                    customFunctionUpdateState: [{ key: 'shared', value: '1' }],
                    text: '{{customFunction_1}}'
                }
            })
            const nodeB = createNode('directReplyAgentflow_0', 'directReplyAgentflow', {
                label: 'B',
                inputs: { customFunctionUpdateState: [{ key: 'shared', value: '2' }] }
            })
            const nodeC = createNode('directReplyAgentflow_1', 'directReplyAgentflow', { label: 'C' })

            const flowObj = createFlow(
                [start, nodeA, nodeB, nodeC],
                [
                    createEdge('start_0', 'customFunction_0'),
                    createEdge('start_0', 'directReplyAgentflow_0'),
                    createEdge('start_0', 'directReplyAgentflow_1')
                ]
            )

            for (const flowType of ['CHATFLOW', 'MULTIAGENT']) {
                setupMockFlow(flowType, flowObj)
                const results = await validationService.checkFlowValidation('flow-1', 'ws-1')
                expect(results).toEqual([])
            }
        })
    })
})
