import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { log } from "./herdr.js";

export interface Profile {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  promptMode: "replace" | "append";
  systemPrompt?: string;
  allowedSubagents: "all" | string[];
}

export const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const BUILTIN_PROFILES: Profile[] = [
  {
    name: "general-purpose",
    description:
      "General agent with all tools. Research, multi-step tasks, code changes. Can spawn any subagent.",
    promptMode: "append",
    allowedSubagents: "all",
  },
  {
    name: "Worker",
    description:
      "Implementation agent with all tools. Executes a well-specified task end to end. May spawn Scout only.",
    promptMode: "append",
    allowedSubagents: ["Scout"],
  },
  {
    name: "Scout",
    description:
      "Read-only fast search agent (read, bash, grep, find, ls, web_search). Locate files, symbols, usages, or web facts. Pick a cheap fast model for it. Cannot spawn subagents.",
    tools: [...READ_ONLY_TOOLS, "web_search"],
    promptMode: "append",
    systemPrompt:
      "You are a read-only scout. Never edit files. Find what was asked, report exact paths, line numbers and short quotes. Be brief.",
    allowedSubagents: [],
  },
];

const asList = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
};

function loadDir(dir: string, out: Map<string, Profile>): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      const { frontmatter: fm, body } = parseFrontmatter<
        Record<string, unknown>
      >(readFileSync(path, "utf8"));
      const name = String(fm.name ?? basename(f, ".md"));
      const allowed = fm.allowed_subagents;
      out.set(name, {
        name,
        description: String(fm.description ?? ""),
        model: fm.model ? String(fm.model) : undefined,
        thinking: fm.thinking ? String(fm.thinking) : undefined,
        tools: asList(fm.tools),
        promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
        systemPrompt: body.trim() || undefined,
        allowedSubagents:
          allowed === "all" || allowed === undefined
            ? "all"
            : (asList(allowed) ?? []),
      });
    } catch (e) {
      log("profile_parse", { path, error: String(e) });
    }
  }
}

/** Builtins first, then global, workspace, project dirs. Same name later wins. */
export function loadProfiles(
  cwd: string,
  agentDir = getAgentDir(),
): Map<string, Profile> {
  const out = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
  loadDir(join(agentDir, "agents"), out);
  loadDir(join(cwd, ".agents", "agents"), out);
  loadDir(join(cwd, CONFIG_DIR_NAME, "agents"), out);
  return out;
}
