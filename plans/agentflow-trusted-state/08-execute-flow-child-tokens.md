# Task 08: Execute Flow Child Tokens

- **Status**: Done (2026-11-23; results, decisions taken here and the recorded limitation in §4)
- **Depends On**: [05-token-only-core.md](./05-token-only-core.md) (child token in the JSON response, F14; child flow tokens field and its plumbing); design: [04 §2.10](./04-decision-gate-and-token-v2-design.md), D15
- **Runs after**: Task 06 (shared characterization tests and components build in one checkout; the version sync uses Task 06's `updateOutdatedNodeData` change)
- **Fixes**: F10; TS25 for Execute Flow
- **Primary Files**:
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.ts` (only this node: the server plumbing comes from Task 05, which keeps this task disjoint from Task 06)
  - `packages/components/nodes/agentflow/ExecuteFlow/ExecuteFlow.test.ts` (new) and/or `packages/server/test/utils/buildAgentflow/trustedState/`

---

## 1. Objective

A child flow called by Execute Flow keeps its own history and state across the parent's turns, without DB reads (TS16).

---

## 2. Scope

- Read `options.childFlowToken` (`{ flowId, token }`, from the run params); send `trustedState: token` only when `flowId` equals the selected flow, otherwise call the child fresh.
- Return `childFlowToken: { flowId: selectedFlowId, token: response.data.trustedState }` at the top level of the node result (the server stores it under this node's id and strips it from the record); no token in the response returns none, which deletes the entry.
- Leave `trustedState` out of the whole-JSON fallback text (`:226`).
- Chat id, override config and Merge State (`agentFlowExecutedData[last].data.state`) unchanged.
- Child flows that stop for human input are not resumed: the next parent turn sends the child token with a question, which abandons the child's pause. Record the limitation.
- Size: the child token adds to the parent token; record its size in S12.
- "Return Response As" (D15): User Message removed, default Assistant Message, any value but `ignore` means assistant; version 1.2 → 1.3 (sync fallback from Task 06's `updateOutdatedNodeData` change). The option is at `ExecuteFlow.ts:90-106`, the role logic at `:258-283`.
- Tests: list S12's differences in `INTENDED_DIFFERENCES` (`characterization.test.ts`) and add `F10-S12-child-token` to its `compare.config.json checks` block, as Task 06 did for its entries (06 §4.3).

---

## 3. Acceptance Criteria

- [x] Failing test for F10 passes: on turn 2 the S12 child sees its own earlier messages and state.
  - `F10 the child flow sees its own earlier messages and state on the next turn (S12)` (`findings: target behaviour`, `characterization.test.ts`) changed from `test.failing` to `test` and passes: the t2 specialist call holds the t1 exchange, and `child_count` goes 1, 2, 3, 4.
  - Three new F10 tests pass:
    - M1's whole S12 conversation equals DB mode's run in `traces/before/M3`, when the child read its messages and state from the database: every request, reply, state and history.
    - The parent keeps the child's token under the node id and sends it with the next call, in M1 and M3. The child token holds no prompt and is not in the executed data.
    - A failed child call leaves the kept token as it was (§4.2).
- [x] S12 shows exactly the intended differences (F10 entry); parent token raw JSON ≤ 10 % of `before/`; other scenarios unchanged.
  - `before/ traces`: M1/S12 t2–t4 differ only in requests, text and state (F10 in `INTENDED_DIFFERENCES`), and each of these turns differs.
  - M3/S12 matches `before/` again in every aspect, so Task 05's F01 entry for M3/S12 t2–t4 is removed (§4.2).
  - `compare.config.json checks`: `F10-S12-child-token` passes on the harness turns: `child_count` 4 at t4, "(specialist turn 2)" at t2, and the t1 question in the t3 specialist input.
  - Parent token raw JSON: 709–1 531 bytes, 1.55–3.15 % of `before/` in M1 and 1.54–3.05 % in M3 (§4.4). The new F10 test checks the 10 % of `SIZE-token-v2-S12`; Task 05's 5 % size test still passes for S12.
  - Every other scenario × mode × turn of `before/` matches as before, and the only snapshots that changed are S12 t2–t4.
- [x] `pnpm --filter ./packages/server build` and components tests green.
  - Builds: `pnpm --filter flowise-components build`, `pnpm --filter ./packages/server build`.
  - Server tests: `pnpm --filter ./packages/server test`, 18 suites, 459 passed + 1 todo, 69 snapshots.
  - Components tests: 8 suites, 101 passed, 5 of them in the new `ExecuteFlow.test.ts`.

---

## 4. Results

### 4.1 Code

- **`ExecuteFlow.ts` (1.3)**:
  - Sends `trustedState` from `options.childFlowToken` when the entry's `flowId` is the selected flow; otherwise the child starts fresh. Chat id, override config and Merge State are unchanged.
  - Returns `childFlowToken: { flowId: selectedFlowId, token }` when the response holds a non-empty string `trustedState`, and none otherwise, which deletes the entry.
  - The whole-JSON fallback text leaves out `trustedState`. A response without that key, such as a text body, is stringified as before.
  - Return Response As offers Assistant Message (default) and Do not append to chat history. Any other stored value, `userMessage` included, appends an assistant message (TS25, D15).
- **No server or UI change**:
  - Task 05's plumbing stores the entry under the node id, strips it from the record and drops entries of nodes no longer in the flow.
  - Task 06's `updateOutdatedNodeData` syncs a saved 1.2 node with `userMessage` to 1.3 with `assistantMessage`. Checked by running the UI helper on the built node definition and the saved S12 node: the other inputs and a stored `ignore` are kept.

### 4.2 Decisions taken in this task (for the plan session)

None changes model input beyond `compare.config.json`.

1. **M3/S12 matches `before/` again.** With its child token, DB mode's S12 sends exactly the requests of `before/` M3, where the child read its messages and state from the database. Task 05's F01 entry for M3/S12 t2–t4 is gone from `INTENDED_DIFFERENCES`; the `F01-M3-like-M1` config entry still holds, since M3 equals M1.
2. **Failed child call (04 §2.10).** A child turn that fails makes the child request fail, so the node throws and the parent turn fails (TS14). The parent's token keeps the child token of the last successful call, and the next turn continues the child from there. Tested with S12's specialist failing on t2: t3 sends the t1 child token, the child sees only the t1 exchange, and `child_count` is 2.
3. **TS25 for Execute Flow changes no captured model input.** No scenario runs a model node after an Execute Flow in the same turn: S12's Execute Flow feeds a Direct Reply. The reply role is covered by `ExecuteFlow.test.ts`.

**Limitation (recorded as the scope asks).** A child flow that stops for human input is not resumed:
- The child's response carries its pending data, and the parent keeps that token as usual.
- The parent's next turn calls the child with a `question`. `readTurnInput` keeps pending data only for a `humanInput` request, so the child's pause is abandoned, as on any normal turn after a stop. The child's history keeps its stop turn.
- Until Task 07, a paused child token holds Task 05's interim `legacyExecution`: the child's records, prompts included, encrypted inside the parent token. Such a token has the size of any paused token before Task 07, 46–94 KB of raw JSON in the scenarios (05 §4.4), and the parent carries it until its next call to the child.

### 4.3 Tests changed

- **New `ExecuteFlow.test.ts`** (components):
  - The definition: version 1.3, the options and the default.
  - The child token is sent only for the selected flow; question, chat id and override config are unchanged.
  - The returned `childFlowToken`, and none without a token; Merge State.
  - The fallback text without the token, and the reply role.
- **`characterization.test.ts`**:
  - F10 flipped to `test`, plus the three F10 tests of §3.
  - `INTENDED_DIFFERENCES`: F10 for M1/S12 t2–t4 (requests, text, state); M3/S12's F01 entry removed.
  - `compare.config.json checks`: `F10-S12-child-token`.
  - `token-only conversations (Task 05)`: S12 added. In M3 with every conversation read throwing, it runs as M1, so the child continues without DB reads.
- **`characterization.expected.ts`**: S12 t2–t4 text and `child_count`; token sizes 709, 1 023, 1 278 and 1 531 bytes. Snapshots updated for S12 t2–t4 only, in a run of the whole file.
- **`fieldRemoval.test.ts`** (Task 03's contract proof):
  - The contract token carries the child flow tokens (TS19). It uses the v2 layout for them, since v1 has no place for child tokens.
  - A new removal, "child flow tokens", changes S12 t2–t4, so the field is required.
  - The flow state removal no longer changes S12: the parent's `child_count` comes back from the child through Merge State.

### 4.4 Child token size in S12 (Jest, M1)

| Turn | Parent token raw JSON | Share of `before/` | Child token in it (base64 chars) | Child token raw JSON | Child history |
| :--- | :--- | :--- | :--- | :--- | :--- |
| t1 | 709 bytes | 1.55 % of 45 689 | 300 | 254 bytes | 2 messages |
| t2 | 1 023 bytes | 2.19 % of 46 731 | 372 | 409 bytes | 4 messages |
| t3 | 1 278 bytes | 2.68 % of 47 697 | 400 | 549 bytes | 6 messages |
| t4 | 1 531 bytes | 3.15 % of 48 611 | 444 | 671 bytes | 8 messages |

- The entry adds the child token plus 68 bytes of JSON around it. Before this task, S12's parent token was 341–1 019 bytes.
- M3 has the same parent sizes: 1.54–3.05 % of its `before/` tokens.
