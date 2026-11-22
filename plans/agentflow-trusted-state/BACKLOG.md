# Agentflow V2 Trusted State: Backlog

Items raised while working on the plan that are not part of it. Each one is reviewed before anything is designed or built.

| ID | Item | Today | To review | Raised |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | Same-turn assistant replies are not carried to the next turn | Only the turn's final answer is saved to the token history (`buildAgentflow.ts:2209–2245`): the content of the finished leaf nodes (`terminalCoordinator.ts:485–504`). Replies that earlier nodes add to the history during the turn (assistant messages under TS22) stay in that turn's runtime history only. Only last nodes stream tokens (`buildAgentflow.ts:787–791`; `Agent.ts:1071`, `LLM.ts:489`), so the user never sees those replies either. | Whether a reply added to the history as an assistant message should also be saved to the token history, and stream its tokens like a last (edge) node does. | User, Task 02 session, 2026-11-22 |
