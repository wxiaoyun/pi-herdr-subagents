/**
 * args.ts: child command line per harness. Multi-line prompts are staged in a
 * file because herdr `agent start` rejects args containing newlines.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./host.ts";
import type { Profile } from "./profiles.ts";
import type { Settings } from "./settings.ts";

export interface ChildSpec {
  id: string;
  profile: Profile;
  model?: string;
  thinking?: string;
  /** pi: session path. claude: session id. */
  session?: string;
  /** Directory for staged prompt files; omit to force inline prompts. */
  stagedDir?: string;
}

export const SPAWN_TOOLS = ["Agent", "get_subagent_result", "kill_subagent"];

/** Claude tool names for the builtin profiles' pi tool names. */
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Bash",
  web_search: "WebSearch",
};

const CLAUDE_EFFORT: Record<string, string> = { off: "low", minimal: "low" };

export const MCP_SERVER_PATH = fileURLToPath(
  new URL("../../claude/bin/herdr-subagents-mcp.ts", import.meta.url),
);

const mcpConfig = () =>
  JSON.stringify({
    mcpServers: { herdr: { command: "node", args: [MCP_SERVER_PATH] } },
  });

/** Inline when single-line, else a staged file path. */
function promptArg(c: ChildSpec): { file: boolean; value: string } | undefined {
  const value = c.profile.systemPrompt;
  if (!value) return undefined;
  if (c.stagedDir && value.includes("\n")) {
    const file = join(c.stagedDir, "system-prompt.md");
    writeFileSync(file, value, { mode: 0o600 });
    return { file: true, value: file };
  }
  return { file: false, value };
}

const canSpawn = (p: Profile) =>
  p.allowedSubagents === "all" || p.allowedSubagents.length > 0;

function piArgs(c: ChildSpec, s: Settings): string[] {
  const p = c.profile;
  const args = ["--name", c.id];
  if (c.model) args.push("--model", c.model);
  if (c.thinking) args.push("--thinking", c.thinking);
  const prompt = promptArg(c);
  if (prompt) {
    // pi reads a file path for both flags.
    args.push(
      p.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      prompt.value,
    );
  }
  if (p.tools?.length) {
    args.push(
      "--tools",
      [...p.tools, "send_message", ...(canSpawn(p) ? SPAWN_TOOLS : [])].join(","),
    );
  }
  if (c.session) args.push("--session", c.session);
  return [...args, ...s.piArgs];
}

function claudeArgs(c: ChildSpec, s: Settings): string[] {
  const p = c.profile;
  const args = ["--name", c.id];
  if (c.model) args.push("--model", c.model);
  if (c.thinking) args.push("--effort", CLAUDE_EFFORT[c.thinking] ?? c.thinking);
  const prompt = promptArg(c);
  if (prompt) {
    const base = p.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    args.push(prompt.file ? `${base}-file` : base, prompt.value);
  }
  if (p.tools?.length) {
    const tools = p.builtin ? p.tools.map((t) => CLAUDE_TOOL_ALIASES[t] ?? t) : p.tools;
    args.push("--tools", [...new Set(tools)].join(","));
  }
  args.push("--permission-mode", "acceptEdits", "--mcp-config", mcpConfig());
  if (c.session) args.push("--resume", c.session);
  return [...args, ...s.claudeArgs];
}

export function childArgs(harness: Harness, c: ChildSpec, s: Settings): string[] {
  return harness === "claude" ? claudeArgs(c, s) : piArgs(c, s);
}
