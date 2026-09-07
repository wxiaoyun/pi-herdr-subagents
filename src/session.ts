import { readFileSync } from "node:fs";
import { log } from "./herdr.js";

export interface Report {
  text: string;
  usage: { input: number; output: number; cost: number; turns: number };
}

/** Last assistant message text plus summed usage from a pi session jsonl. */
export function readReport(sessionPath: string): Report {
  const usage = { input: 0, output: 0, cost: 0, turns: 0 };
  let text = "";
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch (e) {
    log("read_session", { sessionPath, error: String(e) });
    return { text, usage };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry?.message;
    if (entry?.type !== "message" || m?.role !== "assistant") continue;
    usage.turns++;
    usage.input += m.usage?.input ?? 0;
    usage.output += m.usage?.output ?? 0;
    usage.cost += m.usage?.cost?.total ?? 0;
    const t = (Array.isArray(m.content) ? m.content : [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    if (t.trim()) text = t;
  }
  return { text, usage };
}

export const formatUsage = (u: Report["usage"]): string =>
  `turns=${u.turns} in=${u.input} out=${u.output} cost=$${u.cost.toFixed(4)}`;
