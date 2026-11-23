# Agentflow V2 Trusted State: Rollout (Task 10)

Rollout notes for the token-only conversation state ([11-new-implementation.md](./11-new-implementation.md)). Evidence that the build behaves as described: [10-replay-compare-and-rollout.md](./10-replay-compare-and-rollout.md) §4.

---

## 1. Client Note

For every client of an Agentflow V2 flow (`/api/v1/prediction/<flowId>`, streaming or not).

**The token**
- The token (`trustedState`) is the whole conversation state: history, flow state, form values, child flow tokens and, while a turn waits for an answer, what the resume needs. The server keeps nothing else between turns and reads no chat messages or executions.
- Send the latest token with every request, approval answers (`humanInput`) included. It arrives in the `trustedStateData` SSE event, and in `trustedState` of the JSON response for non-streaming calls (new).
- Treat it as opaque: it is encrypted. In the test scenarios it is 268–1,136 base64 characters (S01 after five turns: 664), against 14.5–84 K before. It grows with each turn's messages; child flow tokens and a pending approval add a few hundred characters.
- A request without a token starts a new conversation. An unreadable token also starts one, with a warning in the server log.
- Tokens issued before the deploy keep working, paused conversations included. After a rollback, an older build cannot read tokens issued by this one.

**One conversation, one request at a time** (last writer wins, TS28)
- Send one request at a time per conversation and keep the token of the latest completed turn.
- To retry a failed turn, resend the previous token. A failed approval answer returns the token it was sent with, so answering again retries.
- Hide the approval buttons once an answer is sent: answering the same pause twice resumes it twice (an approved tool can run twice).
- Two requests sent with the same token produce two different tokens; whichever the client keeps continues, and the other turn is lost from history and state.

**Approval answers**
- Send `humanInput: { type: 'proceed' | 'reject', startNodeId: action.data.nodeId, feedback? }` with the token.
- The answer saved in the history is the feedback text, else `question`, else the clicked button's label.

**`history` field**
- `history` is used only when the flow has "Accept conversation history from the client" turned on (off by default); otherwise it is ignored with a server warning.
- When used, it must hold the whole conversation, and may start with a welcome message. It replaces the token's history for that turn, and the token keeps it.
- Resume turns ignore it.

