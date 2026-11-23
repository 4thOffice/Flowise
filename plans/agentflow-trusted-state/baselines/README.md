# Trusted State Scenario Suite & Baseline Traces (Task 00b)

Offline, deterministic capture-and-compare suite for Agentflow V2 conversations. For every turn of 17 multi-turn
scenarios it records what each model received, what the client received and what the `trustedState` token held.
`traces/before/` is today's behaviour; Task 10 captures `traces/after/` and compares (TS6).

- **Baseline commit**: `99e8d4b0d3806d95aeb29fedd4432843b190eaba` (`master`, detached worktree, built with `pnpm build`)
- **Before captured**: see `captures` in [`traces/before/summary.json`](./traces/before/summary.json)
- **Repeatability**: two full captures compare clean on class A ([`reports/00b-before-repeatability.md`](./reports/00b-before-repeatability.md))

---

## 1. Layout

| Path | What it is |
| :--- | :--- |
| [`fake-llm/fake-openai-server.mjs`](./fake-llm/fake-openai-server.mjs) | OpenAI-compatible `POST /v1/chat/completions` (streaming and not, `tool_calls`, `usage`) and `GET /v1/models` on port 3199. Replies come from the active scenario's rules, chosen by the `[[route:…]]` marker in the prompt, the turn and the call index for that route within the turn (never by content, so an intended input change does not ripple into later replies). No match: `FAKE-UNSCRIPTED … digest=…`. Rules can inject HTTP errors and delays. Every request is recorded. Control: `POST /__control/scenario`, `POST /__control/mark` (turn boundary), `GET /__control/requests?since=<seq>`, `POST /__control/clear`. |
| [`flows/`](./flows/) | Importable Agentflow V2 flows (canvas JSON). `{{TS00B_CREDENTIAL_ID}}` and `{{TS00B_FLOW_ID:<flow>}}` are replaced when seeding; `chatflowSettings.apiConfig` holds the API override settings the flow needs. |
| [`build-flows.mjs`](./build-flows.mjs) | Regenerates `flows/` from the node definitions a running server returns (same shape as the UI's `initNode`). Every LLM/Agent/Condition Agent prompt is ~41 KB (above gzip's 32 KiB window, gzip ratio ~4.4) with `[[route:<scenario>-<node>]]` and a unique `SYSPROMPT_SENTINEL_<scenario>_<node>`. |
| [`scenarios/`](./scenarios/) | Turn scripts: requests per turn, modes, scripted model replies (`llm.rules`), expected after-behaviour per finding. |
| [`capture-traces.mjs`](./capture-traces.mjs) | Seeds the credential and flows (fixed ids per mode), runs every mode × scenario, writes `traces/<dir>/<mode>/<scenario>.json` and `summary.json`. |
| [`lib/trusted-state-codec.mjs`](./lib/trusted-state-codec.mjs) | Decodes/encodes the token with the test secret (mirror of `trustedStateHelper.ts`). |
| [`lib/trace-store.mjs`](./lib/trace-store.mjs) | Lossless trace storage: nested JSON strings as `{"$json": …}`, strings ≥ 2 KB once under `blobs/<sha256>.txt`; sentinel counting; bytes per path. |
| [`lib/normalize.mjs`](./lib/normalize.mjs) | Stabilises chat ids, UUIDs, `mock-…` execution ids, dates, `current_date_time` tool output, durations, `timeMetadata`, offsets. Raw values stay in the traces. |
| [`compare-traces.mjs`](./compare-traces.mjs), [`compare.config.json`](./compare.config.json) | Class A comparison with intended differences per finding, plus checks of the expected after-behaviour. |
| [`capture.env`](./capture.env), [`start-server.sh`](./start-server.sh) | Fixed test values (ports, test `CLIENT_STATE_SERVER_SECRET`, dummy API key, login) and an isolated server launcher. |
| `traces/before/` | Baseline traces: `M1/`, `M2/`, `M3/`, `M1-internal/`, `M1-reqflag/`, `M3-envflags/`, `blobs/`, `summary.json`. |
| `reports/` | Comparison reports. |

