/**
 * Claude Code host. Claude has no extension API, so reports are typed into
 * this session's own pane through herdr (they arrive as a user message) and
 * the blocked state is reported to herdr directly.
 */
import { h as defaultHerdr, type Herdr, HerdrError, type Host, log } from "@herdr-subagents/core";

export function createClaudeHost(pane: string, h: Herdr = defaultHerdr): Host {
  return {
    harness: "claude",
    // notify is ignored: typing into the pane always triggers a turn.
    deliver(text) {
      void h.agentPrompt(pane, text).catch(async (e) => {
        if (!(e instanceof HerdrError && e.code === "agent_blocked")) {
          log("deliver_failed", { pane, error: String(e) });
          return;
        }
        await h
          .paneRun(pane, text)
          .catch((e2) => log("deliver_failed", { pane, error: String(e2) }));
      });
    },
    setBlocked(active, label) {
      // ponytail: herdr's screen manifest is the state authority for claude;
      // this report is best effort and may be overridden on the next redraw.
      void h
        .paneReportAgent(pane, active ? "blocked" : "working", label)
        .catch((e) => log("report_blocked", { pane, error: String(e) }));
    },
  };
}
