// Today's behaviour per turn (M1), equal to traces/before/ (Task 00b). Change an entry only in the task whose finding
// intends that change, to the behaviour recorded for it in baselines/compare.config.json (TS6).

export interface TurnFacts {
    status: string | null
    text: string | null
    nodes: string[]
    state: Record<string, any>
    calls: Record<string, string[]>
    history: string | null
    action?: Record<string, any>
    error?: string
}

export const EXPECTED_TURN_FACTS: Record<string, Record<string, TurnFacts>> = {
    S01: {
        t1: {
            status: 'FINISHED',
            text: 'I am sorry about the delay. Order ORD-1001 left our warehouse on Monday and is now with the carrier.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'We are talking about order ORD-1001, which is currently with the carrier.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'The total would be 87 euros.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t3-tool', 't3-answer'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Summary: you asked about the delayed order ORD-1001 and about a quote for 12 jackets, which comes to 87 euros.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t4'] },
            history: 'uauauaua'
        },
        t5: {
            status: 'FINISHED',
            text: 'Goodbye, and thank you for shopping with Northwind Outfitters.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t5'] },
            history: 'uauauauaua'
        }
    },
    S01r: {
        t1: {
            status: 'FINISHED',
            text: 'Yes, order ORD-2002 shipped yesterday and should arrive on Thursday.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Your order number is ORD-2002.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Bye, have a nice day.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t3'] },
            history: 'uauaua'
        }
    },
    S02: {
        t1: {
            status: 'FINISHED',
            text: 'I can see two charges for invoice INV-77. I have started a refund for the duplicate.',
            nodes: ['agentAgentflow_0:FINISHED', 'conditionAgentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-billing': ['billing-t1'], 'S02-router': ['router-billing'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Please update the app to version 5.2 and clear its cache; that fixes the crash.',
            nodes: ['conditionAgentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-router': ['router-tech'], 'S02-tech': ['tech-t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'The duplicate charge will be back on your card within 5 business days.',
            nodes: ['agentAgentflow_0:FINISHED', 'conditionAgentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-billing': ['billing-t3'], 'S02-router': ['router-billing'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'I can help with billing or technical questions. Could you tell me a bit more?',
            nodes: ['conditionAgentAgentflow_0:FINISHED', 'directReplyAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-router': ['router-other'] },
            history: 'uauauaua'
        },
        t5: {
            status: 'FINISHED',
            text: 'Then please reinstall the app. Your orders are kept in your account.',
            nodes: ['conditionAgentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-router': ['router-tech'], 'S02-tech': ['tech-t5'] },
            history: 'uauauauaua'
        },
        t6: {
            status: 'FINISHED',
            text: 'Yes, I have switched the refund to store credit of the same amount.',
            nodes: ['agentAgentflow_0:FINISHED', 'conditionAgentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S02-billing': ['billing-t6'], 'S02-router': ['router-billing'] },
            history: 'uauauauauaua'
        }
    },
    S03: {
        t1: {
            status: 'FINISHED',
            text: 'Your jacket warranty covers a broken zipper for 24 months, as long as it was not misused. Please keep your proof of purchase, because every claim needs it.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {
                findings: 'Research: zippers are covered for 24 months when the defect is not caused by misuse.',
                topic: 'warranty claims'
            },
            calls: { 'S03-composer': ['composer-t1'], 'S03-critic': ['critic-t1'], 'S03-researcher': ['researcher-t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'The warranty stays with the jacket, so you can claim it second-hand, but you need the original receipt from the first owner; without it we can only offer a paid repair.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {
                findings: 'Research: the warranty follows the jacket, so second-hand owners need the original receipt.',
                topic: 'warranty claims'
            },
            calls: { 'S03-composer': ['composer-t2'], 'S03-critic': ['critic-t2'], 'S03-researcher': ['researcher-t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Book the repair online and print the prepaid label; shipping is free inside the EU, and customers outside the EU pay for the shipping themselves.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {
                findings: 'Research: repairs are booked online and the prepaid label is free inside the EU.',
                topic: 'warranty claims'
            },
            calls: {
                'S03-composer': ['composer-t3'],
                'S03-critic': ['critic-t3'],
                'S03-researcher': ['researcher-t3'],
                _noroute: ['summarizer']
            },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'You are welcome. Good luck with the repair!',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: { findings: 'Research: nothing further to add.', topic: 'warranty claims' },
            calls: {
                'S03-composer': ['composer-t4'],
                'S03-critic': ['critic-t4'],
                'S03-researcher': ['researcher-t4'],
                _noroute: ['summarizer']
            },
            history: 'uauauaua'
        }
    },
    S04a: {
        t1: {
            status: 'FINISHED',
            text: 'Intake (t1): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '1', stage: 'qualified' },
            calls: { 'S04a-intake': ['intake'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Follow-up (t2): our onboarding team will call you within two business days.',
            nodes: [
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '2', stage: 'qualified' },
            calls: { 'S04a-followup': ['followup'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Intake (t3): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '3', stage: 'qualified' },
            calls: { 'S04a-intake': ['intake'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Follow-up (t4): our onboarding team will call you within two business days.',
            nodes: [
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '4', stage: 'qualified' },
            calls: { 'S04a-followup': ['followup'] },
            history: 'uauauaua'
        }
    },
    S04b: {
        t1: {
            status: 'FINISHED',
            text: 'Intake (t1): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '1', stage: 'qualified' },
            calls: { 'S04b-intake': ['intake'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Intake (t2): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '1', stage: 'qualified' },
            calls: { 'S04b-intake': ['intake'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Intake (t3): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '1', stage: 'qualified' },
            calls: { 'S04b-intake': ['intake'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Intake (t4): I have recorded the shop details and marked the request as qualified.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { count: '1', stage: 'qualified' },
            calls: { 'S04b-intake': ['intake'] },
            history: 'uauauaua'
        }
    },
    S05: {
        t1: {
            status: 'FINISHED',
            text: 'Thanks, I have opened a billing request for you.',
            nodes: ['llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S05-assistant': ['t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'The annual plan is charged on the first day of next month.',
            nodes: ['llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S05-assistant': ['t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Thanks, I have opened a shipping request for you.',
            nodes: ['llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S05-assistant': ['t3'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Your parcel is at the regional depot and will be delivered tomorrow.',
            nodes: ['llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S05-assistant': ['t4'] },
            history: 'uauauaua'
        }
    },
    S06: {
        t1: {
            status: 'STOPPED',
            text: 'A reviewer will check the draft before it goes out.\n\nDraft: Dear customer, we are sorry that your shipment is delayed by a week. It will arrive next Friday.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06-drafter': ['drafter-t1'] },
            history: 'ua',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: '',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        },
        t2: {
            status: 'STOPPED',
            text: 'Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06-drafter': ['drafter-t2'] },
            history: 'uaa',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: '',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        },
        t3: {
            status: 'FINISHED',
            text: 'Final: Dear customer, we apologise for the one-week delay. Your order arrives next Friday, and code SORRY10 gives you 10% off your next order.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06-finalizer': ['finalizer-t3'] },
            history: 'uaaa'
        },
        t4: {
            status: 'STOPPED',
            text: 'A reviewer will check the draft before it goes out.\n\nDraft SMS: Sorry for the delay! Your order arrives Friday. Use SORRY10 for 10% off.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06-drafter': ['drafter-t4'] },
            history: 'uaaaua',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: '',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        },
        t5: {
            status: 'FINISHED',
            text: 'Final SMS: Sorry for the delay! Your order arrives Friday. Use SORRY10 for 10% off.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06-finalizer': ['finalizer-t5'] },
            history: 'uaaauaa'
        }
    },
    S06b: {
        t1: {
            status: 'STOPPED',
            text: 'A reviewer will check the draft before it goes out.\n\nDraft: Dear customer, we are sorry that your shipment is delayed by a week. It will arrive next Friday.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06b-drafter': ['drafter-t1'] },
            history: 'ua',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: 'doNotIncludeFeedbackHistory',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        },
        t2: {
            status: 'STOPPED',
            text: 'Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06b-drafter': ['drafter-t2'] },
            history: 'uua',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: 'doNotIncludeFeedbackHistory',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        },
        t3: {
            status: 'FINISHED',
            text: 'Final: Dear customer, we apologise for the one-week delay. Your order arrives next Friday, and code SORRY10 gives you 10% off your next order.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06b-finalizer': ['finalizer-t3'] },
            history: 'uuua'
        },
        t4: {
            status: 'STOPPED',
            text: 'A reviewer will check the draft before it goes out.\n\nDraft SMS: Sorry for the delay! Your order arrives Friday. Use SORRY10 for 10% off.\n\nApprove this draft?',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'humanInputAgentflow_0:STOPPED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S06b-drafter': ['drafter-t4'] },
            history: 'uuuaua',
            action: {
                elements: [
                    { label: 'Approve', type: 'agentflowv2-approve-button' },
                    { label: 'Request changes', type: 'agentflowv2-reject-button' }
                ],
                extra: 'doNotIncludeFeedbackHistory',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Review Gate'
            }
        }
    },
    S07: {
        t1: {
            status: 'FINISHED',
            text: 'Today is a regular business day, so our warehouse is open.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t1-tool', 't1-answer'] },
            history: 'ua'
        },
        t2: {
            status: 'STOPPED',
            text: '\nAttempting to use tool:\n```json\n{\n  "name": "calculator",\n  "args": {\n    "input": "249.99*0.15"\n  },\n  "id": "call_S07agent_t2_0_0",\n  "type": "tool_call"\n}\n```',
            nodes: ['agentAgentflow_0:STOPPED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t2-tool'] },
            history: 'uaua',
            action: {
                elements: [
                    { label: 'Proceed', type: 'agentflowv2-approve-button' },
                    { label: 'Reject', type: 'agentflowv2-reject-button' }
                ],
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'agentAgentflow_0',
                nodeLabel: 'Ops Agent'
            }
        },
        t3: {
            status: 'FINISHED',
            text: 'The refund is 37.50 euros.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t3-answer'] },
            history: 'uauaa'
        },
        t4: {
            status: 'STOPPED',
            text: '\nAttempting to use tool:\n```json\n{\n  "name": "calculator",\n  "args": {\n    "input": "80*0.2"\n  },\n  "id": "call_S07agent_t4_0_0",\n  "type": "tool_call"\n}\n```',
            nodes: ['agentAgentflow_0:STOPPED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t4-tool'] },
            history: 'uauaaua',
            action: {
                elements: [
                    { label: 'Proceed', type: 'agentflowv2-approve-button' },
                    { label: 'Reject', type: 'agentflowv2-reject-button' }
                ],
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'agentAgentflow_0',
                nodeLabel: 'Ops Agent'
            }
        },
        t5: {
            status: 'FINISHED',
            text: 'Understood, I will not run the calculation and have passed it to a manager.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t5-answer'] },
            history: 'uauaauaa'
        },
        t6: {
            status: 'FINISHED',
            text: 'You are welcome, have a good day.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S07-agent': ['t6'] },
            history: 'uauaauaaua'
        }
    },
    S08: {
        t1: {
            status: 'STOPPED',
            text: '\n\nManager approval is required for this refund.\n\n\nAttempting to use tool:\n```json\n{\n  "name": "calculator",\n  "args": {\n    "input": "120*0.85"\n  },\n  "id": "call_S08policy_t1_0_0",\n  "type": "tool_call"\n}\n```',
            nodes: ['agentAgentflow_0:STOPPED', 'humanInputAgentflow_0:STOPPED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S08-policy': ['policy-tool'] },
            history: 'ua',
            action: {
                elements: [
                    { label: 'Proceed', type: 'agentflowv2-approve-button' },
                    { label: 'Reject', type: 'agentflowv2-reject-button' }
                ],
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'agentAgentflow_0',
                nodeLabel: 'Policy Check'
            }
        },
        t2: {
            status: 'STOPPED',
            text: '',
            nodes: ['agentAgentflow_0:FINISHED', 'humanInputAgentflow_0:STOPPED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S08-policy': ['policy-after-tool'] },
            history: 'uaa',
            action: {
                elements: [
                    { label: 'Approve refund', type: 'agentflowv2-approve-button' },
                    { label: 'Deny refund', type: 'agentflowv2-reject-button' }
                ],
                extra: '',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Manager Gate'
            }
        },
        t3: {
            status: 'FINISHED',
            text: 'Refund approved: 102 euros will go back to the original payment method.',
            nodes: ['agentAgentflow_0:FINISHED', 'humanInputAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S08-summary': ['summary'] },
            history: 'uaaa'
        },
        t4: {
            status: 'STOPPED',
            text: 'Refund approved: 102 euros will go back to the original payment method.\n\nManager approval is required for this refund.',
            nodes: ['agentAgentflow_0:FINISHED', 'humanInputAgentflow_0:STOPPED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S08-policy': ['policy-t4'] },
            history: 'uaaaua',
            action: {
                elements: [
                    { label: 'Approve refund', type: 'agentflowv2-approve-button' },
                    { label: 'Deny refund', type: 'agentflowv2-reject-button' }
                ],
                extra: '',
                humanInputEnableFeedback: true,
                id: '<uuid>',
                mapping: { approve: 'Proceed', reject: 'Reject' },
                nodeId: 'humanInputAgentflow_0',
                nodeLabel: 'Manager Gate'
            }
        }
    },
    S09: {
        t1: {
            status: 'FINISHED',
            text: 'Analysis complete: Aggregate (t1, pass 1): invoice and shipping are fine; returns need a follow-up call.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'conditionAgentAgentflow_0:FINISHED',
                'conditionAgentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'iterationAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: {
                'S09-aggregator': ['aggregator', 'aggregator'],
                'S09-item': ['item', 'item', 'item'],
                'S09-quality': ['quality-more-t1', 'quality-complete']
            },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Analysis complete: Aggregate (t2, pass 0): invoice and shipping are fine; returns need a follow-up call.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'conditionAgentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'iterationAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: { 'S09-aggregator': ['aggregator'], 'S09-item': ['item', 'item', 'item'], 'S09-quality': ['quality-complete'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Stopped: the review loop reached its maximum count.',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'agentAgentflow_0:FINISHED',
                'conditionAgentAgentflow_0:FINISHED',
                'conditionAgentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'iterationAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'llmAgentflow_0:FINISHED',
                'loopAgentflow_0:FINISHED',
                'loopAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: {},
            calls: {
                'S09-aggregator': ['aggregator', 'aggregator'],
                'S09-item': ['item', 'item', 'item'],
                'S09-quality': ['quality-more-t3', 'quality-more-t3']
            },
            history: 'uauaua'
        }
    },
    S10a: {
        t1: {
            status: 'FINISHED',
            text: 'Yes, we ship to Norway; delivery takes 3 to 5 days.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S10a-context': ['context-t1'], 'S10a-joiner': ['joiner-t1'], 'S10a-quick': ['quick'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Shipping to Norway costs 9 euros and is free above 100 euros.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S10a-context': ['context-t2'], 'S10a-joiner': ['joiner-t2'], 'S10a-quick': ['quick'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Yes, express delivery takes 1 to 2 days for 19 euros.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S10a-context': ['context-t3'], 'S10a-joiner': ['joiner-t3'], 'S10a-quick': ['quick'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Yes, you can pick the parcel up at our Oslo store for free.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S10a-context': ['context-t4'], 'S10a-joiner': ['joiner-t4'], 'S10a-quick': ['quick'] },
            history: 'uauauaua'
        }
    },
    S10b: {
        t1: {
            status: 'FINISHED',
            text: 'Noted for this message, but I do not keep memory between messages.\n\n(turn counter 1)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { counter: '1' },
            calls: { 'S10b-agent': ['t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Sorry, I do not know your favourite colour.\n\n(turn counter 2)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { counter: '2' },
            calls: { 'S10b-agent': ['t2'] },
            history: 'ua'
        },
        t3: {
            status: 'FINISHED',
            text: 'You are welcome.\n\n(turn counter 3)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'customFunctionAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { counter: '3' },
            calls: { 'S10b-agent': ['t3'] },
            history: 'ua'
        }
    },
    S11: {
        t1: {
            status: 'FINISHED',
            text: 'Joined answer (t1): main answer plus the side note.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: { b_note: 'Side note: the holiday peak adds two days.' },
            calls: { 'S11-agentA': ['agentA-t1'], 'S11-joiner': ['joiner'], 'S11-llmB': ['llmB-t1'] },
            history: 'ua'
        },
        t2: {
            status: 'ERROR',
            text: '',
            nodes: ['agentAgentflow_0:ERROR', 'llmAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: { b_note: 'Side note: photos are needed for damage claims.' },
            calls: { 'S11-agentA': ['agentA-error'], 'S11-llmB': ['llmB-t2'] },
            history: 'ua',
            error: 'Error: predictionsServices.buildChatflow - Error in Agent node: 500 Injected fake LLM failure for Agent A'
        },
        t3: {
            status: 'FINISHED',
            text: 'Joined answer (t3): main answer plus the side note.',
            nodes: ['agentAgentflow_0:FINISHED', 'llmAgentflow_0:FINISHED', 'llmAgentflow_1:FINISHED', 'startAgentflow_0:FINISHED'],
            state: { b_note: 'Side note: photos speed up the claim.' },
            calls: { 'S11-agentA': ['agentA-t3'], 'S11-joiner': ['joiner'], 'S11-llmB': ['llmB-t3'] },
            history: 'uaua'
        }
    },
    S12: {
        t1: {
            status: 'FINISHED',
            text: 'Front desk (t1): let me ask our returns specialist.\n\nSpecialist: Boots can be returned within 30 days if they are unworn. (specialist turn 1)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'executeFlowAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { child_count: '1' },
            calls: { 'S12-parent': ['parent'], 'S12-specialist': ['specialist-t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'Front desk (t2): let me ask our returns specialist.\n\nSpecialist: Worn once is fine if the soles show no marks. (specialist turn 1)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'executeFlowAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { child_count: '1' },
            calls: { 'S12-parent': ['parent'], 'S12-specialist': ['specialist-t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: 'Front desk (t3): let me ask our returns specialist.\n\nSpecialist: You wanted to return a pair of boots. (specialist turn 1)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'executeFlowAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { child_count: '1' },
            calls: { 'S12-parent': ['parent'], 'S12-specialist': ['specialist-t3'] },
            history: 'uauaua'
        },
        t4: {
            status: 'FINISHED',
            text: 'Front desk (t4): let me ask our returns specialist.\n\nSpecialist: Happy to help with your return. (specialist turn 1)',
            nodes: [
                'agentAgentflow_0:FINISHED',
                'directReplyAgentflow_0:FINISHED',
                'executeFlowAgentflow_0:FINISHED',
                'startAgentflow_0:FINISHED'
            ],
            state: { child_count: '1' },
            calls: { 'S12-parent': ['parent'], 'S12-specialist': ['specialist-t4'] },
            history: 'uauauaua'
        }
    },
    S13: {
        t1: {
            status: 'FINISHED',
            text: 'Sorry to hear that. Order ORD-3003 is delayed at the depot.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t1'] },
            history: 'ua'
        },
        t2: {
            status: 'FINISHED',
            text: 'You mentioned order ORD-3003.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t2'] },
            history: 'uaua'
        },
        t3: {
            status: 'FINISHED',
            text: '5 times 4 is 20.',
            nodes: ['agentAgentflow_0:FINISHED', 'startAgentflow_0:FINISHED'],
            state: {},
            calls: { 'S01-agent': ['t3-tool', 't3-answer'] },
            history: 'uauaua'
        }
    }
}

export interface TokenContents {
    bytes: number
    sentinels: number
    records: number
    historyWithAction: number
}

// Token contents (raw decoded JSON bytes, prompt sentinels, node records, history messages carrying an action): v2 tokens
// since Task 05. A stopped turn still carries the stopped run's records as interim pending data until Task 07.
export const EXPECTED_TOKEN_CONTENTS: Record<string, Record<string, TokenContents | null>> = {
    S01: {
        t1: { bytes: 311, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 506, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 689, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 919, sentinels: 0, records: 0, historyWithAction: 0 },
        t5: { bytes: 1073, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S01r: {
        t1: { bytes: 255, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 388, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 492, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S02: {
        t1: { bytes: 272, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 467, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 651, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 840, sentinels: 0, records: 0, historyWithAction: 0 },
        t5: { bytes: 1020, sentinels: 0, records: 0, historyWithAction: 0 },
        t6: { bytes: 1203, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S03: {
        t1: { bytes: 495, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 807, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 1086, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 1219, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S04a: {
        t1: { bytes: 313, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 483, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 681, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 859, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S04b: {
        t1: { bytes: 313, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 490, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 688, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 873, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S05: {
        t1: { bytes: 269, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 441, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 596, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 764, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S06: {
        t1: { bytes: 47028, sentinels: 1, records: 4, historyWithAction: 0 },
        t2: { bytes: 93753, sentinels: 2, records: 7, historyWithAction: 0 },
        t3: { bytes: 742, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 49506, sentinels: 1, records: 4, historyWithAction: 0 },
        t5: { bytes: 1138, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S06b: {
        t1: { bytes: 46170, sentinels: 1, records: 4, historyWithAction: 0 },
        t2: { bytes: 91126, sentinels: 2, records: 7, historyWithAction: 0 },
        t3: { bytes: 554, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 47862, sentinels: 1, records: 4, historyWithAction: 0 }
    },
    S07: {
        t1: { bytes: 227, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 90203, sentinels: 2, records: 2, historyWithAction: 0 },
        t3: { bytes: 600, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 91362, sentinels: 2, records: 2, historyWithAction: 0 },
        t5: { bytes: 1008, sentinels: 0, records: 0, historyWithAction: 0 },
        t6: { bytes: 1142, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S08: {
        t1: { bytes: 90682, sentinels: 2, records: 3, historyWithAction: 0 },
        t2: { bytes: 47052, sentinels: 1, records: 3, historyWithAction: 0 },
        t3: { bytes: 597, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 48544, sentinels: 1, records: 3, historyWithAction: 0 }
    },
    S09: {
        t1: { bytes: 298, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 504, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 656, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S10a: {
        t1: { bytes: 221, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 381, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 532, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 703, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S10b: {
        t1: { bytes: 290, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 252, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 211, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S11: {
        t1: { bytes: 290, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 295, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 442, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S12: {
        t1: { bytes: 341, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 583, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 810, sentinels: 0, records: 0, historyWithAction: 0 },
        t4: { bytes: 1019, sentinels: 0, records: 0, historyWithAction: 0 }
    },
    S13: {
        t1: { bytes: 237, sentinels: 0, records: 0, historyWithAction: 0 },
        t2: { bytes: 363, sentinels: 0, records: 0, historyWithAction: 0 },
        t3: { bytes: 482, sentinels: 0, records: 0, historyWithAction: 0 }
    }
}
