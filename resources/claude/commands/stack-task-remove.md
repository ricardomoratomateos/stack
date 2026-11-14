---
description: Borra tareas de Stack terminadas — worktree, agente, tmux y rama si procede
argument-hint: [tarea | branch | "las mergeadas"]
---
<!-- Installed by Stack (Settings → "Stack tools in Claude Code"); rewritten on every install. -->

Clean up Stack tasks: $ARGUMENTS

Use stack_status first to see every task: its group and diff (+added −removed). Never touch the task marked `main`. For each task that matches the request and looks safe to retire:
- If the user said its work is merged (or no longer wanted), call stack_delete_task with `delete_branch: true`.
- Otherwise call stack_delete_task without `delete_branch` (keeps the branch), since deleting it could drop commits that exist nowhere else.
- Skip anything still `working` or with an agent that `needs` a reply — ask the user first instead of stopping it mid-task.

If no argument was given, propose which tasks look safe to clean up (idle, no diff left) and ask which of them are merged and wait for confirmation before deleting more than one.

Report what you deleted and what you left alone, with why, in one short summary, in my language.
