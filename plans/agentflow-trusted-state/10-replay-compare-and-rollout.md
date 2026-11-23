# Task 10: Replay, Compare & Rollout

- **Status**: Done (2026-11-23; matrix results and gaps in §4). Open, for the user: the production-flow checks of the rollout checklist ([rollout.md](./rollout.md) §3–4); queue mode was not run against Redis (user decision, §4.1 item 8).
- **Depends On**: [09-client-payloads-and-ui.md](./09-client-payloads-and-ui.md)
- **Primary Outputs**:
  - `plans/agentflow-trusted-state/baselines/traces/after/`, `traces/continue-v1/`
  - `plans/agentflow-trusted-state/baselines/reports/size-anatomy-after.md`
  - `plans/agentflow-trusted-state/baselines/README.md` (after columns filled)
  - `plans/agentflow-trusted-state/11-new-implementation.md` (reference for the new behaviour)

---

## 1. Objective

Prove end to end on a real server that history and state are correct with no DB reads, that every finding is fixed as intended and nothing else changed, and that the size and data-exposure goals are met. Then prepare the rollout.

---

## 2. Verification Matrix

1. **Full replay**: capture M1–M3 into `traces/after/` and compare with `before/`. Class A identical except the `compare.config.json` intended differences, each of which must appear. The tooling's status for non-streaming turns skips records with `data.parentNodeId`, which external records no longer carry; that matters only for a non-streaming flow with iterations, which no scenario has (09 §4.3).
2. **Empty DB**: M1–M3 `after/` runs with the ChatMessage and Execution tables emptied before every turn give the same traces.
3. **M3 = M1**: flows with Client State off behave exactly like M1.
4. **Internal vs external**: S01 and S07 through `/internal-prediction` keep full executed data; through `/prediction` it is pruned (TS18).
5. **v1 continuation**: for each scenario and turn k (including paused turns), send the `before/` token from turn k to the new server and compare turns k+1… with the expected results. Paused v1 Agent tokens (S07 t2, S08 t1) replay their stored checkpoint once, so their next tokens may still hold that prompt until the Agent is resumed (04 D4).
6. **Determinism**: two `after/` captures compare clean.
7. **Size goals**: token size per turn grows by about that turn's messages, raw JSON ≤ 5 % of `before/` (S12 ≤ 10 %, S13 ≤ 4 KB; `SIZE-token-v2` in `compare.config.json`); sentinel counts 0, paused turns included (TS26), except item 5's v1 Agent checkpoints; decode the child tokens inside parent tokens for these counts (08 §4.2).
8. **Queue mode**: S01, S07 and S13 with `MODE=queue` and a local Redis; class A identical to non-queue; job and pub/sub message sizes recorded. Jest covers queue mode only through a captured `RedisEventPublisher` (09 §4.2).
9. **Flowise UI** pass in the browser on the isolated server.
10. **Full test suites**: server, components, UI build.

---

## 3. Rollout Checklist

- [x] Before/after table in `baselines/README.md` filled, with headline numbers (S01 token at turn 5, before vs after).
  - README §6: the after columns (statuses, token max/last, prompts in token and in executed data) for all 30 scenario × mode runs, S10a with both settings. Headline: S01 t5 is 48.7 KB raw / 16,068 base64 characters before and 1,073 bytes / 664 characters after (2.15 %).
- [x] Client note: always send the latest token (from SSE or JSON) with every request, including approval answers; one request at a time per conversation, keep the token of the latest completed turn, resend the previous token to retry a failed turn, hide approval buttons once answered (last writer wins, 04 D17); `history` per TS13 (whole conversation, may start with a welcome message, needs the flow setting, TS13a); `llmMessages` / `agentMessages` overrides are the node's message list and are trimmed only when they repeat the history a node already gets (04 D16); history reaches nodes only through memory (TS22); external executed data holds only status, state and action (TS18); `action` fields per TS20.
  - [rollout.md](./rollout.md) §1.
