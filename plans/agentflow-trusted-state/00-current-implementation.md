# Task 00: Current Trusted State Implementation (Reference)

- **Status**: Done (from code reading at `d183966b`; field-level accuracy is verified in Task 02)
- **Scope**: Agentflow V2 with Client State on (`chatbotConfig.clientState.enabled`), with Zero-Retention (`clientState.enabledFull`) on or off.

Line references are to `packages/server/src/utils/buildAgentflow.ts` unless another file is named.

---

## 1. Round Trip per Turn

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server (executeAgentFlow)
    C->>S: POST prediction {question, trustedState: T(n-1)}
    Note over S: decode T(n-1) (:1236)<br/>pastChatHistory → node memory, {{chat_history}} (:1563)<br/>previousExecution → lazyLoadExecution() (:1286)
    Note over S: run nodes → agentFlowExecutedData[]<br/>(starts empty, except on human-input resume :1464)
    Note over S: ensureTrustedData() (:1630): previousExecution = this turn<br/>pastChatHistory.push(user, bot) (:2237)
    S-->>C: SSE action (if stopped, :2060)
    S-->>C: SSE trustedStateData: T(n) (:2243; on fatal error :2005)
    S-->>C: SSE agentFlowExecutedData (end of stream, SSEStreamer.ts:28)
```

- **Encoding** (`trustedStateHelper.ts`): `base64( iv | authTag | AES-256-GCM( gzip( JSON.stringify(state) ) ) )`. The key comes from `CLIENT_STATE_SERVER_SECRET` or a generated file next to the module.
- **Streaming only**: the token reaches the client only as the `trustedStateData` SSE event. The non-streaming JSON response carries no token, so a non-streaming client cannot continue a client-state conversation.
- **Queue mode**: the incoming token travels inside the BullMQ job (`buildChatflow.ts:1078`). The outgoing one travels worker → Redis pub/sub → main (`RedisEventPublisher.ts:263`, `RedisEventSubscriber.ts:145`).
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
  previousExecution: IExecution       replaced every turn (getPreviousExecution :1617)
    { id, state, agentflowId, sessionId, workspaceId, createdDate, updatedDate,
      executionData: "<JSON string of this turn's node records>" }
}
```

### 2.1 Node record (`commitExecutedDataDelta`, `:1871`)

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
  } }
```

| Node | `input.messages` holds | Source |
| :--- | :--- | :--- |
| Agent | System prompt (unshifted to the front), incoming `history` (first node), past + runtime history when memory is on, user message, tool-call and tool-result messages from the tool loop | `Agent.ts:997–1066`, `:1726`, return `:1452` |
| LLM | Same pattern without tools | `LLM.ts:472`, return `:665` |
| Condition Agent | Its own classification prompt | `ConditionAgent.ts:442` |
| HumanInput | Full past + runtime history | `HumanInput.ts:211`, `:284` |

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
2. `data.output.humanInputAction.data.input`, the same object (`:1016` HumanInput node, `:1065` Agent tool approval).
3. `apiMessage.action`: the action serialized as a JSON string (`:2233`) and pushed into `pastChatHistory`, so it is escaped twice inside the token.

For an Agent tool approval that is the full prompt three times. For a HumanInput node it is the full history three times. The `action` is cleared from the history message once the approval is answered (`:2138–2156`).

On a resume, the previous turn's records are copied into the new turn (`:1464`), so `executionData` grows across a chain of stops and resumes.

---

## 4. Growth Model

With S = system prompt, H(n) = conversation after n turns, K = LLM/Agent nodes per turn with all-messages memory:

```
|T(n)| ≈ H(n)              pastChatHistory
       + K · (S + H(n))    input.messages in this turn's records
       + nodes · |state|   state clone on every record
       + outputs, other inputs
```

Window memory caps each per-node history copy at the last N×2 messages; the summary memory types store a summary instead.

Amplifiers:
- gzip back-references reach only 32 KiB, so repeated copies of a prompt or history larger than that are not deduplicated.
- `executionData` is JSON nested in JSON, so quotes and newlines are escaped again; `apiMessage.action` adds a third level.
- base64 adds 33%.
- The token crosses the wire twice per turn (four times with Redis in queue mode) and is decrypted, gunzipped and parsed on every request.

---

## 5. What the Next Turn Reads

| Next turn | Reads from the token | Where |
| :--- | :--- | :--- |
| Any | `pastChatHistory[].{role, content, fileUploads, artifacts, fileAnnotations, usedTools}` | `mapChatMessageToIMessage` `:86`, `:1563` |
| Persist State on | Latest record that has `data.state` | `:1314` |
| Form input start | Start record `data.output.form` | `:1360` |
| Human-input resume | `previousExecution.state`, `id`; all records: `nodeId`, `status`, `previousNodeIds`, `data.parentNodeId`, `data.output` (conditions, loop data, content for `{{nodeId}}` references and terminal output), `data.state`, `output.humanInputAction` | `:1383–1500`, `dependencyEngine.ts:397`, `faultCoordinator.ts:50`, `:184`, `:283`, `:773` |
| Agent tool-approval resume | `humanInputAction.data.input.messages`, the full earlier prompt, replayed | `Agent.ts:2329–2339` |
| Human-input resume, history | `pastChatHistory[].action` to find and clear the pending action | `:2138–2156` |
| Ephemeral memory (Start) | Empties `pastChatHistory` during the turn | `stateReconciler.ts` `reconcileRuntimeCommit` |

Nothing else is read from `executionData`. In particular `input.messages` and most of `output` are never read on a normal turn.

---

## 6. Client-Bound Payloads (unencrypted)

| Payload | Contains | Read by the Flowise UI |
| :--- | :--- | :--- |
| SSE `action` (`:2060`) and the saved bot message `action` | `id`, `mapping`, `elements`, `data.{nodeId, nodeLabel, input}`, where `input` is the stopped node's full input | `action.data.input.humanInputEnableFeedback`, and `action.data` is sent back on submit (`ChatMessage.jsx:845–849`) |
| SSE `agentFlowExecutedData` (end of stream, `SSEStreamer.ts:28`) and `result.agentFlowExecutedData` (non-streaming, `:2270`) | All node records of the turn, prompts included | Execution viewer (`ChatMessage.jsx:1110`, `:2495`) |

External clients (e.g. the VoIP consumer in smart_assistant) receive the same payloads; which fields they read is established in Task 02.

---

## 7. Modes

| Mode | Token used | Chat messages saved | Executions saved |
| :--- | :--- | :--- | :--- |
| Client State on, Zero-Retention on | Yes, only copy of history and previous execution | No | No |
| Client State on, Zero-Retention off | Yes, only source for the next turn | No | Yes, full records (kept as is, TS5) |
| Client State off | No (not part of this plan except for the client payloads) | Yes | Yes |

When the flow has no `clientState` config at all, a request can still turn the token on with `enableTrustedState: true` (`:1234`).
