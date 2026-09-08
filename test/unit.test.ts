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
import { type Herdr, HerdrError, LOG_ENV, log } from "../src/herdr.js";
import { Manager } from "../src/manager.js";
import { BUILTIN_PROFILES, loadProfiles } from "../src/profiles.js";
import { readReport } from "../src/session.js";
import { DEFAULTS, loadSettings } from "../src/settings.js";

/** Minimal pi stub so background watchers can deliver without throwing. */
const piStub = (): any => ({ sendUserMessage: () => {}, sendMessage: () => {} });

const tmp = () => mkdtempSync(join(tmpdir(), "phs-"));

/** Herdr stub with every method as a no-op; override per test. */
const emptyHerdr = (): Herdr => ({
  tabCreate: async () => "w1:p9",
  splitCurrent: async () => "w1:p8",
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
    const r = readReport(f);
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
      JSON.stringify({ maxConcurrent: 2, splitRatio: 0.3 }),
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "herdr-subagents.json"),
      JSON.stringify({ maxConcurrent: 7 }),
    );
    expect(loadSettings(cwd, agentDir)).toEqual({
      ...DEFAULTS,
      maxConcurrent: 7,
      splitRatio: 0.3,
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
      splitCurrent: async () => "w1:p8",
      agentStart: async (_id, _pane, args) => {
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
      splitCurrent: async () => "w1:p8",
      agentStart: async (_id, _pane, a) => {
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
      splitCurrent: async () => "w1:p8",
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
    const m = new Manager(piStub(), { ...DEFAULTS }, fake);
    const r = await m.spawn({
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
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
      splitCurrent: async () => "w1:p8",
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
      splitCurrent: async () => "w1:p8",
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
      cwd: "/",
      background: false,
      timeoutMs: 0,
      depth: 1,
    });
    expect(r.status).toBe("done");
    expect(r.text).toContain("late answer");
  });

  it("fails when the stalled child is not in a terminal state", async () => {
    const fake: Herdr = {
      ...emptyHerdr(),
      splitCurrent: async () => "w1:p8",
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
      splitCurrent: async () => "w1:p8",
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
      paneClose: async () => {},
    };
    const sent: string[] = [];
    const pi: any = {
      sendUserMessage: (t: string) => sent.push(t),
      sendMessage: () => {},
    };
    const m = new Manager(pi, { ...DEFAULTS, maxConcurrent: 1 }, fake);
    const base = {
      prompt: "go",
      description: "d",
      profile: BUILTIN_PROFILES[0],
      model: "test/model",
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
    expect(m.children.get(a.id)?.status).toBe("done");
    expect(sent[0]).toContain(`[subagent ${a.id}`);
    expect(sent[0]).toContain("test/model");
    expect(sent[0]).toContain("screen");
    expect(await m.result(a.id, false, 0)).toContain("test/model");
  });
});
