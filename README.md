# pi-herdr-subagents

Thin pi extension that spawns, messages, inspects and kills child pi agents through the [herdr](https://herdr.dev) CLI. Every child is a real interactive `pi` in a herdr pane. Lifecycle (`working`, `idle`, `done`, `blocked`) comes from herdr's pi integration. The final report is the last assistant message parsed from the child's session file.

## Requirements

- herdr >= 0.8.2 with the pi integration installed: `herdr integration install pi`
- pi must run inside a herdr pane. Outside herdr the extension registers nothing.

## Install

```
pi install git:github.com/wxiaoyun/pi-herdr-subagents
```

## Tools

| Tool                  | Purpose                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`               | Spawn a child. Foreground splits the current pane and blocks until the child finishes. `run_in_background: true` opens a tab and returns at once, the report arrives later as a follow-up message. `resume: <id>` sends another prompt to an existing child, relaunching it from its session file if its pane is gone. |
| `get_subagent_result` | Status plus recent screen, or the final report. `wait: true` blocks.                                                                                                                                                                                                                                                   |
| `send_message`        | Text to any agent. `to` omitted in a child means the parent. `kind`: `message` (prompt, steers if busy), `interrupt` (esc first), `keys` (raw keys like `enter` or `ctrl+c`). `expect_reply: true` marks the child `blocked` in herdr until the parent replies.                                                        |
| `kill_subagent`       | Close the child's pane.                                                                                                                                                                                                                                                                                                |

`/agents` lists live children, focus or kill one.

## Profiles

Built in: `general-purpose` (all tools, spawns anything), `Worker` (all tools, may spawn `Scout` only), `Scout` (read-only tools, pick a cheap fast model). User profiles are markdown files in `.pi/agents/`, `.agents/agents/`, or `~/.pi/agent/agents/`. Later locations override earlier ones by name.

```markdown
---
name: reviewer
description: Reviews diffs for correctness
model: anthropic/claude-sonnet-4-5
thinking: medium
tools: read, bash, grep
prompt_mode: append # or replace
allowed_subagents: [Scout] # or all
---

System prompt body goes here.
```

Model and thinking default to the parent's current values.

## Settings

`~/.pi/agent/herdr-subagents.json` then `.pi/herdr-subagents.json` (project wins):

```json
{
  "closeOnDone": true,
  "maxConcurrent": 4,
  "defaultTimeoutMs": 0,
  "notify": "followUp",
  "maxDepth": 2,
  "defaultModel": null,
  "splitRatio": 0.5,
  "piArgs": []
}
```

- `notify`: `followUp` injects the background report as a user message and triggers a turn, `passive` appends it for the next turn.
- `maxConcurrent`: further spawns queue FIFO. Foreground spawns block, background ones return `queued`.
- Timeout returns the partial report with status `timeout` and leaves the child running.
- Pressing esc during a foreground spawn detaches it: the child keeps running as background.
- `piArgs`: extra CLI args for every child pi, for example `["--no-skills"]`.

## Debug logging

Logging is disabled by default and never writes to stdout or stderr. Set `PI_HERDR_SUBAGENTS_LOG=1` to append logs to `~/.pi/agent/herdr-subagents-debug.log`, or set it to a file path:

```sh
PI_HERDR_SUBAGENTS_LOG=/tmp/herdr-subagents.log pi
```

## How a child asks the parent

Child calls `send_message({ message, expect_reply: true })`, ends its turn. The text lands in the parent as a queued message prefixed `[from <id>]`. The parent's foreground `Agent` call returns with status `blocked`. Parent answers with `send_message({ to: <id>, message })` and resumes waiting with `get_subagent_result({ agent_id, wait: true })`.
