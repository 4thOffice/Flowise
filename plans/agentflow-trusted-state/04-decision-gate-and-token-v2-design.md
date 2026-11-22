# Task 04: Token v2 Design Review

- **Status**: Not started
- **Depends On**: [03-field-removal-tests.md](./03-field-removal-tests.md) (TS-O1 resolved there)
- **Interactive**: the design is reviewed with the user before Task 05; nothing is implemented here.
- **Primary Outputs**: this file (design filled in), `PLAN.md` updated if the review changes anything, Tasks 05–09 adjusted, `compare.config.json` intended differences completed.

---

## 1. Objective

Turn the decisions in PLAN §2 (TS1–TS22, TS-O1 as resolved in Task 03) and the evidence from Tasks 02–03 into a precise design, so Tasks 05–09 can be implemented without open questions.

---

## 2. Design to Produce

1. **v2 schema** as a TypeScript interface with separate fields (TS19): version, history, flow state, form values, child flow tokens, pending resume data. For each field: its shape, who writes it, who reads it.
2. **History message shape**: role and content, plus only the fields later turns read (uploads, artifacts, file annotations, used tools; per `field-inventory.md`).
3. **Versioning** and v1 detection.
4. **v1 → v2 upgrade**: history from `pastChatHistory` (without `action`); flow state from the latest record with `data.state`; form values from the Start record `output.form`; pending resume data from a stopped `previousExecution` (per TS-O1); empty child flow tokens.
5. **Turn input** (`TrustedTurnInput` or similar) that replaces every DB and `previousExecution` read in `executeAgentFlow`, including recursive iteration runs.
6. **Builder rules** for normal, stopped, resumed, failed (TS14) and ephemeral (TS17) turns.
7. **History rules**: what each turn appends (user message incl. form text and approval answers per TS15; bot reply); client `history` (TS13, TS13a): replacement, the last-message warning check, welcome messages; how history reaches nodes (TS22), and what happens to `llmMessages` / `agentMessages` overrides that repeat it.
8. **Settings model**: flow config keys for chat message recording (TS21), execution recording (TS5) and accepting client history (TS13a); how today's `clientState.enabled` / `enabledFull` values map onto them; Persist State removal on the Start node (TS11).
9. **Client payloads**: field lists for the slim `action` (TS20) and the pruned external executed data (TS18); how "internal" is determined (`isInternal`) and where pruning happens so queue mode cannot leak full records.
10. **Child flow tokens** (TS16): plumbing between the server and the Execute Flow node (run params in, node result out), behaviour when the selected child flow changes.
11. **Expected compare results**: every `compare.config.json` intended difference with its finding ID; expected sentinel counts and size targets per scenario.

---

## 3. Acceptance Criteria

- [ ] §2.1–2.11 complete in this file and reviewed with the user.
- [ ] Tasks 05–09 updated to match.
- [ ] `compare.config.json` lists every intended difference.
