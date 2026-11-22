# Client Inventory (Task 02)

What the clients of Agentflow V2 predictions send and read, for TS13/TS13a, TS18, TS20 and TS22.

- **Read at**: Flowise `6b10339e`; smart_assistant `743cc18a5` (the VoIP consumer changed while this was written and changed back; see 2.7); LoopChatEmbed `30dbd0c`; loop_int_rust `37b5a8c` (uncommitted test edits only); loop-apps `1c182b1`.
- **Method**: code reading only. Nothing was run against a deployed service; production flow settings and Mongo configs were not available (§6).
- Path prefixes: Flowise paths are repo-relative; others are `<repo>:path:line`.

---

## 0. Decisions (user, 2026-11-22)

Recorded in PLAN §2 as TS17 (changed), TS22, TS23 and TS24; open points as TS-O2 and TS-O3:

1. **Every client that matters round-trips the token**, on every turn and with approval answers. Callers that do not send it are obsolete and ignored (listed in §1).
2. **Node memory settings decide the history.** A node's own memory settings (on/off, all messages, window, summary, …) alone decide which history it sees. History is the conversation's user and assistant messages; anything else from earlier nodes in the flow reaches a node only through its own "Add Messages" list.
   - **Same turn**: a node whose reply is appended to the history adds it as an **assistant** message, and memory-on nodes that run after it see it as a normal part of the history. A reply that is not appended is visible to later nodes only as an output variable (`{{nodeId}}`).
   - Consequence: "Return Response As" offers User Message (the default for Agent, LLM and Execute Flow: `Agent.ts:389-405`, `LLM.ts:176-192`, `ExecuteFlow.ts:90-`), Assistant Message and "Do not append to chat history". Every node in the scenario flows uses the default, and in `before/` S03's Composer and S09's Aggregator receive same-turn replies as user messages named after the node. Under the rule those become assistant messages, so their model input changes (TS6: compare entries in Task 04/06), and the User Message option goes away or maps to Assistant Message (Task 04 decides how existing flows migrate).
   - Only the turn's final answer is saved to the token history (`buildAgentflow.ts:2209-2245`); same-turn replies stay in the turn's runtime history, as today.
3. **No ephemeral memory and no client memory switches, for now.** The client overrides `startEphemeralMemory` and `llmEnableMemory` are blocked (they were workarounds for current conditions), and ephemeral memory is dropped (no use case). The aim is clear, predictable message composition in the node UI. Presumably the other memory-setting overrides (`agentEnableMemory`, `*MemoryType`, `*MemoryWindowSize`, …) go the same way; Task 04 lists them.
4. **VoIP's `llmMessages` need checking.** The VoIP client sends its conversation in `llmMessages` most consistently and expects the welcome message to stay visible to the model, so that the bot does not greet again (§3.1).

---

## 1. Clients that matter

| Client | Reaches Flowise | Streams | Token | Approval answers | `history` | Conversation in overrides | Memory overrides sent | Executed data read | `action` read |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Flowise internal chat | `/internal-prediction` | yes (no if Post Processing) | every turn incl. approvals, from SSE only; memory only | yes | no | no | no | full records (internal) | `elements[].{type,label}`, `data.nodeId`, `data.input.humanInputEnableFeedback` |
| Execute Flow node (child calls) | `/prediction` (`flowise-tool`, no SSE) | no | none today; child tokens with TS16 (Task 08) | no | no | no | no | `[last].data.state` (Merge State) | — |
| LoopChatEmbed (Posta, Noma, Ema legacy) | via `flowise_proxy` | yes (JSON if the flow cannot stream) | every request incl. approvals; localStorage | yes | no (`extraHistory` only) | no | no | none | `elements[].{type,label}`, `data.nodeId`, `data.input.humanInputEnableFeedback` |
| loop-apps chat-core (Ema) | via `flowise_proxy` | yes, always | every request incl. approvals; localStorage | yes (actions module; Ema has none) | no | no | no | none (stored whole) | as LoopChatEmbed |
| `flowise_proxy` (Rust) | `FLOWISE_CLIENT` unless `LOOP_FLOW_CLIENT` | pass-through | passes through | passes through | passes through | — | — | `[last].data.state.transfer_to_human` | — |
| VoIP consumer (smart_assistant) | direct | yes | every turn of a call; memory | none (flow-state driven) | when `legacy_history` (code default on, sample configs off) | **`llmMessages`, every turn, welcome first** | `llmEnableMemory: false`, `startEphemeralMemory: true` | `[last].data.state` | — |
| Celery Flowise bots (smart_assistant) | direct | yes | every turn; Mongo | none | no | **`llmMessages`** (no welcome) | `llmEnableMemory: false`, `startEphemeralMemory: true` | `[last].data.state` | — |

