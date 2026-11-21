# Project scope

All work in this fork targets **Agentflow V2** (`type: 'AGENTFLOW'`; `packages/server/src/utils/buildAgentflow.ts`, `packages/server/src/utils/agentflow/`, `packages/components/nodes/agentflow/`).

Agentflow V1 (`MULTIAGENT`, sequential agents) and chatflows (`CHATFLOW`) are out of scope unless a request explicitly names them:
- Don't research, design for, or test V1/chatflow paths.
- Don't add compatibility work for them; only avoid breaking them outright.
