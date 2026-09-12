/**
 * paths.ts: pi's config locations, reimplemented so the core never imports
 * pi's runtime (the Claude parent harness runs without it).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env.replace(/^~(?=$|\/)/, homedir());
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): { frontmatter: T; body: string } {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return { frontmatter: {} as T, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {} as T, body: text };
  const fm = (parse(text.slice(3, end)) ?? {}) as T;
  const body = text.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: fm, body };
}
