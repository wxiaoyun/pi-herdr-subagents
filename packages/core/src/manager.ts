/**
 * manager.ts: child registry, concurrency queue, spawn / wait / report / kill.
 * All herdr access goes through the injected `Herdr` helper set.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childArgs } from "./args.ts";
import {
  type AgentInfo,
  h as defaultHerdr,
  type Herdr,
  HerdrError,
  log,
} from "./herdr.ts";
import type { Harness, Host } from "./host.ts";
import { balanceOps, childWorkspaceLabel, pickSplit } from "./layout.ts";
import type { Profile } from "./profiles.ts";
import {
  formatUsage,
  lastSpeaker,
  type Report,
  readReport,
  sessionPathFor,
} from "./session.ts";
import type { Settings } from "./settings.ts";

export type ChildStatus =
  | "queued"
  | "starting"
  | "running"
  | "blocked"
  | "idle"
  | "done"
  | "timeout"
  | "killed";

export type Placement = "auto" | "split" | "tab";

export interface Child {
  id: string;
  profile: string;
  harness: Harness;
  model?: string;
  description: string;
  pane?: string;
  placement?: "split" | "tab";
  background: boolean;
  status: ChildStatus;
  sessionPath?: string;
  sessionId?: string;
  report?: Report;
  startedAt: number;
  released: boolean;
  watcher?: AbortController;
}

export interface SpawnOpts {
  prompt: string;
  description: string;
  profile: Profile;
  harness: Harness;
  model?: string;
  thinking?: string;
  cwd: string;
  background: boolean;
  /** Where the pane goes. auto: split until splitCap, then tab. */
  placement?: Placement;
  name?: string;
  timeoutMs: number;
  depth: number;
  /** Existing child id to continue instead of starting fresh. */
  resume?: string;
}

export interface SpawnResult {
  id: string;
  status: ChildStatus | "detached";
  text: string;
}

export const ENV_PARENT = "HERDR_SUBAGENT_PARENT";
export const ENV_DEPTH = "HERDR_SUBAGENT_DEPTH";
export const ENV_ID = "HERDR_SUBAGENT_ID";
export const ENV_PROFILE = "HERDR_SUBAGENT_PROFILE";
export const ENV_HARNESS = "HERDR_SUBAGENT_HARNESS";

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";

export class Manager {
  readonly children = new Map<string, Child>();
  private counter = 0;
  private live = 0;
  private pending: Array<() => void> = [];

  private host: Host;
  private settings: Settings;
  private h: Herdr;

  constructor(host: Host, settings: Settings, h: Herdr = defaultHerdr) {
    this.host = host;
    this.settings = settings;
    this.h = h;
  }

  list(): Child[] {
    return [...this.children.values()];
  }

