import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Herdr, HerdrError, LOG_ENV, log } from "../src/herdr.ts";
import type { Host } from "../src/host.ts";
import { balanceOps, childWorkspaceLabel, pickSplit } from "../src/layout.ts";
import { Manager, type SpawnOpts } from "../src/manager.ts";
import { BUILTIN_PROFILES, loadProfiles } from "../src/profiles.ts";
import { readReport } from "../src/session.ts";
import { DEFAULTS, loadSettings } from "../src/settings.ts";

/** Minimal host stub so background watchers can deliver without throwing. */
const piStub = (): Host => ({
  harness: "pi",
  deliver: () => {},
  setBlocked: () => {},
});

const tmp = () => mkdtempSync(join(tmpdir(), "phs-"));

/** Herdr stub with every method as a no-op; override per test. */
const emptyHerdr = (): Herdr => ({
  tabCreate: async () => "w1:p9",
  paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
  agentStart: async () => {},
  agentPrompt: async () => {},
  agentPromptWait: async () => ({ status: "done", pane: "w1:p8" }),
  agentWait: async () => ({ status: "done", pane: "w1:p8" }),
  agentWaitUntil: async () => ({ status: "working", pane: "w1:p8" }),
  agentGet: async () => ({ status: "idle", pane: "w1:p8" }),
  agentList: async () => [],
  agentRead: async () => "screen",
  agentFocus: async () => {},
  sendKeys: async () => {},
  paneRun: async () => {},
  paneReportAgent: async () => {},
  paneClose: async () => {},
});

describe("logging", () => {
  it("writes to the default or configured file", () => {
    const agentDir = tmp();
    const path = join(tmp(), "nested", "debug.log");
    const previousLog = process.env[LOG_ENV];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      process.env[LOG_ENV] = "1";
      log("default");
      expect(
        readFileSync(join(agentDir, "herdr-subagents-debug.log"), "utf8"),
      ).toBe("[herdr-subagents] stage=default \n");

      process.env[LOG_ENV] = path;
      log("test", { target: "/tmp/example", status: 200 });
      expect(readFileSync(path, "utf8")).toBe(
        '[herdr-subagents] stage=test target="/tmp/example" status=200\n',
      );
    } finally {
      if (previousLog === undefined) delete process.env[LOG_ENV];
      else process.env[LOG_ENV] = previousLog;
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

describe("session", () => {
  it("returns last assistant text and summed usage", () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    const msg = (text: string, cost: number) =>
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { input: 10, output: 5, cost: { total: cost } },
        },
      });
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        msg("first", 0.1),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "x" },
        }),
        "garbage",
        msg("final answer", 0.2),
      ].join("\n"),
    );
    const r = readReport("pi", f);
    expect(r.text).toBe("final answer");
    expect(r.usage).toEqual({
      input: 20,
      output: 10,
      cost: 0.30000000000000004,
      turns: 2,
    });
  });
});

describe("profiles", () => {
  it("loads project md over builtins", () => {
    const cwd = tmp();
    const agentDir = tmp();
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "reviewer.md"),
      `---\ndescription: reviews\nmodel: x/y\ntools: read, grep\nallowed_subagents: [Scout]\n---\nBe strict.`,
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "scout.md"),
      `---\nname: Scout\ndescription: mine\n---\n`,
    );
    const p = loadProfiles(cwd, agentDir);
    expect(p.get("reviewer")).toMatchObject({
      model: "x/y",
      tools: ["read", "grep"],
      allowedSubagents: ["Scout"],
      systemPrompt: "Be strict.",
      promptMode: "append",
    });
    expect(p.get("Scout")?.description).toBe("mine");
    expect(p.size).toBe(BUILTIN_PROFILES.length + 1);
  });
});

