# Flow Redirect: a stable flow id that runs another local flow directly

## 1. Context

Clients need a stable flow id that can be repointed to a new flow version. Until now this was done with a mapping agentflow, `Start → Execute Flow(target)`. Execute Flow runs the target as a nested, blocking HTTP call to `/api/v1/prediction/{id}`, sending the `flowise-tool` header and the parent's `chatId`. That costs:

- two executions, two sets of persisted messages, and an HTTP hop;
- no live streaming: the target's whole reply is emitted as one token at the end.

**Why Execute Flow can't simply stream.** The SSE clients in `SSEStreamer.clients` are keyed by `chatId`, and so are the Redis channels in queue mode.
- A child prediction requested with `streaming: true` and the parent's `chatId` calls `addExternalClient(chatId, res)`, which replaces the parent's client.
- The child's `finally { removeClient(chatId) }` then deletes it, so the parent response is never ended.
- Streaming would therefore need a different child `chatId`. Clients rely on supplying their own `chatId`, so that is not acceptable.

**Goal: a pure switch.** A request to the mapping flow behaves exactly as if the client had called the selected flow directly:
- same `chatId`, uploads, human input and override config;
- every SSE event passed through as-is;
- one execution, with only the cost of one extra flow lookup.

There is no extra client call and no credential on the node. The prediction response carries no flow id. The only change clients see is that progress events and `agentFlowExecutedData` show the target flow's node names.

## 2. Decisions

| ID | Decision |
| :--- | :--- |
| R1 | A new separate node, **Redirect to Flow** (`redirectFlowAgentflow`), with a single flow picker (`redirectFlowSelectedFlow`). Execute Flow and Start are unchanged. |
| R2 | The redirect is resolved on the server, before execution, at the entry points. It is not a nested run. |
| R3 | The **target flow's identity** is used: messages, executions, memory (`pastChatHistory` by `(chatflowid, sessionId)`), human-input resume and abort keys all belong to the target. When the mapping is repointed, ongoing conversations start with empty memory, as with Execute Flow's child today. Trusted client state is unaffected. |
| R4 | Everything passes through. The node has no other options. |
| R5 | The mapping is a separate node rather than an option on Start. Start is shared by every agentflow: a version bump would flag all of them as outdated, and Start is a frequent upstream merge-conflict point. |

## 3. Design

**Mapping flow.** An `AGENTFLOW` containing a `redirectFlowAgentflow` node, valid only as `Start → Redirect to Flow` (sticky notes allowed). The Start node's own settings are ignored.

**Resolution rules** (`resolveFlowRedirect` in `packages/server/src/utils/flowRedirect.ts`):
- If the flow is not an `AGENTFLOW`, or has no Redirect node, it is returned unchanged with no DB call.
- Any node other than Start, a single Redirect node and sticky notes gives HTTP 400.
- No target selected gives HTTP 400.
- A missing target gives HTTP 404.
- A target in a different `workspaceId`, equal to the mapping itself, or itself a mapping (no chains) gives HTTP 400.

**What stays with the mapping flow.** The access checks done before resolution: API key (`validateFlowAPIKey`), allowed origins (`isDomainAllowed`) and the rate limit keyed by route id. They apply only if configured. The target's own access settings are not checked.

**What comes from the target.** Everything else: flow type, graph, chatbotConfig (post-processing, follow-ups, TTS), apiConfig, and the abort key `${targetId}_${chatId}`.

**Hook points**

| Entry point | Effect |
| :--- | :--- |
| `utilBuildChatflow` (`packages/server/src/utils/buildChatflow.ts`) | Resolves right after the API-key check. This covers external and internal (canvas test chat) prediction, streaming and JSON, and queue mode, since the job carries the resolved `chatflow`. |
| `checkIfChatflowIsValidForStreaming` (`packages/server/src/services/chatflows/index.ts`) | The target's type and post-processing decide streaming, both for the prediction controller and for `GET /chatflows-streaming/:id`. |
| `abortChatMessage` (`packages/server/src/services/chat-messages/index.ts`) | A stop sent to the mapping id aborts `${targetId}_${chatId}`. |

**Known gaps** (left as is). These endpoints still answer for the mapping flow's own config:
- `/public-chatbotConfig/:id` (starter prompts and theme in the embed);
- `/chatflows-uploads/:id` (whether the embed offers file and image upload);
- `/attachments/:chatflowId/:chatId` (storage path for files uploaded ahead of time);
- feedback, leads, TTS, and chat-history GET.

The prediction itself is unaffected.

## 4. Tasks

Task 1 and Task 2 are independent. Task 3 needs Task 2. Task 4 needs Tasks 1 and 3.