**Message overrides** (`overrideConfig.llmMessages` / `agentMessages`)
- They are the node's message list, appended to the messages configured in the flow where the flow enables the override.
- A tail that repeats the conversation history is removed only when the node already gets that history: memory on, or an accepted `history`. A memory-off node keeps the override exactly as sent (VoIP's call transcript).
- The other overrides apply where the flow enables them, `llmEnableMemory` included. `startEphemeralMemory` does nothing any more.

**History and memory**
- Nodes see earlier turns only through their own memory settings.
- The first node no longer prepends the request `history` when its memory is off.

**Payloads**
- `agentFlowExecutedData` on `/prediction` holds per record only `nodeId`, `nodeLabel`, `status`, `previousNodeIds`, `data.name`, `data.state`, `data.error` (text) and, on stopped records, the slim action. `[last].data.state` is where it was.
- Only the Flowise internal chat receives full records.
- `action` holds `id`, `mapping`, `elements`, `data.nodeId`, `data.nodeLabel` and, for HumanInput, `data.input.humanInputEnableFeedback`.
- `enableTrustedState` is no longer needed; it only stands in for an unset "Disable recording chat messages".

---

## 2. Flow Migration

| Item | Who | What to do |
| :--- | :--- | :--- |
| "Accept conversation history from the client" (TS13a) | Flows whose clients send `history` and should keep using it | Turn it on. From [client-inventory.md](./client-inventory.md) §3, only the VoIP consumer sends `history` (when `legacy_history` is on), and VoIP flows keep it off (TS27): set `legacy_history` off in the VoIP configs instead (§3). No other client that matters sends `history`, so no flow needs the switch at deploy. |
| Memory for nodes that relied on the first-node prepend (TS22) | Flows whose first Agent/LLM has memory off and whose client sends `history` | Turn memory on (or accept the client history) where the node must see earlier turns. Only VoIP flows with `legacy_history` on can be affected; they get the call through `llmMessages` as well (§3). |
| Node versions (D14, D15) | Every Agentflow V2 flow | Sync saved nodes to Start 1.2, Agent 3.3, LLM 1.2, Execute Flow 1.3: open the flow, Sync Nodes (or each node's update badge), save. The server already ignores Persist State and Ephemeral Memory and treats "Return Response As: User Message" as Assistant Message whatever the saved version, so syncing changes no behaviour; it removes the dead options from the canvas. The canvas shows the Sync Nodes button only when the node definitions were loaded before the flow (06 §4.2). In Task 10's UI pass, a flow opened from the list right after a page load showed every badge but no button; per 06, opening a flow, going back to the list and opening it again in the same page session brings the button. |
| Client State dialog | Flows with Client State settings | The switches now read "Disable recording chat messages" and "Disable recording executions"; stored values keep their meaning for writes, so nothing to migrate. |

---

## 3. VoIP and Celery Flows (TS27, 04 §2.7, §3 Q2)

**Not checked: needs the production flows** (user, Task 10). No repository holds the production flows, the `VoipBotConfig` rows or the `BotTypeFlowiseConfig` rows. Every item below is still open and runs read-only against production.

**Flows to check**
- VoIP flows (`VoipBotConfig.text_processor.kwargs.chatflow_id`, all on `bots.intheloop.io`):
  - `3f34cf73-33b5-41a3-94c7-21fb85717e0b` (ilirika demo);
  - `bd3d4171-49e3-4d5b-b051-b1ecd5cdc194` (mimovrste demo);
  - OTP Oneshot `8828f3e2-fb37-4398-8b51-6a205e9c2e0e`;
  - OTP RAG `c21437aa-7ae1-4029-b717-08d6f7628c79`;
  - any other `VoipBotConfig` row.
- Celery bot flows: `BotTypeFlowiseConfig.{base_url, chatflow_id}` for every community and bot.

**Source**
- For each flow, `GET /api/v1/chatflows/<id>` returns `flowData` (nodes), `apiConfig` (which overrides are enabled) and `chatbotConfig` (Client State).

**Checks per flow**

1. **Nodes that start to see the token history (TS27, D13).** Today both clients send `startEphemeralMemory: true` and `llmEnableMemory: false`.
   - `startEphemeralMemory` does nothing after the deploy.
   - List every Agent and Condition Agent node with memory on, and every LLM node with memory on whose `llmEnableMemory` override is not enabled in `apiConfig`. Each of them sees the token history from now on: the server's question/reply pairs, with no welcome message and no fillers.
   - Decide per node: keep memory, or turn it off.
   - LLM nodes that stay memory-off through the enabled `llmEnableMemory` override keep VoIP's `llmMessages` exactly as sent (D16): no change.
2. **Memory-on nodes that also get `llmMessages` / `agentMessages`.** The tail of the override that repeats the token history is removed with a warning (D16).
   - VoIP's conversation starts with the welcome message and ends with a filler, so it rarely matches the token history exactly; both copies would then reach the model.
   - Decide per node: memory off, or no conversation in the override.
3. **State that now carries over (TS11).**
   - If the saved Start node had Persist State off, every state key now carries to the next turn.
   - List the keys the clients act on: VoIP `transfer_to_human`, `transfer_to_human_copy`, `override_transfer_number`, `end_call`, `share_extra_info`, `share_extra_details`, `intent`, `requestInteraction*`; Celery the platform tag, team and force-post keys.
   - Check that the flow resets each of them on every turn, or that the client sends them back in `startState`. VoIP sends its flow state as `startState` every turn, which applies only where the flow enables that override; Celery sends none.
4. **Ephemeral Memory saved on in the Start node.** Each turn logs a warning until the node is synced (§2); the behaviour has already changed (item 1).
5. **`legacy_history`.** Read it in every `VoipBotConfig` row (code default `true`, sample configs `false`) and set it to `false`: VoIP flows keep "Accept conversation history from the client" off, so `history` is ignored with a warning (TS27).
6. **"Return Response As".** Agent, LLM and Execute Flow nodes on the old default "User Message" now add an assistant message (TS25). List those followed in the same turn by a memory-on node; only there does model input change.
7. **Execute Flow nodes.** Each child now keeps its own conversation through the child token (TS16). A child that stops for human input is not resumed by the parent (08 §4.2).

---

## 4. Agents with Approval Tools that Use `{{question}}` (TS29)

**Not checked: needs the production flows** (user, Task 10).

**What to list**
- Every Agentflow V2 flow in production (`chat_flow` rows with `type = 'AGENTFLOW'`, or `GET /api/v1/chatflows?type=AGENTFLOW`).
- In each, every Agent node (`data.name = 'agentAgentflow'`) that has at least one tool with "Require Human Input" on (`inputs.agentTools[].requireHumanInput`).
- Of those, the ones whose Messages list (`inputs.agentMessages[].content`) contains `{{question}}`.

**What changes for them**
- On a resume the Agent re-resolves its Messages list, so `{{question}}` becomes the resume request's `question` (TS29):
  - empty from API clients that send none;
  - `feedback || 'Proceed' | 'Reject'` from the Flowise chat, LoopChatEmbed and loop-apps.
- Before, the stopped turn's question was replayed.

**What to decide**
- For each Agent on the list, decide whether the Messages list should read the user's request from the history (memory on) instead of `{{question}}`.
- The question the Agent adds after its Messages list is unaffected: it is stored with the checkpoint.

---

## 5. Deploy Note

- **One-way token upgrade** (TS1, TS2): the new build reads tokens from before the deploy, paused conversations included, and always writes the new format. Older builds cannot read new tokens, so a rollback means redeploying an older build and accepting that conversations started or continued on the new build restart.
- **Start node** (TS11, TS17): Persist State and Ephemeral Memory are gone. Flow state always carries over to the next turn. Nodes follow their own memory settings; a saved Ephemeral Memory option is ignored, with a warning per turn.
- **Client State switches only control what is recorded** (TS9, D12): conversations always continue from the token, whatever "Disable recording chat messages" and "Disable recording executions" (and the `DISABLE_*` env flags) say. "Accept conversation history from the client" is new (TS13a, off by default).
- **Return Response As** (TS25): Agent, LLM and Execute Flow nodes on the old default "User Message" now add an assistant message. This changes model input only where a memory-on node runs after them in the same turn.
- **Approvals** (TS15, TS26): answers are saved in the history. A resumed Agent rebuilds its prompt from the current flow, so `{{question}}` in its Messages list gets the answer request's question (TS29).
- **External executed data is pruned** (TS18): Flowise Evaluations lose Agentflow V2 token usage and model names. Execute Flow's fallback text for a blank child reply holds the pruned records.
- **Internal chat** (TS30): the Flowise chat keeps its token with its saved messages, so a page reload continues the conversation when chat messages are recorded.
- **Execute Flow children** keep their own conversation through child tokens in the parent token (TS16). A child paused for human input is not resumed by the parent.
- **Recorded executions and chat messages** are written as before and never read (TS5, TS21). A resume continues the paused run's row and clears the stop message's action.

---

## 6. What to Watch after Deploy

| Signal | Where | Expect | Act when |
| :--- | :--- | :--- | :--- |
| Token sizes | Debug line `[agentflow]: trustedState chatId=…: in v… … chars, history …, pending …; out … chars, …` (needs `LOG_LEVEL=debug`) | `out` a few hundred to a few thousand characters, growing by each turn's messages; `in v1` only on the first turn of conversations started before the deploy; `in v0` on first turns | `out` grows much faster than the messages, or `in v1` keeps appearing days after the deploy (a client replaying an old token) |
| Decode errors | Warnings from `trusted_state_from_string` (decrypt/gunzip/JSON errors) and `Ignoring a trustedState of unknown format` | none | any: the conversation restarted. Check `CLIENT_STATE_SERVER_SECRET` across instances, and clients that truncate or alter the token |
| Resume failures | Errors `No previous execution found for session …: the trustedState holds no stopped run to resume`, `Node … not found in previous execution`; `humanInput` requests ending in `ERROR` | rare | a client answers without the latest token or answers twice; a flow was edited while conversations were paused |
| History warnings | `Ignoring the request history …`, `The request history lacks the last message …`, `… removed the last <n> messages of its message list …` | VoIP with `legacy_history` on until its configs change | they persist after the client changes |
| Ephemeral Memory warning | `Ephemeral Memory is no longer supported …` | flows not yet synced | sync the Start node (§2) |
| Recorded rows | `Execution … not found; it is not updated` | only for conversations paused before the deploy, or after executions were deleted | otherwise |
| Payload consumers | Clients reading more than `[last].data.state` from external executed data | none known (client inventory §4) | a client breaks on a missing field |
