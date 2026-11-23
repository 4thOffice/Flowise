# v1 continuation comparison

- v1 tokens: `traces/before`; expected (v2 conversation): `traces/after`; continuations: `traces/continue-v1`
- Continuations: 105, turns compared: 249, failures: 0

| Mode | Scenario | From | Turns | v1 token differs from v2 in | Aspects that differ (allowed) | History carried | D4 replay = v1 | Legacy checkpoint in token | Failures |
| :--- | :--- | :--- | ---: | :--- | :--- | :---: | :---: | :--- | ---: |
| M1-internal | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M1-internal | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M1-internal | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M1-internal | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M1-internal | S07 | t1 | 5 | — | none | yes | — | — | 0 |
| M1-internal | S07 | t2 | 4 | — | none | yes | yes | — | 0 |
| M1-internal | S07 | t3 | 3 | history | modelRequests (t4), modelRequests (t5), modelRequests (t6) | yes | — | — | 0 |
| M1-internal | S07 | t4 | 2 | history | modelRequests (t5), modelRequests (t6) | yes | yes | — | 0 |
| M1-internal | S07 | t5 | 1 | history | modelRequests (t6) | yes | — | — | 0 |
| M1-reqflag | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M1-reqflag | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M1-reqflag | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M1-reqflag | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M1 | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M1 | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M1 | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M1 | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M1 | S01r | t1 | 2 | — | none | yes | — | — | 0 |
| M1 | S01r | t2 | 1 | — | none | yes | — | — | 0 |
| M1 | S02 | t1 | 5 | — | none | yes | — | — | 0 |
| M1 | S02 | t2 | 4 | — | none | yes | — | — | 0 |
| M1 | S02 | t3 | 3 | — | none | yes | — | — | 0 |
| M1 | S02 | t4 | 2 | — | none | yes | — | — | 0 |
| M1 | S02 | t5 | 1 | — | none | yes | — | — | 0 |
| M1 | S03 | t1 | 3 | — | none | yes | — | — | 0 |
| M1 | S03 | t2 | 2 | — | none | yes | — | — | 0 |
| M1 | S03 | t3 | 1 | — | none | yes | — | — | 0 |
| M1 | S04a | t1 | 3 | — | none | yes | — | — | 0 |
| M1 | S04a | t2 | 2 | — | none | yes | — | — | 0 |
| M1 | S04a | t3 | 1 | — | none | yes | — | — | 0 |
| M1 | S04b | t1 | 3 | — | none | yes | — | — | 0 |
| M1 | S04b | t2 | 2 | history, flowState | modelRequests (t3), finalState (t3), modelRequests (t4), finalState (t4) | yes | — | — | 0 |
| M1 | S04b | t3 | 1 | history, flowState | modelRequests (t4), finalState (t4) | yes | — | — | 0 |
| M1 | S05 | t1 | 3 | — | none | yes | — | — | 0 |
| M1 | S05 | t2 | 2 | — | none | yes | — | — | 0 |
| M1 | S05 | t3 | 1 | formValues | modelRequests (t4) | yes | — | — | 0 |
| M1 | S06 | t1 | 4 | — | none | yes | — | — | 0 |
| M1 | S06 | t2 | 3 | history | modelRequests (t3), modelRequests (t4), modelRequests (t5) | yes | — | — | 0 |
| M1 | S06 | t3 | 2 | history | modelRequests (t4), modelRequests (t5) | yes | — | — | 0 |
| M1 | S06 | t4 | 1 | history | modelRequests (t5) | yes | — | — | 0 |
| M1 | S06b | t1 | 3 | history | modelRequests (t2), modelRequests (t3), modelRequests (t4) | yes | — | — | 0 |
| M1 | S06b | t2 | 2 | history | modelRequests (t3), modelRequests (t4) | yes | — | — | 0 |
| M1 | S06b | t3 | 1 | history | modelRequests (t4) | yes | — | — | 0 |
| M1 | S07 | t1 | 5 | — | none | yes | — | — | 0 |
| M1 | S07 | t2 | 4 | — | none | yes | yes | — | 0 |
| M1 | S07 | t3 | 3 | history | modelRequests (t4), modelRequests (t5), modelRequests (t6) | yes | — | — | 0 |
| M1 | S07 | t4 | 2 | history | modelRequests (t5), modelRequests (t6) | yes | yes | — | 0 |
| M1 | S07 | t5 | 1 | history | modelRequests (t6) | yes | — | — | 0 |
| M1 | S08 | t1 | 3 | — | none | yes | yes | — | 0 |
| M1 | S08 | t2 | 2 | history | modelRequests (t3), modelRequests (t4) | yes | — | — | 0 |
| M1 | S08 | t3 | 1 | history | modelRequests (t4) | yes | — | — | 0 |
| M1 | S09 | t1 | 2 | — | none | yes | — | — | 0 |
| M1 | S09 | t2 | 1 | — | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-off | t1 | 3 | — | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-off | t2 | 2 | — | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-off | t3 | 1 | — | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-on | t1 | 3 | history | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-on | t2 | 2 | history | none | yes | — | — | 0 |
| M1 | S10a@accept-client-history-on | t3 | 1 | history | none | yes | — | — | 0 |
| M1 | S10b | t1 | 2 | — | none | yes | — | — | 0 |
| M1 | S10b | t2 | 1 | history | modelRequests (t3) | yes | — | — | 0 |
| M1 | S11 | t1 | 2 | — | none | yes | — | — | 0 |
| M1 | S11 | t2 | 1 | — | none | yes | — | — | 0 |
| M1 | S12 | t1 | 3 | childFlowTokens | modelRequests (t2), streamedTokens (t2), finalText (t2), finalState (t2), modelRequests (t3), streamedTokens (t3), finalText (t3), finalState (t3), modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |
| M1 | S12 | t2 | 2 | history, flowState, childFlowTokens | modelRequests (t3), streamedTokens (t3), finalText (t3), finalState (t3), modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |
| M1 | S12 | t3 | 1 | history, flowState, childFlowTokens | modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |
| M2 | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M2 | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M2 | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M2 | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M2 | S06 | t1 | 4 | — | none | yes | — | — | 0 |
| M2 | S06 | t2 | 3 | history | modelRequests (t3), modelRequests (t4), modelRequests (t5) | yes | — | — | 0 |
| M2 | S06 | t3 | 2 | history | modelRequests (t4), modelRequests (t5) | yes | — | — | 0 |
| M2 | S06 | t4 | 1 | history | modelRequests (t5) | yes | — | — | 0 |
| M2 | S07 | t1 | 5 | — | none | yes | — | — | 0 |
| M2 | S07 | t2 | 4 | — | none | yes | yes | — | 0 |
| M2 | S07 | t3 | 3 | history | modelRequests (t4), modelRequests (t5), modelRequests (t6) | yes | — | — | 0 |
| M2 | S07 | t4 | 2 | history | modelRequests (t5), modelRequests (t6) | yes | yes | — | 0 |
| M2 | S07 | t5 | 1 | history | modelRequests (t6) | yes | — | — | 0 |
| M2 | S08 | t1 | 3 | — | none | yes | yes | — | 0 |
| M2 | S08 | t2 | 2 | history | modelRequests (t3), modelRequests (t4) | yes | — | — | 0 |
| M2 | S08 | t3 | 1 | history | modelRequests (t4) | yes | — | — | 0 |
| M3-envflags | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M3-envflags | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M3-envflags | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M3-envflags | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M3 | S01 | t1 | 4 | — | none | yes | — | — | 0 |
| M3 | S01 | t2 | 3 | — | none | yes | — | — | 0 |
| M3 | S01 | t3 | 2 | — | none | yes | — | — | 0 |
| M3 | S01 | t4 | 1 | — | none | yes | — | — | 0 |
| M3 | S05 | t1 | 3 | — | none | yes | — | — | 0 |
| M3 | S05 | t2 | 2 | — | none | yes | — | — | 0 |
| M3 | S05 | t3 | 1 | formValues | modelRequests (t4) | yes | — | — | 0 |
| M3 | S06 | t1 | 4 | — | none | yes | — | — | 0 |
| M3 | S06 | t2 | 3 | — | none | yes | — | — | 0 |
| M3 | S06 | t3 | 2 | history | modelRequests (t4), modelRequests (t5) | yes | — | — | 0 |
| M3 | S06 | t4 | 1 | history | modelRequests (t5) | yes | — | — | 0 |
| M3 | S07 | t1 | 5 | — | none | yes | — | — | 0 |
| M3 | S07 | t2 | 4 | — | none | yes | yes | — | 0 |
| M3 | S07 | t3 | 3 | history | modelRequests (t4), modelRequests (t5), modelRequests (t6) | yes | — | — | 0 |
| M3 | S07 | t4 | 2 | history | modelRequests (t5), modelRequests (t6) | yes | yes | — | 0 |
| M3 | S07 | t5 | 1 | history | modelRequests (t6) | yes | — | — | 0 |
| M3 | S12 | t1 | 3 | childFlowTokens | modelRequests (t2), streamedTokens (t2), finalText (t2), finalState (t2), modelRequests (t3), streamedTokens (t3), finalText (t3), finalState (t3), modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |
| M3 | S12 | t2 | 2 | childFlowTokens | modelRequests (t3), streamedTokens (t3), finalText (t3), finalState (t3), modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |
| M3 | S12 | t3 | 1 | childFlowTokens | modelRequests (t4), streamedTokens (t4), finalText (t4), finalState (t4) | yes | — | — | 0 |

