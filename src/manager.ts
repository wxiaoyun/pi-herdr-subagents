/**
 * manager.ts: child registry, concurrency queue, spawn / wait / report / kill.
 * All herdr access goes through the injected `Herdr` helper set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AgentInfo,
  h as defaultHerdr,
  type Herdr,
  HerdrError,
  log,
} from "./herdr.js";
import type { Profile } from "./profiles.js";
import { formatUsage, type Report, readReport } from "./session.js";
import type { Settings } from "./settings.js";

export type ChildStatus =
  "queued" | "starting" | "running" | "blocked" | "done" | "timeout" | "killed";

export interface Child {
  id: string;
  profile: string;
  model?: string;
  description: string;
  pane?: string;
  background: boolean;
  status: ChildStatus;
  sessionPath?: string;
  report?: Report;
  startedAt: number;
  released: boolean;
  watcher?: AbortController;
}

export interface SpawnOpts {
  prompt: string;
  description: string;
  profile: Profile;
  model?: string;
  thinking?: string;
  cwd: string;
  background: boolean;
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

export const ENV_PARENT = "PI_HERDR_SUBAGENT_PARENT";
export const ENV_DEPTH = "PI_HERDR_SUBAGENT_DEPTH";
export const ENV_ID = "PI_HERDR_SUBAGENT_ID";
export const ENV_PROFILE = "PI_HERDR_SUBAGENT_PROFILE";

const SPAWN_TOOLS = ["Agent", "get_subagent_result", "kill_subagent"];

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

  constructor(
    private pi: ExtensionAPI,
    private settings: Settings,
    private h: Herdr = defaultHerdr,
  ) {}

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

  private piArgs(o: SpawnOpts, id: string, session?: string): string[] {
    const p = o.profile;
    const args = ["--name", id];
    const model = this.model(o);
    const thinking = o.thinking ?? p.thinking;
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    if (p.systemPrompt)
      args.push(
        p.promptMode === "replace"
          ? "--system-prompt"
          : "--append-system-prompt",
        p.systemPrompt,
      );
    if (p.tools?.length) {
      const spawnTools =
        p.allowedSubagents === "all" || p.allowedSubagents.length
          ? SPAWN_TOOLS
          : [];
      args.push(
        "--tools",
        [...p.tools, "send_message", ...spawnTools].join(","),
      );
    }
    if (session) args.push("--session", session);
    return [...args, ...this.settings.piArgs];
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
    };
    child.pane = o.background
      ? await this.h.tabCreate(child.id, o.cwd, env)
      : await this.h.splitCurrent(this.settings.splitRatio, o.cwd, env);
    try {
      await this.h.agentStart(
        child.id,
        child.pane,
        this.piArgs(o, child.id, session),
      );
    } catch (e) {
      log("agent_start_failed", { id: child.id, error: String(e) });
      await this.h.paneClose(child.pane).catch(() => {});
      throw e;
    }
    const info = await this.h.agentGet(child.id).catch(() => undefined);
    child.sessionPath = info?.sessionPath;
    child.status = "running";
    log("launched", {
      id: child.id,
      pane: child.pane,
      session: child.sessionPath,
    });
  }

  async spawn(o: SpawnOpts, signal?: AbortSignal): Promise<SpawnResult> {
    if (o.depth > this.settings.maxDepth) {
      throw new Error(`max nesting depth ${this.settings.maxDepth} reached`);
    }
    if (o.resume) return this.resume(o, signal);

    const child: Child = {
      id: await this.newId(o.name ?? o.profile.name),
      profile: o.profile.name,
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
      if (!child.sessionPath)
        throw new Error(`${child.id} is gone and has no session to resume`);
      await this.acquire(signal);
      child.released = false;
      await this.launch(child, o, child.sessionPath).catch((e) => {
        this.fail(child, e);
        throw e;
      });
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
        ? readReport(child.sessionPath)
        : undefined;
      log("child_blocked", { id: child.id });
      return;
    }
    child.report = await this.collect(child);
    child.status = "done";
    log("child_done", { id: child.id, usage: formatUsage(child.report.usage) });
    this.release(child);
    if (this.settings.closeOnDone && child.pane) {
      await this.h
        .paneClose(child.pane)
        .catch((e) => log("pane_close", { id: child.id, error: String(e) }));
    }
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
      const r = readReport(child.sessionPath);
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
        ? `\n(${child.id} is waiting for a reply via send_message)`
        : "";
    return `${head}\n${body}${tail}`;
  }

  private deliver(child: Child): void {
    const text = this.formatReport(child);
    if (this.settings.notify === "followUp") {
      this.pi.sendUserMessage(text, { deliverAs: "followUp" });
    } else {
      this.pi.sendMessage(
        { customType: "herdr-subagent", content: text, display: true },
        { deliverAs: "nextTurn" },
      );
    }
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
    if (child.status === "done" || child.status === "killed")
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
    if (child.pane)
      await this.h
        .paneClose(child.pane)
        .catch((e) => log("kill_close", { id, error: String(e) }));
    child.status = "killed";
    this.release(child);
  }

  async focus(id: string): Promise<void> {
    await this.h.agentFocus(id);
  }
}
