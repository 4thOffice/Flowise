# Task 04: Token v2 Design Review

- **Status**: Done (reviewed with the user, 2026-11-23; decisions in §4, for the plan session to record in `PLAN.md`)
- **Depends On**: [03-field-removal-tests.md](./03-field-removal-tests.md) (TS-O1 resolved there as TS26)
- **Interactive**: the design was reviewed with the user before Task 05; nothing is implemented here.
- **Primary Outputs**: this file, Tasks 05–10 adjusted, `compare.config.json` intended differences completed ([dry run](./baselines/reports/04-config-dry-run.md)), Task 01 tests revised (F11 target, TS13a key).
- **Code**: `master` at `28bda39f`; server, components and UI sources are unchanged since `6b10339e`, so the line references of [field-inventory.md](./field-inventory.md) hold. Short file names as there.

---

## 1. Objective

Turn the decisions in PLAN §2 (TS1–TS26, TS-O3 and TS-O4 resolved here with the user) and the evidence from Tasks 02–03 into a precise design, so Tasks 05–09 can be implemented without open questions.

---

## 2. Design

New server module (Task 05): `packages/server/src/utils/agentflow/trustedState.ts` holds the types below, the codec (`readTurnInput`, `upgradeV1`, `writeToken`), the builder and the history mapping. `trustedStateHelper.ts` (crypto) is unchanged.

### 2.1 v2 schema

```ts
export const TRUSTED_STATE_VERSION = 2

export interface TrustedStateV2 {
    version: 2
    history: TrustedHistoryMessage[]                // 2.2
    flowState: ICommonObject                        // designer-defined keys only
    formValues: ICommonObject                       // latest form submission, {} when none
    childFlowTokens: Record<string, ChildFlowToken> // keyed by Execute Flow node id (2.10)
    pendingResume?: PendingResume                   // only while a turn is stopped (2.6)
}

export interface ChildFlowToken {
    flowId: string // the child flow the token belongs to
    token: string  // the child's trustedState, as its JSON response returned it
}
```

All fields except `pendingResume` are always written (empty values included), so readers never branch on presence.

