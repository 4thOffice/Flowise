# Task 00: Current Trusted State Implementation (Reference)

- **Status**: Done (code reading at `d183966b`; verified field by field and line references moved to `6b10339e` by Task 02: [field-inventory.md](./field-inventory.md), [client-inventory.md](./client-inventory.md), [size-anatomy-before.md](./baselines/reports/size-anatomy-before.md))
- **Scope**: Agentflow V2 with Client State on (`chatbotConfig.clientState.enabled`), with Zero-Retention (`clientState.enabledFull`) on or off.

Line references are to `packages/server/src/utils/buildAgentflow.ts` at `6b10339e` unless another file is named.

---

## 1. Round Trip per Turn

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server (executeAgentFlow)
    C->>S: POST prediction {question, trustedState: T(n-1)}
    Note over S: decode T(n-1) (:1237)<br/>pastChatHistory → node memory, {{chat_history}} (:1567)<br/>previousExecution → lazyLoadExecution() (:1287)
    Note over S: run nodes → agentFlowExecutedData[]<br/>(starts empty, except on human-input resume :1468)
    Note over S: ensureTrustedData() (:1634): previousExecution = this turn<br/>pastChatHistory.push(user, bot) (:2242)
    S-->>C: SSE action (if stopped, :2065)
    S-->>C: SSE trustedStateData: T(n) (:2248; on fatal error :2010)
    S-->>C: SSE agentFlowExecutedData (end of stream, SSEStreamer.ts:28)
```

- **Encoding** (`trustedStateHelper.ts`): `base64( iv | authTag | AES-256-GCM( gzip( JSON.stringify(state) ) ) )`. The key comes from `CLIENT_STATE_SERVER_SECRET` or a generated file next to the module.
- **Streaming only**: the token reaches the client only as the `trustedStateData` SSE event. The non-streaming JSON response carries no token, so a non-streaming client cannot continue a client-state conversation.
- **Every mode**: the token is decoded whenever a request carries one (`:1237`) and written at the end of every turn (`:2241`), Client State off included; it is only *read* in the modes of §7.
- **Queue mode**: the incoming token travels inside the BullMQ job (`buildChatflow.ts:1082`). The outgoing one travels worker → Redis pub/sub → main (`RedisEventPublisher.ts:265-274`, `RedisEventSubscriber.ts:145`).
- **Flowise UI**: `ChatMessage.jsx` keeps the last token in `trustedStateRef` (`:1114`), sends it with the next message (`:1015`) and clears it with the chat (`:1515`).

---

## 2. Token Contents

```
TrustedState {
  pastChatHistory: IChatMessage[]     appended +2 per turn since the session started
    { id, role: 'userMessage', content: question, chatflowid, chatId, sessionId, chatType,
      createdDate, executionId, fileUploads?, leadEmail? }
    { id, role: 'apiMessage', content: final answer, chatflowid, chatId, sessionId, chatType,
      createdDate, executionId, usedTools?, sourceDocuments?, artifacts?, fileAnnotations?,
      followUpPrompts?, action? }
    (Client State off: the saved ChatMessage rows, every column incl. null agentReasoning, memoryType)
  previousExecution: IExecution       replaced every turn (getPreviousExecution :1621)
    { id, state, agentflowId, sessionId, workspaceId, createdDate, updatedDate,
      executionData: "<JSON string of this turn's node records>" }
}
```

### 2.1 Node record (`buildAgentflow.ts:1876–1891`, appended by `commitExecutedDataDelta`, `stateReconciler.ts:131`)

```
{ nodeId, nodeLabel, status, previousNodeIds,
  data: {
    id, name,
    input: {
      messages: [ ... ]        exact prompt sent to the model (LLM, Agent, Condition Agent, HumanInput)
      ...nodeData.inputs       every other resolved input
    },
    output: { content, usageMetadata, responseMetadata, calledTools, usedTools, sourceDocuments,
              artifacts, timeMetadata, humanInputAction? (stopped records), ... },
    state: clone of the full runtime state      on every record
    chatHistory: [ user input (first node only), node reply ]
    iterationIndex, iterationContext, parentNodeId     iteration children only (:933–944)
  } }
