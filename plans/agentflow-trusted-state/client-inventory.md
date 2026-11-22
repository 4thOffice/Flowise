# Client Inventory (Task 02)

What each known client of Agentflow V2 predictions sends and reads, for TS13/TS13a, TS18, TS20 and TS22.

- **Read at**: Flowise `6b10339e`; smart_assistant `743cc18a5` (clean when last read; the VoIP consumer changed while this was written, see 2.9); LoopChatEmbed `30dbd0c`; FlowiseChatEmbed `6ae3852` (share page pins `4da78f38`); loop_int_rust `37b5a8c` (uncommitted test edits only); loop-apps `1c182b1`.
- **Method**: code reading only. Nothing was run against a deployed service; production flow settings and Mongo configs were not available (§6).
- Path prefixes: Flowise paths are repo-relative; others are `<repo>:path:line`.

---

## 1. Summary

| Client | Reaches Flowise | Streams | Round-trips the token | Approval answers | `history` to Flowise | History in overrides | Executed data read | `action` read |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Flowise internal chat | `/internal-prediction` | yes (no if Post Processing) | every turn incl. approvals, from SSE only; memory only | yes | no | no | full records (internal) | `elements[].{type,label}`, `data.nodeId`, `data.input.humanInputEnableFeedback` |
| Flowise execution viewer | `/internal-prediction`, public page `/prediction` | no | **no** | Proceed/Reject without a token | no | no | DB rows | — |
| Share page `/chatbot/:id` (flowise-embed fork) | `/prediction` | yes | **no** | yes | no | no | tree view (on for AGENTFLOW) | as internal chat |
| Embed snippets (npm `flowise-embed`) | `/prediction` | per flow | **no** | yes | no | no | tree view if `showAgentMessages` | as internal chat |
| ExecuteFlow / ChatflowTool / AgentAsTool nodes | `/prediction` (`flowise-tool`) | no | no | no | no | no | ExecuteFlow: `[last].data.state` | — |
| EvaluationRunner | `/prediction` | no | no | no | no | no | `nodeId`, `nodeLabel`, `data.output.usageMetadata`, `data.input.{llm,agent}ModelConfig` | — |
| LoopChatEmbed (Posta, Noma, Ema legacy) | via `flowise_proxy` | yes (JSON if the flow cannot stream) | every request incl. approvals; localStorage | yes | no (`extraHistory` only) | no | none (tree view only if `showAgentMessages`, set by no tenant) | `elements[].{type,label}`, `data.nodeId`, `data.input.humanInputEnableFeedback` |
| loop-apps chat-core (Ema) | via `flowise_proxy` | yes, always | every request incl. approvals; localStorage | yes (actions module; Ema has none) | no | no | none (stored whole) | as LoopChatEmbed |
| `flowise_proxy` (Rust) | `FLOWISE_CLIENT` unless `LOOP_FLOW_CLIENT` | pass-through | passes through | passes through | passes through | — | `[last].data.state.transfer_to_human` | — |
| VoIP consumer (smart_assistant) | direct | yes | every turn of a call; memory | none (state-driven) | yes when `legacy_history` (code default on, sample configs off) | **`llmMessages` always** | `[last].data.state` | — |
| Celery Flowise bots (smart_assistant) | direct | yes | every turn; Mongo | none | no | **`llmMessages`** | `[last].data.state` | — |
| PlatformBot test mode (smart_assistant) | direct | yes, JSON fallback | no | no | no | no | **`nodeId`, `nodeLabel`, `data.output.*`** | — |