### 1.1 Trace format (`ts-00b-trace/1`)

Per turn: `request` (token replaced by length and SHA-256), `response.sseEvents` (with offsets; `trustedStateData` replaced by length + hash, `agentFlowExecutedData` moved to `executedData`), `response.restJson` for non-streaming turns, `status`, `text`, `tokens` (streamed chunks), `action`, `executedData`, `nodeSequence`, `finalState`, `modelRequests` (fake server log: route, call index, matched rule, full body, reply), `token` (`sizes`: base64 length, gzip bytes, raw JSON bytes, history and record sizes; `pathBytes`: bytes per path ≥ 512 B, nested JSON strings with escaped and parsed size; `decoded`: the whole decoded token; `sentinels`), `sentinels` per payload (token, action, executed data, REST JSON, other SSE events, model requests, DB rows), `sizes`, `db` (M2/M3/M1-internal/M1-reqflag: saved `Execution` rows with `executionDataFromBlob`, `ChatMessage` rows) and `serverLog` (warn/error lines written during the turn). `inflate()` in `lib/trace-store.mjs` restores exact values.

---

## 2. Setup and Commands

Never use port 3000 or `~/.flowise`. Run from the repository root; `/tmp/...` paths are examples.

```bash
B=plans/agentflow-trusted-state/baselines

# 1. Baseline worktree (detached, outside the shared checkout) and build
git worktree add --detach /tmp/ts-baseline <commit>
(cd /tmp/ts-baseline && HUSKY=0 pnpm install --frozen-lockfile && NODE_OPTIONS=--max-old-space-size=6096 pnpm build)

# 2. Isolated server on :3100 (DB, encryption key, blob storage and logs under the data dir; secret from capture.env)
$B/start-server.sh /tmp/ts-baseline /tmp/ts-data > /tmp/ts-server.log 2>&1 &

# 3. Fake LLM on :3199
node $B/fake-llm/fake-openai-server.mjs &

# 4. Capture the default modes (M1, M2, M3, M1-internal, M1-reqflag)
node $B/capture-traces.mjs --out-dir $B/traces/before --commit <commit> --label before --server-log /tmp/ts-server.log

# 5. M3-envflags: restart the server with the env flags, capture that mode into the same directory, restart without them
DISABLE_CHAT_MESSAGE_RECORDING=true DISABLE_EXECUTION_RECORDING=true $B/start-server.sh /tmp/ts-baseline /tmp/ts-data > /tmp/ts-server.log 2>&1 &
node $B/capture-traces.mjs --out-dir $B/traces/before --modes M3-envflags --commit <commit> --label before --server-log /tmp/ts-server.log

# 6. Compare: repeatability (no intended differences), then after vs before with compare.config.json
node $B/compare-traces.mjs --before $B/traces/before --after /tmp/ts-rerun --no-intended --markdown $B/reports/<name>.md
node $B/compare-traces.mjs --before $B/traces/before --after $B/traces/after --report $B/reports/after.json --markdown $B/reports/after.md

# 7. Remove the worktree when done
git worktree remove --force /tmp/ts-baseline
```

