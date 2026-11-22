# Task 10: Replay, Compare & Rollout

- **Status**: Not started
- **Depends On**: [09-client-payloads-and-ui.md](./09-client-payloads-and-ui.md)
- **Primary Outputs**:
  - `plans/agentflow-trusted-state/baselines/traces/after/`, `traces/continue-v1/`
  - `plans/agentflow-trusted-state/baselines/reports/size-anatomy-after.md`
  - `plans/agentflow-trusted-state/baselines/README.md` (after columns filled)
  - `plans/agentflow-trusted-state/11-new-implementation.md` (reference for the new behaviour)

---

## 1. Objective

Prove end to end on a real server that history and state are correct with no DB reads, that every finding is fixed as intended and nothing else changed, and that the size and data-exposure goals are met. Then prepare the rollout.

---

## 2. Verification Matrix

1. **Full replay**: capture M1–M3 into `traces/after/` and compare with `before/`. Class A identical except the `compare.config.json` intended differences, each of which must appear.
2. **Empty DB**: M1–M3 `after/` runs with the ChatMessage and Execution tables emptied before every turn give the same traces.
3. **M3 = M1**: flows with Client State off behave exactly like M1.
4. **Internal vs external**: S01 and S07 through `/internal-prediction` keep full executed data; through `/prediction` it is pruned (TS18).
5. **v1 continuation**: for each scenario and turn k (including paused turns), send the `before/` token from turn k to the new server and compare turns k+1… with the expected results.
6. **Determinism**: two `after/` captures compare clean.
7. **Size goals**: token size per turn grows by about that turn's messages; sentinel counts 0 (except as TS-O1 allows while paused).
8. **Queue mode**: S01, S07 and S13 with `MODE=queue` and a local Redis; class A identical to non-queue; job and pub/sub message sizes recorded.
9. **Flowise UI** pass in the browser on the isolated server.
10. **Full test suites**: server, components, UI build.

---

## 3. Rollout Checklist

- [ ] Before/after table in `baselines/README.md` filled, with headline numbers (S01 token at turn 5, before vs after).
- [ ] Client note: always send the latest token (from SSE or JSON) with every request, including approval answers; `history` per TS13 (whole conversation, needs the flow setting, TS13a); history reaches nodes only through memory (TS22); external executed data holds only status, state and action (TS18); `action` fields per TS20.
- [ ] Flow migration: turn on "Accept conversation history from the client" for flows whose clients send `history`, and memory for nodes that relied on the first-node prepend (from `client-inventory.md`).
- [ ] Deploy note: older builds cannot read new tokens (TS2); Persist State and Client State settings no longer exist.
- [ ] What to watch after deploy: token size debug log, decode errors, resume failures.
- [ ] `11-new-implementation.md` written; `00-current-implementation.md` marked as the previous behaviour.
- [ ] `AGENTS.md` and the memory note on trusted state updated to the new contract.
- [ ] Every task Done in `PLAN.md`.
