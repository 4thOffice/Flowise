# Trace comparison

- Before: `traces/before`
- After: `traces/before`
- Intended entries: 33
- Failures: 628

| Trace | Turn | modelRequests | streamedTokens | finalText | nodeSequence | status | finalState | action | error | Token bytes (before → after) | Token sentinels |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | ---: | ---: |
| M1/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46115 → 46115 | 1 → 1 |
| M1/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 46995 → 46995 | 1 → 1 |
| M1/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48729 → 48729 | 1 → 1 |
| M1/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49186 → 49186 | 1 → 1 |
| M1/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 49916 → 49916 | 1 → 1 |
| M1/S01r-redirect-mapping.json | t1 | = | = | = | = | = | = | = | = | 45903 → 45903 | 1 → 1 |
| M1/S01r-redirect-mapping.json | t2 | = | = | = | = | = | = | = | = | 46666 → 46666 | 1 → 1 |
| M1/S01r-redirect-mapping.json | t3 | = | = | = | = | = | = | = | = | 47363 → 47363 | 1 → 1 |
| M1/S02-router-mixed-memory.json | t1 | = | = | = | = | = | = | = | = | 87547 → 87547 | 2 → 2 |
| M1/S02-router-mixed-memory.json | t2 | = | = | = | = | = | = | = | = | 88429 → 88429 | 2 → 2 |
| M1/S02-router-mixed-memory.json | t3 | = | = | = | = | = | = | = | = | 89410 → 89410 | 2 → 2 |
| M1/S02-router-mixed-memory.json | t4 | = | = | = | = | = | = | = | = | 46448 → 46448 | 1 → 1 |
| M1/S02-router-mixed-memory.json | t5 | = | = | = | = | = | = | = | = | 90684 → 90684 | 2 → 2 |
| M1/S02-router-mixed-memory.json | t6 | = | = | = | = | = | = | = | = | 92181 → 92181 | 2 → 2 |
| M1/S03-parallel-agents-join.json | t1 | = | = | = | = | = | = | = | = | 132642 → 132642 | 3 → 3 |
| M1/S03-parallel-agents-join.json | t2 | = | = | = | = | = | = | = | = | 134620 → 134620 | 3 → 3 |
| M1/S03-parallel-agents-join.json | t3 | = | = | = | = | = | = | = | = | 136650 → 136650 | 3 → 3 |
| M1/S03-parallel-agents-join.json | t4 | = | = | = | = | = | = | = | = | 137350 → 137350 | 3 → 3 |
| M1/S04a-state-carry-persist-on.json | t1 | = | = | = | = | = | = | = | = | 45565 → 45565 | 1 → 1 |
| M1/S04a-state-carry-persist-on.json | t2 | = | = | = | = | = | = | = | = | 46952 → 46952 | 1 → 1 |
| M1/S04a-state-carry-persist-on.json | t3 | = | = | = | = | = | = | = | = | 47396 → 47396 | 1 → 1 |
| M1/S04a-state-carry-persist-on.json | t4 | = | = | = | = | = | = | = | = | 48844 → 48844 | 1 → 1 |
| M1/S04b-state-carry-persist-off.json | t1 | = | = | = | = | = | = | = | = | 45743 → 45743 | 1 → 1 |
| M1/S04b-state-carry-persist-off.json | t2 | = | = | = | = | = | = | = | = | 46571 → 46571 | 1 → 1 |
| M1/S04b-state-carry-persist-off.json | t3 | = | = | = | = | = | = | = | = | 47588 → 47588 | 1 → 1 |
| M1/S04b-state-carry-persist-off.json | t4 | = | = | = | = | = | = | = | = | 48477 → 48477 | 1 → 1 |
| M1/S05-form-then-chat.json | t1 | = | = | = | = | = | = | = | = | 44704 → 44704 | 1 → 1 |
| M1/S05-form-then-chat.json | t2 | = | = | = | = | = | = | = | = | 45630 → 45630 | 1 → 1 |
| M1/S05-form-then-chat.json | t3 | = | = | = | = | = | = | = | = | 46480 → 46480 | 1 → 1 |
| M1/S05-form-then-chat.json | t4 | = | = | = | = | = | = | = | = | 47381 → 47381 | 1 → 1 |
| M1/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48209 → 48209 | 1 → 1 |
| M1/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 95550 → 95550 | 2 → 2 |
| M1/S06-human-review-with-feedback.json | t3 | = | = | = | = | = | = | = | = | 136161 → 136161 | 3 → 3 |
| M1/S06-human-review-with-feedback.json | t4 | = | = | = | = | = | = | = | = | 52462 → 52462 | 1 → 1 |
| M1/S06-human-review-with-feedback.json | t5 | = | = | = | = | = | = | = | = | 94364 → 94364 | 2 → 2 |
| M1/S06b-human-review-history-off.json | t1 | = | = | = | = | = | = | = | = | 47383 → 47383 | 1 → 1 |
| M1/S06b-human-review-history-off.json | t2 | = | = | = | = | = | = | = | = | 92634 → 92634 | 2 → 2 |
| M1/S06b-human-review-history-off.json | t3 | = | = | = | = | = | = | = | = | 134516 → 134516 | 3 → 3 |
| M1/S06b-human-review-history-off.json | t4 | = | = | = | = | = | = | = | = | 50624 → 50624 | 1 → 1 |
| M1/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47413 → 47413 | 1 → 1 |
| M1/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136357 → 136357 | 3 → 3 |
| M1/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48597 → 48597 | 1 → 1 |
| M1/S07-agent-tool-approval.json | t4 | = | = | = | = | = | = | = | = | 139286 → 139286 | 3 → 3 |
| M1/S07-agent-tool-approval.json | t5 | = | = | = | = | = | = | = | = | 49863 → 49863 | 1 → 1 |
| M1/S07-agent-tool-approval.json | t6 | = | = | = | = | = | = | = | = | 50814 → 50814 | 1 → 1 |
| M1/S08-parallel-stops.json | t1 | = | = | = | = | = | = | = | = | 134749 → 134749 | 3 → 3 |
| M1/S08-parallel-stops.json | t2 | = | = | = | = | = | = | = | = | 48275 → 48275 | 1 → 1 |
| M1/S08-parallel-stops.json | t3 | = | = | = | = | = | = | = | = | 91855 → 91855 | 2 → 2 |
| M1/S08-parallel-stops.json | t4 | = | = | = | = | = | = | = | = | 51192 → 51192 | 1 → 1 |
| M1/S09-iteration-and-loop.json | t1 | = | = | = | = | = | = | = | = | 305725 → 305725 | 7 → 7 |
| M1/S09-iteration-and-loop.json | t2 | = | = | = | = | = | = | = | = | 220255 → 220255 | 5 → 5 |
| M1/S09-iteration-and-loop.json | t3 | = | = | = | = | = | = | = | = | 308061 → 308061 | 7 → 7 |
| M1/S10a-client-history-field.json | t1 | = | = | = | = | = | = | = | = | 131933 → 131933 | 3 → 3 |
| M1/S10a-client-history-field.json | t2 | = | = | = | = | = | = | = | = | 133146 → 133146 | 3 → 3 |
| M1/S10a-client-history-field.json | t3 | = | = | = | = | = | = | = | = | 134132 → 134132 | 3 → 3 |
| M1/S10a-client-history-field.json | t4 | = | = | = | = | = | = | = | = | 135631 → 135631 | 3 → 3 |
| M1/S10b-ephemeral-with-state.json | t1 | = | = | = | = | = | = | = | = | 45568 → 45568 | 1 → 1 |
| M1/S10b-ephemeral-with-state.json | t2 | = | = | = | = | = | = | = | = | 45401 → 45401 | 1 → 1 |
| M1/S10b-ephemeral-with-state.json | t3 | = | = | = | = | = | = | = | = | 45220 → 45220 | 1 → 1 |
| M1/S11-error-and-recovery.json | t1 | = | = | = | = | = | = | = | = | 130844 → 130844 | 3 → 3 |
| M1/S11-error-and-recovery.json | t2 | = | = | = | = | = | = | = | = | 45151 → 45151 | 1 → 1 |
| M1/S11-error-and-recovery.json | t3 | = | = | = | = | = | = | = | = | 131918 → 131918 | 3 → 3 |
| M1/S12-execute-flow-child-memory.json | t1 | = | = | = | = | = | = | = | = | 45689 → 45689 | 1 → 1 |
| M1/S12-execute-flow-child-memory.json | t2 | = | = | = | = | = | = | = | = | 46731 → 46731 | 1 → 1 |
| M1/S12-execute-flow-child-memory.json | t3 | = | = | = | = | = | = | = | = | 47697 → 47697 | 1 → 1 |
| M1/S12-execute-flow-child-memory.json | t4 | = | = | = | = | = | = | = | = | 48611 → 48611 | 1 → 1 |
| M1/S13-non-streaming-conversation.json | t1 | = | = | = | = | = | = | = | = | 0 → 0 | 0 → 0 |
| M1/S13-non-streaming-conversation.json | t2 | = | = | = | = | = | = | = | = | 0 → 0 | 0 → 0 |
| M1/S13-non-streaming-conversation.json | t3 | = | = | = | = | = | = | = | = | 0 → 0 | 0 → 0 |
| M1-internal/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46159 → 46159 | 1 → 1 |
| M1-internal/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47076 → 47076 | 1 → 1 |
| M1-internal/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48845 → 48845 | 1 → 1 |
| M1-internal/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49339 → 49339 | 1 → 1 |
| M1-internal/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50105 → 50105 | 1 → 1 |
| M1-internal/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47458 → 47458 | 1 → 1 |
| M1-internal/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136438 → 136438 | 3 → 3 |
| M1-internal/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48696 → 48696 | 1 → 1 |
| M1-internal/S07-agent-tool-approval.json | t4 | = | = | = | = | = | = | = | = | 139421 → 139421 | 3 → 3 |
| M1-internal/S07-agent-tool-approval.json | t5 | = | = | = | = | = | = | = | = | 50016 → 50016 | 1 → 1 |
| M1-internal/S07-agent-tool-approval.json | t6 | = | = | = | = | = | = | = | = | 51003 → 51003 | 1 → 1 |
| M1-reqflag/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46178 → 46178 | 1 → 1 |
| M1-reqflag/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47107 → 47107 | 1 → 1 |
| M1-reqflag/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48888 → 48888 | 1 → 1 |
| M1-reqflag/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49394 → 49394 | 1 → 1 |
| M1-reqflag/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50173 → 50173 | 1 → 1 |
| M2/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46138 → 46138 | 1 → 1 |
| M2/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47035 → 47035 | 1 → 1 |
| M2/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48784 → 48784 | 1 → 1 |
| M2/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49258 → 49258 | 1 → 1 |
| M2/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50004 → 50004 | 1 → 1 |
| M2/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48233 → 48233 | 1 → 1 |
| M2/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 95582 → 95582 | 2 → 2 |
| M2/S06-human-review-with-feedback.json | t3 | = | = | = | = | = | = | = | = | 136201 → 136201 | 3 → 3 |
| M2/S06-human-review-with-feedback.json | t4 | = | = | = | = | = | = | = | = | 52518 → 52518 | 1 → 1 |
| M2/S06-human-review-with-feedback.json | t5 | = | = | = | = | = | = | = | = | 94428 → 94428 | 2 → 2 |
| M2/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47436 → 47436 | 1 → 1 |
| M2/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 136397 → 136397 | 3 → 3 |
| M2/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 48645 → 48645 | 1 → 1 |
| M2/S07-agent-tool-approval.json | t4 | = | = | = | = | = | = | = | = | 139350 → 139350 | 3 → 3 |
| M2/S07-agent-tool-approval.json | t5 | = | = | = | = | = | = | = | = | 49935 → 49935 | 1 → 1 |
| M2/S07-agent-tool-approval.json | t6 | = | = | = | = | = | = | = | = | 50902 → 50902 | 1 → 1 |
| M2/S08-parallel-stops.json | t1 | = | = | = | = | = | = | = | = | 134773 → 134773 | 3 → 3 |
| M2/S08-parallel-stops.json | t2 | = | = | = | = | = | = | = | = | 48307 → 48307 | 1 → 1 |
| M2/S08-parallel-stops.json | t3 | = | = | = | = | = | = | = | = | 91895 → 91895 | 2 → 2 |
| M2/S08-parallel-stops.json | t4 | = | = | = | = | = | = | = | = | 51248 → 51248 | 1 → 1 |
| M3/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46524 → 46524 | 1 → 1 |
| M3/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47807 → 47807 | 1 → 1 |
| M3/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 49925 → 49925 | 1 → 1 |
| M3/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 50785 → 50785 | 1 → 1 |
| M3/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 51917 → 51917 | 1 → 1 |
| M3/S05-form-then-chat.json | t1 | = | = | = | = | = | = | = | = | 45114 → 45114 | 1 → 1 |
| M3/S05-form-then-chat.json | t2 | = | = | = | = | = | = | = | = | 46442 → 46442 | 1 → 1 |
| M3/S05-form-then-chat.json | t3 | = | = | = | = | = | = | = | = | 47694 → 47694 | 1 → 1 |
| M3/S05-form-then-chat.json | t4 | = | = | = | = | = | = | = | = | 48997 → 48997 | 1 → 1 |
| M3/S06-human-review-with-feedback.json | t1 | = | = | = | = | = | = | = | = | 48605 → 48605 | 1 → 1 |
| M3/S06-human-review-with-feedback.json | t2 | = | = | = | = | = | = | = | = | 97361 → 97361 | 2 → 2 |
| M3/S06-human-review-with-feedback.json | t3 | = | = | = | = | = | = | = | = | 139841 → 139841 | 3 → 3 |
| M3/S06-human-review-with-feedback.json | t4 | = | = | = | = | = | = | = | = | 56846 → 56846 | 1 → 1 |
| M3/S06-human-review-with-feedback.json | t5 | = | = | = | = | = | = | = | = | 100805 → 100805 | 2 → 2 |
| M3/S07-agent-tool-approval.json | t1 | = | = | = | = | = | = | = | = | 47806 → 47806 | 1 → 1 |
| M3/S07-agent-tool-approval.json | t2 | = | = | = | = | = | = | = | = | 137138 → 137138 | 3 → 3 |
| M3/S07-agent-tool-approval.json | t3 | = | = | = | = | = | = | = | = | 94092 → 94092 | 2 → 2 |
| M3/S07-agent-tool-approval.json | t4 | = | = | = | = | = | = | = | = | 185283 → 185283 | 4 → 4 |
| M3/S07-agent-tool-approval.json | t5 | = | = | = | = | = | = | = | = | 141159 → 141159 | 3 → 3 |
| M3/S07-agent-tool-approval.json | t6 | = | = | = | = | = | = | = | = | 142600 → 142600 | 3 → 3 |
| M3/S12-execute-flow-child-memory.json | t1 | = | = | = | = | = | = | = | = | 46099 → 46099 | 1 → 1 |
| M3/S12-execute-flow-child-memory.json | t2 | = | = | = | = | = | = | = | = | 47543 → 47543 | 1 → 1 |
| M3/S12-execute-flow-child-memory.json | t3 | = | = | = | = | = | = | = | = | 48911 → 48911 | 1 → 1 |
| M3/S12-execute-flow-child-memory.json | t4 | = | = | = | = | = | = | = | = | 50227 → 50227 | 1 → 1 |
| M3-envflags/S01-single-agent-memory.json | t1 | = | = | = | = | = | = | = | = | 46160 → 46160 | 1 → 1 |
| M3-envflags/S01-single-agent-memory.json | t2 | = | = | = | = | = | = | = | = | 47076 → 47076 | 1 → 1 |
| M3-envflags/S01-single-agent-memory.json | t3 | = | = | = | = | = | = | = | = | 48846 → 48846 | 1 → 1 |
| M3-envflags/S01-single-agent-memory.json | t4 | = | = | = | = | = | = | = | = | 49339 → 49339 | 1 → 1 |
| M3-envflags/S01-single-agent-memory.json | t5 | = | = | = | = | = | = | = | = | 50105 → 50105 | 1 → 1 |