Error records: { nodeId, nodeLabel, previousNodeIds, status: 'ERROR' | 'TERMINATED', data: { id, name, error } } (:1922–1958)
```

| Node | `input.messages` holds | Source |
| :--- | :--- | :--- |
| Agent | System prompt (unshifted to the front), incoming `history` (first node), past + runtime history when memory is on, user message, tool-call and tool-result messages from the tool loop | `Agent.ts:997–1066`, `:1676–1725`, return `:1447–1470` |
| LLM | Same pattern without tools | `LLM.ts:398–472`, return `:663–680` |
| Condition Agent | Its own classification prompt | `ConditionAgent.ts:442` |
| HumanInput | Full past + runtime history | `HumanInput.ts:210`, `:284` |

`agentMessages` / `llmMessages` are deleted from `nodeData.inputs` before the return (`Agent.ts:1066`, `LLM.ts:472`), so the raw prompt is not stored a second time in the spread inputs.

---

## 3. Where a System Prompt Ends Up

| Place | Copies in T(n) | Grows with turns |
| :--- | :--- | :--- |
| `input.messages[0]` of each LLM/Agent record using it | One per such node run this turn (more with loops/iteration) | No, rebuilt each turn |
| System prompt containing `{{chat_history}}` (resolved at `:318`) | Prompt plus the full history text, per node | Yes |
| Flow state holding the prompt (start-state override or Update State) | One per node record, persisted to the next turn | Carried, not multiplied |
| `pastChatHistory` | Only if the client sends it inside `question` | Yes |

### 3.1 Stopped turns (human input)

When a turn stops, the stopped record's input is stored again:
1. The stopped record's `data.input`.
2. `data.output.humanInputAction.data.input`, the same object (`:1030` HumanInput node, `:1079` Agent tool approval).
3. `apiMessage.action`: the action serialized as a JSON string (`:2238`) and pushed into `pastChatHistory`, so it is escaped twice inside the token.

For an Agent tool approval that is the full prompt three times (S07 t2: 3 × ~41 KB, each costing ~8.5 KB gzip). For a HumanInput node it is the full history three times. In trusted mode the `action` is set to `null` in the history once the approval is answered (`:2141–2161`); DB mode clears the saved row but not the token's copy.

On a resume, the previous turn's records are copied into the new turn (`:1468`), so `executionData` grows across a chain of stops and resumes.

---

## 4. Growth Model

With S = system prompt, H(n) = conversation after n turns, K = LLM/Agent nodes per turn with all-messages memory:

```
|T(n)| ≈ H(n)              pastChatHistory
       + K · (S + H(n))    input.messages in this turn's records
       + nodes · |state|   state clone on every record
       + outputs, other inputs