- [x] Flow migration: turn on "Accept conversation history from the client" for flows whose clients send `history`, and memory for nodes that relied on the first-node prepend (from `client-inventory.md`); sync saved nodes to Start 1.2, Agent 3.3, LLM 1.2, Execute Flow 1.3 (04 D14, D15). The canvas Sync Nodes button shows only when the flow is opened by in-app navigation; after a full page load it can stay hidden while the per-node badges show (06 §4.2).
  - [rollout.md](./rollout.md) §2. Per [client-inventory.md](./client-inventory.md) §3, only VoIP sends `history`, and VoIP keeps the setting off (TS27), so no flow needs the switch at deploy. The UI pass saw the update badges (Start 1.1 → 1.2, Agent 3.2 → 3.3, LLM 1.1 → 1.2) and no Sync Nodes button on a flow opened from the list right after a page load, the race 06 §4.2 describes (§4.1 item 9).
- [ ] VoIP and Celery flows (04 §2.7 VoIP, §3 Q2): list each production flow's node memory settings and enabled overrides; nodes that today rely on the client's `startEphemeralMemory` to hide the token history (Agent or Condition Agent with memory on, LLM without an enabled `llmEnableMemory` override) will see it after the deploy, so decide per node; set `legacy_history` off in the VoIP configs (its `history` is ignored with a warning).
  - **Open (user)**: no repository holds the production flows or the VoIP and Celery configs, and the user asked for the list of what remains: [rollout.md](./rollout.md) §3 names the flows and the seven checks per flow. Besides memory settings, overrides and `legacy_history`, it covers state that now carries over (TS11), for flows whose clients act on state keys.
- [ ] Agents with approval tools whose Messages list uses `{{question}}` (TS29): list them in the production flows; on resume they get the answer request's question, not the stopped turn's.
  - **Open (user)**: needs the production flows; what to list and decide is in [rollout.md](./rollout.md) §4.
- [x] Deploy note: older builds cannot read new tokens (TS2); Persist State and Ephemeral Memory are gone from the Start node; the Client State switches only control what is recorded (TS9, D12), and "Accept conversation history from the client" is new (TS13a). Agent, LLM and Execute Flow nodes on the old default "Return Response As: User Message" now add an assistant message, which changes model input only where a memory-on node runs after them in the same turn (TS25). External executed data is pruned: Flowise Evaluations lose Agentflow V2 token usage and model names (TS18). The internal chat keeps its token with its saved messages (TS30).
  - [rollout.md](./rollout.md) §5, with child flow tokens and recorded rows.
- [x] What to watch after deploy: token size debug log, decode errors, resume failures.
  - [rollout.md](./rollout.md) §6: the log lines (texts as in the code), what to expect and when to act. Also in [11-new-implementation.md](./11-new-implementation.md) §8.
- [x] `11-new-implementation.md` written; `00-current-implementation.md` marked as the previous behaviour.
  - [11-new-implementation.md](./11-new-implementation.md): round trip, token v2 fields, turn input, write-back rules, settings, recorded data, client payloads, observability and limitations, with line references at `2622c992`. `00-current-implementation.md` has a "Previous behaviour" banner pointing to it.
- [x] `AGENTS.md` and the memory note on trusted state updated to the new contract.
  - `AGENTS.md`: new section "Conversation state (`trustedState`)". Memory note `trusted-state-always-on.md` (and its `MEMORY.md` line): the token is the only conversation state in every mode, Client State only switches recording.
- [ ] Every task Done in `PLAN.md`. (The plan session owns `PLAN.md`; what to record is in §4.3.)

---

## 4. Results

Build: `master` at `2622c9929e0b7d6a498e1e139cfa3d214eea18f1` (Tasks 05–09), built in the shared checkout with a clean working tree (`flowise-components`, server, UI). Isolated server on port 3100 with its data dir under the session's scratch directory, fake LLM on port 3199. Commands: `baselines/README.md` §2.1.

### 4.1 Verification matrix