| Field | Written by (end of a top-level turn, 2.6) | Read by |
| :--- | :--- | :--- |
| `version` | the builder | the codec (2.3) |
| `history` | turn history + the messages the turn appends (2.7); unchanged on a failed turn | turn input → `pastChatHistory` (node memory, `{{chat_history}}`, HumanInput's description), the TS13 last-message check, Agent checkpoint references (2.6) |
| `flowState` | `agentflowRuntime.state` when the turn ends: the stop-time state when stopped, the state after the finished nodes when failed (TS14) | turn input → initial `agentflowRuntime.state`; the Start node puts its defaults under it and an enabled `startState` override over it (2.5); on a resume it is the stop-time state |
| `formValues` | `agentflowRuntime.form`: this turn's submission, else the carried values (TS12) | turn input → `agentflowRuntime.form` → Start `output.form` and `$form.*` |
| `childFlowTokens` | the server, from Execute Flow node results (2.10); entries of node ids no longer in the flow are dropped | Execute Flow run params (2.10) |
| `pendingResume` | the builder, only when the turn ends `STOPPED` (2.6), or unchanged when a resume of it fails (D6) | a resume turn only (request with `humanInput`) |

### 2.2 History message shape

```ts
export interface TrustedHistoryMessage {
    role: 'userMessage' | 'apiMessage'
    content: string
    fileUploads?: IFileUpload[]   // user message of a turn with uploads
    artifacts?: ICommonObject[]   // bot message whose terminal nodes returned artifacts
}
```

- **Roles** keep Flowise's ChatMessage names, as in the request `history` field (`validateHistorySchema`) and the compare checks.
- **Kept**: `role` and `content` (Task 03 contract); `fileUploads` and `artifacts`, stored as parsed arrays instead of JSON strings, because `getPastChatHistoryImageMessages` and `addImageArtifactsToMessages` turn them into model input (not exercised in `before/`).
- **Dropped** (D2): `usedTools` and `fileAnnotations` (copied into `additional_kwargs` but never reach a model; removable in Task 03), `action` (F08), ids, chat/session ids, `chatType`, dates, `executionId`, `leadEmail`, `sourceDocuments`, `followUpPrompts` and the DB-mode columns.
- **Mapping to node input** (`toNodeMessage`): `{ role: 'user' | 'assistant', content, additional_kwargs?: { fileUploads, artifacts } }`, the same objects today's `mapChatMessageToIMessage` (`buildAgentflow.ts:86-127`) produces after parsing, so model input is unchanged.

### 2.3 Versioning

- The decrypted JSON carries `version: 2`. No `version` with a `pastChatHistory` or `previousExecution` key is v1 (TS1).
- Anything else (decrypt or gunzip failure, unparsable JSON, an unknown version) is logged as a warning and treated as no token: a new conversation, as a decode failure is today (`trustedStateHelper.ts:62-68`). A resume request without pending data fails with "nothing to resume" (2.6).
- Encoding is unchanged: `base64(iv | authTag | AES-256-GCM(gzip(JSON)))`, key from `CLIENT_STATE_SERVER_SECRET`. Every token written is v2; an older build cannot read it (TS2).

### 2.4 v1 → v2 upgrade (`upgradeV1`)

| v2 field | From the v1 token |
| :--- | :--- |
| `history` | `pastChatHistory[]` → `{ role, content, fileUploads?, artifacts? }` (JSON strings parsed, `null`/`''` dropped). Messages are kept as they are: consecutive bot messages, `' '`, repeated questions from F06 are not rewritten. |
| `flowState` | `data.state` of the last record that has one in `previousExecution.executionData`, whatever Persist State was (TS11); `{}` if none. |
| `formValues` | `data.output.form` of the first `startAgentflow` record: a string goes through `parseFormStringToJson` (`buildAgentflow.ts:1141-1153`), an object is taken as is; `{}` if none. |
| `childFlowTokens` | `{}` |
| `pendingResume` | Only when `previousExecution.state` is `STOPPED`, or `ERROR` with the last record `ERROR` right after a `STOPPED` one (today's retry rule, `:1405-1427`; the `ERROR` record is dropped). Built from the records by the 2.6 skeleton rules. A stopped Agent keeps its stored checkpoint (`humanInputAction.data.input.messages`) as `legacyMessages`, replayed once (D4). `executionId` = `previousExecution.id` unless it is a `mock-` id; `stopMessageId` = the id of the last history message with a non-null `action`. |

Everything else in a v1 token is dropped. The upgrade runs in memory per request; the token the turn writes is v2.

### 2.5 Turn input

```ts
export interface TrustedTurnInput {
    history: TrustedHistoryMessage[]                  // the turn's history: token history or accepted client history (2.7)
    flowState: ICommonObject
    formValues: ICommonObject                         // incomingInput.form ?? token formValues
    childFlowTokens: Record<string, ChildFlowToken>   // one mutable object for the turn, shared with recursive runs
    pendingResume?: PendingResume                     // set only when the request carries humanInput
    historySource: 'token' | 'client'                 // 2.7: decides where override copies are trimmed
    incoming: { version: 0 | 1 | 2; base64Length: number; historyLength: number; hadPending: boolean } // debug log
}
```

`readTurnInput(incomingInput, chatflowConfig)` builds it once, in the top-level `executeAgentFlow`. Recursive iteration runs get it through a new `IExecuteAgentFlowParams.turnInput` and never decode `incomingInput.trustedState` (F12); they never resume and never create or look up an Execution (they use the parent's execution id when executions are recorded).

| Today | Replaced by |
| :--- | :--- |
| decode `:1237`, `lazyLoadExecution` `:1287-1314` (token and DB branches) | `readTurnInput` |
| Persist State read `:1316-1361` | `agentflowRuntime.state = { ...turnInput.flowState, ...startStateOverride }`, where the override is applied when the flow enables `startState` for the Start node (array or object form, as `:1338-1358` does today). Not applied on a resume turn, where the Start node does not run (today the resume branch overwrites it, `:1490`). The Start node merges carried keys over its defaults unconditionally (`Start.ts:184-190` without the Persist State check). |
| form read `:1363-1385` | `agentflowRuntime.form = turnInput.formValues`; `$form.*` reads `agentflowRuntime.form` (`:755`) |
| resume `previousExecution` `:1387-1499` | `turnInput.pendingResume`, rehydrated into records (2.6); the resume target check and `selectPrimaryStoppedNode` run on them |
| ChatMessage history read `:1563-1581` | `pastChatHistory = turnInput.history.map(toNodeMessage)` |
| pending-action scan `:2139-2177` | `pendingResume` (TS21 writes by id, 2.6.2) |
| iteration parent lookup `:1503-1531` | the parent's execution passed in (F12) |
| `prependedChatHistory` (request `history`) `:1203`, run param `:827` | removed (TS22): an accepted client history becomes the turn history (2.7) |

### 2.6 Builder rules

| Turn ends | `history` | `flowState` | `formValues` | `childFlowTokens` | `pendingResume` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `FINISHED` (normal or resume) | turn history + user message + reply (2.7) | runtime state | runtime form | updated | none |
| `STOPPED` (normal or resume) | turn history + user message + stop message (2.7) | runtime state (stop-time) | runtime form | updated | built below |
| `ERROR` / `TERMINATED`, normal turn | turn history, nothing appended (TS14) | runtime state after the finished nodes (TS14) | runtime form | updated by finished nodes | none |
| `ERROR` / `TERMINATED`, resume turn | the incoming token, every field unchanged, so answering again retries the resume (D6) | | | | incoming |

A normal turn (no `humanInput`) that starts while pending data exists abandons it, as today. The fatal-error token (`:2010`) is built from these rules, not from records, so it carries no credential ids. Every top-level turn logs one debug line: chat id, incoming version, token size in and out, history length in and out, pending in and out.

```ts
export interface PendingResume {
    nodes: PendingNode[]   // run skeleton: one entry per top-level record of the stopped run, in record order
    executionId?: string   // only when executions are recorded: the row the resume continues (D10)
    stopMessageId?: string // only when chat messages are recorded: the bot message whose action is cleared (D11)
}

export interface PendingNode {
    nodeId: string
    status: ExecutionState                    // as recorded
    conditions?: boolean[]                    // decision outputs: isFulfilled per condition, in order
    loop?: { nodeID: string; maxLoopCount: number }
    output?: ICommonObject                    // nodes other nodes reference: only the referenced paths
    action?: SlimAction                       // STOPPED: the announced action (TS20, 2.9)
    prompt?: string                           // STOPPED: output.content as announced at the stop (D9)
    checkpoint?: AgentCheckpoint              // STOPPED Agent (tool approval), TS26
    legacyMessages?: unknown[]                // STOPPED Agent from a v1 token: stored checkpoint, replayed once (D4)
}

export interface AgentCheckpoint {
    historyLength: number                     // length of the history the stopped turn started with
    conversation: Array<{ history: [number, number] } | CheckpointMessage> // prompt after the node's own Messages list
    toolCallMessage: CheckpointMessage        // text, tool_calls, id, usage_metadata
}

type CheckpointMessage = {
    role: string
    content: unknown
    name?: string
    id?: string
    tool_calls?: unknown[]
    tool_call_id?: string
    usage_metadata?: ICommonObject
    additional_kwargs?: ICommonObject
}
```

**Skeleton** (Task 03, [field-inventory.md](./field-inventory.md) §6): every top-level record of the turn's executed data, iteration children (`data.parentNodeId`) excluded, in order; on a resume turn that is the rehydrated records minus every record of the resumed node id (`commitExecutedDataDelta`, `stateReconciler.ts:131-153`), plus the turn's new records. Entries keep every record because the replay counts loop records (`dependencyEngine.ts:424-444`), so within one paused run the skeleton grows by one small entry per node run; a resume that finishes drops it.

- `conditions` from `output.conditions[].isFulfilled`; `loop` from `output.{nodeID, maxLoopCount}` (the stop-time max count, so a per-request override applies as today).
- `output`: for a node id that any node of the current flow references, `{{id}}` keeps `output.content` and `output.http.data` (`:426-438`), `{{id.output.<path>}}` keeps `output.<path>` (`:391-419`); stored as a partial object (lodash `pick` paths).
- `action`, `prompt` and `checkpoint` (or carried `legacyMessages`) for `STOPPED` entries. An entry carried from an earlier stop (S08 t2) is copied unchanged.
- **Agent checkpoint** (D5): when the Agent stops for a tool approval it returns `output.resumeCheckpoint = { conversation, toolCallMessage }` beside today's output. `conversation` is every prompt message after the node's own Messages list (system and other roles) up to the tool-call message: memory messages (window or summary as built), the input message, the turn's question, upload messages (as file references, as today's checkpoint stores them), same-turn messages, earlier tool calls and results of the same run. Each run of messages equal (role, content) to `pastChatHistory[i..j)` becomes `{ history: [i, j] }`. The server adds `historyLength` (the turn history's length). Neither the system prompt nor any other Messages-list entry is stored.
- **Rehydration** on resume (Task 07): one record per entry, `{ nodeId, nodeLabel, status, previousNodeIds: reversedGraph[nodeId] ?? [], data: { id, name, output } }` with label and name from the current flow, `output` = the stored `output` plus `conditions: [{ isFulfilled }]`, `nodeID`/`maxLoopCount`, `humanInputAction: action`, `content: prompt` and `resumeCheckpoint`. Rehydrated records start the turn's executed data (so `nodeSequence` and the replay behave as today) and are excluded from the recorded execution write (D10).
- **Resumed Agent** (D5): rebuilds its prompt as the resolved Messages list of the current flow (system first, the others in order) + `conversation` with references resolved from `pastChatHistory` + `toolCallMessage`, so values and Messages-list edits made while paused take effect and memory-setting edits apply from the next turn; with `legacyMessages` it replays them exactly as today (`Agent.ts:2329-2339`, D4).

**Saved flows with ephemeral memory on** (TS17, D14): the stored `startEphemeralMemory` is ignored; the Start node no longer returns `ephemeralMemory` and the reconciler branch (`stateReconciler.ts:182-187`) goes. A flow that still has it on logs one warning per turn ("Ephemeral Memory is no longer supported; each node's memory settings decide").

#### 2.6.1 Recorded executions (TS5, D10)

- Written only when execution recording is on (2.8); never read for the conversation.
- A normal turn writes its row as today. A stopped turn's pending data keeps `executionId`; the resume continues that row: at the end of the turn the row's records minus the records of the resumed node id, plus the turn's own records (rehydrated ones excluded), as today's chain (`:1468`, `:1983-1995`). That needs `updateExecution`'s `findOneBy({ id, workspaceId })`, the one read the Task 01 harness allows, which stays allowed (05 spec); nothing it returns reaches a node, the token or a client payload.
- A missing row never fails the turn: the start-of-resume state update is skipped with a warning and the final write inserts a new row.

#### 2.6.2 Recorded chat messages (TS21, D11)

- Written only when chat message recording is on (2.8); never read.
- The stopped turn's bot message is saved with the slim action; its id goes into `stopMessageId`. On resume: history toggle on → `update({ id }, { action: null })`; toggle off → that row is deleted, as DB mode does today (`:2163-2167`). No query by chat or session id.

### 2.7 History rules

**Turn history.**
1. `history` in the request and "Accept conversation history from the client" on (TS13a): the client history, mapped to 2.2 (role, content), is the turn history (`historySource: 'client'`); it may start with a welcome message and hold any other messages the client adds. If the token history is not empty and no client message has the role and trimmed content of the token's last message, a warning is logged and the turn continues (TS13).
2. `history` with the setting off: ignored with a warning (TS13a).
3. Otherwise the token history (`historySource: 'token'`).
4. Resume turns (`humanInput`) always use the token history, so the paused run continues on what it stopped on; a `history` field is ignored with a warning (D7).

**How history reaches nodes** (TS22): nodes get the turn history only through their own memory settings; `{{chat_history}}` and HumanInput's description read it as today. The first-node prepend of `history` in Agent and LLM (`Agent.ts:1003-1013`, `LLM.ts:404-414`) is removed; Condition Agent has none.

**Overrides that repeat the history** (D16): an `agentMessages` / `llmMessages` override is the node's own message list (TS22), applied as today (appended to the configured messages where the flow enables it, `utils/index.ts:1137-1148`). Before the node uses it, a tail that repeats the turn history (`countTrailingHistoryCopy`, `nodes/utils.ts:948-962`; today LLM only, against the prepended `history`) is removed from the array with a warning, in Agent and LLM, when the node has memory on (the history already arrives through memory) or when `historySource` is `'client'`. A memory-off node fed from the token history uses the override exactly as sent. Every later use of the override (the "add the current question" rule `LLM.ts:465` / `Agent.ts:1052`, and the runtime-history input messages `LLM.ts:695-707` / `Agent.ts:1420-1438`) sees the trimmed array, so S10a t4 with the setting on gets the question.

**Same-turn replies** (TS25, D15): a node reply appended to the runtime history is an `assistant` message; "Return Response As" offers Assistant Message (new default) and "Do not append to chat history"; any other stored value, `userMessage` included, means Assistant Message at runtime (Agent, LLM, Execute Flow). Only the turn's final answer goes into the token history, as today (B1).

**Appended at the end of a turn** (FINISHED and STOPPED):

| Message | Content |
| :--- | :--- |
| User message, normal turn | the question (with uploads: `fileUploads`); for a form submission the `key: value` lines as today (`:2186-2190`); `' '` when empty, as today |
| User message, resume turn (TS15) | `humanInput.feedback` if not blank, else `question`, else the label of the clicked button from the pending action. Not added when the resumed node is a HumanInput with the history toggle off (D8). |
| Bot reply | the turn's final content (post-processing applied) with `artifacts` |
| Stop message (turn ends STOPPED) | the final content; when it is blank (S08 t2), the `prompt` of the primary stopped node, the one whose action is announced (D9); nothing extra is streamed. Not added when the primary stopped node is a HumanInput with the history toggle off (D8). |

**History toggle off** (TS15, D8): the approval exchange leaves no trace: the stop turn saves only its user message, the resume saves only its reply, so after a chain of reviews the history holds the question and the final reply (DB mode's result today, without F06's state flag, `action.extra` or question rewrite).

**VoIP** (TS-O3, D16):
- VoIP keeps sending its call in `llmMessages` (welcome first, fillers and consecutive bot messages as it composes them); the server neither merges nor reorders them. Since VoIP sends no accepted `history`, its memory-off nodes keep the override as sent.
- The `llmEnableMemory` override keeps working (D13), so VoIP's LLM nodes stay memory-off without flow edits. `startEphemeralMemory` does nothing (TS17): memory-on nodes it hid the token history from today (Agent or Condition Agent nodes in VoIP and Celery flows, LLM nodes without an enabled `llmEnableMemory` override) see the token history from now on. Task 10 checks the production flows for such nodes.
- VoIP's `history` field (sent while `legacy_history` is on) is ignored with a warning, since VoIP flows keep "Accept conversation history from the client" off; turning `legacy_history` off removes the warning.
- A VoIP call's token history holds the server's question/reply pairs (no welcome, no fillers); VoIP's memory-off nodes do not read it. Moving VoIP to `history` (TS13) stays possible later.

### 2.8 Settings model

| Setting | Key | Default | Effect |
| :--- | :--- | :--- | :--- |
| Record chat messages | `chatbotConfig.clientState.enabled` (`true` = do not record) | unset: record, unless the request sends `enableTrustedState: true` (D12) | ChatMessage rows (TS21) |
| Record executions | `chatbotConfig.clientState.enabledFull` (`true` = do not record) | unset: record | Execution rows (TS5) |
| Accept conversation history from the client | `chatbotConfig.clientState.acceptClientHistory` (new) | `false` | TS13a, 2.7 |
| `DISABLE_CHAT_MESSAGE_RECORDING` / `DISABLE_EXECUTION_RECORDING` (env) | — | — | force the matching writes off |

- The stored keys keep their meaning for writes, so no migration and the same rows as today in every mode; none of them selects a source any more (F15, F16). The request flag only stands in for an unset `clientState.enabled`, as today (D12).
- UI (`ClientState.jsx`): the dialog says conversations always continue from the token and the settings only control what the server records; three switches: "Disable recording chat messages", "Disable recording executions", "Accept conversation history from the client".
- Task 01's `ACCEPT_CLIENT_HISTORY_CHATBOT_CONFIG` is now `{ clientState: { acceptClientHistory: true } }`, merged into each mode's `clientState` (harness changed in this task).
- **Start node** (TS11, TS17, D14): `startPersistState` and `startEphemeralMemory` are removed from the node and its version goes 1.1 → 1.2, so saved flows show the update badge and syncing drops the stored values (`updateOutdatedNodeData`, `genericHelper.js:239-246`); the server ignores them whatever the version.
- **Return Response As** (TS25, D15): the User Message option is removed from Agent (3.2 → 3.3), LLM (1.1 → 1.2) and Execute Flow (1.2 → 1.3); syncing a saved node replaces a stored option value that the new definition no longer offers with the input's default (in `updateOutdatedNodeData`, static `options` inputs only), so a stored `userMessage` becomes Assistant Message.
- **Client overrides** (TS24 amended, D13): no override is blocked. Every override the flow enables applies as today, `llmEnableMemory` included; `startEphemeralMemory` targets an option that no longer exists (TS17).

### 2.9 Client payloads

```ts
export interface SlimAction {
    id: string
    mapping: { approve: string; reject: string }
    elements: Array<{ type: string; label: string }>
    data: { nodeId: string; nodeLabel: string; input?: { humanInputEnableFeedback: boolean } } // input only for HumanInput
}

export interface ExternalExecutedRecord {
    nodeId: string
    nodeLabel: string
    status: ExecutionState
    previousNodeIds: string[]
    data: { name: string; state?: ICommonObject; error?: string; output?: { humanInputAction: SlimAction } }
}
```

- **Action** (TS20): `executeNode` builds the slim action when a node stops (`:1017-1033`, `:1066-1081`), so records, the SSE `action`, a saved ChatMessage and the pending data all hold the same object. `extra` goes (F06). The stopped record still has the full `data.input` for the internal chat and recorded executions. All known clients guard `data.input` (CM:845, `Bot.tsx:3522`, `actions.ts:22,37`).
- **Executed data** (TS18): `toClientExecutedData(records, isInternal)` runs wherever `executeAgentFlow` hands records out: the four `streamAgentFlowExecutedDataEvent` calls (`:1829`, `:1900`, `:2004`, the stopped branch) and `result.agentFlowExecutedData` (`:2275`). Queue mode gets the pruned array from those calls (worker → `RedisEventPublisher`, job result), so no full record leaves the process. Internal: the full records with `_removeCredentialId` applied (today's streamed copy still has `FLOWISE_CREDENTIAL_ID`). External: `ExternalExecutedRecord` per record, same order and length (clients read `[last].data.state`); `error` is the error text.
- **Internal** = `isInternal` (the `/internal-prediction` route), unchanged; an API-key caller there counts as internal (§3 Q6).
- **Token in the JSON response** (F14): `result.trustedState` (same string as the SSE event), also through the queue job result. A failed non-streaming turn returns no token (an HTTP error), so such clients retry with their previous one.

### 2.10 Child flow tokens (TS16)

- **In**: `executeNode` passes `childFlowToken: turnInput.childFlowTokens[nodeId]` in the run params.
- **Node** (`ExecuteFlow.ts`): sends `trustedState: childFlowToken.token` only when `childFlowToken.flowId` equals the selected flow; otherwise the child starts fresh. It returns `childFlowToken: { flowId, token: response.data.trustedState }` at the top level of its result, and leaves `trustedState` out of the whole-JSON fallback text (`:226`).
- **Out**: after the node returns, the server moves `results.childFlowToken` into `childFlowTokens[nodeId]` (no token in the response deletes the entry) and removes it from `results`, so it never reaches records, client payloads or recorded executions.
- Chat id, override config and Merge State (`[last].data.state`, kept by the external pruning) are unchanged.
- **Iteration**: items run in order and share the turn's object, so an Execute Flow inside an iteration continues one child conversation, as one chat id does in DB mode today.
- **Failed child call**: the node throws, the entry is unchanged. A child that stops for human input is not resumed: the next parent turn sends the child token with a question, which abandons the child's pause (limitation, recorded in Task 08).

### 2.11 Expected compare results

`compare.config.json` `tokenV2`: `history`, `flowState`, `formValues`, `childFlowTokens`, `pendingResume`. History checks use `tokenV2.historyPath` unless they name their own path (`compare-traces.mjs`, changed in this task, also gained `tokenHistoryAlternates`).

| Entry | Finding / decision | Scenarios, turns | Expected after-behaviour |
| :--- | :--- | :--- | :--- |
| F01-M3-like-M1 | F01, TS9 | M3: S01, S05, S06, S07, S12 | class A equals M1 |
| F02-S10a-accept-on | F02, TS13, TS13a, TS22, D16 | S10a@accept-client-history-on | client history (welcome first) is the turn history and is saved; memory-off Quick Answer gets no history; t3 warning; t4 the override copy is trimmed and the question added |
| F02-S10a-accept-off | F02, TS13a, TS22, D16 | S10a@accept-client-history-off | `history` ignored with a warning; Quick Answer gets no history on t1–t3 and on t4 the override as sent (welcome included, no question, as today); Context Agent sees the token history once, no welcome |
| F03-S04b-state-carries | F03, TS11 | S04b t2+ | as S04a today |
| F04-S05-new-form-wins | F04, TS12 | S05 t4 (M1, M3) | Grace Hopper / shipping |
| F05-S06/S07/S08 | F05, TS15 | resume turns + later | answers are user messages |
| F06-S06b-toggle-off | F06, TS15, D8 | S06b t2+ | history t3 = [user, bot], t4 = [user, bot, user]; the t4 Drafter sees the t3 reply; no state flag; slim action |
| F07-alternating-history | F07, TS15, D8, D9 | S06, S06b, S07, S08 | token history alternates, starts with a user message, no blank message; S08 t2's stop message is the gate's prompt |
| F08-no-action-in-history | F08, TS26 | S06, S06b, S07, S08 | no `action` key in history |
| F09-no-record-copies | F09, TS26 | S06, S08 t2–t3 | token ≤ 0.5 × before |
| F10-S12-child-token | F10, TS16 | S12 t2+ | child sees its history; `child_count` 1–4 |
| F11-S10b-ephemeral-dropped | F11, TS17, D14 | S10b t2+ | Agent sees earlier turns; history 2/4/6 messages; counter 1–3 |
| F12, F13, F14, F15-F16, F17, F18, F19, TS5, TS14 | as named | as in the Task 00b draft | unchanged |
| TS25-S03-composer | TS25, D15 | S03 t1–t4 | Researcher and Critic replies reach the Composer as `assistant` messages |
| TS25-S09-aggregator | TS25, D15 | S09 t1, t3 | the Aggregator's first-pass reply reaches its second pass as an `assistant` message |
| TS26-resume-input (was TS-O1-resume-input) | TS26, D5 | S07, S08 | Agent resumes send today's model input |
| SIZE-token-v2 | F13, TS19 | every token turn | raw JSON ≤ 5 % of before (estimate from `before/` ≤ 2.2 %; paused turns under 1 K base64 in Task 03); S12 ≤ 10 % (child token inside); S13 ≤ 4 KB |

Sentinels: 0 in every token (paused turns included), action and external executed data; ≥ 1 in internal executed data (M1-internal) and recorded rows (M2). `continue-v1` traces (Task 10) may carry a prompt in the paused tokens of S07 t2 and S08 t1 until resumed (D4).

Task 01 tests revised here: F11 (TS17 as changed in Task 02: the token keeps the whole history and the agent sees earlier turns) and the TS13a key (2.8); the F02 t4 expectation (question added after trimming) matches D16 as it stands.

### 2.12 Concurrent and stale tokens (TS-O4, D17)

- **Last writer wins.** The server keeps no per-conversation state; each request continues from the token it carries. Two requests with the same token produce two tokens; the client keeps whichever it stores last, and the other turn is lost from history and state.
- An older token sent again replays from that point: retrying a failed turn (VoIP, Celery) works as intended; answering an approval twice resumes twice, so an approved tool can run twice, as trusted mode does today.
- No detection: it would need server-side conversation state (TS9).
- **Client rule** (Task 10 client note): one request at a time per conversation; keep the token of the latest completed turn; resend the previous token to retry a failed turn; hide approval buttons once answered. LoopChatEmbed's card and canvas requests sent alongside chat turns, and the VoIP observer posting with the main flow's token, break it (client follow-ups outside this plan).
- The per-turn debug log (chat id, incoming history length, pending in/out) makes duplicates and stale tokens traceable.

---

## 3. Client questions ([client-inventory.md](./client-inventory.md) §6)

| # | Question | Triage |
| :--- | :--- | :--- |
| 1 | Same-turn replies | Answered (TS25). |
| 2 | Production VoIP and Celery flow settings | Not available; the design does not depend on them. Task 10 checks the four VoIP flows and the Celery flows: memory settings, enabled overrides, how a memory-off LLM sees the question, `legacy_history` (2.7 VoIP). |
| 3 | `bots.intheloop.io`: Flowise or proxy | Flowise itself (user; ALB → nginx → Flowise 3.0.12, `dev-env/architecture/research/today/10-flowise.md:65`), so VoIP's `history` items never pass the proxy's parser. |
| 4 | Concurrent and stale tokens | TS-O4: last writer wins (2.12). |
| 5 | Proxy deployments using `FLOWISE_CLIENT` | Rollout (Task 10). |
| 6 | API-key callers of `/internal-prediction` | No change: an API key has owner rights and can read the flow (prompts included) through the API anyway. |

---

## 4. Decisions

For the plan session to record in PLAN §2. "User" = settled in the review on 2026-11-23; "Design" = settled in this task without changing model input beyond PLAN §2.

| ID | Topic | Decision | Source |
| :--- | :--- | :--- | :--- |
| D1 | v2 field names | `version`, `history`, `flowState`, `formValues`, `childFlowTokens`, `pendingResume` (2.1) | Design |
| D2 | History message | `role`, `content`, `fileUploads`, `artifacts`; roles `userMessage`/`apiMessage`; `usedTools` and `fileAnnotations` dropped (2.2) | Design |
| D3 | Unknown or broken token | warning, new conversation (2.3) | Design |
| D4 | v1 paused tokens | a v1 Agent checkpoint is replayed once, exactly as today; it stays in the pending data (system prompt included) only until that Agent is resumed (2.4) | User |
| D5 | Agent checkpoint (refines TS26) | the resumed Agent re-resolves its own Messages list from the current flow; the rest of the stopped prompt is stored with history references and replayed (2.6) | User |
| D6 | Failed resume | returns the incoming token unchanged, so answering again retries; replaces today's ERROR-after-STOPPED rule (2.6) | Design |
| D7 | Client history on resume turns | ignored with a warning (2.7) | Design |
| D8 | History toggle off | the stop turn saves only the user message, the resume saves only the reply (DB mode's result, Task 01's F06 test) (2.7) | Design |
| D9 | Blank stop message (S08 t2) | the prompt of the node still waiting (2.7) | User |
| D10 | Recorded executions on resume | one row per paused run through `updateExecution`'s read, which stays allowed in the harness; missing rows tolerated (2.6.1) | Design |
| D11 | Recorded chat messages on resume | update or delete the stop message by `stopMessageId` (2.6.2) | Design |
| D12 | Settings | `clientState.enabled` / `enabledFull` stay as write switches, `clientState.acceptClientHistory` is new; the request flag only stands in for an unset `enabled` (2.8) | Design |
| D13 | Client overrides (amends TS24) | no override is blocked; `llmEnableMemory` and the other memory overrides apply as today where the flow enables them; `startEphemeralMemory` does nothing since TS17 (2.8) | User |
| D14 | Start node | Persist State and Ephemeral Memory removed, version 1.2; stored values ignored; warning for flows with ephemeral on (2.8) | User |
| D15 | Return Response As | User Message removed; Assistant Message default; a stored `userMessage` means assistant and syncs to the default; Agent, LLM, Execute Flow versions bumped (2.8) | User |
| D16 | TS-O3: VoIP and overrides that repeat the history | VoIP keeps its call (welcome, fillers) in `llmMessages`; an override tail repeating the turn history is trimmed only when the node has memory on or the history came from an accepted client `history`; the question rule runs on what remains; VoIP's `history` is ignored while TS13a is off (2.7) | User |
| D17 | TS-O4: concurrent and stale tokens | last writer wins, no detection; client rule documented (2.12) | User |

---

## 5. Acceptance Criteria

- [x] §2.1–2.12 complete in this file and reviewed with the user.
- [x] TS-O3 and TS-O4 resolved (D16, D17; the plan session records them in PLAN §2).
- [x] Tasks 05–09 updated to match (and Task 10's rollout checklist).
- [x] `compare.config.json` lists every intended difference; dry run against `before/` in [reports/04-config-dry-run.md](./baselines/reports/04-config-dry-run.md).