**Ignored** (no token, obsolete): the execution viewer's Proceed/Reject (`packages/ui/src/views/agentexecutions/NodeExecutionDetails.jsx:111-126`), the share page `/chatbot/:id` and the embed snippets (`flowise-embed`), the ChatflowTool and AgentAsTool nodes, the EvaluationRunner, and the one-off smart_assistant scripts.

**Not Flowise clients**: smart_assistant `web_servers/bot_server` (a Flowise-protocol server with its own Fernet token, `smart_assistant:web_servers/bot_server/trusted_state_helpers.py:16,44-54`), and the Loop Flow bots behind the proxy (Posta `posta-ui`, Noma `noma-0.1.0`, Una; `loop_int_rust:services/flowise_proxy/docs/persistent-chats-options.md:42-43`). Ema (`ffbc7616-977f-4c54-8462-237763b11a72` external, `f8c20565-3dd7-4536-9cfc-f54de1420cf2` internal; `loop-apps:apps/emb/src/config/env.ts:39-40,65-72`) is the only Flowise tenant among the widgets.

---

## 2. Clients

### 2.1 Flowise internal chat (`packages/ui/src/views/chatmessage/ChatMessage.jsx`, abbreviated CM)

- **Endpoint**: `/api/v1/internal-prediction/:id` → `utilBuildChatflow(req, true)` (`packages/server/src/controllers/internal-predictions/index.ts:24,49`). Streams with `fetchEventSource` when `isChatFlowAvailableToStream` (CM:1066-1077, set from `GET /chatflows-streaming/:id` CM:1336-1341; AGENTFLOW streams unless Post Processing is on, `packages/server/src/services/chatflows/index.ts:56-65`); otherwise axios JSON (CM:1020).
- **Body** (CM:1003-1015): `question` or `form`, `chatId`, `uploads`, `leadEmail`, `action` (non-V2 buttons only), `humanInput`, `trustedState`. Never `history` or `overrideConfig`.
- **Events**: `agentFlowEvent` (status), `nextAgentFlow` (`nodeId`, `status`, `error` → canvas), `agentFlowExecutedData` (whole array on the last message, CM:643-650), `action` (whole, CM:652-659), `trustedStateData` (CM:1113-1114), `metadata` (`chatMessageId`, `chatId`, `question`, `followUpPrompts`; CM:856-891), `token`, `sourceDocuments`, `usedTools`, `calledTools`, `fileAnnotations`, `artifacts`, `agentReasoning`, `error`, `end`. `usageMetadata` has no handler.
- **JSON path** (CM:1021-1049): `text` / `json` / whole JSON as text (CM:1029), `chatMessageId`, `chatId`, `question`, `followUpPrompts`, `sourceDocuments`, `usedTools`, `calledTools`, `fileAnnotations`, `agentReasoning`, `agentFlowExecutedData`, `action`, `artifacts`. No token (F14), and the server JSON carries no `action` (`buildAgentflow.ts:2267-2277`), so no approval buttons on this path.
- **Executed data** (`AgentExecutedDataCard.jsx`): `nodeId`, `nodeLabel`, `status`, `previousNodeIds` (`.length` unguarded, :461, :528), `data.name`, `data.parentNodeId`, `data.iterationIndex`, `data.iterationContext` (:366-401, :457, :539-540, :586-593); node dialog shows the full `data` (:188). Internal: stays full under TS18.
- **Action**: `elements[].type` (`agentflowv2-approve-button` / `-reject-button`), `elements[].label`, `data.nodeId` (CM:818), `data.input.humanInputEnableFeedback` (CM:845). Not read: `id`, `mapping`, `data.nodeLabel`, `extra`. Within TS20.
- **Token**: `useRef` only (CM:284); set from SSE only (CM:1114); sent on every submit once set, approvals included (CM:1015); cleared when the chat closes or is cleared (CM:1513-1515; Clear also closes the popup, `ChatPopUp.jsx:48-53,157-167`); not cleared on error; not in localStorage (`${id}_INTERNAL` holds `{chatId, lead}`, `genericHelper.js:871-888`). Reload restores nothing under client state (F17).
- **Approval answer** (CM:810-854): `humanInput {type, startNodeId: action.data.nodeId, feedback}` with `question = feedback || 'Proceed'|'Reject'`; without the feedback dialog `feedback` is the button label (CM:849); Cancel and Submit in the dialog both send (CM:3171-3174).
- `/internal-prediction` also accepts workspace API keys (`packages/server/src/index.ts:226-283`), so an API-key caller would get `isInternal` (full executed data under TS18).

