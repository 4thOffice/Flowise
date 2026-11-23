# Task 11: Trusted State Implementation after the Plan (Reference)

- **Status**: Current (code at `2622c992`, verified end to end by Task 10: [10-replay-compare-and-rollout.md](./10-replay-compare-and-rollout.md)). Replaces [00-current-implementation.md](./00-current-implementation.md), which describes the behaviour before this plan.
- **Scope**: Agentflow V2 (`type: 'AGENTFLOW'`), every Client State setting. Decisions: PLAN §2 (TS1–TS30), [04 §4](./04-decision-gate-and-token-v2-design.md) (D1–D17) and the §4.2 lists of Tasks 05–09.
- **Main code**: `packages/server/src/utils/agentflow/trustedState.ts` (token, turn input, pending data), `agentflow/clientPayloads.ts` (executed data for clients), `buildAgentflow.ts` (`executeAgentFlow`). Line references are to `2622c992`.

---

## 1. Round Trip per Turn

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server (executeAgentFlow)
    C->>S: POST prediction {question | form | humanInput, trustedState: T(n-1), history?}
    Note over S: readTurnInput (trustedState.ts:332): decrypt · gunzip · parse<br/>v2 as is, v1 upgraded (upgradeV1 :242), anything else = new conversation
    Note over S: run nodes with history · flowState · formValues · childFlowTokens<br/>resume: records rehydrated from pendingResume (:196)
    Note over S: append the turn's messages to history (buildAgentflow.ts:2027-2112)<br/>buildTrustedState (trustedState.ts:375) → writeToken
    S-->>C: SSE action (slim, if stopped)
    S-->>C: SSE agentFlowExecutedData (full: internal chat; pruned: everyone else)
    S-->>C: SSE trustedStateData: T(n)  ·  JSON: result.trustedState = T(n)
```

- **No DB reads** for history, state or resume, in any mode (TS9). The only Execution read left is `updateExecution`'s `findOneBy({ id, workspaceId })` when a resumed run continues its recorded row (TS5, D10), and only while executions are recorded.
- **Encoding** (`trustedStateHelper.ts`, unchanged): `base64( iv | authTag | AES-256-GCM( gzip( JSON ) ) )`, key from `CLIENT_STATE_SERVER_SECRET` or the generated file next to the module. A token that fails to decrypt or parse logs the error as a warning and the turn starts a new conversation (D3).
- **Every turn writes a token**, streaming or not: the `trustedStateData` SSE event and `result.trustedState` in the JSON response and the queue job result carry the same string (F14). A failed streaming turn still streams its token (TS14); a failed non-streaming turn answers with an HTTP error and no token, so the client retries with its previous one. A failed resume returns the incoming token unchanged, so answering again retries (D6, `buildAgentflow.ts:1507-1511`).
- **Queue mode**: the incoming token travels inside the BullMQ job (`buildChatflow.ts:1082`); the worker publishes `trustedStateData`, `action` and the pruned executed data through Redis pub/sub (`RedisEventPublisher.ts:248`, `:263`, `:308`), and the job result holds `trustedState` and the pruned records.
- **Flowise UI** (`ChatMessage.jsx`): keeps the last token in `trustedStateRef` and in the chat's localStorage entry `<flowId>_INTERNAL.trustedState` next to its chat id (`:284-289`); sends it with every request, approvals included (`:1021`); restores it when the chat reloads its saved messages for the same chat id (`:1271`, TS30); Clear Chat removes it (`:1524`).

---

## 2. Token Contents (v2)

```
TrustedStateV2 {                                        trustedState.ts:53
  version: 2
  history: [{ role: 'userMessage' | 'apiMessage', content, fileUploads?, artifacts? }]     D2
  flowState: { <designer-defined keys> }                 the turn's final runtime state
  formValues: { <field>: <value> }                       latest form submission (TS12)
  childFlowTokens: { <Execute Flow node id>: { flowId, token } }                           TS16
  pendingResume?: {                                      only while a turn is stopped (TS26)
    nodes: [PendingNode]                                 one per top-level record of the stopped run, in record order
    executionId?                                         recorded run to continue (executions recorded only, D10)
    stopMessageId?                                       recorded stop message to clear (chat messages recorded only, D11)
  }
}