describe("settings", () => {
  it("merges global < project < defaults", () => {
    const cwd = tmp();
    const agentDir = tmp();
    writeFileSync(
      join(agentDir, "herdr-subagents.json"),
      JSON.stringify({ maxConcurrent: 2, splitCap: 5 }),
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "herdr-subagents.json"),
      JSON.stringify({ maxConcurrent: 7, claudeArgs: ["--verbose"] }),
    );
    expect(loadSettings(cwd, agentDir)).toEqual({
      ...DEFAULTS,
      maxConcurrent: 7,
      splitCap: 5,
      claudeArgs: ["--verbose"],
    });
  });
});

describe("profile prompt staging", () => {
  it("passes multi-line prompts as a temp file and cleans it up", async () => {
    let stagedPath: string | undefined;
    let stagedContent: string | undefined;
    let fileAfterStart: boolean | undefined;
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async (_id, _pane, _kind, args) => {
        const i = args.indexOf("--append-system-prompt");
        stagedPath = args[i + 1];
        stagedContent = readFileSync(stagedPath!, "utf8");
        fileAfterStart = existsSync(stagedPath!);
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await m.spawn({
      prompt: "go",
      description: "d",
      profile: {
        name: "t",
        description: "",
        promptMode: "append",
        allowedSubagents: [],
        systemPrompt: "first line\nsecond line",
      },
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    });
    expect(stagedPath).toBeDefined();
    expect(stagedContent).toBe("first line\nsecond line");
    expect(stagedPath!.includes("\n")).toBe(false);
    expect(fileAfterStart).toBe(true); // readable while pi boots
    expect(existsSync(stagedPath!)).toBe(false); // removed once interactive
  });

  it("keeps single-line prompts inline", async () => {
    let args: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async (_id, _pane, _kind, a) => {
        args = a;
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    await m.spawn({
      prompt: "go",
      description: "d",
      profile: {
        name: "t",
        description: "",
        promptMode: "append",
        allowedSubagents: [],
        systemPrompt: "single line",
      },
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    });
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toBe("single line");
  });
});

describe("prompt-wait stall recovery", () => {
  const sessionFile = (dir: string) => {
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, cost: { total: 0 } },
          },
        }),
      ].join("\n"),
    );
    return f;
  };

  const stallErr = () =>
    new HerdrError(
      "agent prompt produced no observed working or blocked state within 5000 ms; current status is idle",
      "agent_prompt_stalled",
    );

  it("collects the report when the child already finished", async () => {
    const dir = tmp();
    const sessionPath = sessionFile(dir);
    const closed: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "done",
        pane: "w1:p8",
        sessionPath,
      }),
      paneClose: async (p) => {
        closed.push(p);
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS, closeOnDone: true }, fake);
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.status).toBe("done");
    expect(r.text).toContain("final answer");
    expect(closed).toEqual(["w1:p8"]); // no stranded pane
  });

  it("does not finish a booting child with no assistant reply yet", async () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    // Session with only the user prompt: the turn has not produced output.
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "session" }),
        JSON.stringify({ type: "message", message: { role: "user" } }),
      ].join("\n"),
    );
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "idle",
        pane: "w1:p8",
        sessionPath: f,
      }),
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 300; // keep the test fast
    await expect(
      m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "pi",
        cwd: "/",
        background: false,
        timeoutMs: 0,
        depth: 1,
      }),
    ).rejects.toThrow("no observed working");
    expect(m.children.get([...m.children.keys()][0])?.status).toBe("killed");
  });

  it("finishes once the assistant reply lands while polling", async () => {
    const dir = tmp();
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ type: "message", message: { role: "user" } }),
    );
    let polls = 0;
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => {
        polls++;
        if (polls >= 3) {
          // Turn completes mid-poll: assistant message lands in the session.
          writeFileSync(
            f,
            JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "late answer" }],
              },
            }),
          );
        }
        return { status: "working", pane: "w1:p8", sessionPath: f };
      },
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 3000;
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      harness: "pi",
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.status).toBe("idle");
    expect(r.text).toContain("late answer");
  });

  it("fails when the stalled child is not in a terminal state", async () => {
    const fake: Herdr = {
      ...emptyHerdr(),
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {},
      agentPromptWait: async () => {
        throw stallErr();
      },
      agentGet: async () => ({
        status: "working",
        pane: "w1:p8",
        sessionPath: undefined,
      }),
    };
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    m.stallGraceMs = 300; // keep the test fast
    await expect(
      m.spawn({
        prompt: "go",
        description: "d",
        profile: BUILTIN_PROFILES[0],
        harness: "pi",
        cwd: "/",
        background: false,
        timeoutMs: 0,
        depth: 1,
      }),
    ).rejects.toThrow("no observed working");
    expect(m.children.get([...m.children.keys()][0])?.status).toBe("killed");
  });
});

