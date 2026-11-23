# Trace comparison

- Before: `traces/before`
- After: `traces/after`
- Intended entries: 35
- Failures: 0

| Trace | Turn | modelRequests | streamedTokens | finalText | nodeSequence | status | finalState | action | error | Token bytes (before → after) | Token sentinels |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | ---: |
| M1/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46115 → 311 | 1 → 0 |
| M1/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 46995 → 506 | 1 → 0 |
| M1/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48729 → 689 | 1 → 0 |
| M1/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49186 → 919 | 1 → 0 |
| M1/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 49916 → 1073 | 1 → 0 |
| M1/S01r-redirect-mapping.json | t1 | = | = | = | = | = | = | = | = | 45903 → 255 | 1 → 0 |
| M1/S01r-redirect-mapping.json | t2 | = | = | = | = | = | = | = | = | 46666 → 388 | 1 → 0 |
| M1/S01r-redirect-mapping.json | t3 | = | = | = | = | = | = | = | = | 47363 → 492 | 1 → 0 |
| M1/S02-router-mixed-memory.json | t1 | = | = | = | = | = | = | = | = | 87547 → 272 | 2 → 0 |
| M1/S02-router-mixed-memory.json | t2 | = | = | = | = | = | = | = | = | 88429 → 467 | 2 → 0 |
| M1/S02-router-mixed-memory.json | t3 | = | = | = | = | = | = | = | = | 89410 → 651 | 2 → 0 |
| M1/S02-router-mixed-memory.json | t4 | = | = | = | = | = | = | = | = | 46448 → 840 | 1 → 0 |
| M1/S02-router-mixed-memory.json | t5 | = | = | = | = | = | = | = | = | 90684 → 1020 | 2 → 0 |
| M1/S02-router-mixed-memory.json | t6 | = | = | = | = | = | = | = | = | 92181 → 1203 | 2 → 0 |
| M1/S03-parallel-agents-join.json | t1 | intended (TS25-S03-composer) | = | = | = | = | = | = | = | 132642 → 495 | 3 → 0 |
| M1/S03-parallel-agents-join.json | t2 | intended (TS25-S03-composer) | = | = | = | = | = | = | = | 134620 → 807 | 3 → 0 |
| M1/S03-parallel-agents-join.json | t3 | intended (TS25-S03-composer) | = | = | = | = | = | = | = | 136650 → 1086 | 3 → 0 |
| M1/S03-parallel-agents-join.json | t4 | intended (TS25-S03-composer) | = | = | = | = | = | = | = | 137350 → 1219 | 3 → 0 |
| M1/S04a-state-carry-persist-on.json | t1 | = | = | = | = | = | = | = | = | 45565 → 313 | 1 → 0 |
| M1/S04a-state-carry-persist-on.json | t2 | = | = | = | = | = | = | = | = | 46952 → 483 | 1 → 0 |
| M1/S04a-state-carry-persist-on.json | t3 | = | = | = | = | = | = | = | = | 47396 → 681 | 1 → 0 |
| M1/S04a-state-carry-persist-on.json | t4 | = | = | = | = | = | = | = | = | 48844 → 859 | 1 → 0 |
| M1/S04b-state-carry-persist-off.json | t1 | = | = | = | = | = | = | = | = | 45743 → 313 | 1 → 0 |
| M1/S04b-state-carry-persist-off.json | t2 | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | = | intended (F03-S04b-state-carries) | = | = | 46571 → 483 | 1 → 0 |
| M1/S04b-state-carry-persist-off.json | t3 | intended (F03-S04b-state-carries) | = | = | = | = | intended (F03-S04b-state-carries) | = | = | 47588 → 681 | 1 → 0 |
| M1/S04b-state-carry-persist-off.json | t4 | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | intended (F03-S04b-state-carries) | = | intended (F03-S04b-state-carries) | = | = | 48477 → 859 | 1 → 0 |
| M1/S05-form-then-chat.json | t1 | = | = | = | = | = | = | = | = | 44704 → 269 | 1 → 0 |
| M1/S05-form-then-chat.json | t2 | = | = | = | = | = | = | = | = | 45630 → 441 | 1 → 0 |
| M1/S05-form-then-chat.json | t3 | = | = | = | = | = | = | = | = | 46480 → 597 | 1 → 0 |
| M1/S05-form-then-chat.json | t4 | intended (F04-S05-new-form-wins) | = | = | = | = | = | = | = | 47381 → 765 | 1 → 0 |
| M1/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48209 → 1116 | 1 → 0 |
| M1/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 95550 → 1614 | 2 → 0 |
| M1/S06-human-review-with-feedback.json | t3 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 136161 → 866 | 3 → 0 |
| M1/S06-human-review-with-feedback.json | t4 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 52462 → 1847 | 1 → 0 |
| M1/S06-human-review-with-feedback.json | t5 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 94364 → 1316 | 2 → 0 |
| M1/S06b-human-review-history-off.json | t1 | = | = | = | = | = | = | = | = | 47383 → 900 | 1 → 0 |
| M1/S06b-human-review-history-off.json | t2 | = | = | = | = | = | = | = | = | 92634 → 1145 | 2 → 0 |
| M1/S06b-human-review-history-off.json | t3 | intended (F06-S06b-toggle-off) | = | = | = | = | = | = | = | 134516 → 354 | 3 → 0 |
| M1/S06b-human-review-history-off.json | t4 | intended (F06-S06b-toggle-off) | = | = | = | = | = | = | = | 50624 → 1139 | 1 → 0 |
| M1/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47413 → 227 | 1 → 0 |
| M1/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136357 → 1588 | 3 → 0 |
| M1/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48597 → 643 | 1 → 0 |
| M1/S07-agent-tool-approval.json | t4 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 139286 → 1971 | 3 → 0 |
| M1/S07-agent-tool-approval.json | t5 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 49863 → 1138 | 1 → 0 |
| M1/S07-agent-tool-approval.json | t6 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 50814 → 1272 | 1 → 0 |
| M1/S08-parallel-stops.json | t1 | = | = | = | = | = | = | = | = | 134749 → 1967 | 3 → 0 |
| M1/S08-parallel-stops.json | t2 | = | = | = | = | = | = | = | = | 48275 → 1176 | 1 → 0 |
| M1/S08-parallel-stops.json | t3 | intended (F05-S08-answers-in-history) | = | = | = | = | = | = | = | 91855 → 754 | 2 → 0 |
| M1/S08-parallel-stops.json | t4 | intended (F05-S08-answers-in-history) | = | = | = | = | = | = | = | 51192 → 1646 | 1 → 0 |
| M1/S09-iteration-and-loop.json | t1 | intended (TS25-S09-aggregator) | = | = | = | = | = | = | = | 305725 → 298 | 7 → 0 |
| M1/S09-iteration-and-loop.json | t2 | = | = | = | = | = | = | = | = | 220255 → 504 | 5 → 0 |
| M1/S09-iteration-and-loop.json | t3 | intended (TS25-S09-aggregator) | = | = | = | = | = | = | = | 308061 → 656 | 7 → 0 |
| M1/S10a-client-history-field@accept-client-history-off.json | t1 | intended (F02-S10a-accept-off) | = | = | = | = | = | = | = | 131933 → 221 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-off.json | t2 | intended (F02-S10a-accept-off) | = | = | = | = | = | = | = | 133146 → 381 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-off.json | t3 | intended (F02-S10a-accept-off) | = | = | = | = | = | = | = | 134132 → 532 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-off.json | t4 | intended (F02-S10a-accept-off) | = | = | = | = | = | = | = | 135631 → 703 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-on.json | t1 | intended (F02-S10a-accept-on) | = | = | = | = | = | = | = | 131933 → 314 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-on.json | t2 | intended (F02-S10a-accept-on) | = | = | = | = | = | = | = | 133146 → 474 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-on.json | t3 | intended (F02-S10a-accept-on) | = | = | = | = | = | = | = | 134132 → 529 | 3 → 0 |
| M1/S10a-client-history-field@accept-client-history-on.json | t4 | intended (F02-S10a-accept-on) | = | = | = | = | = | = | = | 135631 → 796 | 3 → 0 |
| M1/S10b-ephemeral-with-state.json | t1 | = | = | = | = | = | = | = | = | 45568 → 290 | 1 → 0 |
| M1/S10b-ephemeral-with-state.json | t2 | intended (F11-S10b-ephemeral-dropped) | = | = | = | = | = | = | = | 45401 → 452 | 1 → 0 |
| M1/S10b-ephemeral-with-state.json | t3 | intended (F11-S10b-ephemeral-dropped) | = | = | = | = | = | = | = | 45220 → 573 | 1 → 0 |
| M1/S11-error-and-recovery.json | t1 | = | = | = | = | = | = | = | = | 130844 → 290 | 3 → 0 |
| M1/S11-error-and-recovery.json | t2 | = | = | = | = | = | = | = | = | 45151 → 295 | 1 → 0 |
| M1/S11-error-and-recovery.json | t3 | = | = | = | = | = | = | = | = | 131918 → 442 | 3 → 0 |
| M1/S12-execute-flow-child-memory.json | t1 | = | = | = | = | = | = | = | = | 45689 → 726 | 1 → 0 |
| M1/S12-execute-flow-child-memory.json | t2 | intended (F10-S12-child-token) | intended (F10-S12-child-token) | intended (F10-S12-child-token) | = | = | intended (F10-S12-child-token) | = | = | 46731 → 1040 | 1 → 0 |
| M1/S12-execute-flow-child-memory.json | t3 | intended (F10-S12-child-token) | intended (F10-S12-child-token) | intended (F10-S12-child-token) | = | = | intended (F10-S12-child-token) | = | = | 47697 → 1295 | 1 → 0 |
| M1/S12-execute-flow-child-memory.json | t4 | intended (F10-S12-child-token) | intended (F10-S12-child-token) | intended (F10-S12-child-token) | = | = | intended (F10-S12-child-token) | = | = | 48611 → 1548 | 1 → 0 |
| M1/S13-non-streaming-conversation.json | t1 | = | = | = | = | = | = | = | = | 0 → 237 | 0 → 0 |
| M1/S13-non-streaming-conversation.json | t2 | intended (F14-S13-token-in-json) | = | = | = | = | = | = | = | 0 → 363 | 0 → 0 |
| M1/S13-non-streaming-conversation.json | t3 | intended (F14-S13-token-in-json) | = | = | = | = | = | = | = | 0 → 482 | 0 → 0 |
| M1-internal/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46159 → 311 | 1 → 0 |
| M1-internal/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47076 → 506 | 1 → 0 |
| M1-internal/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48845 → 689 | 1 → 0 |
| M1-internal/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49339 → 919 | 1 → 0 |
| M1-internal/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50105 → 1073 | 1 → 0 |
| M1-internal/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47458 → 227 | 1 → 0 |
| M1-internal/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136438 → 1588 | 3 → 0 |
| M1-internal/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48696 → 643 | 1 → 0 |
| M1-internal/S07-agent-tool-approval.json | t4 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 139421 → 1971 | 3 → 0 |
| M1-internal/S07-agent-tool-approval.json | t5 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 50016 → 1138 | 1 → 0 |
| M1-internal/S07-agent-tool-approval.json | t6 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 51003 → 1272 | 1 → 0 |
| M1-reqflag/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46178 → 311 | 1 → 0 |
| M1-reqflag/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47107 → 506 | 1 → 0 |
| M1-reqflag/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48888 → 689 | 1 → 0 |
| M1-reqflag/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49394 → 919 | 1 → 0 |
| M1-reqflag/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50173 → 1073 | 1 → 0 |
| M2/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46138 → 311 | 1 → 0 |
| M2/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47035 → 506 | 1 → 0 |
| M2/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48784 → 689 | 1 → 0 |
| M2/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49258 → 919 | 1 → 0 |
| M2/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50004 → 1073 | 1 → 0 |
| M2/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48233 → 1169 | 1 → 0 |
| M2/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 95582 → 1667 | 2 → 0 |
| M2/S06-human-review-with-feedback.json | t3 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 136201 → 866 | 3 → 0 |
| M2/S06-human-review-with-feedback.json | t4 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 52518 → 1900 | 1 → 0 |
| M2/S06-human-review-with-feedback.json | t5 | intended (F05-S06-answers-in-history) | = | = | = | = | = | = | = | 94428 → 1316 | 2 → 0 |
| M2/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47436 → 227 | 1 → 0 |
| M2/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136397 → 1641 | 3 → 0 |
| M2/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48645 → 643 | 1 → 0 |
| M2/S07-agent-tool-approval.json | t4 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 139350 → 2024 | 3 → 0 |
| M2/S07-agent-tool-approval.json | t5 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 49935 → 1138 | 1 → 0 |
| M2/S07-agent-tool-approval.json | t6 | intended (F05-S07-answers-in-history) | = | = | = | = | = | = | = | 50902 → 1272 | 1 → 0 |
| M2/S08-parallel-stops.json | t1 | = | = | = | = | = | = | = | = | 134773 → 2020 | 3 → 0 |
| M2/S08-parallel-stops.json | t2 | = | = | = | = | = | = | = | = | 48307 → 1229 | 1 → 0 |
| M2/S08-parallel-stops.json | t3 | intended (F05-S08-answers-in-history) | = | = | = | = | = | = | = | 91895 → 754 | 2 → 0 |
| M2/S08-parallel-stops.json | t4 | intended (F05-S08-answers-in-history) | = | = | = | = | = | = | = | 51248 → 1699 | 1 → 0 |
| M3/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46524 → 311 | 1 → 0 |
| M3/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47807 → 506 | 1 → 0 |
| M3/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 49925 → 689 | 1 → 0 |
| M3/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 50785 → 919 | 1 → 0 |
| M3/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 51917 → 1073 | 1 → 0 |
| M3/S05-form-then-chat.json | t1 | = | = | = | = | = | = | = | = | 45114 → 269 | 1 → 0 |
| M3/S05-form-then-chat.json | t2 | = | = | = | = | = | = | = | = | 46442 → 441 | 1 → 0 |
| M3/S05-form-then-chat.json | t3 | = | = | = | = | = | = | = | = | 47694 → 597 | 1 → 0 |
| M3/S05-form-then-chat.json | t4 | intended (F01-M3-like-M1, F04-S05-new-form-wins) | = | = | = | = | = | = | = | 48997 → 765 | 1 → 0 |
| M3/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48605 → 1224 | 1 → 0 |
| M3/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 97361 → 1722 | 2 → 0 |
| M3/S06-human-review-with-feedback.json | t3 | = | = | = | = | = | = | = | = | 139841 → 866 | 3 → 0 |
| M3/S06-human-review-with-feedback.json | t4 | intended (F01-M3-like-M1) | = | = | = | = | = | = | = | 56846 → 1955 | 1 → 0 |
| M3/S06-human-review-with-feedback.json | t5 | intended (F01-M3-like-M1) | = | = | = | = | = | = | = | 100805 → 1316 | 2 → 0 |
| M3/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47806 → 227 | 1 → 0 |
| M3/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 137138 → 1696 | 3 → 0 |
| M3/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 94092 → 643 | 2 → 0 |
| M3/S07-agent-tool-approval.json | t4 | intended (F01-M3-like-M1) | = | = | = | = | = | = | = | 185283 → 2079 | 4 → 0 |
| M3/S07-agent-tool-approval.json | t5 | intended (F01-M3-like-M1) | = | = | = | = | = | = | = | 141159 → 1138 | 3 → 0 |
| M3/S07-agent-tool-approval.json | t6 | intended (F01-M3-like-M1) | = | = | = | = | = | = | = | 142600 → 1272 | 3 → 0 |
| M3/S12-execute-flow-child-memory.json | t1 | = | = | = | = | = | = | = | = | 46099 → 726 | 1 → 0 |
| M3/S12-execute-flow-child-memory.json | t2 | = | = | = | = | = | = | = | = | 47543 → 1040 | 1 → 0 |
| M3/S12-execute-flow-child-memory.json | t3 | = | = | = | = | = | = | = | = | 48911 → 1295 | 1 → 0 |
| M3/S12-execute-flow-child-memory.json | t4 | = | = | = | = | = | = | = | = | 50227 → 1548 | 1 → 0 |
| M3-envflags/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46160 → 311 | 1 → 0 |
| M3-envflags/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47076 → 506 | 1 → 0 |
| M3-envflags/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48846 → 689 | 1 → 0 |
| M3-envflags/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49339 → 919 | 1 → 0 |
| M3-envflags/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50105 → 1073 | 1 → 0 |

