# Task 03: Contract Proof (Field Removal)

- **Status**: Done (TS-O1: variant (b) recommended, §5.4; recorded in PLAN §2 by the plan session)
- **Depends On**: [01-test-harness-and-characterization-tests.md](./01-test-harness-and-characterization-tests.md), [02-field-inventory-and-size-anatomy.md](./02-field-inventory-and-size-anatomy.md)
- **Primary Files**:
  - `packages/server/test/utils/buildAgentflow/trustedState/fieldRemoval.test.ts` (new)
  - `plans/agentflow-trusted-state/field-inventory.md` (adds a "Proven by removal" column)

---

## 1. Objective

Prove on today's code that the token fields of TS19 (history, flow state, form values) are all a normal turn needs, and **resolve TS-O1**: find the least a stopped turn needs to resume correctly, before any production change.

---

## 2. Method

For each scenario S01–S13 and each turn boundary n → n+1:
1. Run turns 1…n with the Task 01 runner and take the real token T(n).
2. Build modified tokens (decode, strip, re-encode) and run turn n+1 with each, comparing class A results with the run on the original token.

Modified tokens:
- **Contract token** for normal turns: only history, the final flow state and the form values, each placed where today's code still reads it (form values in the Start record's `output.form`), so the test runs on unchanged code. Expected: class A identical.
- **Single-field removals** from the inventory (e.g. `data.input.messages`, `data.output` except what is read, `data.state` on all but the latest record, history metadata fields, the `action` string on history messages), to confirm the inventory's "needed" column.
- **Stopped turns, TS-O1 variants** for S06–S08, from smallest to largest: (a) only the needed state: stopped node ids, the pending tool calls (ids, names, arguments) and the stop-time flow state, with the system prompt and history rebuilt on resume by a test-only helper; (b) (a) plus the assistant message that holds the tool calls; (c) the full checkpoint stored once. Record identity of model calls and token size for each.

Test-only helpers live in the test folder, not in `src/`.

---

## 3. Outputs

- `field-inventory.md`: "Proven by removal" column (`removable` / `required in <scenarios>`) and a "Minimal contract" section.
- A results section in this file for TS-O1: per variant, whether model calls stay identical in S06–S08 and the token size at the paused turn.
- **TS-O1 resolution**: the smallest variant that resumes correctly (direction: only the needed state). If it changes model input compared with today, ask the user before choosing it. Record the result in PLAN §2 and move TS-O1 to the resolved table.

---

## 4. Acceptance Criteria

- [x] The contract token keeps class A identical for every normal-turn boundary of S01–S13, or each exception is explained and added to 00c as a finding. (All 43 identical, no exception: §5.2.)
- [x] TS-O1 variants measured on S06–S08, TS-O1 resolved and recorded in PLAN §2. (Measured with five probes: §5.4; the plan session records the resolution in PLAN §2.)
- [x] Tests stay in the suite as regression guards (< 60 s). (`fieldRemoval.test.ts`, 41 tests: 32–44 s, of which about 20 s is module loading; the trusted state suite now takes about 60 s.)
- [x] No production code changed.

---

## 5. Results

Test: `packages/server/test/utils/buildAgentflow/trustedState/fieldRemoval.test.ts`, 41 tests on the Task 01 harness, M1. `TS03_REPORT=1` prints every measurement below as JSON.

### 5.1 Method as built

