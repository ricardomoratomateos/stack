---
description: Crea una tarea en Stack desde un ticket (Jira, Linear), un hilo de Slack o una descripción
argument-hint: <AS-1234 | enlace | descripción>
---
<!-- Installed by Stack (VS Code). Removed when "Stack tools in Claude Code" is switched off. -->

Create a Stack task for: $ARGUMENTS

If that is a ticket key or a link, read it first with the tool that has it (Jira, Linear, Slack…) and pass it as the ticket. Write a self-contained prompt for the worker agent (goal, acceptance criteria, links), create the task with stack_create_task, and confirm the task name, branch and agent in one line.