## Intended entries

| Entry | Class A differences seen | Checks passed | Checks failed | Checks pending |
| :--- | ---: | ---: | ---: | ---: |
| TS25-S03-composer | 4 | 4 | 0 | 0 |
| F03-S04b-state-carries | 12 | 4 | 0 | 0 |
| F04-S05-new-form-wins | 2 | 2 | 0 | 0 |
| F05-S06-answers-in-history | 6 | 6 | 0 | 0 |
| F06-S06b-toggle-off | 2 | 9 | 0 | 0 |
| F05-S07-answers-in-history | 9 | 6 | 0 | 0 |
| F05-S08-answers-in-history | 4 | 4 | 0 | 0 |
| TS25-S09-aggregator | 2 | 2 | 0 | 0 |
| F02-S10a-accept-off | 4 | 12 | 0 | 0 |
| F02-S10a-accept-on | 4 | 11 | 0 | 0 |
| F11-S10b-ephemeral-dropped | 2 | 3 | 0 | 0 |
| F10-S12-child-token | 12 | 3 | 0 | 0 |
| F14-S13-token-in-json | 2 | 4 | 0 | 0 |
| F01-M3-like-M1 | 6 | 24 | 0 | 0 |
| F13-no-records-in-token | 0 | 106 | 0 | 0 |
| F18-executed-data-external | 0 | 254 | 0 | 0 |
| F18-external-record-keys | 0 | 127 | 0 | 0 |
| TS26-pending-only-while-stopped | 0 | 138 | 0 | 0 |
| SIZE-token-v2 | 0 | 127 | 0 | 0 |
| F07-alternating-history | 0 | 34 | 0 | 0 |
| F08-no-action-in-history | 0 | 51 | 0 | 0 |
| F19-slim-action | 0 | 71 | 0 | 0 |
| F09-no-record-copies | 0 | 8 | 0 | 0 |
| F13-tool-approval-pending | 0 | 32 | 0 | 0 |
| F07-S08-blank-stop-message | 0 | 2 | 0 | 0 |
| F12-S09-no-parent-lookup | 0 | 3 | 0 | 0 |
| TS14-failed-turn | 0 | 1 | 0 | 0 |
| SIZE-token-v2-S12 | 0 | 8 | 0 | 0 |
| SIZE-token-v2-S13 | 0 | 3 | 0 | 0 |
| F18-executed-data-internal | 0 | 11 | 0 | 0 |
| F18-internal-like-external | 0 | 11 | 0 | 0 |
| F15-F16-switches-only-control-writes | 0 | 10 | 0 | 0 |
| TS5-saved-executions-full | 0 | 20 | 0 | 0 |