  // ---- concurrency queue ----------------------------------------------------

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.live < this.settings.maxConcurrent) {
      this.live++;
      return Promise.resolve();
    }
    log("queue_wait", { live: this.live, pending: this.pending.length });
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.pending = this.pending.filter((p) => p !== grant);
        reject(new Error("aborted while queued"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(grant);
    });
  }

  private release(child: Child): void {
    if (child.released) return;
    child.released = true;
    const next = this.pending.shift();
    if (next) next();
    else this.live--;
  }

  // ---- spawn ----------------------------------------------------------------

  private async newId(base: string): Promise<string> {
    const live = new Set(
      (await this.h.agentList().catch(() => [])).map((a) => a.name),
    );
    let id: string;
    do {
      this.counter++;
      id = `sa-${slug(base)}-${this.counter}`.slice(0, 32);
    } while (this.children.has(id) || live.has(id));
    return id;
  }

  private model(o: SpawnOpts): string | undefined {
    return o.model ?? o.profile.model ?? this.settings.defaultModel ?? undefined;
  }

  private async launch(
    child: Child,
    o: SpawnOpts,
    session?: string,
  ): Promise<void> {
    child.status = "starting";
    child.model = this.model(o);
    const env = {
      [ENV_PARENT]: process.env.HERDR_PANE_ID ?? "",
      [ENV_DEPTH]: String(o.depth),
      [ENV_ID]: child.id,
      [ENV_PROFILE]: o.profile.name,
      [ENV_HARNESS]: o.harness,
    };
    [child.pane, child.placement] = await this.place(child, o, env);
    // herdr cannot pass args containing newlines; stage multi-line profile
    // prompts in a temp file (pi reads the path at startup) and clean up after
    // the child is interactive.
    const staged = mkdtempSync(join(tmpdir(), "pi-herdr-subagents-"));
    try {
      await this.h.agentStart(
        child.id,
        child.pane,
        o.harness,
        childArgs(
          o.harness,
          {
            id: child.id,
            profile: o.profile,
            model: this.model(o),
            thinking: o.thinking ?? o.profile.thinking,
            session,
            stagedDir: staged,
          },
          this.settings,
        ),
      );
    } catch (e) {
      log("agent_start_failed", { id: child.id, error: String(e) });
      await this.closePane(child);
      throw e;
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
    const info = await this.h.agentGet(child.id).catch(() => undefined);
    child.sessionId = info?.sessionId;
    child.sessionPath =
      info?.sessionPath ?? sessionPathFor(o.harness, o.cwd, info?.sessionId);
    child.status = "running";
    log("launched", {
      id: child.id,
      pane: child.pane,
      session: child.sessionPath,
    });
  }

  // ---- placement ------------------------------------------------------------

  private parentPane = process.env.HERDR_PANE_ID ?? "";

  private async place(
    child: Child,
    o: SpawnOpts,
    env: Record<string, string>,
  ): Promise<[string, "split" | "tab"]> {
    const placement = o.placement ?? "auto";
    let layout = placement === "tab" ? undefined : await this.h.paneLayout(this.parentPane);
    if (layout && placement === "auto" && layout.panes.length - 1 >= this.settings.splitCap) {
      log("split_cap", { cap: this.settings.splitCap, panes: layout.panes.length });
      layout = undefined;
    }
    if (!layout) {
      const ws = await this.childWorkspace(o.cwd);
      return [await this.h.tabCreate(child.id, o.cwd, env, ws), "tab"];
    }
    const target = pickSplit(layout, this.parentPane);
    const pane = await this.h.paneSplit(target.pane, target.direction, o.cwd, env);
    await this.rebalance();
    return [pane, "split"];
  }

  private childWs?: string;

  /**
   * herdr relabels an unlabelled workspace after the focused pane's cwd, so
   * the derived label can drift mid-session. Resolve once per parent process.
   */
  private async childWorkspace(cwd: string): Promise<string | undefined> {
    const mine = process.env.HERDR_WORKSPACE_ID;
    if (!mine) return undefined;
    if (!this.childWs) {
      const label = childWorkspaceLabel(await this.h.workspaceLabel(mine));
      this.childWs = await this.h.workspaceByLabel(label, cwd);
      log("child_workspace", { label, id: this.childWs });
    }
    return this.childWs;
  }

  /** Equal share for every pane in the parent's tab. Best effort. */
  private async rebalance(): Promise<void> {
    try {
      for (const op of balanceOps(await this.h.paneLayout(this.parentPane)))
        await this.h.paneResize(op);
    } catch (e) {
      log("rebalance", { error: String(e) });
    }
  }

  private async closePane(child: Child): Promise<void> {
    if (!child.pane) return;
    await this.h
      .paneClose(child.pane)
      .catch((e) => log("pane_close", { id: child.id, error: String(e) }));
    if (child.placement === "split") await this.rebalance();
  }

  async spawn(o: SpawnOpts, signal?: AbortSignal): Promise<SpawnResult> {
    if (o.depth > this.settings.maxDepth) {
      throw new Error(`max nesting depth ${this.settings.maxDepth} reached`);
    }
    if (o.resume) return this.resume(o, signal);

    const child: Child = {
      id: await this.newId(o.name ?? o.profile.name),
      profile: o.profile.name,
      harness: o.harness,
      model: this.model(o),
      description: o.description,
      background: o.background,
      status: "queued",
      startedAt: Date.now(),
      released: false,
    };
    this.children.set(child.id, child);

    const run = async () => {
      await this.launch(child, o);
      this.watchPrompt(child, o.prompt, o.timeoutMs);
    };

    if (o.background) {
      if (this.live >= this.settings.maxConcurrent) {
        void this.acquire()
          .then(run)
          .catch((e) => this.fail(child, e));
        return {
          id: child.id,
          status: "queued",
          text: `${child.id} queued with model ${child.model ?? "default"} (${this.live}/${this.settings.maxConcurrent} slots busy)`,
        };
      }
      await this.acquire();
      await this.launch(child, o).catch((e) => {
        this.fail(child, e);
        throw e;
      });
      this.watchPrompt(child, o.prompt, o.timeoutMs);
      return {
        id: child.id,
        status: "running",
        text: `${child.id} started with model ${child.model ?? "default"} in pane ${child.pane}`,
      };
    }

    await this.acquire(signal);
    await this.launch(child, o).catch((e) => {
      this.fail(child, e);
      throw e;
    });
    return this.foreground(child, o.prompt, o.timeoutMs, signal);
  }

  private async resume(
    o: SpawnOpts,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const child = this.children.get(o.resume!);
    if (!child) throw new Error(`unknown subagent ${o.resume}`);
    child.background = o.background;
    const alive = await this.h.agentGet(child.id).then(
      () => true,
      () => false,
    );
    if (!alive) {
      const session =
        child.harness === "claude" ? child.sessionId : child.sessionPath;
      if (!session)
        throw new Error(`${child.id} is gone and has no session to resume`);
      await this.acquire(signal);
      child.released = false;
      await this.launch(child, o, session).catch((e) => {
        this.fail(child, e);
        throw e;
      });
    } else if (child.released) {
      await this.acquire(signal);
      child.released = false;
    }
    child.status = "running";
    if (o.background) {
      this.watchPrompt(child, o.prompt, o.timeoutMs);
      return {
        id: child.id,
        status: "running",
        text: `${child.id} resumed with model ${child.model ?? "default"}`,
      };
    }
    return this.foreground(child, o.prompt, o.timeoutMs, signal);
  }

  // ---- foreground / background waiting --------------------------------------

  private async foreground(
    child: Child,
    prompt: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    try {
      const info = prompt
        ? await this.h.agentPromptWait(child.id, prompt, timeoutMs, signal)
        : await this.h.agentWait(child.id, timeoutMs, signal);
      await this.finish(child, info);
    } catch (e) {
      if (signal?.aborted) {
        log("foreground_detach", { id: child.id });
        child.background = true;
        this.watch(child, timeoutMs);
        return {
          id: child.id,
          status: "detached",
          text: `${child.id} detached with model ${child.model ?? "default"}, keeps running in pane ${child.pane}`,
        };
      }
      if (e instanceof HerdrError && e.code === "timeout") {
        await this.timeout(child);
      } else if (await this.stalledToFinish(child, e)) {
        // herdr gave up observing a transition, but the child already finished.
      } else {
        this.fail(child, e);
        throw e;
      }
    }
    return {
      id: child.id,
      status: child.status,
      text: this.formatReport(child),
    };
  }

  /**
   * herdr `agent prompt --wait` errors with `agent_prompt_stalled` when the
   * whole turn completes before it observes a working/blocked state. `idle`
   * alone is ambiguous (booting vs finished), so poll the session file: a turn
   * is done only once an assistant message follows the last user message.
   */
  stallGraceMs = 30_000;

  private async stalledToFinish(child: Child, e: unknown): Promise<boolean> {
    if (!(e instanceof HerdrError) || e.code !== "agent_prompt_stalled") {
      return false;
    }
    const deadline = Date.now() + this.stallGraceMs;
    while (Date.now() < deadline) {
      const info = await this.h.agentGet(child.id).catch(() => undefined);
      if (!info) return false;
      const path = info.sessionPath ?? child.sessionPath;
      if (path && lastSpeaker(child.harness, path) === "assistant") {
        log("prompt_wait_stalled", { id: child.id, status: info.status });
        await this.finish(child, info);
        return true;
      }
      if (info.status === "blocked" || info.status === "failed") return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    log("prompt_wait_stall_timeout", { id: child.id, status: child.status });
    return false;
  }

  private watchPrompt(child: Child, prompt: string, timeoutMs: number): void {
    this.spawnWatcher(
      child,
      (signal) => this.h.agentPromptWait(child.id, prompt, timeoutMs, signal),
      timeoutMs,
    );
  }

  private watch(child: Child, timeoutMs: number): void {
    this.spawnWatcher(
      child,
      (signal) => this.h.agentWait(child.id, timeoutMs, signal),
      timeoutMs,
    );
  }

  private spawnWatcher(
    child: Child,
    op: (signal: AbortSignal) => Promise<AgentInfo>,
    timeoutMs: number,
  ): void {
    child.watcher?.abort();
    const ac = new AbortController();
    child.watcher = ac;
    void op(ac.signal)
      .then((info) => this.finish(child, info))
      .catch(async (e) => {
        if (ac.signal.aborted) return;
        if (e instanceof HerdrError && e.code === "timeout")
          await this.timeout(child);
        else if (await this.stalledToFinish(child, e)) return;
        else this.fail(child, e);
      })
      .then(() => {
        if (!ac.signal.aborted) this.deliver(child);
      });
  }

  // ---- completion -----------------------------------------------------------

  private async finish(child: Child, info: AgentInfo): Promise<void> {
    child.sessionPath = info.sessionPath ?? child.sessionPath;
    if (info.status === "blocked") {
      child.status = "blocked";
      child.report = child.sessionPath
        ? readReport(child.harness, child.sessionPath)
        : undefined;
      log("child_blocked", { id: child.id });
      return;
    }
    child.report = await this.collect(child);
    child.status = this.settings.closeOnDone ? "done" : "idle";
    log("child_done", { id: child.id, usage: formatUsage(child.report.usage) });
    this.release(child);
    if (this.settings.closeOnDone) await this.closePane(child);
  }

  private async timeout(child: Child): Promise<void> {
    child.status = "timeout";
    child.report = await this.collect(child);
    log("child_timeout", { id: child.id });
  }

  private fail(child: Child, e: unknown): void {
    log("child_failed", { id: child.id, error: String(e) });
    child.status = "killed";
    child.report = {
      text: `failed: ${String(e)}`,
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
    this.release(child);
  }

  private async collect(child: Child): Promise<Report> {
    if (child.sessionPath) {
      const r = readReport(child.harness, child.sessionPath);
      if (r.text) return r;
    }
    const screen = await this.h.agentRead(child.id, 120).catch(() => "");
    return {
      text: screen.trim(),
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    };
  }

  formatReport(child: Child): string {
    const r = child.report;
    const head = `[subagent ${child.id} | ${child.profile} | ${child.model ?? "default model"} | ${child.status}${r ? ` | ${formatUsage(r.usage)}` : ""}]`;
    const body = r?.text || "(no output)";
    const tail =
      child.status === "blocked"
        ? `\n(${child.id} is waiting for a reply via SendMessage)`
        : child.status === "idle"
          ? `\n(${child.id} is idle: SendMessage to it or Agent resume to continue, KillAgent to close)`
          : "";
    return `${head}\n${body}${tail}`;
  }

  private deliver(child: Child): void {
    this.host.deliver(this.formatReport(child), this.settings.notify);
  }

  // ---- inspect / message / kill ---------------------------------------------

  async result(
    id: string,
    wait: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const child = this.children.get(id);
    if (!child) throw new Error(`unknown subagent ${id}`);
    if (
      wait &&
      (child.status === "running" ||
        child.status === "blocked" ||
        child.status === "timeout")
    ) {
      child.watcher?.abort();
      child.watcher = undefined;
      return (await this.foreground(child, undefined, timeoutMs, signal)).text;
    }
    if (["idle", "done", "killed"].includes(child.status))
      return this.formatReport(child);
    const recent = await this.h.agentRead(id, 40).catch(() => "");
    return `[subagent ${id} | ${child.profile} | ${child.model ?? "default model"} | ${child.status} | pane ${child.pane}]\n${recent.trim()}`;
  }

  async send(
    to: string,
    message: string,
    kind: "message" | "interrupt" | "keys",
  ): Promise<void> {
    if (kind === "keys") {
      await this.h.sendKeys(to, message.split(/\s+/).filter(Boolean));
      return;
    }
    if (kind === "interrupt") {
      await this.h.sendKeys(to, ["esc"]);
      await new Promise((r) => setTimeout(r, 300));
    }
    const idle = this.children.get(to);
    if (idle?.status === "idle") {
      // Resume: a new background turn, the report is delivered when it ends.
      idle.status = "running";
      idle.background = true;
      idle.released = false;
      await this.acquire();
      this.watchPrompt(idle, message, this.settings.defaultTimeoutMs);
      return;
    }
    try {
      await this.h.agentPrompt(to, message);
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === "agent_blocked")) throw e;
      const pane =
        this.children.get(to)?.pane ?? (await this.h.agentGet(to)).pane;
      log("send_via_pane", { to, pane });
      await this.h.paneRun(pane, message);
    }
    const child = this.children.get(to);
    if (child && child.status === "blocked") {
      await this.h
        .agentWaitUntil(to, ["working", "idle", "done"], 15000)
        .catch((e) => log("unblock_wait", { to, error: String(e) }));
      child.status = "running";
      if (child.background) this.watch(child, this.settings.defaultTimeoutMs);
    }
  }

  async kill(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) throw new Error(`unknown subagent ${id}`);
    child.watcher?.abort();
    await this.closePane(child);
    child.status = "killed";
    this.release(child);
  }

  async focus(id: string): Promise<void> {
    await this.h.agentFocus(id);
  }
}