describe("manager queue", () => {
  it("second background spawn waits for a slot, then starts", async () => {
    let starts = 0;
    let waiters: Array<(v: any) => void> = [];
    const fake: Herdr = {
      tabCreate: async () => "w1:p9",
      paneSplit: async () => "w1:p8",
  paneLayout: async () => ({ panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }], splits: [] }),
  paneResize: async () => {},
  workspaceLabel: async () => "ws",
  workspaceByLabel: async () => "w9",
      agentStart: async () => {
        starts++;
      },
      agentPrompt: async () => {},
      agentPromptWait: () => new Promise((r) => waiters.push(r)),
      agentWait: () => new Promise((r) => waiters.push(r)),
      agentWaitUntil: async () => ({ status: "working", pane: "w1:p9" }),
      agentGet: async () => ({
        status: "idle",
        pane: "w1:p9",
        sessionPath: undefined,
      }),
      agentList: async () => [],
      agentRead: async () => "screen",
      agentFocus: async () => {},
      sendKeys: async () => {},
      paneRun: async () => {},
      paneReportAgent: async () => {},
      paneClose: async () => {},
    };
    const sent: string[] = [];
    const host: Host = {
      ...piStub(),
      deliver: (t: string) => {
        sent.push(t);
      },
    };
    const m = new Manager(host, { ...DEFAULTS, maxConcurrent: 1 }, fake);
    const base: SpawnOpts = {
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      model: "test/model",
      harness: "pi",
      cwd: "/",
      background: true,
      timeoutMs: 0,
      depth: 1,
    };
    const a = await m.spawn(base);
    expect(a.status).toBe("running");
    expect(a.text).toContain("model test/model");
    const b = await m.spawn(base);
    expect(b.status).toBe("queued");
    expect(b.text).toContain("model test/model");
    expect(starts).toBe(1);
    waiters.shift()!({ status: "idle", pane: "w1:p9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(2);
    expect(m.children.get(a.id)?.status).toBe("idle");
    expect(sent[0]).toContain(`[subagent ${a.id}`);
    expect(sent[0]).toContain("test/model");
    expect(sent[0]).toContain("screen");
    expect(await m.result(a.id, false, 0)).toContain("test/model");
  });
});

describe("layout", () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  // parent 93x44 | child a 93x22 over child b 93x22 (root split right 0.5, right column split down 0.5)
  const grid = {
    panes: [
      { pane_id: "w1:p1", rect: rect(0, 0, 93, 44) },
      { pane_id: "w1:p2", rect: rect(93, 0, 93, 22) },
      { pane_id: "w1:p3", rect: rect(93, 22, 93, 22) },
    ],
    splits: [
      { direction: "right" as const, ratio: 0.5, rect: rect(0, 0, 186, 44) },
      { direction: "down" as const, ratio: 0.5, rect: rect(93, 0, 93, 44) },
    ],
  };

  it("splits the biggest pane along its longer axis, ties go to a child", () => {
    expect(pickSplit({ panes: [{ pane_id: "w1:p1", rect: rect(0, 0, 186, 44) }], splits: [] }, "w1:p1")).toEqual({ pane: "w1:p1", direction: "right" });
    const two = {
      panes: [
        { pane_id: "w1:p1", rect: rect(0, 0, 93, 44) },
        { pane_id: "w1:p2", rect: rect(93, 0, 93, 44) },
      ],
      splits: [],
    };
    expect(pickSplit(two, "w1:p1")).toEqual({ pane: "w1:p2", direction: "down" });
    expect(pickSplit(grid, "w1:p1")).toEqual({ pane: "w1:p1", direction: "down" });
  });

  it("resizes each split to leaves-first over leaves-total", () => {
    // root: 1 leaf left, 2 right, want 1/3: move the parent's right edge left by 0.1667
    expect(balanceOps(grid)).toEqual([{ pane: "w1:p1", direction: "left", amount: 0.1667 }]);
    const balanced = { ...grid, splits: [{ ...grid.splits[0], ratio: 1 / 3 }, grid.splits[1]] };
    expect(balanceOps(balanced)).toEqual([]);
    const tall = { ...grid, splits: [grid.splits[0], { ...grid.splits[1], ratio: 0.3 }] };
    expect(balanceOps(tall)[1]).toEqual({ pane: "w1:p2", direction: "down", amount: 0.2 });
  });

  it("derives an idempotent child workspace label", () => {
    expect(childWorkspaceLabel("proj")).toBe("proj-agents");
    expect(childWorkspaceLabel("proj-agents")).toBe("proj-agents");
  });
});

