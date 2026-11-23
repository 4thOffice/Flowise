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
5. **v1 continuation**: for each scenario and turn k (including paused turns), send the `before/` token from turn k to the new server and compare turns k+1… with the expected results. Paused v1 Agent tokens (S07 t2, S08 t1) replay their stored checkpoint once, so their next tokens may still hold that prompt until the Agent is resumed (04 D4).
6. **Determinism**: two `after/` captures compare clean.
7. **Size goals**: token size per turn grows by about that turn's messages, raw JSON ≤ 5 % of `before/` (S12 ≤ 10 %, S13 ≤ 4 KB; `SIZE-token-v2` in `compare.config.json`); sentinel counts 0, paused turns included (TS26), except item 5's v1 Agent checkpoints.
8. **Queue mode**: S01, S07 and S13 with `MODE=queue` and a local Redis; class A identical to non-queue; job and pub/sub message sizes recorded.
9. **Flowise UI** pass in the browser on the isolated server.
10. **Full test suites**: server, components, UI build.

---

## 3. Rollout Checklist

- [ ] Before/after table in `baselines/README.md` filled, with headline numbers (S01 token at turn 5, before vs after).
- [ ] Client note: always send the latest token (from SSE or JSON) with every request, including approval answers; one request at a time per conversation, keep the token of the latest completed turn, resend the previous token to retry a failed turn, hide approval buttons once answered (last writer wins, 04 D17); `history` per TS13 (whole conversation, may start with a welcome message, needs the flow setting, TS13a); `llmMessages` / `agentMessages` overrides are the node's message list and are trimmed only when they repeat the history a node already gets (04 D16); history reaches nodes only through memory (TS22); external executed data holds only status, state and action (TS18); `action` fields per TS20.
- [ ] Flow migration: turn on "Accept conversation history from the client" for flows whose clients send `history`, and memory for nodes that relied on the first-node prepend (from `client-inventory.md`); sync saved nodes to Start 1.2, Agent 3.3, LLM 1.2, Execute Flow 1.3 (04 D14, D15). The canvas Sync Nodes button shows only when the flow is opened by in-app navigation; after a full page load it can stay hidden while the per-node badges show (06 §4.2).
- [ ] VoIP and Celery flows (04 §2.7 VoIP, §3 Q2): list each production flow's node memory settings and enabled overrides; nodes that today rely on the client's `startEphemeralMemory` to hide the token history (Agent or Condition Agent with memory on, LLM without an enabled `llmEnableMemory` override) will see it after the deploy, so decide per node; set `legacy_history` off in the VoIP configs (its `history` is ignored with a warning).
- [ ] Deploy note: older builds cannot read new tokens (TS2); Persist State and Ephemeral Memory are gone from the Start node; the Client State switches only control what is recorded (TS9, D12), and "Accept conversation history from the client" is new (TS13a).
- [ ] What to watch after deploy: token size debug log, decode errors, resume failures.
- [ ] `11-new-implementation.md` written; `00-current-implementation.md` marked as the previous behaviour.
- [ ] `AGENTS.md` and the memory note on trusted state updated to the new contract.
- [ ] Every task Done in `PLAN.md`.