### 2.2 Execute Flow node (`packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.ts`)

POST `/api/v1/prediction/:id` with `flowise-tool: true` (no SSE: `buildChatflow.ts:1004` → `buildAgentflow.ts:1223`) and `{question, chatId: parent chatId, overrideConfig}` (:203-218). Reads `text` / `json` / whole JSON as text (:224-226) and, with Merge State, `agentFlowExecutedData[last].data.state` (:240-246). No token today (F10); TS16 makes the parent send and keep each child's token (Task 08). The whole-JSON fallback (:226) would put a token into the result text once F14 adds it to the JSON response (Task 05).

### 2.3 LoopChatEmbed (`LoopChatEmbed:src/components/Bot.tsx`)

- **Path**: `{apiHost}/api/v1/prediction/{id}` where `apiHost` is a Loop proxy (`posta-proxy.intheloop.io`, `nomago-proxy.intheloop.io`; `src/customers/posta/posta.ts:5-6`, `src/customers/travel/travel-base.ts:953`). Streams via fetch-event-source when `GET /chatflows-streaming/{id}` allows (default true before it loads; `src/components/user/userProvider.tsx:59,118-139`), else JSON (:3335-3351). Card/canvas requests always stream; non-blocking ones use `/prediction/async/{id}` (:2118, :2917-2918).
- **Events**: `token`; `agentFlowEvent` (status); `agentFlowExecutedData` (whole array stored on the message and in localStorage, :2417-2419; no field read, the tree view is off for every bundled tenant, `BotBubble.tsx:861-866`); `trustedStateData` (:2420-2423); `action` (whole, JSON-parsed if a string, :2427-2429); `metadata` (`chatId`, `chatMessageId`, `question`, `followUpPrompts`); `sourceDocuments`, `usedTools`, `fileAnnotations`, `agentReasoning`, `artifacts` stored whole; `error`; `tts_*`; Loop-only events. Ignored: `calledTools`, `usageMetadata`, `nextAgentFlow`, `nextAgent`, `tool`. JSON path: same fields, no token.
- **Action**: `elements[].type`, `elements[].label`, `data.nodeId`, `data.input.humanInputEnableFeedback` (:3451-3472, :3518-3526). Whole action echoed only for V1 buttons (:3528-3529). Within TS20.
- **Token**: memory signal (:799) + `localStorage["{chatflowid}_EXTERNAL"].trustedState` (:1565-1570). Sent on every prediction when non-empty, with `enableTrustedState: true` always (`addPlatformData` :2800-2815): chat turns, approvals, retries, card/canvas requests. Not cleared on error/abort; reset on Clear chat (:3565) and new/removed session (:3756-3761); restored on reload unless older than 24 h or a new browser session (`postaBase.ts:46-47`, `travel-base.ts:1039-1040`).
- **Approval answer**: `humanInput {type, startNodeId: action.data.nodeId, feedback}`, `feedback` = button label or dialog text; `question = feedback || 'Proceed'|'Reject'`; the action is set to `null` and persisted (:3508-3517); retries resend `humanInput` with the then-current token (:1781, :1906).
- **History**: no `history` to predictions; `extraHistory` (live-agent messages) always sent (:1164-1167, :2805-2806); `overrideConfig = config.chatflowConfig` (:3283), set by neither bundled tenant (+ `nomaHostContext` when the host passes it, :3313-3319).

### 2.4 loop-apps chat-core / transport (Ema)