## Intended entries

| Entry | Class A differences seen | Checks passed | Checks failed | Checks pending |
| :--- | ---: | ---: | ---: | ---: |
| F13-no-records-in-token | 0 | 3 | 99 | 0 |
| F18-executed-data-external | 0 | 120 | 126 | 0 |
| TS26-pending-only-while-stopped | 0 | 105 | 29 | 0 |
| SIZE-token-v2 | 0 | 0 | 123 | 0 |
| TS25-S03-composer | 0 | 0 | 4 | 0 |
| F03-S04b-state-carries | 0 | 1 | 3 | 0 |
| F04-S05-new-form-wins | 0 | 0 | 2 | 0 |
| F07-alternating-history | 0 | 0 | 34 | 0 |
| F08-no-action-in-history | 0 | 0 | 51 | 0 |
| F19-slim-action | 0 | 41 | 40 | 0 |
| F09-no-record-copies | 0 | 0 | 8 | 0 |
| F05-S06-answers-in-history | 0 | 0 | 6 | 0 |
| F06-S06b-toggle-off | 0 | 2 | 7 | 0 |
| F13-tool-approval-pending | 0 | 0 | 32 | 0 |
| F05-S07-answers-in-history | 0 | 0 | 6 | 0 |
| F07-S08-blank-stop-message | 0 | 0 | 2 | 0 |
| F05-S08-answers-in-history | 0 | 0 | 4 | 0 |
| F12-S09-no-parent-lookup | 0 | 0 | 3 | 0 |
| TS25-S09-aggregator | 0 | 0 | 2 | 0 |
| F11-S10b-ephemeral-dropped | 0 | 1 | 2 | 0 |
| TS14-failed-turn | 0 | 1 | 0 | 0 |
| SIZE-token-v2-S12 | 0 | 0 | 8 | 0 |
| F10-S12-child-token | 0 | 0 | 3 | 0 |
| F14-S13-token-in-json | 0 | 0 | 4 | 0 |
| SIZE-token-v2-S13 | 0 | 3 | 0 | 0 |
| F18-executed-data-internal | 0 | 11 | 0 | 0 |
| F15-F16-switches-only-control-writes | 0 | 0 | 10 | 0 |
| TS5-saved-executions-full | 0 | 20 | 0 | 0 |
| F01-M3-like-M1 | 0 | 15 | 9 | 0 |

