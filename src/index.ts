/**
 * pi-herdr-subagents: spawn, message, inspect and kill child pi agents
 * living in herdr panes. See docs/plans for the design.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { log } from "./herdr.js";
import { ENV_DEPTH, ENV_PARENT, ENV_PROFILE, Manager } from "./manager.js";
import { loadProfiles } from "./profiles.js";
import { loadSettings } from "./settings.js";

const text = (t: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text: t }],
  details,
});
const err = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  isError: true,
});

export default function (pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    log("disabled", { reason: "not inside a herdr pane" });
    return;
  }

  const parentPane = process.env[ENV_PARENT];
  const depth = Number(process.env[ENV_DEPTH] ?? 0);
  const myProfile = process.env[ENV_PROFILE];
  let manager: Manager | undefined;
  let awaitingParent = false;

  const getManager = (cwd: string): Manager => {
    manager ??= new Manager(pi, loadSettings(cwd));
    return manager;
  };

  // ---- child side: clear herdr "blocked" once the parent's reply arrives ----
  pi.on("input", () => {
    if (awaitingParent) {
      awaitingParent = false;
      pi.events.emit("herdr:blocked", { active: false });
    }
  });

  // ---- Agent -----------------------------------------------------------------
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Spawn a child pi agent in a herdr pane. Foreground (default) splits the current pane and blocks until the child finishes, returning its final message. Background opens a new tab and returns immediately, the report arrives later as a message. Use `resume` to send a follow-up prompt to an existing child.",
    promptSnippet:
      "Spawn a child pi agent (profiles: general-purpose, Worker, Scout, plus user profiles)",
    promptGuidelines: [
      "Use Agent with subagent_type Scout for read-only searches, pass a cheap fast model.",
      "Use Agent with run_in_background true for long independent work, the report arrives as a later message.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Task for the child. Self-contained, the child has no conversation context.",
      }),
      description: Type.String({
        description: "3-5 word summary shown in listings.",
      }),
      subagent_type: Type.Optional(
        Type.String({ description: "Profile name. Default general-purpose." }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "provider/model[:thinking]. Default inherits the parent model.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Default parent cwd." }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({ description: "Default false." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Short handle used in the agent id." }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Existing agent id to continue with this prompt.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "0 = no timeout. On timeout returns partial output, child keeps running.",
        }),
      ),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const m = getManager(ctx.cwd);
      const profiles = loadProfiles(ctx.cwd);
      const typeName = p.subagent_type ?? "general-purpose";
      const profile = profiles.get(typeName);
      if (!profile)
        return err(
          `unknown subagent_type ${typeName}. Available: ${[...profiles.keys()].join(", ")}`,
        );
      if (myProfile) {
        const allowed = profiles.get(myProfile)?.allowedSubagents ?? "all";
        if (allowed !== "all" && !allowed.includes(typeName)) {
          return err(
            `profile ${myProfile} may only spawn: ${allowed.join(", ") || "nothing"}`,
          );
        }
      }
      const settings = loadSettings(ctx.cwd);
      try {
        const r = await m.spawn(
          {
            prompt: p.prompt,
            description: p.description,
            profile,
            model:
              p.model ??
              profile.model ??
              settings.defaultModel ??
              (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
            thinking: p.thinking ?? profile.thinking ?? pi.getThinkingLevel(),
            cwd: p.cwd ?? ctx.cwd,
            background: p.run_in_background ?? false,
            name: p.name,
            resume: p.resume,
            timeoutMs: p.timeout_ms ?? settings.defaultTimeoutMs,
            depth: depth + 1,
          },
          signal,
        );
        return text(r.text, { id: r.id, status: r.status });
      } catch (e) {
        return err(`Agent failed: ${String(e)}`);
      }
    },
  });

  // ---- get_subagent_result ---------------------------------------------------
  pi.registerTool({
    name: "get_subagent_result",
    label: "Subagent result",
    description:
      "Status and output of a child agent. With wait=true blocks until it finishes or blocks on a question.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: Type.Optional(Type.Number()),
    }),
    async execute(_id, p, signal, _u, ctx) {
      try {
        const settings = loadSettings(ctx.cwd);
        return text(
          await getManager(ctx.cwd).result(
            p.agent_id,
            p.wait ?? false,
            p.timeout_ms ?? settings.defaultTimeoutMs,
            signal,
          ),
        );
      } catch (e) {
        return err(String(e));
      }
    },
  });

  // ---- send_message ----------------------------------------------------------
  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description:
      "Send text to another agent. Omit `to` to reach the parent (child agents only). kind=message queues a prompt (steers if the target is busy), kind=interrupt presses esc first, kind=keys sends raw keys like `enter` or `ctrl+c`. Set expect_reply=true when you need an answer before continuing: end your turn after calling it, the reply arrives as your next message.",
    promptGuidelines: [
      "Use send_message without `to` to ask the parent agent a clarifying question, then end the turn and wait for the reply.",
    ],
    parameters: Type.Object({
      to: Type.Optional(
        Type.String({ description: "Agent id or pane id. Default: parent." }),
      ),
      message: Type.String(),
      kind: Type.Optional(
        StringEnum(["message", "interrupt", "keys"] as const),
      ),
      expect_reply: Type.Optional(
        Type.Boolean({
          description: "Mark this agent as waiting for the parent.",
        }),
      ),
    }),
    async execute(_id, p, _s, _u, ctx) {
      const to = p.to ?? parentPane;
      if (!to) return err("no `to` given and this agent has no parent");
      const prefix =
        !p.to && process.env.PI_HERDR_SUBAGENT_ID
          ? `[from ${process.env.PI_HERDR_SUBAGENT_ID}] `
          : "";
      try {
        await getManager(ctx.cwd).send(
          to,
          prefix + p.message,
          p.kind ?? "message",
        );
      } catch (e) {
        return err(`send_message failed: ${String(e)}`);
      }
      if (p.expect_reply && parentPane && !p.to) {
        awaitingParent = true;
        pi.events.emit("herdr:blocked", {
          active: true,
          label: "awaiting parent",
        });
        return text(
          "Sent to parent. End your turn now and wait for the reply.",
        );
      }
      return text(`Sent to ${to}.`);
    },
  });

  // ---- kill_subagent ---------------------------------------------------------
  pi.registerTool({
    name: "kill_subagent",
    label: "Kill subagent",
    description: "Close a child agent's pane. Irreversible.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_id, p, _s, _u, ctx) {
      try {
        await getManager(ctx.cwd).kill(p.agent_id);
        return text(`${p.agent_id} killed`);
      } catch (e) {
        return err(String(e));
      }
    },
  });

  // ---- /agents ---------------------------------------------------------------
  pi.registerCommand("agents", {
    description: "List herdr subagents, focus or kill one",
    handler: async (_args, ctx) => {
      const m = getManager(ctx.cwd);
      const kids = m.list();
      if (!kids.length) {
        ctx.ui.notify("no subagents", "info");
        return;
      }
      const labels = kids.map(
        (c) =>
          `${c.id}  ${c.status.padEnd(8)} ${c.profile.padEnd(16)} ${c.pane ?? "-"}  ${c.description}`,
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