Other capture options: `--modes M1,M3`, `--scenarios S01,S07`, `--variant <name>` (writes `<scenario>@<variant>.json`, paired with the plain before trace; used for S10a's two after runs), `--continue-from <trace dir> --turn <k>` (re-encodes the decoded token of turn k with the test secret and runs turns k+1…; token modes only, Task 10), `--run-tag`, `--timeout-ms`. `build-flows.mjs` needs a running server and rewrites `flows/`.

The flows use an **OpenAI API credential** (`TS00b Fake OpenAI`, dummy key `sk-fake-00b-test-key`, Base URL `http://localhost:3199/v1`) and `ChatOpenAI` with the typed model name `fake-model`, streaming on, reasoning off.

---

## 3. Modes

| Mode | Client State (`chatbotConfig.clientState`) | Executions saved | Endpoint | Scenarios | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **M1** | `enabled`, `enabledFull` (Zero-Retention) | no | `/prediction` | all 17 | Main target. |
| **M2** | `enabled` | yes | `/prediction` | S01, S06, S07, S08 | Saved executions stay full and are never read (TS5). |
| **M3** | off (DB mode) | yes | `/prediction` | S01, S05, S06, S07, S12 | `before/`: today's DB-mode reference. `after/`: must equal M1 (F01). Turns start ≥ 1.1 s apart (see §7). |
| **M1-internal** | as M1 | no | `/internal-prediction` (logged-in session) | S01, S07 | Internal chat keeps full executed data (TS18); reload source (`ChatMessage`) is empty (F17). |
| **M1-reqflag** | no `clientState`; request sends `enableTrustedState: true` | yes | `/prediction` | S01 | F15: the request flag alone turns the token on while Zero-Retention is undefined, so executions are saved. |
| **M3-envflags** | off; server runs with `DISABLE_CHAT_MESSAGE_RECORDING` and `DISABLE_EXECUTION_RECORDING` | no | `/prediction` | S01 | F16: env flags switch DB mode to reading the token. Needs a server restart (§2 step 5). |

All turns stream except S13. The capture client sends the latest token it received (SSE, or JSON after F14) in every mode, the action's `data.nodeId` as `humanInput.startNodeId`, and a unique `chatId` per run.

---

## 4. Scenarios

| # | Flow | Topology (labels) | Turns | Exercises | Findings | Modes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **S01** | [`S01-single-agent-memory`](./flows/S01-single-agent-memory.json) | Start → Support Agent (all messages; Calculator, Current DateTime) | 5; t3 calls the calculator | Growth case, tool messages in records | F13 | M1, M2, M3, M1-internal, M1-reqflag, M3-envflags |
| **S01r** | [`S01r-redirect-mapping`](./flows/S01r-redirect-mapping.json) | Start → Redirect to Flow → S01 | 3 | Token through a redirect | — | M1 |
| **S02** | [`S02-router-mixed-memory`](./flows/S02-router-mixed-memory.json) | Start → Router (Condition Agent: billing / technical / other) → Billing Agent (all) / Tech Support LLM (window 2) / Fallback Reply | 6, routes b, t, b, o, t, b | Different nodes per turn, window memory | F13 | M1 |
| **S03** | [`S03-parallel-agents-join`](./flows/S03-parallel-agents-join.json) | Start → [Researcher Agent (all; state `findings`), Critic LLM (summary buffer, limit 120; prompt has `{{chat_history}}`)] → Composer LLM (`{{agentAgentflow_0}}`, `{{llmAgentflow_0}}`, `$flow.state`) | 4; summarizer call from t3 | History copies, `{{chat_history}}`, parallel first nodes | F13 | M1 |
| **S04a** | [`S04a-state-carry-persist-on`](./flows/S04a-state-carry-persist-on.json) | Start (`stage`, `count`, Persist State on, startState override enabled) → Count Turns (Custom Function) → Stage Check (Condition) → Intake Agent (sets `stage=qualified`) / Follow Up LLM | 4; t3 sends `overrideConfig.startState` | Carry-over with the toggle | — | M1 |
| **S04b** | [`S04b-state-carry-persist-off`](./flows/S04b-state-carry-persist-off.json) | As S04a, Persist State off | 4 | Carry-over without the toggle | F03 | M1 |
| **S05** | [`S05-form-then-chat`](./flows/S05-form-then-chat.json) | Start (form: name, topic) → Form Assistant LLM (`$form.*` in the prompt, memory on) | 4: form → chat → new form → chat | Form values across turns | F04 | M1, M3 |
| **S06** | [`S06-human-review-with-feedback`](./flows/S06-human-review-with-feedback.json) | Start → [Drafter Agent → Review Gate (HumanInput, feedback on; Approve / Request changes) → Finalizer LLM / Revise Loop → Drafter (max 2)] + [Companion Direct Reply] | 5: ask → reject+feedback → proceed → ask → proceed+feedback | Chained resumes, answers, companion text | F05, F07, F08, F09, F19 | M1, M2, M3 |
| **S06b** | [`S06b-human-review-history-off`](./flows/S06b-human-review-history-off.json) | As S06, history toggle off | 4 | Toggle-off handling | F06 | M1 |
| **S07** | [`S07-agent-tool-approval`](./flows/S07-agent-tool-approval.json) | Start → Ops Agent (memory; Calculator needs approval, Current DateTime does not) | 6: normal → stop → proceed → stop → reject+feedback → normal | Replayed checkpoint prompt | F05, F07, F08, F19, TS-O1 | M1, M2, M3, M1-internal |
| **S08** | [`S08-parallel-stops`](./flows/S08-parallel-stops.json) | Start → [Policy Check Agent (approval tool), Manager Gate (HumanInput)] → Summary LLM; gate reject → Rejected Reply | 4: both stop → resume primary → resume second → new question | Several stopped records | F05, F07, F08, F09 | M1, M2 |
| **S09** | [`S09-iteration-and-loop`](./flows/S09-iteration-and-loop.json) | Start → Split Items (Custom Function) → For Each Item {Item Analyst LLM} → Aggregator Agent → Quality Check (Condition Agent) → Retry Loop → Aggregator (max 2) / Final Reply | 3: one extra pass, none, loop hits max | Recursive runs, loop counts | F12 | M1 |
| **S10a** | [`S10a-client-history-field`](./flows/S10a-client-history-field.json) | Start → [Quick Answer LLM (memory off; `llmMessages` override enabled), Context Agent (memory on)] → Joiner LLM (memory off) | 4; `history` every turn from a welcome message; t3 leaves out the token's last message; t4 repeats it in `overrideConfig.llmMessages` | Client history priority, warning check, memory-off nodes, override duplicates | F02, TS13, TS13a, TS22 | M1 (after: `@accept-client-history-on` / `-off`) |
| **S10b** | [`S10b-ephemeral-with-state`](./flows/S10b-ephemeral-with-state.json) | Start (ephemeral memory, Persist State on, `counter`) → Ephemeral Agent → Counter (Custom Function) → Reply | 3 | Ephemeral memory with state | F11 | M1 |
| **S11** | [`S11-error-and-recovery`](./flows/S11-error-and-recovery.json) | Start (Persist State on, `b_note`) → [Agent A, LLM B (300 ms slower; sets `b_note`)] → Joiner LLM | 3: ok → error → ok; Agent A gets HTTP 500 on t2 | Token after a failure, partial state | TS14 | M1 |
| **S12** | [`S12-execute-flow-child-memory`](./flows/S12-execute-flow-child-memory.json) + child [`S12-child-flow`](./flows/S12-child-flow.json) | Parent: Start → Parent Agent → Ask Specialist (Execute Flow, merges `child_count`) → Reply. Child: Start (Persist State on, `child_count`) → Child Counter → Specialist Agent (memory) | 4 | Child history and state across turns | F10 | M1, M3 |
| **S13** | S01's flow | as S01, non-streaming | 3; t3 calls the calculator | Continuing without SSE | F14 | M1 |

---

## 5. Where Each Finding Shows in `traces/before/`

| Finding | Trace and turn | What to look at |
| :--- | :--- | :--- |
| **F01** DB reads | `M3/S06…` t2–t5, `M3/S07…` vs `M1/…` | M3 model input comes from `ChatMessage` rows (`db.*.chatMessages`) and includes the answers (user, bot, user, bot…), M1 from the token; resumes read the `Execution` row. |
| **F02** request `history` | `M1/S10a…` t1–t4 | Quick Answer (memory off) gets the client history; Context Agent (memory on) gets client history + token history (duplicates); token history never holds the welcome message; t3: no warning when the token's last message is missing; t4: the trailing `llmMessages` copy is removed, and the current question is not sent (observation 2). |
| **F03** Persist State | `M1/S04b…` vs `M1/S04a…` | S04b: `count` stays 1 and every turn goes to Intake Agent; S04a carries `count` 1–4 and routes t2/t4 to Follow Up. |
| **F04** form values | `M1/S05…`, `M3/S05…` t3, t4 | t3: Start `output.form` keeps Ada Lovelace while the prompt's `$form` says Grace Hopper; t4: the prompt falls back to Ada Lovelace / billing. **Confirmed.** |
| **F05** answers not in history | `M1/S06…`, `M1/S07…`, `M1/S08…` (and M2) | Token history after resumes has no user message for the answer; `M3/S06…` saves the feedback (`uaua…`). |
| **F06** history toggle | `M1/S06b…` | `action.extra = "doNotIncludeFeedbackHistory"`; token history cut and the original question re-added as repeated user messages (t2: user, user, bot; t3: user ×3, bot); t2 Drafter input has only the question. |
| **F07** consecutive bot messages | `M1/S06…` t2/t3, `M1/S07…` t3, `M1/S08…` t2/t3 | History bot, bot (, bot) with no user message between; S08 t2 saves a whitespace-only bot message `" "` that the t3 Summary receives. **Confirmed** (the S07 stopped-turn message itself is not empty). |
| **F08** action in history | `M1/S06…` t1, `M1/S07…` t2/t4, `M1/S08…` t1 | `pastChatHistory[-1].action` holds the action JSON with the stopped node's full input (S07: ~44 KB with the prompt); `historyMessagesWithAction` in `token.sizes`. |
| **F09** resume copies records | `M1/S06…` t1→t2→t3, `M1/S08…` t1→t3 | S06: `token.sizes.records` 4 → 7 → 7 (t3 still holds the records of t1's run), token raw JSON 48 → 96 → 136 KB; S08 t3 carries t1's Start and Agent records. |
| **F10** Execute Flow child | `M1/S12…` vs `M3/S12…` | M1: `child_count` stays 1, the Specialist never sees earlier turns; M3: 1–4 with history (from the DB). |
| **F11** ephemeral memory | `M1/S10b…` | Token history keeps the last exchange (2 messages) every turn; `counter` 1–3. |
| **F12** iteration lookups | `M1/S09…` t1–t3 | `serverLog`: one `Parent execution ID mock-… not found` per iteration item, i.e. a parent execution lookup per item with Zero-Retention on. |
| **F13** records in token | every token turn | `token.sentinels` ≥ 1 per LLM node run; `token.pathBytes` shows `previousExecution.executionData<json>[i].data.input.messages`. |
| **F14** no token in JSON | `M1/S13…` | `token.received: false` on every turn; t2/t3 model input has no history. |
| **F15** switch selection | `M1-reqflag/S01…` | Token used (history from the token) while `db.*.executions` are saved: the request flag alone leaves Zero-Retention undefined. |
| **F16** env flags | `M3-envflags/S01…` vs `M3/S01…` | With the flags, DB mode reads history and the previous run from the token and saves no rows. |
| **F17** internal chat reload | `M1-internal/S01…`, `M1-internal/S07…` | `db.*.chatMessages` is empty, so a reload has nothing to show (UI behaviour itself is Task 09). |
| **F18** executed data to clients | every streaming turn of `M1/*`; `M1/S13…` REST JSON | `sentinels.executedData` ≥ 1 on `/prediction`: full prompts, inputs and state copies; `M1-internal` gets the same. |
| **F19** action payload | `M1/S06…` t1, `M1/S07…` t2/t4, `M1/S08…` t1 | `action.data.input` holds the full history (HumanInput) or the full prompt and Agent settings (tool approval); `sentinels.action`. |
| **TS13 / TS22** | `M1/S10a…` | As F02. |
| **TS14** failed turn | `M1/S11…` t2 | Status `ERROR`, 7 Agent A attempts (HTTP 500, LangChain retries), `b_note` from LLM B kept in the record state, token history unchanged; t3 continues. |
| **TS-O1** | `M1/S07…` t3, t5; `M1/S08…` t2 | The resume replays `humanInputAction.data.input.messages` (the earlier prompt) as model input. |

Every finding except F17's UI part is visible in at least one trace. `compare.config.json` holds the expected after-behaviour. Run against `before/` itself ([`reports/04-config-dry-run.md`](./reports/04-config-dry-run.md), after Task 04 named the token v2 fields and completed the entries; first draft: [`reports/00b-config-dry-run.md`](./reports/00b-config-dry-run.md)), the checks for changed behaviour fail and the ones for kept behaviour (TS5, TS14, F18 internal) pass; no check is pending.

---

## 6. Before / After

Token sizes are raw decoded JSON. "Prompts" columns give the highest `SYSPROMPT_SENTINEL` count of any turn in that payload. After columns are filled by Task 10.

| Scenario | Mode | Statuses (before) | Token max / last (before) | Prompts in token (before) | Prompts in executed data (before) | Statuses (after) | Token max / last (after) | Prompts in token (after) |
| :--- | :--- | :--- | ---: | ---: | ---: | :--- | ---: | ---: |
| S01 | M1 | F F F F F | 48.7 KB (t5) / 48.7 KB | 1 | 1 |  |  |  |
| S01 | M2 | F F F F F | 48.8 KB (t5) / 48.8 KB | 1 | 1 |  |  |  |
| S01 | M3 | F F F F F | 50.7 KB (t5) / 50.7 KB | 1 | 1 |  |  |  |
| S01 | M1-internal | F F F F F | 48.9 KB (t5) / 48.9 KB | 1 | 1 |  |  |  |
| S01 | M1-reqflag | F F F F F | 49.0 KB (t5) / 49.0 KB | 1 | 1 |  |  |  |
| S01 | M3-envflags | F F F F F | 48.9 KB (t5) / 48.9 KB | 1 | 1 |  |  |  |
| S01r | M1 | F F F | 46.3 KB (t3) / 46.3 KB | 1 | 1 |  |  |  |
| S02 | M1 | F F F F F F | 90.0 KB (t6) / 90.0 KB | 2 | 2 |  |  |  |
| S03 | M1 | F F F F | 134.1 KB (t4) / 134.1 KB | 3 | 3 |  |  |  |
| S04a | M1 | F F F F | 47.7 KB (t4) / 47.7 KB | 1 | 1 |  |  |  |
| S04b | M1 | F F F F | 47.3 KB (t4) / 47.3 KB | 1 | 1 |  |  |  |
| S05 | M1 | F F F F | 46.3 KB (t4) / 46.3 KB | 1 | 1 |  |  |  |
| S05 | M3 | F F F F | 47.8 KB (t4) / 47.8 KB | 1 | 1 |  |  |  |
| S06 | M1 | S S F S F | 133.0 KB (t3) / 92.2 KB | 3 | 3 |  |  |  |
| S06 | M2 | S S F S F | 133.0 KB (t3) / 92.2 KB | 3 | 3 |  |  |  |
| S06 | M3 | S S F S F | 136.6 KB (t3) / 98.4 KB | 3 | 3 |  |  |  |
| S06b | M1 | S S F S | 131.4 KB (t3) / 49.4 KB | 3 | 3 |  |  |  |
| S07 | M1 | F S F S F F | 136.0 KB (t4) / 49.6 KB | 3 | 2 |  |  |  |
| S07 | M2 | F S F S F F | 136.1 KB (t4) / 49.7 KB | 3 | 2 |  |  |  |
| S07 | M3 | F S F S F F | 180.9 KB (t4) / 139.3 KB | 4 | 2 |  |  |  |
| S07 | M1-internal | F S F S F F | 136.2 KB (t4) / 49.8 KB | 3 | 2 |  |  |  |
| S08 | M1 | S S F S | 131.6 KB (t1) / 50.0 KB | 3 | 2 |  |  |  |
| S08 | M2 | S S F S | 131.6 KB (t1) / 50.0 KB | 3 | 2 |  |  |  |
| S09 | M1 | F F F | 300.8 KB (t3) / 300.8 KB | 7 | 7 |  |  |  |
| S10a | M1 | F F F F | 132.5 KB (t4) / 132.5 KB | 3 | 3 |  |  |  |
| S10b | M1 | F F F | 44.5 KB (t1) / 44.2 KB | 1 | 1 |  |  |  |
| S11 | M1 | F E F | 128.8 KB (t3) / 128.8 KB | 3 | 3 |  |  |  |
| S12 | M1 | F F F F | 47.5 KB (t4) / 47.5 KB | 1 | 1 |  |  |  |
| S12 | M3 | F F F F | 49.0 KB (t4) / 49.0 KB | 1 | 1 |  |  |  |
| S13 | M1 | F F F | none | 0 | 1 |  |  |  |

Statuses per turn: F finished, S stopped, E error. Token max / last: largest token of any turn (turn) and the token of the last turn. S13 receives no token in `before/` (F14).

---

## 7. Gaps, Deviations and Observations

**Gaps and deviations**
- **S11 error**: LangChain retries an HTTP 500 six times with backoff, so S11 t2 takes ~1.5 min and records 7 Agent A requests. The scenario keeps the 500 (as specified) with a 300 s turn timeout.
- **M3 turn spacing**: `Execution.createdDate` has second resolution in SQLite, so DB mode resumes an older execution (`Cannot resume execution … FINISHED`) when two turns start in the same second. M3 and M3-envflags turns start ≥ 1.1 s apart, like a real client.
- **Condition Agent prompts**: the ~41 KB prompt is set through "Override System Prompt", since the default Condition Agent prompt is fixed.
- **Summary buffer**: `fake-model` is unknown to tiktoken, so `getNumTokens` uses the length/4 estimate (deterministic, offline). The S03 critic's limit is 120 tokens so the summarizer runs from t3.
- **Route markers**: Flowise's turndown pass turns `[[route:x]]` into `\[\[route:x\]\]`; the fake server accepts both.
- **S13**: in `before/` the JSON response has no token, so t2 and t3 run without one (baseline result, F14).
- **S10a variants**: the "Accept conversation history from the client" setting does not exist yet; Task 10 captures `S10a…@accept-client-history-on` and `@accept-client-history-off` with `--variant`.
- **F17** is a UI behaviour; the trace only shows that the internal chat has no saved messages to reload.
- No scenario needed a production change.

**Observations for later tasks** (today's behaviour, not decided)
1. DB mode picks the latest execution by second-resolution `createdDate` (see above); moot once F01 removes DB reads.
2. S10a t4: when the client repeats the history in an `llmMessages` override, the memory-off LLM drops the trailing copy but also never receives the current question, because the override contains user messages. Settled in Task 04 (D16): an override tail that repeats an accepted client history is trimmed, so the question is added; a memory-off node fed from the token history keeps its override as sent (`compare.config.json`, F02 entries).
3. S08 t2: a resume turn that finishes one branch while another stays stopped streams no text and saves `" "` as the bot message (F07; Task 07).
4. S06b: each toggle-off resume re-adds the original question as a user message, so history gets the same question three times by t3 (F06).