- **Path**: `ProxyClient` → `{apiHost}/api/v1/prediction/{chatflowid}` (`loop-apps:packages/core/transport/src/client.ts:235-236,384-399`), always `streaming: true` (:457). Ema production via `emb-proxy.intheloop.io`; test `embtest.intheloop.io` ("our test Flowise", `apps/emb/package.json:29`).
- **Events** (`packages/core/chat-core/src/chat.ts:582-730`): `token`, `start` / `agentFlowEvent` (`ERROR` fails the turn), `action` (whole, persisted), `agentFlowExecutedData` (whole array persisted, no field read), `trustedStateData`, `metadata` (`chatMessageId`; `followUpPrompts` only as a string, so Flowise's array is dropped), `sourceDocuments`, `usedTools`, `agentReasoning`, `artifacts`, `fileAnnotations`; others → `onUnknownEvent`. Ema has no actions module (`apps/emb/src/api.ts:44`).
- **Token**: memory + `localStorage[{storageId}_EXTERNAL].trustedState` (`chat.ts:159,203-214`); sent on every request incl. `humanInput` answers, retries, background sends (`chat.ts:550-580`), `enableTrustedState: true` always (:556); dropped if its turn was aborted or the chat is no longer live (:592); not cleared on error.
- **Approval answer** (`packages/widget-kit/src/modules/actions/actions.ts:42-47`, `actions/index.tsx:31-50`): as LoopChatEmbed.
- **History**: none to predictions (`extraHistory` instead, `chat.ts:194-195,571-572`); no `llmMessages`/`agentMessages`.
- Ema's test config has `clientState.enabled: false` (`apps/emb/e2e/fixtures/config.ts:6`), which wins over `enableTrustedState` (`buildAgentflow.ts:1235`), so Ema test runs in DB mode today.

### 2.5 `flowise_proxy` (`loop_int_rust:services/flowise_proxy`)

- Calls Flowise (`FLOWISE_CLIENT`, Bearer key) only when `LOOP_FLOW_CLIENT` is unset (`src/main.rs:1948-1959`); remaps ids by `CHATFLOW_MAPPINGS` (:291-300). Streams when the body says `streaming: true` (:932), else returns Flowise's JSON reading `text`, `messageId` (:933-966).
- **Pass-through**: every upstream `data:` line goes to the browser unchanged (`crates/flowise_client/src/lib.rs:87-91`; `main.rs:880,1066-1117`); adds `rememberUser`, a re-serialized `metadata`, `setLoopinId`, `widgetMode` frames.
- **Reads**: `token`, `metadata.{chatId, chatMessageId}`, `agentFlowEvent` INPROGRESS/FINISHED, `agentFlowExecutedData[last].data.state` → `transfer_to_human` (`main.rs:1055-1062,1146-1160`). Not `action`.
- **Request**: `trustedState`, `enableTrustedState`, `humanInput`, `history` pass through (`crates/widget_models/src/requests.rs:110-125,158-222`); the proxy never stores the token. A proxy-parsed `history` item needs `message` and `type`, Flowise needs `role` and `content` (`buildAgentflow.ts:1198-1204`); no widget sends `history` today.

### 2.6 smart_assistant shared transport (`smart_assistant:flowise/client.py`)

Body: `chatflowId, question, overrideConfig, chatId, history` (`[]` when empty), `uploads: []`, `streaming`, `trustedState` when set (:133-143, :155-164, :181-191, :211-221). Streamed calls check `chatflows-streaming` first (:96-107) and parse every `data:` line (:174-231). Abort: `PUT /api/v1/chatmessage/abort/{flowId}/{chatId}` (:233-248). No caller sends `humanInput`, `action`, `form`, `enableTrustedState` or `agentMessages`.

### 2.7 VoIP consumer (`smart_assistant:voip/ai_processors/flowise_text_consumer.py`, abbreviated ftc)

- **Request** (`ProcessPrediction.get_prediction_data`, ftc:200-228): `overrideConfig = {memoryType: 'BufferMemory', sessionId: <per call>, llmEnableMemory: false, startEphemeralMemory: true}`, plus `stateMemory` and `startState` from the client's flow state (always present: `past_pii_labels`, `question_pii_labels`), `vars` (`phone_number`, `can_transfer`, `can_transfer_alt_offices`, `lang`, `mode: 'VOICE'`). **`overrideConfig.llmMessages`** = the whole conversation as user/assistant messages whenever there is any (ftc:214-216). **`history`** = the same conversation as `{message:'', type:'', role, content}` when `legacy_history` is on (ftc:218; `FlowiseProcessor.__init__` default `legacy_history=True`, ftc:517; both sample configs set `false`, `projectDocs/voip-bot-configs/ilirika_demo.json:27`, `mimovrste_demo.json:25`). `trustedState` when held. `question` = the redacted speech since the last answered bot message.
- **Conversation** built from the call transcript (ftc:608-663): the welcome message first as an assistant message if it was played, uninterrupted messages, consecutive user fragments merged, PII-redacted unless `dont_redact_for_llm`, a filler bot message last; `keep_original_history` sends the client's own Q/A list instead.
- **Events** (ftc:231-292): `token`, `trustedStateData` (stored), `agentFlowExecutedData` (only `data[-1].data.state`, which replaces the client flow state), `nextAgentFlow` (logged), `error`, `end`, `metadata` / `usageMetadata` (logged). Flow-state keys used afterwards: `share_extra_info`, `share_extra_details`, `transfer_to_human`, `override_transfer_number`, `end_call`, `transfer_to_human_copy`, `intent`, `requestInteraction*` (ftc:386-445, :546-577, :679).
- **Token**: in memory per call, sent whenever set; a turn works on a state copy committed when the first reply audio is ready, so a failed or cancelled turn and its retry resend the last committed token; a turn started before the previous stream finished sends the older token.
- **Observer** (`voip/ai_processors/usecases/flowise/flowise_observer.py:17-60`): posts `question: ''` to other flows at call start/end using the processor's live state, so its token, state and Q/A overwrite the main flow's. Not configured in the sample configs.
- **Flows** (`VoipBotConfig.text_processor.kwargs.chatflow_id` in Mongo): `3f34cf73-33b5-41a3-94c7-21fb85717e0b` (ilirika demo), `bd3d4171-49e3-4d5b-b051-b1ecd5cdc194` (mimovrste demo), OTP Oneshot `8828f3e2-fb37-4398-8b51-6a205e9c2e0e`, OTP RAG `c21437aa-7ae1-4029-b717-08d6f7628c79` (untracked `voip/barefake/RESULTS.md:9,118`); all on `bots.intheloop.io`.
- While this inventory was written, the working tree briefly forced `legacy_history=True` and stopped sending `llmMessages`; the committed code above sends both. Re-check before deploy.

### 2.8 Celery Flowise bots (`smart_assistant:ai/bots/flowise/flowise_tasks.py`)

- Same `ProcessPrediction` with `legacy_history=False` (:129-135): `history: []`, the conversation in `overrideConfig.llmMessages` (stored Q/A pairs, no greeting), `llmEnableMemory: false`, `startEphemeralMemory: true`, `vars` (`{mode: 'EMAIL'}` for email).
- Token, flow state and session id persisted per thread in Mongo (`helpers/bots/smart_thread.py:47-50,97-120,160-164,288-292`); sent every later turn; not saved after an exception, an empty reply or a failed chat post, so the previous token is resent. One-shot email starts fresh.
- Reads `agentFlowExecutedData[-1].data.state` (platform tag/team/force-post keys, `flowise_tasks.py:296-305,321-369`).
- Flows: `BotTypeFlowiseConfig.{base_url, api_key, chatflow_id}` per community and bot (`ai/bots/models.py:346-373`), Mongo only. Meri also prefixes the previous Q/A to `question` (`Meri/answer.py:404-412`).

---

## 3. History (TS13, TS13a, TS22)

| Flows | Client | `history` field | Conversation in overrides | Memory overrides (blocked, decision 3) | Effect of the decisions |
| :--- | :--- | :--- | :--- | :--- | :--- |
| VoIP flows (`VoipBotConfig` rows; ids in 2.7) | VoIP consumer | when `legacy_history` is on; starts with the welcome message | `llmMessages` every turn, welcome first | `llmEnableMemory: false`, `startEphemeralMemory: true` | The flows' own node memory settings take effect; see 3.1 for the welcome. TS13a is needed only if VoIP's conversation is to become the turn's `history`. |
| Celery bot flows (`BotTypeFlowiseConfig`) | Celery bots | no | `llmMessages` every turn, no welcome | same two | Same: node memory settings take effect; with memory on, the token history and the `llmMessages` conversation would both reach the node. |
| Ema, Flowise internal chat | — | no | no | no | none |

No client that matters sends `agentMessages`. Only the VoIP consumer sends `history`.

### 3.1 VoIP `llmMessages` and the welcome message

Today:
- VoIP sends the whole call conversation in `overrideConfig.llmMessages` on every turn: the welcome message first (as `assistant`, if it was played), then user/assistant turns, a filler last (ftc:214-216, :608-663).
- The server applies an array override only to nodes whose API override settings enable `llmMessages`, and **appends** it to the node's configured messages (`packages/server/src/utils/index.ts:1137-1148`). The LLM node puts system messages first and keeps the rest in order (`LLM.ts:421-430`).
- **Memory off** (what VoIP forces where the override is enabled): the node adds the current question only when none of its messages has the user role (`LLM.ts:465`). VoIP's conversation has user turns, so the node adds no question of its own; S10a t4 shows the same shape (Quick Answer's model input ends with the history, without the question). Whatever the production flows do to show the question is in their node configuration (§6 Q1).
- **Memory on**: the token history and the current question are added by the memory handling, and the strict window mode (`llmMemoryWindowDisableStrict` off by default, "useful if you're overriding llmMessages") trims user/assistant messages across the whole list, the `llmMessages` conversation included (`LLM.ts:800-812`).
- The welcome message is never in the token (the server never sees it). A model sees it only through `llmMessages`, or through the `history` prepend when `legacy_history` is on.

