# Task 00b: Scenario Suite, Fake LLM & Baseline Capture

- **Status**: Done. Baseline commit `99e8d4b0`; suite, traces and results in [baselines/README.md](./baselines/README.md); repeatability in [baselines/reports/00b-before-repeatability.md](./baselines/reports/00b-before-repeatability.md). Beyond §3.1, modes M1-reqflag and M3-envflags make F15 and F16 visible.
- **Depends On**: [00-current-implementation.md](./00-current-implementation.md), [00c-findings.md](./00c-findings.md)
- **Runs on**: a detached worktree at a recorded commit (no production edits, no branch)
- **Primary Outputs** (under `plans/agentflow-trusted-state/baselines/`):
  - `fake-llm/fake-openai-server.mjs`: OpenAI-compatible fake with scripted replies and request recording
  - `flows/Sxx-*.json`: importable Agentflow V2 flows
  - `scenarios/Sxx-*.json`: turn scripts (requests per turn, modes, scripted model replies, expected-after notes per finding)
  - `capture-traces.mjs`, `lib/trusted-state-codec.mjs`, `lib/normalize.mjs`, `compare-traces.mjs`, `compare.config.json`
  - `traces/before/<mode>/<scenario>.json`, `traces/before/summary.json`
  - `README.md`: setup, commands, scenario table, before/after table with empty "after" columns

---

## 1. Objective

Build a reproducible, offline capture-and-compare suite that records, for every turn of realistic multi-turn conversations, **what each model received**, what the client received, and what the token held. Capture the `before/` baseline on today's code. Every finding in [00c-findings.md](./00c-findings.md) must be visible in at least one scenario, so its fix shows up as an intended difference later (TS6).

---

## 2. Fake OpenAI-Compatible Server

`fake-llm/fake-openai-server.mjs` (plain Node, no new dependencies):
- `POST /v1/chat/completions`, streaming and non-streaming, including `tool_calls` and `usage`; `GET /v1/models`.
- **Deterministic replies** chosen by rules from the active scenario script: route marker in the system prompt (e.g. `[[route:billing-agent]]`), keywords in the last user message, call index for that route within the turn. No match: a stable digest of the request, so unexpected calls differ visibly.
- **Error injection**: a rule can return HTTP 500 (S11).
- **Recording**: every request body is logged with a sequence number. Control endpoints: `POST /__control/scenario`, `POST /__control/mark` (turn boundary), `GET /__control/requests?since=<seq>`.
- Port `3199`. Flows use an **OpenAI API credential with Base URL `http://localhost:3199/v1`** and a dummy key (test value), `ChatOpenAI` with the typed model name `fake-model`, reasoning off.

---

## 3. Scenario Catalog (TS4)