```

Window memory caps each per-node history copy at the last N×2 messages; the summary memory types store a summary instead. Measured in [size-anatomy-before.md](./baselines/reports/size-anatomy-before.md): records are 91–99% of every token; each history message carries ~280 B of metadata (ids, dates, chat type) besides its content.

Amplifiers:
- gzip back-references reach only 32 KiB, so repeated copies of a prompt or history larger than that are not deduplicated.
- `executionData` is JSON nested in JSON, so quotes and newlines are escaped again; `apiMessage.action` adds a third level.
- base64 adds 33%.
- The token crosses the wire twice per turn (four times with Redis in queue mode) and is decrypted, gunzipped and parsed on every request.

---

## 5. What the Next Turn Reads

| Next turn | Reads from the token | Where |
| :--- | :--- | :--- |
| Any | `pastChatHistory[].{role, content, fileUploads, artifacts, fileAnnotations, usedTools}` (`usedTools` and `fileAnnotations` never reach a model) | `mapChatMessageToIMessage` `:86`, `:1567` |
| Persist State on | Latest record that has `data.state`, i.e. the last record | `:1318–1335` |
| Form input start | Start record `data.output.form` (a `key: value` string after the first form turn, an object afterwards) | `:1364–1385` |
| Human-input resume | `previousExecution.state`, `id`; all records: `nodeId`, `status`, `data.parentNodeId`, `data.name` (loop counts), `data.output` (decision `conditions[].isFulfilled`, loop `nodeID`/`maxLoopCount`, any output a `{{nodeId}}` reference names), `data.state` (last), `output.humanInputAction` (also re-emitted when another branch is still stopped). Not `previousNodeIds`; terminal output uses only this turn's records (`terminalCoordinator.ts:433`) | `:1387–1499`, `dependencyEngine.ts:366–469`, `faultCoordinator.ts:50`, `:184`, `:223`, `:283`, `:773`, `:2035–2058` |
| Agent tool-approval resume | `humanInputAction.data.input.messages`, the full earlier prompt, replayed | `Agent.ts:2329–2339` |
| Human-input resume, history | `pastChatHistory[].action` to find and clear the pending action (trusted mode reads only its presence) | `:2141–2176` |
| Ephemeral memory (Start) | Empties `pastChatHistory` during the turn | `stateReconciler.ts:182–187` |
| Iteration children | Decode the token again and read `pastChatHistory` | `:896–924` → `:1237` |

Nothing else is read from `executionData`. In particular `input.messages` and most of `output` are never read on a normal turn. Field by field: [field-inventory.md](./field-inventory.md).

---

## 6. Client-Bound Payloads (unencrypted)

| Payload | Contains | Read by the Flowise UI |
| :--- | :--- | :--- |
| SSE `action` (`:2065`) and the saved bot message `action` | `id`, `mapping`, `elements`, `data.{nodeId, nodeLabel, input}`, where `input` is the stopped node's full input (`FLOWISE_CREDENTIAL_ID` included: the action is taken before `_removeCredentialId`, `:2124`) | `elements[].{type, label}`, `action.data.nodeId`, `action.data.input.humanInputEnableFeedback`; the answer is `humanInput {type, startNodeId: action.data.nodeId, feedback}` plus `question`, and V2 never sends the action back (`ChatMessage.jsx:810–854`) |
| SSE `agentFlowExecutedData` (end of stream, `SSEStreamer.ts:28`) and `result.agentFlowExecutedData` (non-streaming, `:2275`) | All node records of the turn, prompts included; the SSE copy is the array buffered at the last node commit, so it still holds `FLOWISE_CREDENTIAL_ID` (the JSON response is stripped) | Internal chat: `AgentExecutedDataCard` tree and node details (`ChatMessage.jsx:2495–2503`). The execution viewer (`views/agentexecutions/`) reads saved Execution rows instead |

External clients read far less: every known external client reads only `[last].data.state` of the executed data, or nothing, and only `elements`, `data.nodeId` and the feedback flag of `action`. The exceptions (PlatformBot test mode, the EvaluationRunner, the share-page tree view) are in [client-inventory.md](./client-inventory.md) §4.

---

## 7. Modes

| Mode | Token used | Chat messages saved | Executions saved |
| :--- | :--- | :--- | :--- |
| Client State on, Zero-Retention on | Yes, only copy of history and previous execution | No | No |
| Client State on, Zero-Retention off | Yes, only source for the next turn | No | Yes, full records (kept as is, TS5) |
| Client State off | Written and returned, built on the client's incoming token; not read (except with the `DISABLE_*` env flags, F16) | Yes | Yes |

When the flow has no `clientState.enabled` value at all, a request can still turn the token on with `enableTrustedState: true` (`:1235`); an explicit `false` wins over the request flag.