## Failures

- check-failed F13-no-records-in-token (99×)
- check-failed F18-executed-data-external (126×)
- check-failed SIZE-token-v2 (123×)
- check-failed TS25-S03-composer (4×)
- check-failed F03-S04b-state-carries (3×)
- check-failed F04-S05-new-form-wins (2×)
- check-failed F07-alternating-history (34×)
- check-failed F08-no-action-in-history (51×)
- check-failed F19-slim-action (40×)
- check-failed TS26-pending-only-while-stopped (29×)
- check-failed F09-no-record-copies (8×)
- check-failed F05-S06-answers-in-history (6×)
- check-failed F06-S06b-toggle-off (7×)
- check-failed F13-tool-approval-pending (32×)
- check-failed F05-S07-answers-in-history (6×)
- check-failed F07-S08-blank-stop-message (2×)
- check-failed F05-S08-answers-in-history (4×)
- check-failed F12-S09-no-parent-lookup (3×)
- check-failed TS25-S09-aggregator (2×)
- check-failed F11-S10b-ephemeral-dropped (2×)
- check-failed SIZE-token-v2-S12 (8×)
- check-failed F10-S12-child-token (3×)
- check-failed F14-S13-token-in-json (4×)
- check-failed F15-F16-switches-only-control-writes (10×)
- check-failed F01-M3-like-M1 (9×)
- intended-difference-missing F03-S04b-state-carries: F03-S04b-state-carries (F03) expected a difference that did not appear
- intended-difference-missing F04-S05-new-form-wins: F04-S05-new-form-wins (F04) expected a difference that did not appear
- intended-difference-missing F05-S06-answers-in-history: F05-S06-answers-in-history (F05) expected a difference that did not appear
- intended-difference-missing F05-S07-answers-in-history: F05-S07-answers-in-history (F05) expected a difference that did not appear
- intended-difference-missing F05-S08-answers-in-history: F05-S08-answers-in-history (F05) expected a difference that did not appear
- intended-difference-missing F06-S06b-toggle-off: F06-S06b-toggle-off (F06) expected a difference that did not appear
- intended-difference-missing F10-S12-child-token: F10-S12-child-token (F10) expected a difference that did not appear
- intended-difference-missing F11-S10b-ephemeral-dropped: F11-S10b-ephemeral-dropped (F11) expected a difference that did not appear
- intended-difference-missing F14-S13-token-in-json: F14-S13-token-in-json (F14) expected a difference that did not appear
- intended-difference-missing TS25-S03-composer: TS25-S03-composer (TS25) expected a difference that did not appear
- intended-difference-missing TS25-S09-aggregator: TS25-S09-aggregator (TS25) expected a difference that did not appear
