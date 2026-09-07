import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { log } from "./herdr.js";

export interface Settings {
	closeOnDone: boolean;
	maxConcurrent: number;
	defaultTimeoutMs: number;
	notify: "followUp" | "passive";
	maxDepth: number;
	defaultModel: string | null;
	splitRatio: number;
}

export const DEFAULTS: Settings = {
	closeOnDone: true,
	maxConcurrent: 4,
	defaultTimeoutMs: 0,
	notify: "followUp",
	maxDepth: 2,
	defaultModel: null,
	splitRatio: 0.5,
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
	return { ...DEFAULTS, ...readJson(join(agentDir, FILE)), ...readJson(join(cwd, CONFIG_DIR_NAME, FILE)) };
}