Not Flowise clients: smart_assistant `web_servers/bot_server` (a Flowise-protocol server with its own Fernet token, `smart_assistant:web_servers/bot_server/trusted_state_helpers.py:16,44-54`), and the Loop Flow bots behind the proxy (Posta `posta-ui`, Noma `noma-0.1.0`, Una; `loop_int_rust:services/flowise_proxy/docs/persistent-chats-options.md:42-43`). Ema (`ffbc7616-977f-4c54-8462-237763b11a72` external, `f8c20565-3dd7-4536-9cfc-f54de1420cf2` internal; `loop-apps:apps/emb/src/config/env.ts:39-40,65-72`) is the only Flowise tenant among the widgets.

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
- **Note**: `/internal-prediction` also accepts workspace API keys (`packages/server/src/index.ts:226-283`), so an API-key client can get `isInternal` (full executed data under TS18).

### 2.2 Execution viewer (`packages/ui/src/views/agentexecutions/`)

- Reads DB `Execution` rows (`GET /executions`, `/executions/:id`, `/public-executions/:id`), not SSE; renders `NodeExecutionDetails.jsx` (NED) from each record's full `data` (TS5 keeps these). `humanInputAction` is not read anywhere in `packages/ui`.
- **Proceed/Reject** on a STOPPED node (NED:1161-1190): non-streaming POST `{question, chatId: metadata.sessionId, humanInput {type, startNodeId: data.id, feedback}}` to `/internal-prediction/:agentflowId` (public page: `/prediction/`) with **no token** (NED:111-126). With Client State on it already fails: no previous execution (`buildAgentflow.ts:1290-1296` → `:1389-1392`). Under TS9 it can never work → Task 09.

### 2.3 Share page `/chatbot/:id` and embed snippets

- **Share page** (`packages/ui/src/views/chatbot/index.jsx`): `FullPageChat` from `flowise-embed` (`git://github.com/4thOffice/FlowiseChatEmbed#main`, locked to `4da78f38`, `packages/ui/package.json:42`, `pnpm-lock.yaml:1102-1107`), `chatflowConfig = chatbotConfig.overrideConfig`, and `theme.chatWindow.showAgentMessages = true` for AGENTFLOW (:47-59, :105-109). The widget POSTs `/api/v1/prediction/:id` with `{question, chatId, form?, uploads?, overrideConfig, leadEmail?, action?, humanInput?}` and has **no `trustedState` handling** (FlowiseChatEmbed `src/queries/sendMessageQuery.ts:4-15`, `src/components/Bot.tsx:1074-1092`). Under Client State a share-page conversation has no memory today; under TS9 none at all until the widget round-trips the token.
- **Executed-data tree** (`showAgentMessages`): `nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.parentNodeId`, `data.iterationIndex`, `data.iterationContext`, and the selected node's whole `data` as JSON (FlowiseChatEmbed `src/components/treeview/WorkflowTreeView.tsx`; same file in LoopChatEmbed `:317,326-328,360,420-427,547-550,663,674`). External under TS18, so the share page would show pruned records and lose iteration nesting.
- **Embed snippets** (`packages/ui/src/views/chatflows/EmbedChat.jsx:43,67,196,249`): unpinned upstream `cdn.jsdelivr.net/npm/flowise-embed` or `flowise-embed-react`; no token handling assumed (not in this repo).
- **API code dialog** (`APICodeDialog.jsx:285-698`): examples show only `question` and `overrideConfig`; the swagger documents `history` and `humanInput` but not `trustedState` (`packages/api-documentation/src/yml/swagger.yml:1258-1265,2114,2176`).
- **Client State dialog** (`packages/ui/src/ui-component/extended/ClientState.jsx:74,108-122`): toggles `clientState.enabled` / `enabledFull`; does nothing when the flow has no `chatbotConfig` yet.

### 2.4 Server-side clients in this repo

