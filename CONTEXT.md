# pi-herdr-subagents

Spawns coding-agent processes as herdr panes and relays messages between them. This context exists to name the parts of that orchestration that span more than one coding agent product.

## Language

**Harness**:
A coding-agent product that runs as an interactive terminal session and that herdr can recognize in a pane. Currently `pi` or `claude`.
_Avoid_: agent kind, backend, runtime, CLI

**Host**:
The harness running the parent session, which loads this project's tools. The pi host is the extension. The claude host is the MCP server.
_Avoid_: plugin, adapter, integration

**Parent**:
The session that spawned a child and receives its reports and messages.

**Child**:
A session spawned by a parent into its own herdr pane. Has exactly one harness, chosen at spawn time.
_Avoid_: subagent (reserved for the tool name), worker

**Profile**:
A named preset for a child: system prompt, tool allowlist, model, effort, and which profiles it may spawn. Harness-neutral by default. May pin a harness.
_Avoid_: agent definition, subagent type, persona

**Report**:
The child's final assistant text plus usage totals, delivered to the parent when the child finishes a turn.
_Avoid_: result, output, summary

**Blocked**:
herdr state meaning the child is waiting on input from a person or its parent. Reached by a permission prompt or by `expect_reply`.

**Foreground / Background**:
Whether the parent waits. Foreground: the parent waits for the Report. Background: the parent continues and the Report is delivered later. Says nothing about where the child's pane is.
_Avoid_: split, tab (those are Placement)

**Placement**:
Where a child's pane lives. Split: beside the parent in the parent's tab. Tab: its own tab in the Child workspace. Independent of Foreground / Background.

**Split cap**:
The most child panes allowed beside a parent in one tab. Idle children count. Past the cap, new children get Tab placement.

**Child workspace**:
The herdr workspace holding Tab-placed children. Derived from the parent's workspace by a fixed rule, and a Child workspace maps to itself, so grandchildren land in the same one.

**Idle**:
A child whose turn finished and whose pane stays open. Delivered its Report, holds no concurrency slot, and can be Resumed. The default end state of a turn.
_Avoid_: done, finished, alive

**Resume**:
Giving an Idle child a new prompt. Starts a new turn that ends in a Report. If the pane is gone, the child is relaunched from its session first.
_Avoid_: reuse, continue, follow-up

**Detached**:
A foreground child the parent stopped waiting on. It continues as a background child.

**Stalled**:
A child whose turn finished before herdr observed it working. Recovered by checking the session file.
