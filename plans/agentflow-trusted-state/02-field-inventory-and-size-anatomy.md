# Task 02: Field & Client Inventory, Size Anatomy

- **Status**: Not started
- **Depends On**: [00b-scenario-suite-and-baseline-capture.md](./00b-scenario-suite-and-baseline-capture.md) (`before/` traces)
- **Parallel with**: Task 01 (disjoint files)
- **Primary Outputs**:
  - `plans/agentflow-trusted-state/field-inventory.md`
  - `plans/agentflow-trusted-state/client-inventory.md`
  - `plans/agentflow-trusted-state/baselines/analyze-token.mjs`
  - `plans/agentflow-trusted-state/baselines/reports/size-anatomy-before.md`
  - Corrections to `00-current-implementation.md` and `00c-findings.md`, if any

---

## 1. Objective

Collect the evidence for Task 03 and the Task 04 design: which token fields the server reads and when, which payload fields each client reads, which flows depend on client `history`, and what each field costs in bytes.

---

## 2. Field Inventory (server)

Start from where the token is decoded (`:1236`), `pastChatHistory` (`:1563`), `lazyLoadExecution` (`:1286`) and its consumers, and the resume path (`:1383–1500` and everything that reads `agentFlowExecutedData` during a resumed run: dependency engine replay, `findResumedHumanInputAction`, `selectPrimaryStoppedNode`, `resolveVariables` node references and loop counts, terminal coordinator, Agent `handleResumedToolCalls`, HumanInput resume).

`field-inventory.md`, one row per field path:

| Field path | Written by | Read by (file:line) | Scenario (normal / form / human-input resume / tool-approval resume / ephemeral / error) | Target field (history / flow state / form / child tokens / pending / drop) | Notes |

Mark reads that are bulk copies (`cloneDeep`, spreads, `agentFlowExecutedData.push(...executionData)`) separately: a bulk copy does not prove the field is needed. The "target field" column follows TS10, TS12, TS16 and TS19.

---

## 3. Client Inventory

`client-inventory.md` lists, for each known client, which events and fields it reads and sends:
- Flowise UI: `packages/ui/src/views/chatmessage/ChatMessage.jsx` (internal chat, full executed data per TS18), the execution viewer, and embed/widget code in this repo (external, pruned per TS18).
- External clients, e.g. the VoIP consumer in smart_assistant (`voip/ai_processors/flowise_text_consumer.py`). If the repository is not available here, ask the user.

For each client record:
- events read: `token`, `action`, `agentFlowExecutedData`, `trustedStateData`, `metadata`, `end`, others; and which fields of `action` and executed data;
- whether it streams; whether it round-trips the token on every turn, including approval answers;
- **its use of `history`** (TS13, TS13a, TS22): which flows it sends `history` to (they need "Accept conversation history from the client" on at deploy), whether it also sends history inside `llmMessages` / `agentMessages` overrides, and whether those flows rely on the first node seeing `history` with memory off (they need memory turned on);
- that it needs nothing from executed data beyond state and the action (TS18), and nothing from `action` beyond the TS20 fields.

---

## 4. Size Anatomy

`analyze-token.mjs` reads the `before/` traces and reports per scenario and turn:
- base64 / gzip / raw JSON sizes and growth per turn;
- raw bytes per path, and **gzip cost per path** (`gzip(full) − gzip(full without that path)`);
- sentinel copies per path;
- share of history vs. records vs. state.

`reports/size-anatomy-before.md` summarises the findings, with S01 and S07 in detail.

---

## 5. Acceptance Criteria

- [ ] Every field path seen in the `before/` tokens appears in `field-inventory.md` (checked by a script that walks the decoded tokens).
- [ ] Every "read by" entry has a file:line reference; bulk copies are marked.
- [ ] `client-inventory.md` covers the Flowise UI and every external client the user names, including the flows affected by TS13a and TS22; open questions recorded.
- [ ] Size report exists for all M1 scenarios.
- [ ] `00-current-implementation.md` and `00c-findings.md` corrected where the inventory disagrees.
- [ ] No production code changed.
