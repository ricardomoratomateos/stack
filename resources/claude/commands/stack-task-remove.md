---
description: Borra tareas de Stack terminadas — worktree, agente, tmux y rama si procede
argument-hint: [tarea | branch | "las mergeadas"]
---
<!-- Installed by Stack (VS Code). Removed when "Stack tools in Claude Code" is switched off. -->

Clean up Stack tasks: $ARGUMENTS

Use stack_status first to see every task: its PR state, CI, and diff (+added −removed). Never touch the task marked `main`. For each task that matches the request and looks safe to retire:
- If its PR is merged, or it has an upstream with nothing ahead of it, call stack_delete_task with `delete_branch: true` — the branch's work exists elsewhere.
- Otherwise call stack_delete_task without `delete_branch` (keeps the branch) unless the user explicitly said to discard it, since that would drop commits that exist nowhere else.
- Skip anything still `working` or with an agent that `needs` a reply — ask the user first instead of stopping it mid-task.

If no argument was given, propose which tasks look safe to clean up (merged PRs, no uncommitted changes, idle) and wait for confirmation before deleting more than one.

Report what you deleted and what you left alone, with why, in one short summary, in my language.
