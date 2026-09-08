/**
 * pi host: registers the shared tools with pi, delivers reports through pi's
 * message queue and flips herdr's blocked state through pi's event bus.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTools, type Host, log } from "@herdr-subagents/core";

export default function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    log("disabled", { reason: "not inside a herdr pane" });
    return;
  }

  let cwd = process.cwd();
  let model: string | undefined;
  let awaitingParent = false;

  const host: Host = {
    harness: "pi",
    model: () => model,
    thinking: () => pi.getThinkingLevel(),
    deliver(text, notify) {
      if (notify === "followUp") {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      } else {
        pi.sendMessage(
          { customType: "herdr-subagent", content: text, display: true },
          { deliverAs: "nextTurn" },
        );
      }
    },
    setBlocked(active, label) {
      awaitingParent = active;
      pi.events.emit("herdr:blocked", { active, label });
    },
  };

  // child side: clear herdr "blocked" once the parent's reply arrives
  pi.on("input", () => {
    if (awaitingParent) host.setBlocked(false);
  });

  const tools = createTools(host, () => cwd);

  const snippets: Record<string, Partial<Parameters<typeof pi.registerTool>[0]>> = {
    Agent: {
      promptSnippet:
        "Spawn a child pi or Claude Code agent (profiles: general-purpose, Worker, Scout, plus user profiles)",
      promptGuidelines: [
        "Use Agent with subagent_type Scout for read-only searches, pass a cheap fast model.",
        "Use Agent with run_in_background true for long independent work, the report arrives as a later message.",
        "Use Agent with harness claude to run the child in Claude Code instead of pi.",
      ],
    },
    send_message: {
      promptGuidelines: [
        "Use send_message without `to` to ask the parent agent a clarifying question, then end the turn and wait for the reply.",
      ],
    },
  };

  for (const t of tools.all) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters as any,
      ...snippets[t.name],
      async execute(_id, p, signal, _u, ctx) {
        cwd = ctx.cwd;
        model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const r = await t.execute(p, signal);
        return {
          content: [{ type: "text" as const, text: r.text }],
          details: r.details ?? {},
          ...(r.isError ? { isError: true } : {}),
        };
      },
    });
  }

  pi.registerCommand("agents", {
    description: "List herdr subagents, focus or kill one",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      const m = tools.manager();
      const kids = m.list();
      if (!kids.length) {
        ctx.ui.notify("no subagents", "info");
        return;
      }
      const labels = kids.map(
        (c) =>
          `${c.id}  ${c.status.padEnd(8)} ${c.profile.padEnd(16)} ${c.harness.padEnd(6)} ${c.pane ?? "-"}  ${c.description}`,
      );
      const pick = await ctx.ui.select("Subagents", labels);
      if (!pick) return;
      const child = kids[labels.indexOf(pick)];
      const action = await ctx.ui.select(child.id, ["focus", "kill", "cancel"]);
      if (action === "focus")
        await m.focus(child.id).catch((e) => ctx.ui.notify(String(e), "error"));
      if (action === "kill")
        await m.kill(child.id).catch((e) => ctx.ui.notify(String(e), "error"));
    },
  });
}
