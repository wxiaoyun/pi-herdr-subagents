# pi-herdr-subagents

Spawn, message, inspect and kill child coding agents through the [herdr](https://herdr.dev) CLI. Parent and child can each be **pi** or **Claude Code**. Every child is a real interactive session in a herdr pane. Lifecycle (`working`, `idle`, `done`, `blocked`) comes from herdr. The final report is the last assistant message parsed from the child's session file.

Vocabulary is in [CONTEXT.md](./CONTEXT.md). The one architectural decision is in [docs/adr](./docs/adr).

## Requirements

- Node >= 26
- herdr >= 0.8.2 with the integrations installed for the harnesses you use: `herdr integration install pi`, `herdr integration install claude`
- The parent must run inside a herdr pane. Outside herdr the tools do nothing.

## Install

pi parent:

```
pi install git:github.com/wxiaoyun/pi-herdr-subagents
```

Claude Code parent, once per user (path is wherever you cloned or pi installed the repo):

```
claude mcp add -s user herdr -- node <repo>/packages/claude/bin/herdr-subagents-mcp.ts
```

Claude Code children spawned by either parent get the MCP server injected automatically and do not need the registration.

## Layout

| Package           | Role                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `packages/core`   | herdr client, child manager, profiles, settings, the five tools        |
| `packages/pi`     | pi extension, the pi parent harness                                    |
| `packages/claude` | Claude Code parent harness: a stdio MCP server exposing the same tools as `mcp__herdr__*` |

## Tools

| Tool                  | Purpose                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`          | Spawn a child. `harness: pi \| claude` picks the child harness (default: profile, then the parent's). Blocks until the child's turn ends and returns its report. `run_in_background: true` returns at once, the report arrives later as a message. `machine: <id or label>` runs the child on a saved herdr machine (see Machines). `resume: <id>` sends another prompt to an existing child, relaunching it from its session if its pane is gone. |
| `GetAgentResult` | Status plus recent screen, or the final report. `wait: true` blocks.                                                                                                                                                                                                                                                                                 |
| `SendMessage`    | Text to any agent of either harness. To an idle child this starts a new turn, the report arrives later as a message. `to` omitted in a child means the parent. `kind`: `message` (prompt, steers if busy), `interrupt` (esc first), `keys` (raw keys like `enter` or `ctrl+c`). `expect_reply: true` marks the child `blocked` in herdr until the parent replies. |
| `KillAgent`      | Close the child's pane.                                                                                                                                                                                                                                                                                                                              |
| `ListAgents`     | Children of this session with id, status, profile, harness and machine.                                                                                                                                                                                                                                                                              |

Child ids are `<parent harness>-<name>-<n>`, for example `pi-scout-2`, unique among the live agents on the child's machine.

A child's turn ends in status `idle`: its pane stays open and it keeps its context. Continue it with `SendMessage` (background) or `Agent` with `resume` (blocks like a spawn). Close it with `KillAgent` or by ending the parent session. Set `closeOnDone: true` to close panes at the end of every turn instead.

## Placement

Every child gets its own tab in the child workspace: the workspace labelled `<parent workspace label>-agents`, created on first use. A child workspace maps to itself, so grandchildren land in the same one. The label is read once per parent session, since herdr relabels unlabelled workspaces after the focused pane's directory. Nothing is focused on spawn.

In pi, `/agents` lists live children, focus or kill one.

## Machines

`Agent` with `machine` runs the child on another herdr server. The value is the id or label of a profile saved with `herdr machine add`; without saved machines nothing changes. Every herdr call for that child goes through `herdr --machine <id>`, which forwards it over SSH to the remote server. Requirements:

- herdr newer than 0.9.0 on both sides (the `--machine` CLI prefix), a running herdr server on the machine, and `ssh <target>` working non-interactively. herdr's own errors say which one is missing.
- The child harness (pi or Claude Code) installed and authenticated on the machine.
- `cwd` (default: the parent's) exists on the machine. herdr silently falls back to `$HOME` otherwise, so the spawn checks the pane's cwd and fails instead.

The child's tab lands in the same `<label>-agents` workspace on the machine. Its report is read from its session file over `ssh <target> cat`. A machine child gets no `HERDR_SUBAGENT_PARENT` and no MCP config, so it cannot spawn or message back; the parent still reaches it with `SendMessage`, `resume` and `KillAgent`. If the SSH bridge drops mid-turn the child goes `idle` with the error as its report; `resume` reattaches, or relaunches it from its session if it is gone. Nothing syncs files or branches between machines.

## Harness differences

| Concern              | pi child                                    | Claude Code child                                                                  |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| model                | `provider/id`, inherits parent when pi      | `anthropic/<id>` loses its prefix, bare ids pass through, other providers error     |
| thinking             | `--thinking` as given                       | `--effort`, `off` and `minimal` become `low`                                       |
| tools                | `--tools` plus the subagent tools           | `--tools` verbatim; builtin profiles are translated (`read` to `Read`, `find` to `Glob`, ...) |
| permissions          | n/a                                         | `--permission-mode acceptEdits`, profile tools also go to `--allowedTools`, override via `claudeArgs`. `bypassPermissions` blocks startup on a confirmation |
| native subagents     | none                                        | native `Agent`, `SendMessage`, `ListAgents` stay available, except for profiles that may not spawn (Scout) |
| report into parent   | pi message queue (`notify` setting applies) | typed into the parent's pane as a user message (`notify` ignored)                   |
| `expect_reply`       | herdr shows `blocked`                       | best effort, herdr's screen detection may override                                  |
| resume               | `--session <path>`                          | `--resume <session id>`                                                             |

Cross-harness spawns with no explicit model pass no model, so the child harness uses its own default.

## Profiles

Built in: `general-purpose` (all tools, spawns anything), `Worker` (all tools, may spawn `Scout` only), `Scout` (read-only tools, pick a cheap fast model). User profiles are markdown files in `.pi/agents/`, `.agents/agents/`, or `~/.pi/agent/agents/`. Later locations override earlier ones by name. The same locations serve both parent harnesses.

```markdown
---
name: reviewer
description: Reviews diffs for correctness
harness: claude # optional, pi or claude
model: sonnet
thinking: medium
tools: [Read, Grep, Bash]
prompt_mode: append # or replace
allowed_subagents: [Scout] # or all
---

System prompt body goes here.
```

Tool names in user profiles are passed to the child harness as written. Model and thinking default to the parent's current values when the harness matches.

## Settings

`~/.pi/agent/herdr-subagents.json` then `.pi/herdr-subagents.json` (project wins), read by both parent harnesses:

```json
{
  "closeOnDone": false,
  "maxConcurrent": 4,
  "defaultTimeoutMs": 0,
  "notify": "followUp",
  "maxDepth": 2,
  "defaultModel": null,
  "piArgs": [],
  "claudeArgs": []
}
```

- `notify`: `followUp` injects the background report as a user message and triggers a turn, `passive` appends it for the next turn. pi parent only.
- `maxConcurrent`: further spawns queue FIFO. Foreground spawns block, background ones return `queued`. Idle children hold no slot.
- Timeout returns the partial report with status `timeout` and leaves the child running.
- Pressing esc during a foreground spawn detaches it: the child keeps running as background.
- `piArgs` / `claudeArgs`: extra CLI args for every child of that harness, for example `["--no-skills"]` or `["--allowedTools", "Bash(git *)"]`.

Children carry `HERDR_SUBAGENT_PARENT`, `HERDR_SUBAGENT_DEPTH`, `HERDR_SUBAGENT_ID`, `HERDR_SUBAGENT_PROFILE` and `HERDR_SUBAGENT_HARNESS` in their environment.

## Debug logging

Logging is disabled by default and never writes to stdout or stderr. Set `HERDR_SUBAGENTS_LOG=1` to append logs to `~/.pi/agent/herdr-subagents-debug.log`, or set it to a file path:

```sh
HERDR_SUBAGENTS_LOG=/tmp/herdr-subagents.log pi
```

## How a child asks the parent

Child calls `SendMessage({ message, expect_reply: true })`, ends its turn. The text lands in the parent as a queued message prefixed `[from <id>]`. The parent's foreground `Agent` call returns with status `blocked`. Parent answers with `SendMessage({ to: <id>, message })` and resumes waiting with `GetAgentResult({ agent_id, wait: true })`.

## Development

```
npm install
npm test
npm run typecheck
npm run lint
```
