import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./herdr.ts";
import type { Harness } from "./host.ts";

export interface Report {
  text: string;
  usage: { input: number; output: number; cost: number; turns: number };
}

const EMPTY = (): Report => ({
  text: "",
  usage: { input: 0, output: 0, cost: 0, turns: 0 },
});

function entries(sessionPath: string): any[] {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch (e) {
    log("read_session", { sessionPath, error: String(e) });
    return [];
  }
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip partial or garbage lines
    }
  }
  return out;
}

const textOf = (m: any): string =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

/** pi: `{type:"message", message:{role, content, usage:{input,output,cost:{total}}}}` */
function readPi(sessionPath: string): Report {
  const r = EMPTY();
  for (const e of entries(sessionPath)) {
    const m = e?.message;
    if (e?.type !== "message" || m?.role !== "assistant") continue;
    r.usage.turns++;
    r.usage.input += m.usage?.input ?? 0;
    r.usage.output += m.usage?.output ?? 0;
    r.usage.cost += m.usage?.cost?.total ?? 0;
    const t = textOf(m);
    if (t.trim()) r.text = t;
  }
  return r;
}

/**
 * Claude Code: `{type:"assistant", message:{id, role, content, usage:{input_tokens,output_tokens}}}`.
 * One API response is split over several entries sharing `message.id`, so
 * usage is counted once per id. The format is internal to Claude Code; on
 * any surprise this yields no text and the caller falls back to the screen.
 */
function readClaude(sessionPath: string): Report {
  const r = EMPTY();
  const seen = new Set<string>();
  for (const e of entries(sessionPath)) {
    const m = e?.message;
    if (e?.type !== "assistant" || m?.role !== "assistant") continue;
    const id = String(m.id ?? r.usage.turns);
    if (!seen.has(id)) {
      seen.add(id);
      r.usage.turns++;
      r.usage.input += m.usage?.input_tokens ?? 0;
      r.usage.output += m.usage?.output_tokens ?? 0;
    }
    const t = textOf(m);
    if (t.trim()) r.text = t;
  }
  return r;
}

/** Last assistant message text plus summed usage from a child session file. */
export function readReport(harness: Harness, sessionPath: string): Report {
  return harness === "claude" ? readClaude(sessionPath) : readPi(sessionPath);
}

/**
 * Role of the last message entry, or undefined when the file has no messages
 * yet (missing file, boot in progress, garbage only). A Claude assistant entry
 * that stopped for a tool call is still mid-turn and counts as the user's.
 */
export function lastSpeaker(
  harness: Harness,
  sessionPath: string,
): string | undefined {
  let last: string | undefined;
  for (const e of entries(sessionPath)) {
    const isMsg =
      harness === "claude"
        ? e?.type === "user" || e?.type === "assistant"
        : e?.type === "message";
    if (!isMsg || !e.message?.role) continue;
    last =
      harness === "claude" && e.message.stop_reason === "tool_use"
        ? "user"
        : e.message.role;
  }
  return last;
}

/**
 * Claude Code keeps sessions at `<config dir>/projects/<encoded cwd>/<id>.jsonl`
 * and herdr only reports the id. pi reports the path itself.
 */
export function sessionPathFor(
  harness: Harness,
  cwd: string,
  sessionId: string | undefined,
): string | undefined {
  if (harness !== "claude" || !sessionId) return undefined;
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

export const formatUsage = (u: Report["usage"]): string =>
  `turns=${u.turns} in=${u.input} out=${u.output} cost=$${u.cost.toFixed(4)}`;