| # | Item | Result | Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Full replay | **Pass** | [10-after-vs-before.md](./baselines/reports/10-after-vs-before.md): 31 traces (S10a with both settings), 138 turns, 0 failures, 1,111 checks passed. Every entry that must differ did (F02 ×2, F03, F04, F05 ×3, F06, F10, F11, F14, TS25 ×2), and nothing else changed. TS26-resume-input: S07 t3 and S08 t2 send exactly the `before/` requests in every mode. |
| 2 | Empty DB | **Pass** | [10-empty-db.md](./baselines/reports/10-empty-db.md): the default modes captured with ChatMessage and Execution emptied before every turn (`--empty-db`), 30 traces and 133 turns, class A identical to `after/`. 168 chat messages and 134 executions were deleted before 49 turns. Resumes whose paused row was gone logged `Execution … not found` (24) and inserted a new row (D10). |
| 3 | M3 = M1 | **Pass** | `F01-M3-like-M1`: 24 of 24 `sameClassAAsMode` checks (S01, S05, S06, S07, S12). Beyond the matrix, every trace of the other modes (M2, M3, M1-internal, M1-reqflag, M3-envflags; 13 traces) has M1's class A at every turn. |
| 4 | Internal vs external | **Pass** | `F18-executed-data-internal`: 11 checks, M1-internal S01 and S07 keep full records (44.4 and 45.1 KB, the Agent's prompt included). `F18-executed-data-external`: 254 checks, 0 prompts in executed data and REST JSON. New `F18-external-record-keys`: 127 checks, external records hold only the TS18 keys. New `F18-internal-like-external`: 11 checks, the internal chat runs the same conversation as M1. |
| 5 | v1 continuation | **Pass** | [10-continue-v1.md](./baselines/reports/10-continue-v1.md): `before/` tokens of every turn k (t1–t5) sent to the new build in every mode, S10a with both settings; 105 continuations, 249 turns, 0 failures. S13 has no `before/` token (F14). Details below the table. |
| 6 | Determinism | **Pass except S03 t1/t2** | [10-after-repeatability.md](./baselines/reports/10-after-repeatability.md): 136 of 138 turns identical. S03 t1/t2 model requests differ: the Composer gets the two parallel replies in the order their model calls finish, a race `before/` shows too (critic first at t1/t2, researcher first at t3/t4). `after/` has the `before/` order. Left as is (user). |
| 7 | Size goals | **Pass** | [size-anatomy-after.md](./baselines/reports/size-anatomy-after.md). `SIZE-token-v2`: 127 of 127; `-S12`: 8 of 8; `-S13`: 3 of 3. Largest share of `before/`: 3.62 % (S06 M2 t4, paused); finished turns ≤ 3.18 % (S12, child token included), ≤ 2.50 % elsewhere. The token grows by the turn's messages: on the 67 turns that append a user message and a reply, the history grows by exactly those two messages, and in 57 of 70 pairs of consecutive unpaused turns the whole token grows by the history alone (the other 13: flow state, form values, S12's child token). Sentinels: 0 in all 138 `after/` tokens and all 249 continued tokens, child tokens decoded. No continued token kept a v1 Agent checkpoint, since each paused Agent was resumed in the first continued turn. |
| 8 | Queue mode | **Not run (user)** | The user chose not to pull a Redis image, so job and pub/sub message sizes were not recorded. Coverage: the Jest test that runs S07 through a captured `RedisEventPublisher` and checks the published events and the job result (09 §4.2). |
| 9 | Flowise UI | **Pass** | Details below the table. |
| 10 | Full test suites | **Pass** | §4.4. |

**v1 continuation (item 5) in detail**
- The expected result is the `after/` conversation carried on from the content of the v1 token (`compare-continuations.mjs`). Where the upgraded v1 token holds the same history, flow state, form values, child tokens and pending skeleton as the v2 token of the same turn, every later turn must be class A identical. 64 continuations have the same content, and all of them are identical: S01 (every mode), S01r, S02, S03, S04a, S09, S11, S10a with the setting off, S04b and S10b from t1, S05 from t1/t2, S06 from t1 (M3 also t2), S07 from t1/t2, and S08 from t1.
- In the other 41 the v1 content differs, and only the aspects that field can reach differ:
  - history → model requests: F05/F06/F07 histories of S06, S06b, S07 and S08; F11's last-exchange history of S10b; S10a's history without the welcome message (no difference: the accepted client history replaces it);
  - flow state → routing, text and state: F03's reset count of S04b;
  - form values → prompt: F04's stale form in S05 t3;
  - no child token → the child restarts: S12.