| Client | Request | Response read |
| :--- | :--- | :--- |
| Execute Flow node (`packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.ts:203-247`) | POST `/api/v1/prediction/:id`, `flowise-tool: true` (no SSE, `buildChatflow.ts:1004` → `buildAgentflow.ts:1223`), `{question, chatId: parent chatId, overrideConfig}` | `text` / `json` / whole JSON as text (:224-226); with Merge State, `agentFlowExecutedData[last].data.state` (:240-246). No token (F10). |
| ChatflowTool, AgentAsTool (`nodes/tools/ChatflowTool/ChatflowTool.ts:334-365`, `nodes/tools/AgentAsTool/AgentAsTool.ts:326-357`) | same, `{question, chatId, overrideConfig.sessionId}` | `text` |
| EvaluationRunner (`packages/components/evaluation/EvaluationRunner.ts:115-191`) | POST `/api/v1/prediction/:id`, `{question, evaluationRunId, evaluation: true, overrideConfig.sessionId?}` | per record `nodeId`, `nodeLabel`, `data.output.usageMetadata.{input,output,total}_tokens`, `data.input.llmModelConfig.{llmModel,modelName}`, `data.input.agentModelConfig.{agentModel,modelName}` (shown in `EvaluationResultSideDrawer.jsx:199-345`); `metrics`; `text` / `json` / whole JSON |

Whole-JSON fallbacks (CM:1029, `ExecuteFlow.ts:226`, `EvaluationRunner.ts:191`) would put a token into message text once F14 adds it to the JSON response (Task 05).

### 2.5 LoopChatEmbed (`LoopChatEmbed:src/components/Bot.tsx`)

- **Path**: `{apiHost}/api/v1/prediction/{id}` where `apiHost` is a Loop proxy (`posta-proxy.intheloop.io`, `nomago-proxy.intheloop.io`; `src/customers/posta/posta.ts:5-6`, `src/customers/travel/travel-base.ts:953`). Streams via fetch-event-source when `GET /chatflows-streaming/{id}` allows (default true before it loads; `src/components/user/userProvider.tsx:59,118-139`), else JSON (:3335-3351). Card/canvas requests always stream; non-blocking ones use `/prediction/async/{id}` (:2118, :2917-2918).
- **Events**: `token`; `agentFlowEvent` (status); `agentFlowExecutedData` (whole array stored on the message and in localStorage, :2417-2419); `trustedStateData` (:2420-2423); `action` (whole, JSON-parsed if a string, :2427-2429); `metadata` (`chatId`, `chatMessageId`, `question`, `followUpPrompts`); `sourceDocuments`, `usedTools`, `fileAnnotations`, `agentReasoning`, `artifacts` stored whole; `error`; `tts_*`; Loop-only events. Ignored: `calledTools`, `usageMetadata`, `nextAgentFlow`, `nextAgent`, `tool`. JSON path: same fields, no token.
- **Executed data**: no field read (`data.state` included) except by the tree view when `showAgentMessages` is set, which no bundled tenant does (`BotBubble.tsx:861-866`).
- **Action**: `elements[].type`, `elements[].label`, `data.nodeId`, `data.input.humanInputEnableFeedback` (:3451-3472, :3518-3526). Whole action echoed only for V1 buttons (:3528-3529). Within TS20.
- **Token**: memory signal (:799) + `localStorage["{chatflowid}_EXTERNAL"].trustedState` (:1565-1570). Sent on every prediction when non-empty, with `enableTrustedState: true` always (`addPlatformData` :2800-2815): chat turns, approvals, retries, card/canvas requests. Not cleared on error/abort; reset on Clear chat (:3565) and new/removed session (:3756-3761); restored on reload unless older than 24 h or a new browser session (`postaBase.ts:46-47`, `travel-base.ts:1039-1040`).
- **Approval answer**: `humanInput {type, startNodeId: action.data.nodeId, feedback}`, `feedback` = button label or dialog text (Loop change, FlowiseChatEmbed `Bot.tsx:1225`); `question = feedback || 'Proceed'|'Reject'`; action set to `null` and persisted (:3508-3517); retries resend `humanInput` with the then-current token (:1781, :1906).
- **History**: no `history` to predictions; `extraHistory` (live-agent messages) always sent (:1164-1167, :2805-2806); `overrideConfig = config.chatflowConfig` (:3283), set by neither bundled tenant (+ `nomaHostContext` when the host passes it, :3313-3319). `request_agent` (proxy endpoint, not Flowise) gets `history: messages().slice(1)` (:3477-3483).