PendingNode {                                            trustedState.ts:34
  nodeId, status
  conditions?: boolean[]                                 decision outcomes (Condition / Condition Agent)
  loop?: { nodeID, maxLoopCount }                        Loop target and limit
  output?: { <paths the flow references> }               findOutputReferences (:126): {{nodeId}} → content / http.data
  stopped nodes only:
    action?: SlimAction                                  TS20
    prompt?: string                                      the stop message (D9)
    checkpoint?: { historyLength, conversation, toolCallMessage }   Agent tool approval (TS26, D5)
    legacyMessages?: [...]                               a v1 Agent stop: its stored prompt, replayed once (D4)
}
```

- Nothing else: no node records, no system prompts, no ids, dates or chat metadata in history (TS19, F13). Token sizes from Task 10: 221–1,548 bytes of raw JSON on finished turns, 900–2,079 bytes while paused, against 43.7–300.8 KB before ([size-anatomy-after.md](./baselines/reports/size-anatomy-after.md)).
- **Agent checkpoint** (`Agent.ts:1424-1428`, helpers in `nodes/agentflow/utils.ts`): the prompt the Agent sent after its own Messages list, with each run of exact history copies stored as `{ history: [i, j] }`, plus the tool-call message (text, tool calls, id, usage). The server adds `historyLength`. On resume the Agent rebuilds its prompt as its Messages list resolved from the current flow + the expanded conversation + the tool-call message (`Agent.ts:1105-1113`), so `{{question}}` there resolves to the resume request's question (TS29).
- **v1 tokens** (TS1, `upgradeV1`): `pastChatHistory` → `history` (role, content, file uploads, artifacts), the last record's `data.state` → `flowState`, the Start record's `output.form` → `formValues`, no child tokens; a stopped run (or an error right after a stop, the v1 retry rule) → `pendingResume` with the same skeleton. A stopped v1 Agent keeps its stored prompt as `legacyMessages`, replayed exactly as before on its resume and carried unchanged while it stays stopped (D4); that is the only way a system prompt can be in a token written by this server.

---

## 3. Turn Input

`readTurnInput` (`trustedState.ts:332`) runs once per top-level turn; iteration children get the same object through `IExecuteAgentFlowParams.turnInput` (F12).

| Field | Comes from |
| :--- | :--- |
| History | The request `history` when the flow has "Accept conversation history from the client" on (`clientState.acceptClientHistory`, TS13a) and the turn is not a resume; otherwise the token history. A warning when `history` is ignored (setting off, or a resume turn: D7) and when an accepted `history` lacks the token's last message (TS13). |
| Flow state | The token's `flowState`, with an enabled `startState` override on top on non-resume turns; the Start node merges it over its defaults (TS11, `buildAgentflow.ts:1316-1342`). |
| Form values | The request `form`, else the token's `formValues` (TS12); `$form.*` and the Start node read them in every run, iteration runs included. |
| Child flow tokens | The token's `childFlowTokens`; each Execute Flow node gets its own entry (`buildAgentflow.ts:826-839`). |
| Pending resume | The token's `pendingResume`, only on a `humanInput` request; any other request abandons a pause. |

History reaches nodes only through each node's own memory settings (TS22): no first-node prepend, and `{{chat_history}}` and HumanInput's description read the same turn history.

---

## 4. What a Turn Writes Back

| Turn | `history` | `flowState` | `pendingResume` |
| :--- | :--- | :--- | :--- |
| Finished | + user message (question; form as `key: value` lines; `' '` when empty), + bot reply with artifacts | the turn's final state | none |
| Stopped | + user message, + stop message (the turn's text; blank → the waiting node's prompt, D9) | state at the stop | skeleton of the run (`buildPendingResume`, `trustedState.ts:180`) |
| Resume (finished or stopped again) | + the answer (feedback, else `question`, else the clicked button's label, TS15), + reply or new stop message | as above | none, or the new skeleton; entries of nodes still stopped are carried over unchanged |
| HumanInput with the history toggle off | the stop adds only the user message, the resume only the reply (D8) | | |
| Failed normal turn | unchanged (TS14) | state of the nodes that finished | none |
| Failed resume | the incoming token is returned unchanged (D6) | | |

- **Same-turn replies** (TS25): a node reply appended to the runtime history is an assistant message ("Return Response As": Assistant Message default, or Do not append; a saved `userMessage` acts as assistant). Only the turn's final answer goes into the token history (B1).
- **Overrides that repeat the history** (D16): before an Agent or LLM uses an `agentMessages` / `llmMessages` override, a tail that repeats the turn history is removed with a warning when the node has memory on or the history came from an accepted client `history` (`trimTrailingHistoryCopy`, `nodes/agentflow/utils.ts:966`). A memory-off node fed from the token history keeps the override as sent (VoIP, TS27).
- **Child flow tokens**: a returned `childFlowToken` replaces the node's entry, no token removes it, a failed child call keeps the earlier one; entries of nodes no longer in the flow are dropped. A child paused for human input is not resumed: the next parent turn calls it with a question (08 §4.2).
- **Last writer wins** (TS28): the server keeps no conversation state, so each request continues from the token it carries.

---

## 5. Settings (write switches only)

| Setting (UI label) | Key | Effect |
| :--- | :--- | :--- |
| Disable recording chat messages | `chatbotConfig.clientState.enabled` (unset: the request's `enableTrustedState` stands in, D12) | ChatMessage rows are not written (TS21). |
| Disable recording executions | `chatbotConfig.clientState.enabledFull` | Execution rows are not written (TS5). |
| Accept conversation history from the client | `chatbotConfig.clientState.acceptClientHistory` (default off) | TS13a, §3. |
| `DISABLE_CHAT_MESSAGE_RECORDING`, `DISABLE_EXECUTION_RECORDING` (env) | — | Force the matching writes off. |

None of them selects where history, state or the previous run come from (F15, F16): every mode reads the token only. Start node 1.2 has no Persist State and no Ephemeral Memory (TS11, TS17; saved values are ignored, with a warning per turn when Ephemeral Memory was on). Node versions: Start 1.2, Agent 3.3, LLM 1.2, Execute Flow 1.3 (D14, D15).

---

## 6. Recorded Data (debugging only, never read during a conversation)

- **Executions** (when recorded): written with full records as before (TS5). A resume continues the paused run's row: the row's records minus the resumed node's, then the turn's own; rehydrated records are never written; a missing row logs `Execution … not found; it is not updated` and the final write inserts a new row (D10). The stopped record's `output.humanInputAction` is the slim action; its `data.input` keeps the full input.
- **Chat messages** (when recorded): one user and one bot row per turn, the bot row of a stop with the slim action. On resume the stop message's row is updated to `action: null` by `stopMessageId`, or deleted when the answered HumanInput has the history toggle off (D11).

---

## 7. Client-Bound Payloads (unencrypted)

| Payload | Internal chat (`/internal-prediction`) | Every other caller (`/prediction`, Execute Flow children, queue mode) |
| :--- | :--- | :--- |
| `action` (SSE; saved bot message) | slim (TS20): `id`, `mapping`, `elements`, `data.nodeId`, `data.nodeLabel`, `data.input.humanInputEnableFeedback` (HumanInput only) | same |
| `agentFlowExecutedData` (SSE end of stream, JSON, job result) | full records without credential ids | per record: `nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, `data.error` (text), `data.output.humanInputAction` (slim, stopped records) (TS18, `clientPayloads.ts`) |
| `trustedStateData` / `trustedState` | the token | the token |