## Where the v1 token differs from the v2 token of the same turn

- M1-internal S07 from t3, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1-internal S07 from t4, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1-internal S07 from t5, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1 S04b from t2, `history` at `[3].content`: v1 "Intake (t2): I have recorded the shop details and marked the request as qualified." / v2 "Follow-up (t2): our onboarding team will call you within two business days."
- M1 S04b from t2, `flowState` at `.count`: v1 "1" / v2 "2"
- M1 S04b from t3, `history` at `[3].content`: v1 "Intake (t2): I have recorded the shop details and marked the request as qualified." / v2 "Follow-up (t2): our onboarding team will call you within two business days."
- M1 S04b from t3, `flowState` at `.count`: v1 "1" / v2 "3"
- M1 S05 from t3, `formValues` at `.name`: v1 "Ada Lovelace" / v2 "Grace Hopper"
- M1 S06 from t2, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M1 S06 from t3, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M1 S06 from t4, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M1 S06b from t1, `history` at `[1]`: v1 {"content":"A reviewer will check the draft before it goes out.\n\nDraft: Dear customer, we are sorry that your shipment is delayed by a week. It will arrive next Friday.\n\nApprove this draft?","role":"apiMessage"} / v2 <missing>
- M1 S06b from t2, `history` at `[1]`: v1 {"content":"Draft a reply to a customer whose shipment is delayed by a week.","role":"userMessage"} / v2 <missing>
- M1 S06b from t3, `history` at `[1].content`: v1 "Draft a reply to a customer whose shipment is delayed by a week." / v2 "Final: Dear customer, we apologise for the one-week delay. Your order arrives next Friday, and code SORRY10 gives you 10% off your next order."
- M1 S07 from t3, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1 S07 from t4, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1 S07 from t5, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M1 S08 from t2, `history` at `[2].content`: v1 " " / v2 "Proceed"
- M1 S08 from t3, `history` at `[2].content`: v1 " " / v2 "Proceed"
- M1 S10a@accept-client-history-on from t1, `history` at `[0].content`: v1 "Do you ship to Norway?" / v2 "Welcome to Northwind Outfitters! How can I help you today?"
- M1 S10a@accept-client-history-on from t2, `history` at `[0].content`: v1 "Do you ship to Norway?" / v2 "Welcome to Northwind Outfitters! How can I help you today?"
- M1 S10a@accept-client-history-on from t3, `history` at `[0].content`: v1 "Do you ship to Norway?" / v2 "Welcome to Northwind Outfitters! How can I help you today?"
- M1 S10b from t2, `history` at `[0].content`: v1 "What is my favourite colour?" / v2 "Remember that my favourite colour is green."
- M1 S12 from t1, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
- M1 S12 from t2, `history` at `[3].content`: v1 "Front desk (t2): let me ask our returns specialist.\n\nSpecialist: Worn once is fine if the soles show no marks. (specialist turn 1)" / v2 "Front desk (t2): let me ask our returns specialist.\n\nSpecialist: Worn once is fine if the soles show no marks. (specialist turn 2)"
- M1 S12 from t2, `flowState` at `.child_count`: v1 "1" / v2 "2"
- M1 S12 from t2, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
- M1 S12 from t3, `history` at `[3].content`: v1 "Front desk (t2): let me ask our returns specialist.\n\nSpecialist: Worn once is fine if the soles show no marks. (specialist turn 1)" / v2 "Front desk (t2): let me ask our returns specialist.\n\nSpecialist: Worn once is fine if the soles show no marks. (specialist turn 2)"
- M1 S12 from t3, `flowState` at `.child_count`: v1 "1" / v2 "3"
- M1 S12 from t3, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
- M2 S06 from t2, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M2 S06 from t3, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M2 S06 from t4, `history` at `[2].content`: v1 "Draft v2: Dear customer, we are sorry for the one-week delay. Please use code SORRY10 for 10% off your next order.\n\nApprove this draft?" / v2 "Please mention the 10% discount code SORRY10."
- M2 S07 from t3, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M2 S07 from t4, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M2 S07 from t5, `history` at `[4].content`: v1 "The refund is 37.50 euros." / v2 "Proceed"
- M2 S08 from t2, `history` at `[2].content`: v1 " " / v2 "Proceed"
- M2 S08 from t3, `history` at `[2].content`: v1 " " / v2 "Proceed"
- M3 S05 from t3, `formValues` at `.name`: v1 "Ada Lovelace" / v2 "Grace Hopper"
- M3 S06 from t3, `history` at `[4].content`: v1 " " / v2 "Approve"
- M3 S06 from t4, `history` at `[4].content`: v1 " " / v2 "Approve"
- M3 S07 from t3, `history` at `[4].content`: v1 " " / v2 "Proceed"
- M3 S07 from t4, `history` at `[4].content`: v1 " " / v2 "Proceed"
- M3 S07 from t5, `history` at `[4].content`: v1 " " / v2 "Proceed"
- M3 S12 from t1, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
- M3 S12 from t2, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
- M3 S12 from t3, `childFlowTokens` at `[0]`: v1 <missing> / v2 {"flowId":"<uuid>","nodeId":"executeFlowAgentflow_0"}
