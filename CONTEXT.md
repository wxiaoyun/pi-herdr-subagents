# pi-herdr-subagents

Spawns coding-agent processes as herdr panes and relays messages between them. This context exists to name the parts of that orchestration that span more than one coding agent product.

## Language

**Harness**:
A coding-agent product that runs as an interactive terminal session and that herdr can recognize in a pane. Currently `pi` or `claude`.
_Avoid_: agent kind, backend, runtime, CLI

**Host**:
The harness running the parent session, which loads this project's tools. The pi host is the extension; the claude host is the MCP server.
_Avoid_: plugin, adapter, integration

**Parent**:
The session that spawned a child and receives its reports and messages.

**Child**:
A session spawned by a parent into its own herdr pane. Has exactly one harness, chosen at spawn time.
_Avoid_: subagent (reserved for the tool name), worker

**Profile**:
A named preset for a child: system prompt, tool allowlist, model, effort, and which profiles it may spawn. Harness-neutral by default; may pin a harness.
_Avoid_: agent definition, subagent type, persona

**Report**:
The child's final assistant text plus usage totals, delivered to the parent when the child finishes a turn.
_Avoid_: result, output, summary

**Blocked**:
herdr state meaning the child is waiting on input from a person or its parent. Reached by a permission prompt or by `expect_reply`.

**Foreground / Background**:
Foreground: child shares the parent's tab and the parent waits. Background: child gets its own tab and the parent continues.

**Detached**:
A foreground child the parent stopped waiting on; it continues as a background child.

**Stalled**:
A child whose turn finished before herdr observed it working. Recovered by checking the session file.