Every LLM/Agent system prompt is **~40 KB** (above gzip's 32 KiB window, like the affected production flow) and holds a unique sentinel `SYSPROMPT_SENTINEL_<scenario>_<node>`.

| # | Flow | Topology | Turns | Exercises | Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **S01** | `S01-single-agent-memory` | Start → Agent (all-messages memory; Calculator and Current DateTime tools, no approval) | 5; turn 3 calls a tool | Reported growth case; tool messages in records | F13 |
| **S01r** | `S01r-redirect-mapping` | Mapping flow Start → Redirect to Flow → S01 | 3 | Token through a redirect | — |
| **S02** | `S02-router-mixed-memory` | Start → Condition Agent (billing / tech / other) → Agent billing (all messages) / LLM tech (window 2) / Direct Reply | 6, alternating routes | Different nodes per turn, window memory | F13 |
| **S03** | `S03-parallel-agents-join` | Start → [Agent researcher (all messages), LLM critic (summary buffer; prompt uses `{{chat_history}}`)] → LLM composer (uses `{{agentAgentflow_0}}`, `{{llmAgentflow_0}}`, `$flow.state`) | 4 | Several history copies, `{{chat_history}}`, parallel first nodes | F13 |
| **S04** | `S04-state-carry-and-overrides` | Start (`startState` `stage`, `count`; startState override enabled). Variant **a**: Persist State on; variant **b**: Persist State off. → Custom Function (`count`+1) → Condition on `stage` → Agent intake (Update State `stage=qualified`) / LLM follow-up | 4; turn 3 sends `overrideConfig.startState` | State carry-over with and without the toggle | F03 (b changes: state now carries over) |
| **S05** | `S05-form-then-chat` | Start (form input: name, topic) → LLM (uses `$form.*`, memory on) | 4: form → chat → **new form** → chat | Form values across turns, resubmission | F04 |
| **S06** | `S06-human-review-with-feedback` | Start → [Agent drafter (memory) → HumanInput (feedback on) → proceed: LLM finalize / reject: Loop back to drafter (max 2)] + [Direct Reply companion] | 5: ask → stop → reject + feedback → stop → proceed → normal | Chained resumes, answers in history, companion text | F05, F07, F08, F09 |
| **S06b** | `S06b-human-review-history-off` | As S06 with the HumanInput history toggle off | 4 | Toggle-off handling | F06 |
| **S07** | `S07-agent-tool-approval` | Start → Agent (memory; Calculator requires approval, Current DateTime does not) | 6: normal → stop → proceed → stop → reject → normal | Replayed checkpoint prompt, empty stopped-turn message | F05, F07, F08, TS-O1 |
| **S08** | `S08-parallel-stops` | Start → [Agent policy check (approval tool), HumanInput manager gate] → LLM summary | 4: both stop → resume primary → resume second → normal | Several stopped records | F08, F09 |
| **S09** | `S09-iteration-and-loop` | Start → Custom Function (array) → Iteration { LLM per item } → Agent aggregate (memory) → Condition Agent → Loop back to aggregate (max 2) / Direct Reply | 3 | Recursive runs, loop counts | F12 |
| **S10a** | `S10a-client-history-field` | Start → [LLM (memory off), Agent (memory on)] → LLM join. The client sends the whole conversation in `history` every turn, starting with a welcome message; in turn 3 its `history` leaves out the token's last message; in turn 4 it also repeats the history inside an `llmMessages` override. After: run once with "Accept conversation history from the client" on and once off | 4 | Client history priority, the warning check, memory-off nodes, override duplicates | F02, TS13, TS13a, TS22 |
| **S10b** | `S10b-ephemeral-with-state` | Start (ephemeral memory) → Agent (memory) → Custom Function (state counter) | 3 | Ephemeral memory with carried state | F11 |
| **S11** | `S11-error-and-recovery` | Start → [Agent A, LLM B (slower)] → LLM join; fake LLM returns 500 for Agent A on turn 2 | 3: ok → error → ok | Token after a failure, partial state kept | TS14 |
| **S12** | `S12-execute-flow-child-memory` | Parent: Start → Agent → Execute Flow (child: Start → Agent with memory + Custom Function state counter) → Direct Reply | 4 | Child history and state across turns | F10 |
| **S13** | `S13-non-streaming-conversation` | S01's flow, all turns non-streaming | 3 | Continuing without SSE | F14 |

### 3.1 Modes

| Mode | Client State | Executions saved | Scenarios | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **M1** | on | no (Zero-Retention on) | all | Main target. |
| **M2** | on | yes | S01, S06, S07, S08 | Saved executions stay full and are never read (TS5). |
| **M3** | off (DB mode) | yes | S01, S05, S06, S07, S12 | `before/`: today's DB-mode behaviour as a reference (e.g. feedback saved in history). `after/`: must behave like M1 with an empty DB. |

All turns stream unless the scenario says otherwise. The capture client always sends the latest token it received, from SSE or (after F14) from the JSON response.

S01 and S07 also run in M1 through `/internal-prediction` (logged-in session, like the Flowise UI) to check that the internal chat keeps full executed data while `/prediction` gets the pruned form (TS18).

---

## 4. Capture Tooling

### 4.1 `capture-traces.mjs`
Seeds the credential and flows into the isolated server, then for each mode × scenario runs the turns in order. Per turn it records:
- the request body (token replaced by its size and SHA-256);
- the ordered SSE events with offsets (token frames replaced by size + hash, the decoded token stored separately);
- the REST JSON for non-streaming turns;
- **model requests** for the turn, from the fake server log;
- the **decoded token**, using `lib/trusted-state-codec.mjs` with the fixed test secret from `capture.env`;
- **size metrics**: base64 length, gzip bytes, raw JSON bytes, raw bytes per path;
- **sentinel counts** in the decoded token, `action`, executed data and REST JSON;
- for M2/M3, the saved `Execution` / `ChatMessage` rows.

`--continue-from <trace-dir> --turn <k>` sends a recorded token from turn k and runs turns k+1… (used in Task 10).

### 4.2 `lib/normalize.mjs`
Removes or stabilises UUIDs, dates, durations, `timeMetadata`, execution and action ids, SSE offsets. Raw values stay in the trace.

### 4.3 `compare-traces.mjs` + `compare.config.json`
- **Class A, identical unless intended** (TS6): model requests, streamed tokens and final text, node sequence and statuses, final state, user-facing `action` fields (`mapping`, `elements`, `data.nodeId`).
- **Intended differences**: `compare.config.json` entries keyed by finding ID, scenario and turn, each with the expected new behaviour (e.g. F05: "user message `Reject: <feedback>` precedes the resume reply in turn 4 model input"). An intended difference that does **not** appear also fails the run.
- **Class B, measured**: decoded token, `action.data.input`, executed data. Output: size per turn and path, growth per turn, sentinel counts.

---

## 5. Procedure

1. Record the baseline commit (current `master` HEAD) and create a detached worktree at it outside the shared checkout's working files (`git worktree add --detach <scratch path> <commit>`). Build there.
2. Start the isolated server from that worktree on port `3100` with isolated DB/storage paths and a fixed test `CLIENT_STATE_SERVER_SECRET` stored in `baselines/capture.env`.
3. Start the fake server on `3199`.
4. Capture M1–M3 into `traces/before/`. Capture **twice** and compare the runs; class A must match exactly.
5. Check each *verify* finding (F04, F07) against the traces and update [00c-findings.md](./00c-findings.md): confirmed with trace reference, or dropped.
6. Write `README.md` and remove the worktree.

---

## 6. Edge Cases

- Parallel branches call the model in nondeterministic order: group requests by route marker and call index.
- Streaming and non-streaming model calls must both be recorded; the Agent streams only as the last node.
- S13 in `before/` cannot continue past turn 1 (no token in JSON); record that as the baseline result.
- If a scenario cannot be built with stock nodes, simplify it and note the gap in the README instead of changing production code.

---

## 7. Acceptance Criteria

- [x] All scenarios and modes capture without timeouts on the baseline commit.
- [x] Two captures compare clean on class A (30 traces, 134 turns, 0 differences).
- [x] Every trace has model requests, decoded tokens, size metrics and sentinel counts per turn (S13 has no token to decode: the F14 baseline result, §6).
- [x] Every finding in 00c is visible in at least one trace (listed in the README §5; F17 only through its precondition, since it is UI behaviour).
- [x] *Verify* findings confirmed or dropped in 00c (F04 and F07 confirmed; F07 with a correction on where the empty bot message appears).
- [x] `compare.config.json` drafted with an entry per finding the fixes will change (expected behaviour filled in from TS decisions; checks that need Task 04's field names or Task 03's TS-O1 result are marked pending).
- [x] No files outside `plans/agentflow-trusted-state/` changed.
