# Project scope

All work in this fork targets **Agentflow V2** (`type: 'AGENTFLOW'`; `packages/server/src/utils/buildAgentflow.ts`, `packages/server/src/utils/agentflow/`, `packages/components/nodes/agentflow/`).

Agentflow V1 (`MULTIAGENT`, sequential agents) and chatflows (`CHATFLOW`) are out of scope unless a request explicitly names them:
- Don't research, design for, or test V1/chatflow paths.
- Don't add compatibility work for them; only avoid breaking them outright.

# Conversation state (`trustedState`)

An Agentflow V2 conversation continues only from the encrypted `trustedState` token the client sends back with each request. Reference: `plans/agentflow-trusted-state/11-new-implementation.md`; decisions TS1–TS30 in its `PLAN.md`.

- **Token contents.** The token (v2) holds `history`, `flowState`, `formValues` and `childFlowTokens`, plus `pendingResume` while a turn waits for human input. Nothing else: no node records and no prompts. Tokens from before v2 are upgraded on read.
- **No DB reads.** The server never reads ChatMessage or Execution rows for history, state or resume, in any mode. Those rows are written only when recording is on, for debugging.
- **Client State settings** only switch recording (chat messages, executions). "Accept conversation history from the client" decides whether a request's `history` replaces the token history.
- **Clients round-trip the token** on every request, approval answers included. Never suggest dropping the round trip. One request at a time per conversation; last writer wins.
- **External callers** get pruned executed data and the slim `action`. Only the internal Flowise chat gets full records.
- **Model input changes** only where `plans/agentflow-trusted-state/baselines/compare.config.json` intends them (TS6). Keep that file and the characterization tests (`packages/server/test/utils/buildAgentflow/trustedState/`) in step with changes to these paths.