describe("placement and idle children", () => {
  const base: SpawnOpts = {
    prompt: "go",
    description: "d",
    profile: BUILTIN_PROFILES[0],
    harness: "pi",
    cwd: "/",
    background: false,
    timeoutMs: 0,
    depth: 1,
  };
  const full = () => ({
    panes: [1, 2, 3, 4].map((n) => ({ pane_id: `w1:p${n}`, rect: { x: 0, y: 0, width: 10, height: 10 } })),
    splits: [],
  });

  it("splits under the cap, tabs in the child workspace past it, honours forced placement", async () => {
    const calls: string[] = [];
    let panes = 1;
    const fake: Herdr = {
      ...emptyHerdr(),
      paneLayout: async () => ({ ...full(), panes: full().panes.slice(0, panes) }),
      paneSplit: async (pane, dir) => {
        calls.push(`split ${pane} ${dir}`);
        return `w1:p${++panes}`;
      },
      paneResize: async (op) => {
        calls.push(`resize ${op.pane} ${op.direction} ${op.amount}`);
      },
      tabCreate: async (_l, _c, _e, ws) => {
        calls.push(`tab ${ws}`);
        return "w9:p1";
      },
    };
    const prev = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p1";
    const m = new Manager(piStub(), { ...DEFAULTS, splitCap: 1 }, fake);
    if (prev === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = prev;
    const a = await m.spawn(base);
    expect(m.children.get(a.id)?.placement).toBe("split");
    const b = await m.spawn(base);
    expect(m.children.get(b.id)?.placement).toBe("tab");
    const c = await m.spawn({ ...base, placement: "split" });
    expect(m.children.get(c.id)?.placement).toBe("split");
    await m.spawn({ ...base, placement: "tab" });
    expect(calls).toEqual(["split w1:p1 down", "tab w9", "split w1:p2 down", "tab w9"]);
  });

  it("keeps the pane after a turn, SendMessage resumes it and delivers the report", async () => {
    const closed: string[] = [];
    const prompts: string[] = [];
    const sent: string[] = [];
    const fake: Herdr = {
      ...emptyHerdr(),
      paneClose: async (p) => {
        closed.push(p);
      },
      agentPromptWait: async (_id, text) => {
        prompts.push(text);
        return { status: "idle", pane: "w1:p8" };
      },
    };
    const m = new Manager({ ...piStub(), deliver: (t) => sent.push(t) }, DEFAULTS, fake);
    const a = await m.spawn(base);
    expect(a.status).toBe("idle");
    expect(a.text).toContain("is idle");
    expect(closed).toEqual([]);
    await m.send(a.id, "more", "message");
    expect(m.children.get(a.id)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toEqual(["go", "more"]);
    expect(m.children.get(a.id)?.status).toBe("idle");
    expect(sent).toHaveLength(1);
    await m.kill(a.id);
    expect(closed).toEqual(["w1:p8"]);
  });
});