Clients read `[last].data.state` of the executed data and only `elements`, `data.nodeId` and the feedback flag of `action` ([client-inventory.md](./client-inventory.md) §4). Accepted consequences (TS18): Flowise Evaluations lose Agentflow V2 token usage and model names; Execute Flow's fallback text for a blank child reply holds the pruned records.

---

## 8. Observability

| Log line | Level | Meaning |
| :--- | :--- | :--- |
| `[agentflow]: trustedState chatId=<id>: in v<0\|1\|2> <n> chars, history <n>, pending <bool>; out <n> chars, history <n>, pending <bool>` (`trustedState.ts:396`) | debug | One per top-level turn: token version and size in and out. `in v0` = no or unreadable token; `in v1` = a token from before the deploy. |
| decrypt / gunzip / JSON error from `trusted_state_from_string` | warn | A token that cannot be read; the turn starts a new conversation (D3). |
| `Ignoring a trustedState of unknown format (version …); starting a new conversation` | warn | D3. |
| `Ignoring the request history: "Accept conversation history from the client" is off for this flow` / `… on a resume turn …` / `The request history lacks the last message of the token history …` | warn | TS13, TS13a, D7. |
| `<node>: removed the last <n> messages of its message list because they repeat the conversation history` | warn | D16. |
| `Ephemeral Memory is no longer supported; each node's memory settings decide` | warn | A saved Start node with the removed option on (TS17). |
| `No previous execution found for session …: the trustedState holds no stopped run to resume` | error (turn fails) | A `humanInput` request whose token has no pending data (answered twice, stale or missing token). |
| `Execution … not found; it is not updated` | warn | D10: the recorded row of a paused run is gone (executions recorded only). |

---

## 9. Known Limitations and Accepted Changes

- A child flow paused for human input is not resumed by its parent (08 §4.2).
- Concurrent or stale tokens: last writer wins; clients send one request at a time per conversation (TS28).
- A resumed Agent re-resolves its Messages list: `{{question}}` there is the resume request's question, values and flow edits changed while paused take effect (TS26, TS29).
- A v1 Agent stop replays its stored prompt once; if the flow's Messages list changed while paused and that Agent stops again, its next rebuild can start one message off (07 §4.2 observations).
- The internal chat continues across reloads only with chat message recording on (TS30); the popup and the expanded view each hold their own token in memory (09 §4.2).
- Status of a non-streaming turn in the capture tooling skips records with `data.parentNodeId`, which external records no longer carry; only a non-streaming flow with iterations is affected (09 §4.3).