After decisions 2 and 3 (memory overrides blocked, node memory decides):
- Nodes whose own memory is off: same model input as today, welcome included.
- Nodes whose own memory is on: the token history (no welcome) plus VoIP's `llmMessages` conversation, i.e. the conversation twice.
- To keep the welcome visible without a second copy, Task 04/06 choose between: (a) VoIP's conversation becomes the turn's history (TS13: `history` with the welcome first, TS13a on), and the conversation leaves `llmMessages`; (b) VoIP's LLM nodes keep memory off and `llmMessages` stays the conversation, as today. Either way the production VoIP flows' memory and override settings decide what changes (§6 Q1).

## 4. Executed data and `action` against TS18 / TS20

Every client that matters reads from executed data only `[last].data.state` (VoIP, Celery bots, proxy, Execute Flow) or nothing (LoopChatEmbed, loop-apps: stored whole, never read); the internal chat keeps full records. TS18 holds.

`action`: every client reads only `elements[].{type,label}`, `data.nodeId` and `data.input.humanInputEnableFeedback` (LoopChatEmbed also holds `data` whole). Nobody reads `id`, `mapping`, `data.nodeLabel` or `extra`, and V2 answers never echo the action. TS20 holds.

## 5. Token round-trip and answers

- Every client that matters round-trips the token: internal chat (from SSE only), LoopChatEmbed, loop-apps, VoIP, Celery bots; Execute Flow children get theirs with TS16.
- Approval answers carry the token in the internal chat, LoopChatEmbed and loop-apps; VoIP and the Celery bots have no approvals.
- Answers send `question = feedback || 'Proceed'|'Reject'` together with `humanInput`, and `feedback` is the button label when no feedback dialog is used. Relevant to TS15 (the server cannot tell typed feedback from a label).
- No client reads a token from the JSON response (F14); the internal chat and LoopChatEmbed have JSON paths that would need it.
- Stale or competing tokens: LoopChatEmbed sends card/canvas requests alongside chat turns and whichever token arrives last wins; VoIP and Celery resend the last committed token after a failed turn; the VoIP observer overwrites the main flow's token with another flow's (2.7).