- **Outcome compared** at each boundary: class A (status, error, final text, streamed tokens, node runs and statuses, final state, the action's slim fields, model requests per route) plus the history (role, content), flow state and form values of the token the turn writes, so a difference that would only show on the following turn is caught as well.
- **Resume turns** carry the stopped run's records into their own executed data (F09); the node list counts only the nodes the turn ran.
- **S13** turns ran without a token (F14), so its boundaries compare runs from the token the server built. **S11** runs with shorter scripted delays (LLM B 10 ms, Agent A's error 250 ms) that keep its branch order.
- **Probes**: test-only variations of S06–S08 for what the scripted resumes do not exercise (Task 02 asked for a reference to a stopped-run output before outputs are dropped):

| Probe | Built from | Exercises | Today's behaviour |
| :--- | :--- | :--- | :--- |
| P1 S06 rejected twice | S06 t1, t2, then a second reject | loop count across a resume | t3 reaches the Revise Loop max: "Loop completed after reaching maximum iteration count of 2." |
| P2 S08 manager denies | S08 t1, t2, then the gate rejects | a node finished in an earlier resume (Policy Check, t2) joined with the gate's branch | t3 runs Rejected Reply **and** the Summary (one activated in-edge is enough) |
| P3 S06 reads the Drafter and the state | S06 with Start state `stage: review` and the Finalizer prompt reading `{{agentAgentflow_0}}` and `{{$flow.state.stage}}` | an output and the flow state read after a resume | t3 and t5 prompts carry the Drafter's last draft and "Stage: review" |
| P4 S07 tool call with text | S07 t1–t3, the t2 tool call with text next to it | text in the tool-call message | t2 streams the text twice; on resume LangChain's OpenAI converter sends `content: ""` for any AI message with tool calls, so the model never sees the text |
| P5 S08 gate approved first | S08 t1, the gate approved first (explicit `startNodeId`), then the Policy Check | a decision that finished in the stopped run | t3 runs Policy Check and Summary; Rejected Reply stays skipped |

### 5.2 Contract token (normal turns)

Only the history (`role`, `content`), the latest flow state and the form values, placed where today's code reads them (state on the last record, form values in the Start record's `output.form`): **class A identical at all 43 normal-turn boundaries of S01–S13.** No exception, so no new finding.

Each contract field is required (contract token minus that field; history fields at each scenario's first normal turn with history):

| Removed | Outcome changes at |
| :--- | :--- |
| history, or every message's `role`, or every message's `content` | every scenario but S10b (S10b's ephemeral memory hides the history) |
| flow state (where not empty) | S04a t2–t4, S10b t2–t3; S03, S04b, S11, S12 carry state no node reads on the next turn |
| form values, or the Start record's `data.name` | S05 t2–t4 |

### 5.3 Resumes: single-field removals

From the original token, at the 19 resume boundaries (S06 t2/t3/t5, S06b t2/t3, S07 t3/t5, S08 t2/t3, P1 t2/t3, P2 t2/t3, P3 t2/t3/t5, P4 t3, P5 t2/t3):

| Removed | Outcome changes at |
| :--- | :--- |
| every field marked drop, at once (history metadata, `previousExecution.id` and envelope, record labels, `previousNodeIds`, `data.id`, `data.name`, `data.input`, `data.chatHistory`, other output fields, condition fields but `isFulfilled`, the stopped node's input but the messages and the feedback flag, `humanInputAction.extra`, state copies but the latest) | nowhere |
| history message `action` | every resume but S06b's: a user message is saved; S06b's toggle removes it again |
| history message `action` replaced by a marker string | nowhere |
| `previousExecution.state`, or record `nodeId` | every resume (it fails) |
| record `status` | S06 t2, S06b t2, S08 t2/t3, P1 t2/t3, P2 t2/t3, P3 t2, P5 t2/t3 |
| checkpoint messages (`humanInputAction.data.input.messages`) | S07 t3/t5, S08 t2, P2 t2, P4 t3, P5 t3: every Agent resume, no HumanInput resume |
| action `id`, `mapping`, `elements`, `data.nodeId`, `data.nodeLabel` | S08 t2, P2 t2, P5 t2: a branch still stopped is announced again from its record |
| `output.content` | P3 t3/t5 |
| decision `conditions` | P5 t3 |
| loop `output.{nodeID, maxLoopCount}` | S06 t3, S06b t3, P1 t3, P3 t3 |
| `data.state` on every record | P3 t2/t3/t5 |
| finished records (stopped ones kept) | P1 t3, P2 t3, P3 t3/t5 |

The resulting minimal contract, with the "Proven by removal" column, is in [field-inventory.md](./field-inventory.md) §6.

### 5.4 TS-O1: pending resume data

Every variant carries the contract fields (history `role`/`content` with a pending marker on the stop message, the flow state as the stop-time state) and the same base, which §5.3 shows is needed: the run skeleton (node id, status, decision outcomes, loop target and max count per record), the outputs of finished nodes another node references, and the slim action of each stopped node. They differ in the stopped Agent's checkpoint:

- **(a)** the pending tool calls (`id`, `name`, `args`) and the history length at the stop; a test-only helper rebuilds the prompt with the server's `resolveVariables` and the Agent's message order (system prompt, history before the stopped turn, that turn's question) and adds a tool-call message without text.
- **(b)** as (a), but with the assistant message holding the tool calls (text, tool calls, id, usage) instead of the bare calls.
- **(c)** the checkpoint messages stored once.

The rebuilt checkpoint equals the stored one at all seven Agent stops (S07 t2/t4, S08 t1, P2 t1, P4 t2, P5 t1/t2).

| Variant | S06 | S07 | S08 | Probes P1–P5 | Prompt copies in the paused token |
| :--- | :--- | :--- | :--- | :--- | :--- |
| (a) | identical | identical | identical | identical | 0 |
| (b) | identical | identical | identical | identical | 0 |
| (c) | identical | identical | identical | identical | 1 per stopped Agent |

Paused token sizes, base64 characters (today's v1 token; the contract fields alone; the contract fields with each variant's pending data):

| Paused turn | Today | Contract only | (a) | (b) | (c) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| S06 t1 | 15,268 | 344 | 680 | 680 | 724 |
| S06 t2 | 27,716 | 420 | 808 | 808 | 908 |
| S06 t4 | 16,036 | 544 | 872 | 872 | 964 |
| S07 t2 | 39,676 | 428 | 752 | 856 | 13,852 |
| S07 t4 | 40,368 | 500 | 828 | 932 | 14,124 |
| S08 t1 | 38,656 | 408 | 868 | 972 | 13,668 |
| S08 t2 | 15,412 | 416 | 728 | 728 | 744 |

HumanInput stops (S06, S08 t2) read no checkpoint, so (a) and (b) are the same there; (c) adds the HumanInput's history copy.

**Recommendation: (b).** Model input is identical to today in every measured case (S06–S08 and P1–P5), the paused token stays under 1 KB with no system prompt, and the tool-call message costs about 100 characters over (a). (a) drops the text the model wrote next to the tool call: invisible with ChatOpenAI (P4), but providers whose LangChain converter sends that text (Anthropic, for one) would get different input on resume.

Rebuilding the prompt can differ from today's replay where the measured scenarios do not go; each is a model input change, so the user decides (TS-O1 rule):

1. **Values that change while paused** are taken at resume time: `{{current_date_time}}`, `$vars` edited meanwhile, and flow state changed by another branch resumed first (unless the stop-time state is kept for that Agent).
2. **What the history does not hold**: the stopped turn's question with its uploads, same-turn messages of earlier nodes (an Agent that is not the first node of its turn), a summary memory's summary (re-summarising costs a model call and may differ). Keeping in the pending data the checkpoint messages the history does not hold, next to the tool-call message, covers these and leaves only the system prompt rebuilt. In S06–S08 there are none, so the sizes above stand.
3. **The flow edited while paused** (prompt, memory settings): the resume uses the new version.

(c) replays exactly in all of these, at about 13–14 K characters per stopped Agent (one prompt copy, which invariant 6 allows only while paused).