- In every continuation the v1 history is carried as it is: the v1 messages first, then the same roles and user messages as in `after/`.
- **D4**: the first resume of a paused v1 Agent sends exactly the v1 server's requests from `before/`, in all 10 cases: S07 from t2 and t4 in M1, M2, M3 and M1-internal, and S08 from t1 in M1 and M2.
- Pending data appears exactly on stopped turns. External payloads carry no prompt.

**UI pass (item 9) in detail**

Browser on the isolated server, with the fake LLM pointed at each scenario turn by turn:
- **S07 with chat messages recorded** (M3 settings):
  - A chat turn, then a tool-approval stop with Proceed/Reject. The paused token (1,052 characters) is stored with the chat id in `<flowId>_INTERNAL`.
  - After a page reload the saved messages show with their buttons. Proceed resumes with the restored token: "The refund is 37.50 euros.", and the model input holds the whole conversation.
  - After another reload the answered message has no buttons (D11).
  - The chat's node details show the Agent's full input. Clear Chat removes the stored token.
- **Agent Executions page**: the recorded runs, the resumed run continuing the paused run's row (D10), and the Agent's full input (TS5).
- **S06** (M1 settings): Request changes opens the feedback dialog from the slim action; the feedback resumes the loop, which stops again at the gate with Draft v2.
- **Canvas**: update badges on the seeded flows (Start 1.1 → 1.2, Agent 3.2 → 3.3, LLM 1.1 → 1.2). The Client State dialog shows "Disable recording chat messages", "Disable recording executions" and "Accept conversation history from the client".
- **Errors**: none on the server. The browser console has a 401 from the sign-in page before login and two external resources that timed out.

### 4.2 Tooling changed

None of these changes `before/` or production code.

- **`capture-traces.mjs`**:
  - Decodes v2 tokens (field sizes, pending entries) and every child flow token inside them, recursively. `token.sentinels` counts parent and children (08 §4.2).
  - `--after-variants`: S10a's two settings, seeded per variant.
  - `--empty-db <sqlite>`: invariant 1, with the deleted row counts per turn.
  - Continuations skip a turn that is missing, the last one, or has no token, and are named `@from-tk`.
- **`compare-traces.mjs`**:
  - `--partial`.
  - A continuation trace is compared from its start turn; entries can match `continuedFrom`.
  - Variants are named by the whole suffix.
  - New check type `executedDataKeysOnly`.
  - Importable: `classA`, `firstDifference`, `listTraces`.
- **`compare.config.json`**: two check-only entries, `F18-external-record-keys` and `F18-internal-like-external`. The Jest harness runs only its listed entries, so it is unaffected.
- **New scripts**: `compare-continuations.mjs` (item 5) and `analyze-token-v2.mjs` (item 7, README §6 columns).
- **`start-server.sh`**: an optional third argument `start|worker`, for queue mode.

### 4.3 For the plan session (PLAN.md not edited)

- Task 10 Done in the §4 table, with the two open items: the production-flow checks (rollout.md §3–4, the user's) and queue mode not run against Redis (user decision).
- PLAN §1 references: `11-new-implementation.md` is the current reference; `00-current-implementation.md` is the previous behaviour.
- Record the user's Task 10 decisions:
  - no Redis image, so queue mode stays Jest-covered;
  - the production checks are listed for the user;
  - the S03 parallel-reply order race is left as is.
- New plan files: [rollout.md](./rollout.md) (client note, flow migration, open production checks, deploy note, watch list) and [11-new-implementation.md](./11-new-implementation.md).
- The rollout checklist's last box ("Every task Done in `PLAN.md`") is the plan session's.

### 4.4 Test suites

All at `2622c992`, in the shared checkout:
- Builds: `pnpm --filter flowise-components build`, `pnpm --filter ./packages/server build`, `pnpm --filter flowise-ui build`. All green.
- Server tests: `pnpm --filter ./packages/server test`. 18 suites, 495 passed + 1 todo, 69 snapshots passed (313 s). Same totals as Task 09; no snapshot updated.
- Components tests: `pnpm --filter flowise-components test`. 8 suites, 105 passed.
- No test or production file changed in this task.