## 6. Open questions

1. **VoIP and Celery flows in production**: their node memory settings, the overrides they enable (`llmMessages`, `llmEnableMemory`, `startEphemeralMemory`, `startState`, `stateMemory`, `vars`), how they show the current question to a memory-off LLM, and `legacy_history` in the production `VoipBotConfig` rows. Flowise DB and Mongo, not in any repo; needed for 3.1.
2. Is `bots.intheloop.io` Flowise or the proxy? The proxy's history item type rejects `type: ''`, which the VoIP consumer sends with `history` (matters for 3.1 option a).
3. Concurrent requests with the same token, and older tokens resent after failures (§5): last writer wins, or detect it (Task 04)?
4. Which proxy deployments use `FLOWISE_CLIENT` (Flowise) rather than `LOOP_FLOW_CLIENT` (rollout, Task 10).
5. Any API-key caller of `/internal-prediction` would keep full executed data (2.1).

Outside this plan: `flowise_proxy` treats `trustedStateData` (and `nextAgentFlow`, `artifacts`, `tts_*`) as unknown events, which sets `must_have_content` (`main.rs:1009-1014`). Flowise sends `trustedStateData` after `agentFlowEvent FINISHED`, and with platform sync on FINISHED empties the reply (`main.rs:1040-1044`), so the proxy may append its fallback text and sync it to Loop (`main.rs:1134-1144,1162-1172`). Inferred from code, not run; browsers stop at `end` and never see it.
