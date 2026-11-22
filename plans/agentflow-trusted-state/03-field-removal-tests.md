# Task 03: Contract Proof (Field Removal)

- **Status**: Not started
- **Depends On**: [01-test-harness-and-characterization-tests.md](./01-test-harness-and-characterization-tests.md), [02-field-inventory-and-size-anatomy.md](./02-field-inventory-and-size-anatomy.md)
- **Primary Files**:
  - `packages/server/test/utils/buildAgentflow/trustedState/fieldRemoval.test.ts` (new)
  - `plans/agentflow-trusted-state/field-inventory.md` (adds a "Proven by removal" column)

---

## 1. Objective

Prove on today's code that the token fields of TS19 (history, flow state, form values) are all a normal turn needs, and **resolve TS-O1**: find the least a stopped turn needs to resume correctly, before any production change.

---

## 2. Method

For each scenario S01–S13 and each turn boundary n → n+1:
1. Run turns 1…n with the Task 01 runner and take the real token T(n).
2. Build modified tokens (decode, strip, re-encode) and run turn n+1 with each, comparing class A results with the run on the original token.

Modified tokens:
- **Contract token** for normal turns: only history, the final flow state and the form values, each placed where today's code still reads it (form values in the Start record's `output.form`), so the test runs on unchanged code. Expected: class A identical.
- **Single-field removals** from the inventory (e.g. `data.input.messages`, `data.output` except what is read, `data.state` on all but the latest record, history metadata fields, the `action` string on history messages), to confirm the inventory's "needed" column.
- **Stopped turns, TS-O1 variants** for S06–S08, from smallest to largest: (a) only the needed state: stopped node ids, the pending tool calls (ids, names, arguments) and the stop-time flow state, with the system prompt and history rebuilt on resume by a test-only helper; (b) (a) plus the assistant message that holds the tool calls; (c) the full checkpoint stored once. Record identity of model calls and token size for each.

Test-only helpers live in the test folder, not in `src/`.

---

## 3. Outputs

- `field-inventory.md`: "Proven by removal" column (`removable` / `required in <scenarios>`) and a "Minimal contract" section.
- A results section in this file for TS-O1: per variant, whether model calls stay identical in S06–S08 and the token size at the paused turn.
- **TS-O1 resolution**: the smallest variant that resumes correctly (direction: only the needed state). If it changes model input compared with today, ask the user before choosing it. Record the result in PLAN §2 and move TS-O1 to the resolved table.

---

## 4. Acceptance Criteria

- [ ] The contract token keeps class A identical for every normal-turn boundary of S01–S13, or each exception is explained and added to 00c as a finding.
- [ ] TS-O1 variants measured on S06–S08, TS-O1 resolved and recorded in PLAN §2.
- [ ] Tests stay in the suite as regression guards (< 60 s).
- [ ] No production code changed.
