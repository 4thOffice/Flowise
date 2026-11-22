# Token Field Inventory (Task 02)

- **Code**: `master` at `6b10339e` (server, components and UI sources unchanged since `7ef76982`). File names below are short for `packages/server/src/utils/buildAgentflow.ts`, `packages/server/src/utils/agentflow/*.ts`, `packages/components/nodes/agentflow/*/*.ts`, `packages/components/nodes/agentflow/utils.ts` (`nodes/utils.ts`) and `packages/server/src/utils/addChatMesage.ts`.
- **Token paths**: every path in the decoded `before/` tokens (131 tokens, all modes; 487 distinct normalized paths; nested JSON strings are parsed only when they re-serialize exactly, as in `lib/trace-store.mjs`). `[]` is any array element, `<json>` a JSON string parsed in place, `*` one key, `{a,b}` alternatives, `.**` the path and everything below it.
- **Coverage check**: `node plans/agentflow-trusted-state/baselines/analyze-token.mjs --check-inventory` walks the decoded tokens and fails if a path matches no row here (`--verbose` prints path → row). Rows marked *not in before/* exist in code only.
- **Sizes**: [baselines/reports/size-anatomy-before.md](./baselines/reports/size-anatomy-before.md).

Scenario words: **normal** (every turn), **persist** (Start Persist State on: S04a, S10b, S11), **form** (S05), **HI resume** (HumanInput resume: S06, S06b, S08), **TA resume** (Agent tool-approval resume: S07, S08), **ephemeral** (S10b), **error** (S11 t2), **iteration** (S09), **resume** (both kinds).

Target follows TS10/TS12/TS16/TS19: **history**, **flow state**, **form**, **child tokens**, **pending** (pending resume data, only while stopped; contents settled by Task 03/TS-O1), **drop** (not carried).

---

## 1. Where the token is read

| Step | Code | Condition | What it takes |
| :--- | :--- | :--- | :--- |
| Decode | `buildAgentflow.ts:1237–1239` | any request with `trustedState`, any mode (also DB mode, where it is decoded and then extended but not read) | whole token; `undefined` if decryption fails (`trustedStateHelper.ts:62–68`, logged as a warning) |
| History | `buildAgentflow.ts:1566–1581` → `mapChatMessageToIMessage` `:86–127` | `DISABLE_CHAT_MESSAGE_RECORDING`, `useTrustedState` or `zeroRetention` | `pastChatHistory[].{role, content, fileUploads, artifacts, fileAnnotations, usedTools}` |
| Previous execution | `lazyLoadExecution` `buildAgentflow.ts:1287–1314` (token branch `:1290–1296`) | `DISABLE_EXECUTION_RECORDING` or `useTrustedState`; used by the three steps below | `previousExecution` |
| Persist State | `buildAgentflow.ts:1316–1361` | Start `startPersistState === true` | last record's `data.state` |
| Form | `buildAgentflow.ts:1363–1385` | `startInputType === 'formInput'` | Start record's `data.output.form` |
| Resume | `buildAgentflow.ts:1387–1499`, dependency engine `:1547–1560`, `executeNode` `:772–784` | request has `humanInput` (not inside an iteration) | `previousExecution.{id, state}`, all records (bulk copy `:1468`) |
| Pending action cleanup | `buildAgentflow.ts:2139–2177` | request has `humanInput` and `useTrustedState` | `pastChatHistory[].action` (presence) |
| Iteration children | `executeNode` passes `incomingInput` (raw token) to `executeAgentFlow` `:896–924`; child decodes again `:1237` | Iteration node | child reads only `pastChatHistory` (F12) |

The token is written in `ensureTrustedData` (`:1634–1641`: `previousExecution` replaced by `getPreviousExecution()` `:1621–1633`) and `pastChatHistory.push` (`:2242–2245`), and streamed at `:2248` (end of turn) and `:2010` (fatal error, before `_removeCredentialId` at `:2124`). Both happen in every mode, so DB-mode turns also return a token (M3 rows in the size report).

On a normal turn the records of the previous turn are **never read** except `data.state` (Persist State) and the Start record's `output.form` (form flows). Everything else in `previousExecution.executionData` matters only to a resume.

---

## 2. Field table

### 2.1 History messages

| Field path | Written by | Read by (file:line) | Scenario | Target | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `pastChatHistory` | `ensureTrustedData` `buildAgentflow.ts:1636` (new `[]`), `.push` `:2242–2245`; truncated in place `stateReconciler.ts:184–186` (ephemeral), `:193–195` (feedback toggle) | `buildAgentflow.ts:1569` (map), `:2144` (action scan) | normal | history | Grows +2 per turn (+1 when the toggle cuts one, S06b). |
| `pastChatHistory[]` | user message stub `buildAgentflow.ts:2194–2206`, bot message `:2209–2240`, both through `utilAddChatMessage` (`addChatMesage.ts:16–20` returns the stub when not recording; DB mode returns the saved entity, so M3 messages carry every column, `null` included) | — (fields below) | normal | history | No user message when `doNotIncludeFeedbackHistory` (`:2179`), which trusted mode forces on every resume (F05). |
| `pastChatHistory[].role` | `:2195`, `:2211` | `mapChatMessageToIMessage` `buildAgentflow.ts:89`; then every memory reader below | normal | history | `userMessage` / `apiMessage` → `user` / `assistant`. |
| `pastChatHistory[].content` | `:2196` (question, else `humanInput.feedback`, else form text, else `' '`; `:2180–2192`), `:2212` (terminal content `:2073–2121`) | `buildAgentflow.ts:88`; Agent memory `Agent.ts:1676` (all / window / summary `:1700–1725`); LLM `LLM.ts:738`; Condition Agent `ConditionAgent.ts:499`; HumanInput `HumanInput.ts:204`, `:235–237` (last message), `:258`, `:284`; `{{chat_history}}` `buildAgentflow.ts:318–319` (`convertChatHistoryToText`, components `src/utils.ts:802–820`); toggle question rewrite `stateReconciler.ts:197` | normal, HI resume, S03 (`{{chat_history}}`) | history | S08 t2 saves `' '` (F07). |
| `pastChatHistory[].fileUploads` | `:2202` (`uploads ? JSON.stringify(fileUploads)`) | `buildAgentflow.ts:91`, `:97–103` → `additional_kwargs.fileUploads` → `getPastChatHistoryImageMessages` `nodes/utils.ts:317–387` (images re-read from storage into model input) | normal with uploads (none in before/: only `null` in M3) | history | Model input depends on it. |
| `pastChatHistory[].artifacts` | `:2222` | `buildAgentflow.ts:92`, `:104–110` → `addImageArtifactsToMessages` `nodes/utils.ts:812–` (image artifacts become user image messages); copied `nodes/utils.ts:320`, `:380`, `:397`, `:422–436` | normal with artifacts (none in before/: only `null` in M3) | history | Model input depends on it. |
| `pastChatHistory[].fileAnnotations` | `:2221` | `buildAgentflow.ts:93`, `:111–117` → `additional_kwargs.fileAnnotations`, copied `nodes/utils.ts:321`, `:381`, `:398`, `:426–437` | none in before/ (only `null` in M3) | history (optional) | No model-input use found; Task 04 decides. |
| `pastChatHistory[].usedTools.**` | `:2220` (`JSON.stringify(terminalMetadata.usedTools)`) | `buildAgentflow.ts:94`, `:118–124` → `additional_kwargs.usedTools`, copied `nodes/utils.ts:322`, `:382`, `:399`, `:430–438` into the records' `input.messages` | S01 t3, S07 | drop | Never reaches the model: no S01/S07 model request contains `usedTools`. JSON string; `toolOutput` may itself be JSON (Current DateTime). |
| `pastChatHistory[].action.**` | `:2237–2238` `JSON.stringify(primaryStopped.action)` (bulk copy of a record's `output.humanInputAction`, taken **before** `_removeCredentialId`, so it keeps `agentModelConfig.FLOWISE_CREDENTIAL_ID`: S07, S08); set to `null` `:2161` | `:2154–2161`: trusted mode needs only its presence (`doNotIncludeFeedbackHistory` is forced by `useTrustedState`, `:2157–2160`); the `includes('doNotIncludeFeedbackHistory')` check matters only without `useTrustedState` (M3-envflags) | HI/TA resume (S06, S06b, S07, S08) | drop (presence → pending) | F08. Scan is oldest-first in trusted mode (`:2144`) and newest-first in DB mode (`:2151`). M3 never clears it in the token (S07 M3: 4 prompt copies). Escaped twice. |
| `pastChatHistory[].id` | `:2210` (`apiMessageId`); user: `addChatMesage.ts:17` | — (only inside the bulk `ChatMessage.create(result)` `:2162`) | — | drop | Task 04: keep only if messages need ids. |
| `pastChatHistory[].{chatflowid,chatId,sessionId,chatType}` | `:2197–2200`, `:2213–2216` | — | — | drop | |
| `pastChatHistory[].createdDate` | `:2201` (request time); bot `addChatMesage.ts:18` | — | — | drop | |
| `pastChatHistory[].executionId` | `:2204`, `:2217` (`newExecution.id`: mock id, DB id, or on resume the token's `previousExecution.id`) | — | — | drop | |
| `pastChatHistory[].{leadEmail,sourceDocuments,followUpPrompts}` | `:2203`, `:2219`, `:2234` | — (`mapChatMessageToIMessage` ignores them) | M3 only (`null`) | drop | |
| `pastChatHistory[].{agentReasoning,memoryType}` | ChatMessage entity columns (DB mode only) | — | M3 only (`null`) | drop | |

### 2.2 Previous execution envelope

| Field path | Written by | Read by (file:line) | Scenario | Target | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `previousExecution` | `getPreviousExecution` `buildAgentflow.ts:1621–1633` via `ensureTrustedData` `:1634–1641` (called `:2009`, `:2241`) | `lazyLoadExecution` `:1292–1294` | persist, form, resume | split (below) | Replaced every turn. |
| `previousExecution.id` | `:1623` (`newExecution.id`: `addExecution` mock id `:148` with Zero-Retention, DB id otherwise; on resume the incoming id `:1495`) | `:1495–1496` (resume continues the same execution: `parentExecutionId`, DB updates `:1473`, `:1494`, `:1985` when executions are recorded, M2), error texts `:1422`, `:1429`, `:1435` | resume | pending (only if recorded executions must continue in one row; Task 04) | Also becomes `executionId` of the new history messages. |
| `previousExecution.state` | `:1624` (turn status) | `:1402–1438` (resume only from `STOPPED`, or `ERROR` whose last record is `ERROR` after a `STOPPED` one) | resume | pending (implied by its presence) | Task 04: the ERROR-after-STOPPED retry needs an equivalent rule. |
| `previousExecution.{agentflowId,sessionId,workspaceId}` | `:1625–1627` | — | — | drop | |
| `previousExecution.{createdDate,updatedDate}` | `:1630–1631` (on resume copied from the incoming token through `newExecution`) | — | — | drop | |
| `previousExecution.executionData`, `previousExecution.executionData<json>` | `:1628` `JSON.stringify(agentFlowExecutedData)` (bulk copy of every record of the turn; on resume this includes the previous turn's records, `:1468`, F09) | `JSON.parse` `:1319–1324` (persist), `:1365–1370` (form), `:1394–1398` (resume) | persist, form, resume | split (below) | JSON string inside JSON: escaped once more. 83–99% of every token (size report). |

### 2.3 Node records (`previousExecution.executionData<json>[]`)

Records are appended by `commitExecutedDataDelta` (`stateReconciler.ts:131–153`) from `buildAgentflow.ts:1817–1821` (stopped), `:1881–1891` (finished), and pushed directly for errors (`:1922–1932`, `:1948–1958`) and iteration children (`:933–944`).

| Field path | Written by | Read by (file:line) | Scenario | Target | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `previousExecution.executionData<json>[]` | see above | resume: bulk copy `buildAgentflow.ts:1468`; `executionData.length` `:1407`; ERROR-after-STOPPED trim `:1408–1419` | resume | pending | |
| `previousExecution.executionData<json>[].nodeId` | `:1040`, `:1084`, `:1885`, `:1923`, `:1949`, `:934` | `:1456` (resume target exists), `:1414` (log); `faultCoordinator.ts:197`, `:205`, `:242–246` (stopped records), `dependencyEngine.ts:369–373`, `:401` (replay), `buildAgentflow.ts:2041` (final status), `:399`, `:427` (`{{nodeId}}`), `:331–334` (loop count), `stateReconciler.ts:136–143` (resumed STOPPED record removed by id), `terminalCoordinator.ts:433–434` (current-turn filter) | resume | pending | |
| `previousExecution.executionData<json>[].nodeLabel` | `:1041`, `:1085`, `:1886`, `:1924`, `:1950` | `:1414` (debug log) | — | drop | Kept in the pruned client payload (TS18). |
| `previousExecution.executionData<json>[].status` | `:1050`, `:1094`, `:1889`, `:1931`, `:1957` | `:1411` (ERROR after STOPPED); `faultCoordinator.ts:197`, `:215`, `:242` (stopped records: resume target `:1445`, `selectPrimaryStoppedAction` `:2035`); `dependencyEngine.ts:404`, `:412` (replay); `buildAgentflow.ts:2040–2041`, `:2048–2058` (turn status: a branch stopped in an earlier turn keeps the turn `STOPPED`, S08 t2); `terminalCoordinator.ts:440–441` (current turn only) | resume | pending | |
| `previousExecution.executionData<json>[].previousNodeIds.**` | `:1049`, `:1093`, `:1888`, `:1925`, `:1951` | — | — | drop | Kept in the pruned client payload (TS18). |
| `previousExecution.executionData<json>[].data` | node result: `{...results, output}` `:1042–1048`, `:1086–1092`; `{...nodeResult, state}` `:1876–1879`; error records `:1926–1930`, `:1952–1956` | replay passes the whole `record.data` as the edge `sourceResult` (`dependencyEngine.ts:418`, `:841–845`), which ends in the queue entry's `data`/`inputs` (`:993–1001`); `executeNode` never reads them (`buildAgentflow.ts:1718–1768` passes only `nodeId`) | resume | split (below) | Bulk copy. |
| `previousExecution.executionData<json>[].data.id` | node return (e.g. `Agent.ts:1448`, `LLM.ts:663`), `:1927`, `:1953` | — | — | drop | |
| `previousExecution.executionData<json>[].data.name` | node return (e.g. `Agent.ts:1449`), `:1928`, `:1954` | `:1372` (find the Start record for form values), `:331` (loop count: latest `loopAgentflow` record) | form; resume with `{{$loop…}}` (no such flow in before/) | drop (form gets its own field; loop counts → pending) | |
| `previousExecution.executionData<json>[].data.input` | node return (`input: {messages, ...nodeData.inputs}` `Agent.ts:1451–1454`, `LLM.ts:665–668`; Start `Start.ts:194–207`; HumanInput `HumanInput.ts:210`, `:284`; resumed node gets `humanInput` added `buildAgentflow.ts:777`) | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.messages.**` | `Agent.ts:1453` (system prompt unshifted `:1019–1020`, client `history` prepended on the first node `:1003–1013`, memory `:1028–1065`, tool loop), `LLM.ts:666`, `ConditionAgent.ts:442`, `HumanInput.ts:284` (past + runtime history) | — (the Agent resume reads the copy in `output.humanInputAction`, not this one) | — | drop | The prompt and history copy: 82–96% of gzip on finished turns (F13). Credential-free. |
| `previousExecution.executionData<json>[].data.input.agent*.**` | Agent: spread of resolved `nodeData.inputs` (`Agent.ts:1454`) | — | — | drop | Includes `agentModelConfig.credential` (a credential id) and tool settings (F18). |
| `previousExecution.executionData<json>[].data.input.llm*.**` | LLM: spread of resolved inputs (`LLM.ts:667`) | — | — | drop | `llmModelConfig.FLOWISE_CREDENTIAL_ID` appears once: S11 t2, the fatal-error token is written (`:2010`) before `_removeCredentialId` (`:2124`). |
| `previousExecution.executionData<json>[].data.input.{code,inputVariables}` | Custom Function inputs | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.conditions.**` | Condition node inputs | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.{maxLoopCount,nodeID}` | Loop node inputs | — | — | drop | Replay reads the **output** copies. |
| `previousExecution.executionData<json>[].data.input.iterationInput.**` | Iteration node | `executeNode` reads the current result (`buildAgentflow.ts:846–882`) | — | drop | |
| `previousExecution.executionData<json>[].data.input.{feedback,startNodeId,type}` | HumanInput resume record `input = {...humanInput, messages}` (`HumanInput.ts:210`) | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.humanInput.**` | resumed Agent record (`buildAgentflow.ts:777`) | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.humanInputEnableFeedback` | HumanInput stop record (`HumanInput.ts:284`) | — | — | drop | The client reads the action's copy (TS20). |
| `previousExecution.executionData<json>[].data.input.question` | Start (`Start.ts:198`) | — | — | drop | |
| `previousExecution.executionData<json>[].data.input.form.**` | Start form definition (`Start.ts:203–207`) | — | — | drop | |
| `previousExecution.executionData<json>[].data.output` | node results | `{{nodeId.output.<path>}}` `buildAgentflow.ts:391–419` and `{{nodeId}}` `:426–438` read the latest record with that id, so on resume any output of a node that finished in the stopped run (bulk-copied `:1468`) | resume with references to the stopped run (none in before/) | pending (Task 03) | No before/ resume flow references an upstream node; Task 03 should add one before dropping outputs. |
| `previousExecution.executionData<json>[].data.output.content.**` | nodes; loop fallback `dependencyEngine.ts:689`; iteration `buildAgentflow.ts:1008` | `{{nodeId}}` `:432` (`content ?? http.data`); `terminalCoordinator.ts:491–496` (current-turn records only, `:433`) | resume with references (none in before/) | pending (Task 03) | S09's iteration output is pretty-printed JSON and stays a string. |
| `previousExecution.executionData<json>[].data.output.conditions.**` | Condition, Condition Agent, HumanInput resume (`HumanInput.ts:178–211`) | `dependencyEngine.ts:114–124` (`isFulfilled`) via replay `:418` | HI resume after a decision node (S04a/b, S02 decisions are replayed only on resume; S06, S06b, S08 gate) | pending (`isFulfilled` only) | Other condition fields (`feedback`, `startNodeId`, `output`, `type`, `value1/2`, `operation`) are never read. |
| `previousExecution.executionData<json>[].data.output.{nodeID,maxLoopCount}` | Loop node | replay `dependencyEngine.ts:424–444` (loop target, max count, loop count rebuild → `buildAgentflow.ts:1556–1560`) | HI resume after a loop (S06 Revise Loop) | pending | |
| `previousExecution.executionData<json>[].data.output.fallbackMessage` | Loop node | `dependencyEngine.ts:684` reads the current result; replay copies the whole output as a queue payload (`:444`, `:787`, `:793`), unused | — | drop | |
| `previousExecution.executionData<json>[].data.output.form.**` | Start `Start.ts:208–213` (first form turn: the `key: value` string built at `buildAgentflow.ts:801–804`; later turns the object read back) | `buildAgentflow.ts:1375–1382` (string → `parseFormStringToJson` `:1141–1153`) → `agentflowRuntime.form` → `Start.ts:210–211` (preferred over a new submission, F04) and `$form.*` fallback `buildAgentflow.ts:755` | form (S05) | form (TS12) | string on t1, object afterwards. |
| `previousExecution.executionData<json>[].data.output.humanInputAction`, `previousExecution.executionData<json>[].data.output.humanInputAction.data`, `previousExecution.executionData<json>[].data.output.humanInputAction.data.input` | `buildAgentflow.ts:1017–1033` (HumanInput), `:1066–1081` (Agent tool approval), stored `:1043–1047`, `:1087–1091` | `faultCoordinator.ts:50–57` (non-empty object); `findResumedHumanInputAction` `:184–221` → `executeNode` `buildAgentflow.ts:773–775` → `options.humanInputAction` `:834`; `selectPrimaryStoppedAction` `faultCoordinator.ts:283–311` at `buildAgentflow.ts:2035` → SSE `action` `:2065` and history `action` `:2238` | HI/TA resume; S08 t2 re-announces the branch stopped in t1 | pending (slim, TS20) | Bulk copy into the SSE event, the history and the client payloads. |
| `previousExecution.executionData<json>[].data.output.humanInputAction.{id,mapping,elements}.**` | as above | re-emitted whole (above); not read field by field on the server | HI/TA resume | pending (slim, TS20) | |
| `previousExecution.executionData<json>[].data.output.humanInputAction.data.{nodeId,nodeLabel}` | as above | re-emitted whole | HI/TA resume | pending (slim, TS20) | |
| `previousExecution.executionData<json>[].data.output.humanInputAction.data.input.messages.**` | `results.input` of the stopped node (`:1030`, `:1079`): Agent = the full prompt incl. the tool-call message; HumanInput = past + runtime history | Agent `handleResumedToolCalls`: `Agent.ts:2329` (checkpoint), `:2335` (last message = model response: `tool_calls[].{id,name,args}` `:2344–2380`, `id`, `content`, `usage_metadata.total_tokens` `:2342`), `:2338–2339` (earlier messages replayed as model input). HumanInput resume does not read it (`HumanInput.ts:177–228` uses `options.pastChatHistory`) | TA resume (S07 t3/t5, S08 t2) | pending (TS-O1, Task 03) | HumanInput copy: drop. |
| `previousExecution.executionData<json>[].data.output.humanInputAction.data.input.humanInputEnableFeedback` | HumanInput stop input (`HumanInput.ts:284`) | — on the server; clients read it from the SSE `action` | HI resume | pending (slim, TS20) | |
| `previousExecution.executionData<json>[].data.output.humanInputAction.data.input.agent*.**` | Agent settings spread into the stopped node's input | — | — | drop | Credential id, tool configuration (F19). |
| `previousExecution.executionData<json>[].data.output.humanInputAction.extra` | `:1032`, `:1036` | — (the history copy's string is the one checked, `:2158`) | — | drop | TS15. |
| `previousExecution.executionData<json>[].data.output.isWaitingForHumanInput` | Agent | `buildAgentflow.ts:1065` reads the current result | — | drop | |
| `previousExecution.executionData<json>[].data.output.ephemeralMemory` | Start `Start.ts:216–218` | `stateReconciler.ts:182` reads the current result | — | drop | |
| `previousExecution.executionData<json>[].data.output.{persistState,question}` | Start `Start.ts:199`, `:220–222` | — | — | drop | |
| `previousExecution.executionData<json>[].data.output.{usageMetadata,responseMetadata,timeMetadata}.**` | Agent `prepareOutputObject` `Agent.ts:1865–`, LLM, Condition Agent | — | — | drop | |
| `previousExecution.executionData<json>[].data.output.{calledTools,usedTools,availableTools}.**` | Agent `Agent.ts:1890`, `:1924`, `:1936` | `terminalCoordinator.ts:524–525` (`usedTools` of current-turn terminal records) | — | drop | |
| `previousExecution.executionData<json>[].data.output.iterationResults.**` | `buildAgentflow.ts:1005–1009` | — | — | drop | |
| `previousExecution.executionData<json>[].data.output.http.**` | HTTP node | `{{nodeId}}` fallback `buildAgentflow.ts:432` | not in before/ | pending (Task 03) | |
| `previousExecution.executionData<json>[].data.output.{sourceDocuments,artifacts,fileAnnotations}.**` | Agent/LLM/Retriever outputs | `terminalCoordinator.ts:521–532` (current turn only) | not in before/ | drop | |
| `previousExecution.executionData<json>[].data.state.**` | `buildAgentflow.ts:1814` (stopped), `:1878` (finished): a clone of the whole runtime state on **every** record | Persist State: last record with `data.state` `:1326–1335` → `agentflowRuntime.state` `:1360` → `Start.ts:186–190`, `flowConfig.state` `buildAgentflow.ts:735` (`$flow.state`); resume: last record with state `:1481–1491` | persist (S04a, S10b, S11), resume (S06, S07, S08) | flow state (TS11, TS19) | One copy per record today; S04b (Persist State off) never reads it (F03). |
| `previousExecution.executionData<json>[].data.chatHistory.**` | node results (`Agent.ts:1458`, `LLM.ts:671`, `ConditionAgent.ts:453`, `HumanInput.ts:224`, `:294–295`) | `stateReconciler.ts:171–176` reads the current result only; runtime history starts empty every turn, resume included (`buildAgentflow.ts:1278–1282`) | — | drop | |
| `previousExecution.executionData<json>[].data.error` | `:1929`, `:1955` | `:1414` (debug log) | error (S11 t2) | drop | The pruned client payload keeps the text (TS18). |
| `previousExecution.executionData<json>[].data.parentNodeId` | iteration children `:939` | filter only: `faultCoordinator.ts:195`, `:203`, `:213`, `:241`; `dependencyEngine.ts:368`, `:400`; `buildAgentflow.ts:2039`; `terminalCoordinator.ts:432` | iteration (S09) | drop | Iteration children cannot be resumed. |
| `previousExecution.executionData<json>[].data.{iterationIndex,iterationContext}.**` | `:937–938` | — | iteration (S09) | drop | |

---

## 3. Bulk copies

A bulk copy moves a whole object; it does not show that any field inside it is needed.

| Copy | Code | What moves | Effect |
| :--- | :--- | :--- | :--- |
| Resume carries the previous records | `buildAgentflow.ts:1468` `agentFlowExecutedData.push(...executionData)` | every record of the previous token | Into this turn's records, so into the next token, the SSE `agentFlowExecutedData` and the JSON response (F09). |
| Token records | `:1628` `JSON.stringify(agentFlowExecutedData)` | every record of the turn | `previousExecution.executionData` of the next token. |
| Credential strip | `:2124` `_removeCredentialId` (`utils/index.ts:2029–2042`) | every record, minus `FLOWISE_CREDENTIAL_ID` keys | Runs after the action and the fatal-error token were taken (see 2.1, 2.3). `agentModelConfig.credential` (also an id) stays. |
| Stopped action | `faultCoordinator.ts:50–57`, `:283–311` → `buildAgentflow.ts:2065`, `:2238` | a record's whole `output.humanInputAction` | SSE `action`, `apiMessage.action` (history), saved ChatMessage in DB mode. |
| Stopped node input | `:1030`, `:1079` (`data.input: results.input`) and `:1043–1047`, `:1087–1091` | the stopped node's full input | Third copy of the prompt/history while stopped (00 §3.1). |
| History carried over | `:2242–2245` | every incoming history message object | All fields of 2.1 survive unchanged, `null` columns from DB mode included. |
| Pending-action cleanup | `:2162` `ChatMessage.create(result)` | one history message | Not saved in trusted mode (`:2164`). |
| Replay edge payloads | `dependencyEngine.ts:418`, `:841–845`, `:444`, `:787`, `:793`, `:993–1001` | record `data` / loop `output` | Queue entry `data`/`inputs`; unused by `executeNode`. |
| Snapshots | `buildAgentflow.ts:719`, `:1750` | shallow copies of the record list | Read paths above. |
| Iteration children | `:896–924` | `incomingInput` incl. the raw token | Child decodes the token again (F12). |
| Client payloads | `:1829`, `:1900`, `:2004` (SSE), `:2275` (JSON), queue: `RedisEventPublisher.ts:254`, `:269` | all records incl. carried-over ones | F18 (TS18). |
| Saved execution | `:1983–1995` (`persistFinalExecution`) | all records | DB only when recording (M2, M3); TS5. |

---

## 4. What the inventory shows (input for Tasks 03 and 04)

1. **Normal turn**: the server reads `pastChatHistory[].{role, content, fileUploads, artifacts, fileAnnotations, usedTools}`, the last record's `data.state` (Persist State on) and the Start record's `output.form` (form flows). Nothing else. `usedTools` and `fileAnnotations` never reach a model.
2. **HumanInput resume** reads `previousExecution.state`, and from the records of the stopped run: `nodeId`, `status`, `data.parentNodeId`, `data.state` (last), `output.conditions[].isFulfilled`, loop `output.{nodeID, maxLoopCount}`, `data.name` (loop counts) and `output.humanInputAction` (to re-announce a branch that is still stopped). It does not read `humanInputAction.data.input.messages`.
3. **Agent tool-approval resume** additionally reads `humanInputAction.data.input.messages` (the whole checkpoint prompt; the last message's `tool_calls`, `id`, `content`, `usage_metadata`). This is the TS-O1 measurement target.
4. **Not exercised in before/**: a node after a resume referencing a node that finished in the stopped run (`{{nodeId}}`, `{{nodeId.output.x}}`), and `{{$loop…}}` after a resume. Today both resolve from the carried-over records; pending data that drops outputs would change them. Task 03 should add such a scenario before settling the pending field.
5. **Recorded executions on resume**: today a resume continues the same Execution row using `previousExecution.id` (M2). Without the id in pending data, recording (TS5) would start a new row per resume turn. Task 04 decides.
6. **ERROR after STOPPED**: today a stopped turn whose resume failed can be resumed again (`:1405–1427`). Task 04 needs an equivalent rule for the pending field.
7. **Credential ids**: `_removeCredentialId` (`:2124`) runs after the SSE executed data was buffered (`SSEStreamer.ts:162-167`, last update `:1829`/`:1900`), after the action was taken (`:2035`) and after the fatal-error token (`:2010`). So `FLOWISE_CREDENTIAL_ID` reaches clients in every streamed `agentFlowExecutedData` (one per Agent record in the M1 traces, two on stopped turns), in the SSE and history `action` (S07, S08) and in the fatal-error token (S11 t2); only the JSON response and the normal token are stripped. `agentModelConfig.credential` / `llmModelConfig.credential` (ids too) stay in every record.
8. **DB mode** writes a token too (`:2241` has no mode check), built on the client's incoming token; its history keeps every `action` (never cleared there) and the ChatMessage `null` columns.
9. **History `action` scan order** differs by mode (`:2144` oldest first vs `:2151` newest first).

## 5. Check result

`node plans/agentflow-trusted-state/baselines/analyze-token.mjs --check-inventory` on `before/`: see the task file (§5 acceptance).
