# 1. Claude Code host is an MCP server, cross-harness delivery is PTY typing through herdr

Date: 2026-09-08

## Status

Accepted

## Context

The project spawns children as interactive sessions in herdr panes and needs the same four tools (`Agent`, `send_message`, `get_subagent_result`, `kill_subagent`) inside both pi and Claude Code, with either harness able to be parent or child.

pi has an extension API that can register tools, push a user message into the conversation, and emit the herdr blocked event. Claude Code has none of that. The candidates for giving Claude Code the tools and for getting a child's report back into a Claude Code parent were:

- A stdio MCP server started by Claude Code, with reports typed into the parent's own pane through herdr's `agent prompt`.
- The Claude Agent SDK, hosting our own Claude loop instead of the interactive TUI.
- Claude Code channels, which are marketplace plugins that push events into a session.
- Claude Code's cross-session messaging socket, which is undocumented and reaches only other Claude Code sessions.
- Headless `claude -p --input-format stream-json`, which is single turn and exits after one result.

## Decision

The Claude Code host is a stdio MCP server in this repository, registered by the user once with `claude mcp add` and injected inline with `--mcp-config` into every Claude Code child. Delivery into a Claude Code parent is herdr typing the report into the parent's pane, where it arrives as a user message. Blocked state for a Claude Code child is reported to herdr with `pane report-agent` on a best-effort basis, since herdr's screen manifest remains the state authority for Claude Code.

The MCP server speaks JSON-RPC over stdio directly and does not depend on the MCP SDK.

## Consequences

- Both hosts share every code path except delivery and blocked signalling. A third harness is one more small host.
- A Claude Code parent sees reports as user messages, not tool results, and `notify: passive` has no meaning there.
- `expect_reply` from a Claude Code child may not show as `blocked` in herdr while Claude Code's own screen state disagrees. The parent still receives the message text.
- The Claude Code session file format is internal and may change. The report reader is best effort and falls back to a screen scrape.
- Only interactive Claude Code sessions in herdr panes are supported. Headless and SDK use are out of scope.
