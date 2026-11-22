# Agentflow V2 Trusted State: Backlog

Items raised while working on the plan that are not part of it. Each one is reviewed before anything is designed or built.

| ID | Item | Today | To review | Raised |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | Same-turn assistant replies are not carried to the next turn | Only the turn's final answer is saved to the token history (`buildAgentflow.ts:2209–2245`): the content of the finished leaf nodes (`terminalCoordinator.ts:485–504`). Replies that earlier nodes add to the history during the turn (assistant messages under TS22) stay in that turn's runtime history only. Only last nodes stream tokens (`buildAgentflow.ts:787–791`; `Agent.ts:1071`, `LLM.ts:489`), so the user never sees those replies either. | Whether a reply added to the history as an assistant message should also be saved to the token history, and stream its tokens like a last (edge) node does. | User, Task 02 session, 2026-11-22 |
| **B2** | A node after a denied approval still runs | In Task 03's probe P2 (S08 with the manager denying, [03 §5.1](./03-field-removal-tests.md)), the Summary still runs after the denial: the engine runs a node once any one of its incoming branches fires, here the finished Policy Check's. The scripted reply then says the refund was approved. | Whether a node joined to a human gate should wait for or be skipped by a denied branch, and whether that is engine behaviour or flow design. | Task 03 session, 2026-11-22 |
| **B3** | Text next to an approval tool call streams twice | In Task 03's probe P4 ([03 §5.1](./03-field-removal-tests.md)), the text a model writes next to a tool call that needs approval reaches the client twice in the stream. | Fix so it streams once. | Task 03 session, 2026-11-22 |
