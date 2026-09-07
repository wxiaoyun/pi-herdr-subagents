/**
 * herdr.ts: thin wrapper over the `herdr` CLI. Every command prints JSON on
 * stdout (success) or JSON on stderr (error). We log every call so a broken
 * step is searchable by stage.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";

export const log = (stage: string, fields: Record<string, unknown> = {}): void => {
	const kv = Object.entries(fields)
		.map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
		.join(" ");
	process.stderr.write(`[herdr-subagents] stage=${stage} ${kv}\n`);
};

export class HerdrError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

export interface ExecOpts {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Return raw stdout instead of parsing JSON. */
	raw?: boolean;
}

/** Run a herdr command and return `.result` of its JSON response. */
export function herdr(args: string[], opts: ExecOpts = {}): Promise<any> {
	const stage = `herdr:${args.slice(0, 2).join("_")}`;
	log(stage, { args: args.slice(2, 6) });
	return new Promise((resolve, reject) => {
		execFile(
			"herdr",
			args,
			{ maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs, signal: opts.signal },
			(err, stdout, stderr) => {
				if (err) {
					const parsed = tryJson(stderr);
					const code = parsed?.error?.code ?? parsed?.code;
					const msg = parsed?.error?.message ?? parsed?.message ?? stderr.trim() ?? err.message;
					log(stage, { error: msg, code });
					reject(new HerdrError(`${args.slice(0, 2).join(" ")} failed: ${msg}`, code));
					return;
				}
				if (opts.raw) {
					resolve(stdout);
					return;
				}
				const parsed = tryJson(stdout);
				if (!parsed) {
					reject(new HerdrError(`${stage}: non-JSON output: ${stdout.slice(0, 200)}`));
					return;
				}
				resolve(parsed.result ?? parsed);
			},
		);
	});
}

/** Spawn a long running herdr command (e.g. `agent wait`) and return the process. */
export function herdrDetached(args: string[]): ChildProcess {
	log(`herdr:${args.slice(0, 2).join("_")}:detached`, { args: args.slice(2, 6) });
	return spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function tryJson(s: string): any | undefined {
	try {
		return JSON.parse(s.trim());
	} catch {
		return undefined;
	}
}

const envArgs = (env: Record<string, string>): string[] =>
	Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export interface AgentInfo {
	status: string;
	pane: string;
	name?: string;
	sessionPath?: string;
}

const toAgentInfo = (a: any): AgentInfo => ({
	status: a.agent_status ?? "unknown",
	pane: a.pane_id,
	name: a.label,
	sessionPath: a.agent_session?.kind === "path" ? a.agent_session.value : undefined,
});

/** Named helpers used by the manager. Injectable for tests. */
export const h = {
	async splitCurrent(ratio: number, cwd: string, env: Record<string, string>): Promise<string> {
		const r = await herdr([
			"pane", "split", "--current", "--direction", "right", "--ratio", String(ratio),
			"--no-focus", "--cwd", cwd, ...envArgs(env),
		]);
		return r.pane.pane_id;
	},
	async tabCreate(label: string, cwd: string, env: Record<string, string>): Promise<string> {
		const r = await herdr(["tab", "create", "--no-focus", "--label", label, "--cwd", cwd, ...envArgs(env)]);
		return r.root_pane.pane_id;
	},
	async agentStart(id: string, pane: string, piArgs: string[], timeoutMs = 60000): Promise<void> {
		await herdr(["agent", "start", id, "--kind", "pi", "--pane", pane, "--timeout", String(timeoutMs), "--", ...piArgs]);
	},
	async agentPrompt(id: string, text: string): Promise<void> {
		await herdr(["agent", "prompt", id, text]);
	},
	/** Prompt then block until idle | done | blocked. */
	async agentPromptWait(id: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "prompt", id, text, "--wait"];
		if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
		const r = await herdr(args, { signal });
		return toAgentInfo(r.agent);
	},
	/** Blocks until idle | done | blocked. */
	async agentWait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "wait", id];
		if (timeoutMs > 0) args.push("--timeout", String(timeoutMs));
		const r = await herdr(args, { signal });
		return toAgentInfo(r.agent);
	},
	async agentGet(id: string): Promise<AgentInfo> {
		const r = await herdr(["agent", "get", id]);
		return toAgentInfo(r.agent);
	},
	async agentList(): Promise<AgentInfo[]> {
		const r = await herdr(["agent", "list"]);
		return (r.agents ?? []).map(toAgentInfo);
	},
	async agentRead(id: string, lines: number): Promise<string> {
		return herdr(["agent", "read", id, "--source", "recent-unwrapped", "--lines", String(lines)], { raw: true });
	},
	async agentFocus(id: string): Promise<void> {
		await herdr(["agent", "focus", id]);
	},
	async sendKeys(id: string, keys: string[]): Promise<void> {
		await herdr(["agent", "send-keys", id, ...keys]);
	},
	async paneRun(pane: string, text: string): Promise<void> {
		await herdr(["pane", "run", pane, text]);
	},
	async paneClose(pane: string): Promise<void> {
		await herdr(["pane", "close", pane]);
	},
};

export type Herdr = typeof h;