### 2.6 loop-apps chat-core / transport (Ema)

- **Path**: `ProxyClient` → `{apiHost}/api/v1/prediction/{chatflowid}` (`loop-apps:packages/core/transport/src/client.ts:235-236,384-399`), always `streaming: true` (:457). Ema production via `emb-proxy.intheloop.io`; test `embtest.intheloop.io` ("our test Flowise", `apps/emb/package.json:29`).
- **Events** (`packages/core/chat-core/src/chat.ts:582-730`): `token`, `start` / `agentFlowEvent` (`ERROR` fails the turn), `action` (whole, persisted), `agentFlowExecutedData` (whole array persisted, no field read), `trustedStateData`, `metadata` (`chatMessageId`; `followUpPrompts` only as a string, so Flowise's array is dropped), `sourceDocuments`, `usedTools`, `agentReasoning`, `artifacts`, `fileAnnotations`; others → `onUnknownEvent`. Ema has no actions or reasoning module (`apps/emb/src/api.ts:44`); the widget-demo reasoning module reads `nodeLabel`, `status` (`packages/widget-kit/src/modules/reasoning/reasoning.ts:28-33`).
- **Token**: memory + `localStorage[{storageId}_EXTERNAL].trustedState` (`chat.ts:159,203-214`); sent on every request incl. `humanInput` answers, retries, background sends (`chat.ts:550-580`), `enableTrustedState: true` always (:556); dropped if its turn was aborted or the chat is no longer live (:592); not cleared on error.
- **Approval answer** (`packages/widget-kit/src/modules/actions/actions.ts:42-47`, `actions/index.tsx:31-50`): as LoopChatEmbed.
- **History**: none to predictions (`extraHistory` instead, `chat.ts:194-195,571-572`); no `llmMessages`/`agentMessages`.
- Ema test config has `clientState.enabled: false` (`apps/emb/e2e/fixtures/config.ts:6`), which wins over `enableTrustedState` (`buildAgentflow.ts:1235`), so Ema test runs in DB mode today.

### 2.7 `flowise_proxy` (`loop_int_rust:services/flowise_proxy`)

- Calls Flowise (`FLOWISE_CLIENT`, Bearer key) only when `LOOP_FLOW_CLIENT` is unset (`src/main.rs:1948-1959`); remaps ids by `CHATFLOW_MAPPINGS` (:291-300). Streams when the body says `streaming: true` (:932), else returns Flowise's JSON reading `text`, `messageId` (:933-966).
- **Pass-through**: every upstream `data:` line goes to the browser unchanged (`crates/flowise_client/src/lib.rs:87-91`; `main.rs:880,1066-1117`); adds `rememberUser`, a re-serialized `metadata`, `setLoopinId`, `widgetMode` frames.
- **Reads**: `token`, `metadata.{chatId, chatMessageId}`, `agentFlowEvent` INPROGRESS/FINISHED, `agentFlowExecutedData[last].data.state` → `transfer_to_human` (`main.rs:1055-1062,1146-1160`). Not `action`.
- **Token / request**: `trustedState`, `enableTrustedState`, `humanInput`, `history` pass through (`crates/widget_models/src/requests.rs:110-125,158-222`); the proxy never stores the token. A proxy-parsed `history` item needs `message` and `type`; Flowise needs `role` and `content` (`buildAgentflow.ts:1198-1204`) — moot today, no widget sends `history`. An echoed `action` must carry `mapping.toolCalls` or gets 400 (`main.rs:862-877`; V1 buttons only).
- **Observation**: `trustedStateData` (and `nextAgentFlow`, `artifacts`, `tts_*`) are unknown to the typed parser, which sets `must_have_content` (`main.rs:1009-1014`); Flowise sends `trustedStateData` after `agentFlowEvent FINISHED`, and with platform sync FINISHED empties the reply (`main.rs:1040-1044`), so the end-of-stream fallback text may be appended and synced to Loop (`main.rs:1134-1144,1162-1172`). Inferred from code, not run; browsers stop at `end` and never see it.

### 2.8 smart_assistant shared transport (`smart_assistant:flowise/client.py`)

Body: `chatflowId, question, overrideConfig, chatId, history` (`[]` when empty), `uploads: []`, `streaming`, `trustedState` when set (:133-143, :155-164, :181-191, :211-221). Streamed calls check `chatflows-streaming` first (:96-107) and parse every `data:` line (:174-231). Abort: `PUT /api/v1/chatmessage/abort/{flowId}/{chatId}` (:233-248). No caller sends `humanInput`, `action`, `form`, `enableTrustedState` or `agentMessages`.

### 2.9 VoIP consumer (`smart_assistant:voip/ai_processors/flowise_text_consumer.py`, abbreviated ftc)

- **Request** (`ProcessPrediction.get_prediction_data`, ftc:200-228): `overrideConfig = {memoryType: 'BufferMemory', sessionId: <per call>, llmEnableMemory: false, startEphemeralMemory: true}`, plus `stateMemory` and `startState` from the client's flow state (always present: `past_pii_labels`, `question_pii_labels`), `vars` (`phone_number`, `can_transfer`, `can_transfer_alt_offices`, `lang`, `mode: 'VOICE'`). **`overrideConfig.llmMessages`** = the whole conversation as user/assistant messages whenever there is any (ftc:214-216). **`history`** = the same conversation as `{message:'', type:'', role, content}` when `legacy_history` is on (ftc:218; `FlowiseProcessor.__init__` default `legacy_history=True`, ftc:517; both sample configs set `false`, `projectDocs/voip-bot-configs/ilirika_demo.json:27`, `mimovrste_demo.json:25`). `trustedState` when held. `question` = the redacted speech since the last answered bot message.
- **Conversation built** from the call transcript (ftc:608-663): the welcome message first as `apiMessage` if it was played, uninterrupted messages, consecutive user fragments merged, PII-redacted unless `dont_redact_for_llm`, a filler bot message last; `keep_original_history` sends the client's own Q/A list instead.
- **Events** (ftc:231-292): `token`, `trustedStateData` (stored), `agentFlowExecutedData` (**only `data[-1].data.state`**, replaces the client flow state), `nextAgentFlow` (logged), `error`, `end`, `metadata`/`usageMetadata` (logged); `action` is unhandled. Flow-state keys used afterwards: `share_extra_info`, `share_extra_details`, `transfer_to_human`, `override_transfer_number`, `end_call`, `transfer_to_human_copy`, `intent`, `requestInteraction*` (ftc:386-445, :546-577, :679).
- **Token**: in memory per call, sent whenever set; a turn works on a state copy committed when the first reply audio is ready, so a failed/cancelled turn and its retry resend the last committed token; a turn started before the previous stream finished sends the older token.
- **Approvals**: none (interaction polling through flow-state keys instead).
- **Observer** (`voip/ai_processors/usecases/flowise/flowise_observer.py:17-60`): posts `question: ''` to other flows at call start/end using the processor's **live** state, so its token, state and Q/A overwrite the main flow's. Not configured in the sample configs.
- **Flows** (`VoipBotConfig.text_processor.kwargs.chatflow_id` in Mongo): `3f34cf73-33b5-41a3-94c7-21fb85717e0b` (ilirika demo), `bd3d4171-49e3-4d5b-b051-b1ecd5cdc194` (mimovrste demo), OTP Oneshot `8828f3e2-fb37-4398-8b51-6a205e9c2e0e`, OTP RAG `c21437aa-7ae1-4029-b717-08d6f7628c79` (untracked `voip/barefake/RESULTS.md:9,118`); all on `bots.intheloop.io`.
- **Changing**: the working tree briefly forced `legacy_history=True` and stopped sending `llmMessages` while this inventory was written; the committed code above sends both. Re-check before deploy.

### 2.10 Celery Flowise bots (`smart_assistant:ai/bots/flowise/flowise_tasks.py`)

- Same `ProcessPrediction` with `legacy_history=False` (:129-135): **`history: []`, conversation in `overrideConfig.llmMessages`** (stored Q/A pairs, no greeting), `llmEnableMemory: false`, `startEphemeralMemory: true`, `vars` (`{mode: 'EMAIL'}` for email).
- Token, flow state and session id persisted per thread in Mongo (`helpers/bots/smart_thread.py:47-50,97-120,160-164,288-292`); sent every later turn; not saved after an exception, empty reply or failed chat post, so the previous token is resent. One-shot email always starts fresh.
- Reads `agentFlowExecutedData[-1].data.state` (platform tag/team/force-post keys, `flowise_tasks.py:296-305,321-369`).
- Flows: `BotTypeFlowiseConfig.{base_url, api_key, chatflow_id}` per community and bot (`ai/bots/models.py:346-373`), Mongo only. Meri also prefixes the previous Q/A to `question` (`Meri/answer.py:404-412`).

### 2.11 PlatformBot test mode (`smart_assistant:PlatformBot/agent_test_flowise.py`)

Two predictions per question (test store and prod, `processor.py:210-211`), streaming with JSON fallback (:442-497); no token, no history; `chatId` = `sessionId` = conversation or agent id (`processor.py:165`). Reads `token`, `sourceDocuments`, and from `agentFlowExecutedData[]` **`nodeId`, `nodeLabel`, `data.output`** (list, or keys `sourceDocuments|documents|docs|content|result`, nested `pageContent`/`metadata`) to recover retriever citations that Agentflow V2 does not emit as a `sourceDocuments` event (:140-252, :452-510).

### 2.12 Scripts

`scripts/one_time_scripts/flowise_stress_test.py` (raises on any unlisted non-list event, `trustedStateData` included, :101-127), `inspect_agent_test_flowise.py` (`nodeId`, `nodeLabel`, `data.output`), `clustering/sparkasse/get_answers_for_questions.py` (JSON `text`): not production.

---

## 3. `history` (TS13, TS13a, TS22)

| Flows | Client | `history` field | History in overrides | Memory-off first node | Needed at deploy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| VoIP flows (`VoipBotConfig` rows; ids in 2.9) | VoIP consumer | when `legacy_history` is on (code default on, sample configs off); starts with the welcome message | `llmMessages` with the same conversation, every turn | yes: the client sends `llmEnableMemory: false` and `startEphemeralMemory: true`, so where those overrides are enabled the LLM nodes see history only through the prepend or `llmMessages` | TS13a on for every VoIP flow whose config keeps `legacy_history`; memory on for the nodes that must see it (TS22) **and** the client must stop forcing `llmEnableMemory: false` / `startEphemeralMemory: true` (TS17 hides all history; open question 1) |
| Celery bot flows (`BotTypeFlowiseConfig`) | Celery bots | no | `llmMessages` every turn | `llmEnableMemory: false`, ephemeral | none for TS13a/TS22 (overrides keep working); the S10a t4 behaviour (memory-off LLM drops the current question when `llmMessages` holds user messages, README §7 obs. 2) applies to them today |
| Ema, Flowise UI, share page, embeds, tools, evaluation | — | no | no | — | none |

No client sends `agentMessages`. Only the VoIP consumer sends `history` to Flowise.

## 4. Executed data and `action` against TS18 / TS20

| Client | Reads beyond the TS18 external set (`nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, error, slim action) | Effect of pruning |
| :--- | :--- | :--- |
| PlatformBot test mode | `data.output.*` (retriever documents) | Agentflow V2 citations lost; needs another source (e.g. a `sourceDocuments` event) — Task 09. |
| EvaluationRunner (server, `/prediction`) | `data.output.usageMetadata`, `data.input.{llm,agent}ModelConfig.{model}` | Evaluation token/model metrics lost — Task 09 (internal endpoint or explicit fields). |
| Share page / embeds tree view, LoopChatEmbed tree view | `data.parentNodeId`, `data.iterationIndex`, `data.iterationContext`, whole `data` in the node panel | Iteration nesting and node details lost (share page has the view on for AGENTFLOW). |
| Internal chat | full (internal) | none |
| VoIP, Celery bots, proxy, Execute Flow | `[last].data.state` | none |

`action`: every client reads only `elements[].{type,label}`, `data.nodeId` and `data.input.humanInputEnableFeedback` (LoopChatEmbed also holds `data` whole). Nobody reads `id`, `mapping`, `data.nodeLabel` or `extra`. V2 answers never echo the action. TS20 holds for all.

## 5. Token round-trip and answers

- Round-trip every turn: internal chat, LoopChatEmbed, loop-apps, VoIP, Celery bots. Never: share page, embed snippets, execution viewer, tools, evaluation, PlatformBot.
- Approval answers carry the token: internal chat, LoopChatEmbed, loop-apps. The execution viewer's do not (2.2).
- Answers send `question = feedback || 'Proceed'|'Reject'` together with `humanInput`, and `feedback` is the button label when no feedback dialog is used (internal chat, LoopChatEmbed, loop-apps). Relevant to TS15 (the server cannot tell typed feedback from a label).
- No client reads a token from the JSON response (F14); the internal chat and LoopChatEmbed have JSON paths that would need it.
- Stale or competing tokens: LoopChatEmbed sends card/canvas requests alongside chat turns, and whichever token arrives last wins; VoIP and Celery resend the last committed token after a failed turn; the VoIP observer overwrites the main flow's token with another flow's (2.9).

## 6. Open questions

1. **VoIP and TS13/TS17/TS22** (needs a user decision before Task 06): the VoIP client sends its own conversation (`history` and/or `llmMessages`) together with `startEphemeralMemory: true` and `llmEnableMemory: false`. Under TS17 ephemeral nodes see no past history, and under TS22 memory-off nodes see no `history`. Should the VoIP client stop sending those two overrides (and the flows turn memory on), or should client `history` reach nodes even with ephemeral memory?
2. Which overrides each production flow enables (`llmMessages`, `llmEnableMemory`, `startEphemeralMemory`, `startState`, `stateMemory`, `vars`) and whether `legacy_history` is on in the production `VoipBotConfig` rows: Flowise DB and Mongo, not in any repo.
3. Is `bots.intheloop.io` Flowise or the proxy? The proxy's history item type rejects `type: ''`, which the VoIP consumer sends.
4. Which proxy deployments use `FLOWISE_CLIENT` (Flowise) rather than `LOOP_FLOW_CLIENT`; is `embtest.intheloop.io` Flowise directly?
5. TS18 consumers outside the pruned set (§4): PlatformBot, EvaluationRunner, share-page tree view — keep, replace or accept the loss (Task 09)?
6. Share page and embed snippets never send the token: should Task 09 give the fork widget token support, or document that these pages have no conversation memory under TS9?
7. Execution viewer Proceed/Reject cannot work token-only: remove, or resume through the internal chat (Task 09)?
8. Does the proxy's end-of-stream fallback really fire after `trustedStateData` in production (2.7)? Not a Flowise change, but it affects every proxied Flowise turn.
9. Concurrent requests with the same token and older tokens resent after failures (§5): accept last-writer-wins, or detect it (Task 04)?
10. Any API-key client using `/internal-prediction` (2.1) would keep full executed data.
