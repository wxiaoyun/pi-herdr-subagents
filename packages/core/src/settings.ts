import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./herdr.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "./paths.ts";

export interface Settings {
  closeOnDone: boolean;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  notify: "followUp" | "passive";
  maxDepth: number;
  defaultModel: string | null;
  /** Child panes allowed beside the parent before new ones go to a tab. */
  splitCap: number;
  /** Extra CLI args appended to every child pi. */
  piArgs: string[];
  /** Extra CLI args appended to every child Claude Code. */
  claudeArgs: string[];
}

export const DEFAULTS: Settings = {
  closeOnDone: false,
  maxConcurrent: 4,
  defaultTimeoutMs: 0,
  notify: "followUp",
  maxDepth: 2,
  defaultModel: null,
  splitCap: 3,
  piArgs: [],
  claudeArgs: [],
};

const FILE = "herdr-subagents.json";

function readJson(path: string): Partial<Settings> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    log("settings_parse", { path, error: String(e) });
    return {};
  }
}

/** Global file then project file, later wins. Missing keys fall back to DEFAULTS. */
export function loadSettings(cwd: string, agentDir = getAgentDir()): Settings {
  return {
    ...DEFAULTS,
    ...readJson(join(agentDir, FILE)),
    ...readJson(join(cwd, CONFIG_DIR_NAME, FILE)),
  };
}