| # | Task | Files | Tests |
| :--- | :--- | :--- | :--- |
| 0 | Branch `feat/flow-redirect-node` from `master` and add this doc (later applied on top of the concurrent-execution commits on `master`) | `plans/flow-redirect/*` | n/a |
| 1 | The node, a shared `listFlows`, and the UI icon | `packages/components/nodes/agentflow/RedirectFlow/RedirectFlow.ts`, `packages/components/nodes/agentflow/utils.ts`, `ExecuteFlow.ts` (delegates `listFlows`), `packages/ui/src/store/constant.js` | `RedirectFlow.test.ts`: definition, `run()` throws, `listFlows` scoping/labels/sort/no data source, ExecuteFlow parity |
| 2 | The resolver | `packages/server/src/utils/flowRedirect.ts` | `packages/server/test/utils/flowRedirect.test.ts`: detection, valid mapping, every error rule |
| 3 | Hook the resolver in | `buildChatflow.ts`, `services/chatflows/index.ts`, `services/chat-messages/index.ts` | `packages/server/test/services/flowRedirect.test.ts`: streaming check, abort (in-process and queue mode). `utilBuildChatflow` is covered end to end, because `executeFlow` lives in the same module and can't be stubbed. |
| 4 | End-to-end verification | `plans/flow-redirect/verify-redirect.mjs`, `plans/flow-redirect/fixtures/*` | See section 5 |

## 5. Verification

**Unit and service tests**
- `pnpm --filter flowise-components test -- agentflow/RedirectFlow`
- `pnpm --filter flowise test -- test/utils/flowRedirect test/services/flowRedirect`

**Builds**
- `pnpm --filter flowise-components build`
- `pnpm --filter flowise build`
- `pnpm --filter flowise-ui build`

**End to end:** `node plans/flow-redirect/verify-redirect.mjs` against a running server built from this branch, using an isolated SQLite database and no API keys. The fixtures are zero-API-key agentflows (Start, CustomFunction, Condition, DirectReply, HumanInput and Loop nodes only), copied from the concurrent-execution baseline suite.

| Check | Expectation |
| :--- | :--- |
| SSE parity | Mapping → fixture 04 vs direct 04, both with a fixed `chatId`: the same event-type sequence and the same concatenated token text |
| JSON parity | Mapping → fixture 01 returns the same `text` as direct 01 |
| Persistence | The mapping run's messages are stored under the target's id with the client's `chatId` |
| Human input | Mapping → fixture 05: turn 1 returns an `action`, and turn 2 (proceed) through the mapping returns `Approved!` |
| Abort | Mapping → fixture 06: `PUT /api/v1/chatmessage/abort/<mappingId>/<chatId>` mid-run ends the run well before its normal duration |
| Repoint | After updating the mapping to fixture 01, the next call returns 01's output |
| Misuse | A mapping with an extra node, or with no target, returns the clear error |

Queue mode (`MODE=queue`) is not exercised. It uses the same `executeData.chatflow` path.

## 6. Results (2026-11-21, on `master` including the concurrent-execution commits)

**Unit and service tests:** all pass.
- `RedirectFlow.test.ts`: 7 tests.
- `test/utils/flowRedirect.test.ts`: 15 tests.
- `test/services/flowRedirect.test.ts`: 7 tests.

**Builds:** `flowise-components`, `flowise` and `flowise-ui` build cleanly.

**Existing server suite:** `pnpm --filter flowise test` passes, 200 tests in 14 suites. One `integration.test.ts` analytics-span test failed once while three builds ran in parallel, and passed on both re-runs.

**End to end:** `node plans/flow-redirect/verify-redirect.mjs` against an isolated SQLite server on port 3011 passed 7 of 7.

| Check | Result |
| :--- | :--- |
| SSE parity, mapping → 04 | Same 21-event sequence and token text as direct. First token at 11 ms through the mapping vs 10 ms direct (warm). |
| Persistence | 2 messages stored under the target id with the client `chatId`; none under the mapping. |
| Human input, mapping → 05 | Turn 1 STOPPED; turn 2 resumed through the mapping and returned `Approved!`. |
| Abort, mapping → 06 | Normal run about 490 ms. An abort sent to the mapping id ended it at about 325 ms with `Flow execution was cancelled`. |
| JSON parity and repoint, mapping → 01 | After updating the same mapping flow to point at 01, it returned 01's text with the client `chatId`. |
| Misuse | An extra node and a missing target both fail with the clear message (HTTP 500 wrapper). |

**Canvas (browser):**
- The Redirect to Flow node renders with its icon and no output handle.
- The flow picker lists the workspace's flows.
- The canvas test chat on the mapping runs the target and shows its output, including with the concurrent-execution test chat changes.
- As listed in the known gaps, the mapping's own chat-history and executions views stay empty, because runs are stored under the target.
