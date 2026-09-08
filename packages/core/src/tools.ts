/**
 * tools.ts: the four tools, harness-neutral. Each host wraps them in its own
 * registration API (pi registerTool, MCP tools/list + tools/call).
 */
import { type Static, type TSchema, Type } from "typebox";
import { log } from "./herdr.ts";
import { HARNESSES, type Harness, type Host } from "./host.ts";
import {
  ENV_DEPTH,
  ENV_ID,
  ENV_PARENT,
  ENV_PROFILE,
  Manager,
} from "./manager.ts";
import { loadProfiles } from "./profiles.ts";
import { loadSettings } from "./settings.ts";

export interface ToolResult {
  text: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface ToolDef<S extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: S;
  execute(params: Static<S>, signal?: AbortSignal): Promise<ToolResult>;
}

const ok = (text: string, details?: Record<string, unknown>): ToolResult => ({
  text,
  details,
});
const err = (text: string): ToolResult => ({ text, isError: true });

const AgentParams = Type.Object({
  prompt: Type.String({
    description:
      "Task for the child. Self-contained, the child has no conversation context.",
  }),
  description: Type.String({ description: "3-5 word summary shown in listings." }),
  subagent_type: Type.Optional(
    Type.String({ description: "Profile name. Default general-purpose." }),
  ),
  harness: Type.Optional(
    Type.Union(
      HARNESSES.map((h) => Type.Literal(h)),
      { description: "Child harness: pi or claude. Default: profile, then the parent's harness." },
    ),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model id in the child harness's own format. Default inherits the parent model when the harness matches, else the child harness default.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory. Default parent cwd." }),
  ),
  run_in_background: Type.Optional(Type.Boolean({ description: "Default false." })),
  name: Type.Optional(
    Type.String({ description: "Short handle used in the agent id." }),
  ),
  resume: Type.Optional(
    Type.String({ description: "Existing agent id to continue with this prompt." }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "0 = no timeout. On timeout returns partial output, child keeps running.",
    }),
  ),
});

const ResultParams = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean()),
  timeout_ms: Type.Optional(Type.Number()),
});

const SendParams = Type.Object({
  to: Type.Optional(
    Type.String({ description: "Agent id or pane id. Default: parent." }),
  ),
  message: Type.String(),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("message"),
      Type.Literal("interrupt"),
      Type.Literal("keys"),
    ]),
  ),
  expect_reply: Type.Optional(
    Type.Boolean({ description: "Mark this agent as waiting for the parent." }),
  ),
});

const KillParams = Type.Object({ agent_id: Type.String() });

export interface ToolSet {
  agent: ToolDef<typeof AgentParams>;
  result: ToolDef<typeof ResultParams>;
  send: ToolDef<typeof SendParams>;
  kill: ToolDef<typeof KillParams>;
  all: ToolDef[];
  manager(): Manager;
}

/** Build the tools for a host. `cwd` is resolved per call so project config is live. */
export function createTools(host: Host, cwd: () => string): ToolSet {
  const parentPane = process.env[ENV_PARENT];
  const depth = Number(process.env[ENV_DEPTH] ?? 0);
  const myProfile = process.env[ENV_PROFILE];
  const myId = process.env[ENV_ID];
  let manager: Manager | undefined;
  const getManager = () => {
    manager ??= new Manager(host, loadSettings(cwd()));
    return manager;
  };

  const agent: ToolDef<typeof AgentParams> = {
    name: "Agent",
    description:
      "Spawn a child coding agent (pi or Claude Code) in a herdr pane. Foreground (default) splits the current pane and blocks until the child finishes, returning its final message. Background opens a new tab and returns immediately, the report arrives later as a message. Use `resume` to send a follow-up prompt to an existing child.",
    parameters: AgentParams,
    async execute(p, signal) {
      const dir = cwd();
      const m = getManager();
      const profiles = loadProfiles(dir);
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
      const settings = loadSettings(dir);
      const harness: Harness = p.harness ?? profile.harness ?? host.harness;
      try {
        const r = await m.spawn(
          {
            prompt: p.prompt,
            description: p.description,
            profile,
            harness,
            model:
              p.model ??
              profile.model ??
              settings.defaultModel ??
              (harness === host.harness ? host.model?.() : undefined),
            thinking: p.thinking ?? profile.thinking ?? host.thinking?.(),
            cwd: p.cwd ?? dir,
            background: p.run_in_background ?? false,
            name: p.name,
            resume: p.resume,
            timeoutMs: p.timeout_ms ?? settings.defaultTimeoutMs,
            depth: depth + 1,
          },
          signal,
        );
        return ok(r.text, { id: r.id, status: r.status });
      } catch (e) {
        return err(`Agent failed: ${String(e)}`);
      }
    },
  };

  const result: ToolDef<typeof ResultParams> = {
    name: "get_subagent_result",
    description:
      "Status and output of a child agent. With wait=true blocks until it finishes or blocks on a question.",
    parameters: ResultParams,
    async execute(p, signal) {
      try {
        const settings = loadSettings(cwd());
        return ok(
          await getManager().result(
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
  };

  const send: ToolDef<typeof SendParams> = {
    name: "send_message",
    description:
      "Send text to another agent (pi or Claude Code). Omit `to` to reach the parent (child agents only). kind=message queues a prompt (steers if the target is busy), kind=interrupt presses esc first, kind=keys sends raw keys like `enter` or `ctrl+c`. Set expect_reply=true when you need an answer before continuing: end your turn after calling it, the reply arrives as your next message.",
    parameters: SendParams,
    async execute(p) {
      const to = p.to ?? parentPane;
      if (!to) return err("no `to` given and this agent has no parent");
      const prefix = !p.to && myId ? `[from ${myId}] ` : "";
      try {
        await getManager().send(to, prefix + p.message, p.kind ?? "message");
      } catch (e) {
        return err(`send_message failed: ${String(e)}`);
      }
      if (p.expect_reply && parentPane && !p.to) {
        host.setBlocked(true, "awaiting parent");
        return ok("Sent to parent. End your turn now and wait for the reply.");
      }
      return ok(`Sent to ${to}.`);
    },
  };

  const kill: ToolDef<typeof KillParams> = {
    name: "kill_subagent",
    description: "Close a child agent's pane. Irreversible.",
    parameters: KillParams,
    async execute(p) {
      try {
        await getManager().kill(p.agent_id);
        return ok(`${p.agent_id} killed`);
      } catch (e) {
        return err(String(e));
      }
    },
  };

  log("tools_created", { harness: host.harness, depth, profile: myProfile });
  return { agent, result, send, kill, all: [agent, result, send, kill], manager: getManager };
}
