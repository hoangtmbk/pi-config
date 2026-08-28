/**
 * Manual test runner: drives the extension against **real pi** child processes,
 * end to end — a Run spawned, a Question asked and answered, a deliberate join,
 * the widget, and a shutdown that leaves nothing behind.
 *
 * Not part of the extension load path and not part of `npm test`: `package.json`
 * lists only `index.ts` under `pi.extensions`, and the test script globs
 * `tests/*.test.ts`, which this file sits beside rather than in. The exclusion is
 * the point. One of the reference repos ran its integration tests as real pi in
 * tmux panes: slow, key-dependent and flaky. This repo's suite stays offline,
 * key-free and deterministic — it drives the same code paths against the scripted
 * fake RPC child in `tests/fake-rpc-child.ts` — and everything that genuinely
 * needs a real model, a real API key and a real pi binary lives here instead,
 * where a human runs it deliberately and reads the output.
 *
 * Run with:
 *
 *   npm run live:subagents                      # the pi pinned in devDependencies
 *   npm run live:subagents -- --model <id>      # …on a particular model, as
 *                                               #   `PI_SUBAGENT_LIVE_MODEL` also does
 *   PI_CLI=/path/to/cli.js npm run live:subagents
 *
 * It spends real tokens: five Runs and six turns — one each, and a second for
 * the Run that asks — on tasks written to be as short as a turn can be. Every
 * Run is reaped before it exits, including on the way out of a failure.
 *
 * The parent side is stood in for rather than real: this file plays the pi
 * session — it registers the tools, calls them, and records what the extension
 * says back — because that is the only half of the relationship that is not a
 * process. Everything below the tool call is the real thing: a real `pi --mode
 * rpc` child per Run, real RPC framing, a real model deciding to call
 * `ask_question`, and a real reap of a real pid.
 *
 * Three seams are deliberately left to the offline suite, which settles them
 * without spending anything: discovery building the `subagent` tool's
 * description (the roster here is this file's own Agents, written to settle in
 * one turn — the discovered one is printed, not run), the queue at the
 * concurrency cap, and the project-Agent trust confirmation, which needs a
 * session that can show a dialog.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Agent, discoverAgents, type Roster } from "./agents.ts";
import { spawnRun } from "./child.ts";
import { registerSubagents } from "./index.ts";
// The one helper this shares with the offline suite: asking the kernel whether a
// pid has really gone is the same question here as it is there.
import { reaped } from "./tests/processes.ts";

const THIS_FILE = fileURLToPath(import.meta.url);

/** How long any one step waits on a real model before calling it a failure. */
const STEP_TIMEOUT_MS = 180_000;

/** How often a step asks again while it waits. */
const POLL_MS = 100;

/** What a Run is asked to say back, so a Delivery is recognisable at a glance. */
const COURIER_TOKEN = "LIVE-OK";
const JOIN_TOKENS = ["JOIN-A", "JOIN-B"];

/** The fact the asking Agent cannot know, and is given only if it asks for it. */
const SECRET_VERSION = "9.9.9";

/**
 * The Agents this runner delegates to.
 *
 * Its own rather than the bundled `scout` and `worker`: those are written to do
 * real work on a real repository, and what is being proved here is the
 * machinery — a Run that settles, and a Run that asks. So the tasks are one turn
 * long and their results are single tokens a reader can spot in a wall of
 * output.
 */
function liveAgent(name: string, description: string, systemPrompt: string): Agent {
	return { name, description, tools: ["read"], systemPrompt, source: "bundled", filePath: THIS_FILE };
}

const COURIER = liveAgent(
	"courier",
	"Says one short thing back and stops",
	[
		"You carry one short message back to the session that delegated to you, and do nothing else.",
		"Do not read files, do not explain yourself, and do not ask anything. Say exactly what the task asks you to say, as your whole final message.",
	].join("\n\n"),
);

const ASKER = liveAgent(
	"asker",
	"Asks the delegating session for the one fact it is missing, then uses it",
	[
		"Your task names one fact you cannot possibly know and that is nowhere in this repository: a version number the delegating session has not told you.",
		"Do not guess it and do not go looking for it. Call `ask_question` to ask for it, then end your turn.",
		"When the answer arrives, your whole final message is the single line `RELEASE <version>`, using the version you were given.",
	].join("\n\n"),
);

const ROSTER: Roster = { agents: [COURIER, ASKER], projectAgents: [], problems: [] };

/**
 * The pi a Run is spawned from.
 *
 * `spawnRun` would default to this session's own entry script, which here is
 * this runner rather than a pi — so a live Run has to be told. The pinned
 * devDependency is the honest default: it is the version this extension targets,
 * and it is the one every offline test is written against. `PI_CLI` points the
 * runner at another one — the pi on the `PATH`, a local build — when what is
 * being checked is whether this still works over there.
 */
function resolveCliPath(): string {
	const override = process.env.PI_CLI;
	if (override) {
		if (!existsSync(override)) throw new Error(`PI_CLI points at ${override}, which does not exist.`);
		return override;
	}

	const root = installedPi();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string; bin?: Record<string, string> };
	const relative = manifest.bin?.pi;
	if (!relative) throw new Error(`@earendil-works/pi-coding-agent ${manifest.version} declares no \`pi\` binary to spawn a run from.`);
	const cliPath = join(root, relative);
	if (!existsSync(cliPath)) throw new Error(`@earendil-works/pi-coding-agent ${manifest.version} is installed but ${cliPath} is missing. Run \`npm install\`.`);
	return cliPath;
}

/**
 * Where the pinned pi is installed, by the same walk up `node_modules` npm's own
 * resolution does.
 *
 * Node's resolvers are both out here: the package is ESM-only, so
 * `createRequire(...).resolve` refuses it for want of a `require` condition, and
 * its `exports` deliberately does not publish `package.json`, which is the file
 * naming the binary. Walking is what is left, and it is what npm does anyway.
 */
function installedPi(): string {
	const installed = join("node_modules", "@earendil-works", "pi-coding-agent");
	for (let directory = dirname(THIS_FILE); ; ) {
		const candidate = join(directory, installed);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error("@earendil-works/pi-coding-agent is not installed, so there is no pi to spawn a run from. Run `npm install`.");
		directory = parent;
	}
}

/** The model every Run uses, when the runner was told to pin one. */
function resolveModel(): string | undefined {
	const flag = process.argv.indexOf("--model");
	if (flag !== -1) return process.argv[flag + 1];
	return process.env.PI_SUBAGENT_LIVE_MODEL || undefined;
}

/** Something the extension put into the parent conversation. */
interface Said {
	customType: string;
	content: string;
	triggerTurn?: boolean;
	/** The Run it was about, from the message's own metadata. */
	run?: string;
}

/** A tool as pi is handed it, narrowed to the part this runner calls. */
interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/**
 * The parent session, played by this file: the three things pi gives an
 * extension — a place to register tools, a way to be told about the session's
 * lifecycle, and a way to say something into the conversation — with every one
 * of them recorded instead of rendered.
 */
function parentSession(cliPath: string) {
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, Handler[]>();
	const said: Said[] = [];
	/** Every block handed to `setWidget`, in order; `undefined` is the block being taken away. */
	const widgets: (string[] | undefined)[] = [];

	const ui = {
		setWidget(_key: string, content: string[] | undefined) {
			widgets.push(content);
		},
	} as unknown as ExtensionContext["ui"];

	// A session with somewhere to put a widget, and one that trusts its own
	// checkout — this runner delegates to Agents of its own, so the project-scope
	// confirmation is not what is under test here.
	const ctx = { hasUI: true, ui, cwd: process.cwd(), isProjectTrusted: () => true } as unknown as ExtensionContext;

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: unknown) {
			tools.push(tool as RegisteredTool);
		},
		sendMessage(message: { customType: string; content: string; details?: unknown }, options?: { triggerTurn?: boolean }) {
			said.push({
				customType: message.customType,
				content: message.content,
				triggerTurn: options?.triggerTurn,
				run: (message.details as { run?: string } | undefined)?.run,
			});
		},
	};

	registerSubagents(pi as unknown as ExtensionAPI, {
		roster: ROSTER,
		spawn: (options) => spawnRun({ ...options, cliPath }),
	});

	async function fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	}

	return {
		said,
		widgets,
		/**
		 * The first thing the extension has said since `from` of a given kind, and
		 * about a given Run when one is named — the shape every step waits on.
		 */
		saidSince(from: number, customType: string, run?: string): Said | undefined {
			return said.slice(from).find((message) => message.customType === customType && (run === undefined || message.run === run));
		},
		/** Call a tool the way pi would, and read its text back. */
		async call(name: string, params: Record<string, unknown>): Promise<string> {
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`no ${name} tool was registered; got ${tools.map((candidate) => candidate.name).join(", ") || "none"}`);
			const result = await tool.execute("live-1", params, undefined, undefined, ctx);
			return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		},
		start: () => fire("session_start", { reason: "startup" }),
		shutdown: () => fire("session_shutdown", { reason: "quit" }),
	};
}

/**
 * The pids of this process's live Runs.
 *
 * Its children, less the ones that are not Runs: `tsx` keeps an esbuild service
 * of its own around for as long as the runner lives, and `ps` lists the very
 * invocation that is asking. A Run's child is a pi, which pi's bundle titles
 * `pi` however it was started — so that, or the CLI path it was started from
 * for a build that does not rename itself, is what one is recognised by.
 *
 * The kernel is the only witness worth having here. Whatever the extension
 * believes about a Run, an orphaned pi child is a process that is still there,
 * still holding a context and still able to burn tokens with nothing left to
 * report to.
 */
function runPids(cliPath: string): number[] {
	const listing = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf-8" });
	return listing
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter((fields) => fields !== null && Number(fields[2]) === process.pid && isPi(fields[3], cliPath))
		.map((fields) => Number(fields?.[1]));
}

/** Whether a child process's command line is a Run's pi rather than the runner's own toolchain. */
function isPi(command: string, cliPath: string): boolean {
	return command === "pi" || command.includes(cliPath) || command.includes("--mode rpc");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `probe` has something to say, or give up loudly. */
async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
	const giveUpAt = Date.now() + timeoutMs;
	for (;;) {
		const found = probe();
		if (found !== undefined) return found;
		if (Date.now() >= giveUpAt) throw new Error(`gave up after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
		await sleep(POLL_MS);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let failures = 0;

/** Two spaces past the `ok  `/`FAIL` column, so a detail block reads as one. */
function indented(detail: string): string {
	return detail
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n");
}

/**
 * One expectation, reported.
 *
 * `problem` is what went wrong, or nothing when the case held — the same shape
 * the other manual runners in this repo use, so a reader who has run one can
 * read this one.
 */
function check(what: string, problem: string | undefined, detail?: string): void {
	if (problem) {
		failures++;
		console.log(`FAIL  ${what}\n${indented(problem)}`);
	} else {
		console.log(`ok    ${what}`);
	}
	if (detail) console.log(indented(detail));
}

function contains(text: string, wanted: string): string | undefined {
	return text.includes(wanted) ? undefined : `expected ${wanted} somewhere in: ${text.slice(0, 300)}`;
}

/** The last block the widget was drawn with, or nothing if it was taken away. */
function latestBlock(widgets: (string[] | undefined)[]): string[] | undefined {
	return widgets.at(-1);
}

/** Every block the widget was actually drawn with, oldest first — the clears dropped. */
function drawnBlocks(widgets: (string[] | undefined)[]): string[][] {
	return widgets.filter((lines): lines is string[] => Boolean(lines));
}

/**
 * The most recent entry a predicate holds for.
 *
 * `findLast` would say this in one call and is deliberately not used: it needs a
 * newer `lib` than this repo's `tsconfig` targets, and a live runner is not the
 * place to widen that.
 */
function lastWhere<T>(items: T[], holds: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index--) if (holds(items[index])) return items[index];
	return undefined;
}

const cliPath = resolveCliPath();
const model = resolveModel();
const session = parentSession(cliPath);

console.log(`pi:     ${cliPath}`);
console.log(`model:  ${model ?? "whatever this pi defaults to"}`);

// The roster a real session would build its tool description from. Nothing here
// is spawned — the Runs below use this file's own Agents — but a machine whose
// discovery is broken is worth finding out about before spending a token.
const discovered = discoverAgents();
console.log(
	`roster: ${discovered.agents.map((agent) => agent.name).join(", ") || "none"}` +
		`${discovered.projectAgents.length > 0 ? ` (+ project: ${discovered.projectAgents.map((agent) => agent.name).join(", ")})` : ""}`,
);
for (const problem of discovered.problems) console.log(`        rejected ${problem.filePath}: ${problem.reason}`);

await session.start();

try {
	console.log("\n--- 1. a run spawned, and a result that arrives on its own ---");
	{
		const from = session.said.length;
		const startedAt = Date.now();
		const started = await session.call("subagent", { agent: "courier", task: `Reply with exactly ${COURIER_TOKEN} and nothing else.`, model });
		check("`subagent` came back with a run's name rather than its result", contains(started, "courier"), started);
		check(
			"nothing was delivered while the run was still working",
			session.said.length === from ? undefined : `${session.said.length - from} message(s) arrived before the run could have finished`,
		);

		const delivery = await waitFor("the run's result", () => session.saidSince(from, "subagent-delivery"));
		check(
			"the result was delivered into the conversation, waking the parent",
			contains(delivery.content, COURIER_TOKEN) ?? (delivery.triggerTurn ? undefined : "delivered without triggerTurn, so an idle parent would never read it"),
			`${Math.round((Date.now() - startedAt) / 1000)}s\n${delivery.content.slice(0, 300)}`,
		);
	}

	console.log("\n--- 2. a question, and the answer that resumes the run ---");
	{
		const from = session.said.length;
		await session.call("subagent", {
			agent: "asker",
			name: "curious",
			task: "Write the one-line release note for this project's next version. Nobody has told you which version that is.",
			model,
		});

		const question = await waitFor("the run's question", () => session.saidSince(from, "subagent-question"));
		check("the run escalated rather than guessing, and its question arrived on its own", question.run === "curious" ? undefined : `it came back about \`${question.run}\``, question.content.slice(0, 300));

		const block = await waitFor("the widget to show the run waiting", () =>
			lastWhere(drawnBlocks(session.widgets), (lines) => lines.some((line) => line.includes("curious") && line.includes("waiting"))),
		);
		check(
			"the widget showed it waiting, without repeating the question",
			block.some((line) => line.includes("?")) ? "the question text leaked into the widget" : undefined,
			block.join("\n"),
		);

		const answered = await session.call("subagent_answer", { name: "curious", answer: `The version is ${SECRET_VERSION}.` });
		check("`subagent_answer` resumed it", contains(answered, "curious"), answered);

		const resumed = await waitFor("the answered run's result", () => session.saidSince(from, "subagent-delivery", "curious"));
		check("the answered run carried on and used the answer", contains(resumed.content, SECRET_VERSION), resumed.content.slice(0, 300));
	}

	console.log("\n--- 3. a deliberate join ---");
	{
		const from = session.said.length;
		for (const [index, token] of JOIN_TOKENS.entries()) {
			await session.call("subagent", { agent: "courier", name: `join-${index}`, task: `Reply with exactly ${token} and nothing else.`, model });
		}

		const joined = await session.call("subagent_wait", { names: JOIN_TOKENS.map((_token, index) => `join-${index}`) });
		check(
			"`subagent_wait` blocked until both runs were done and returned what they said",
			JOIN_TOKENS.map((token) => contains(joined, token)).find(Boolean),
			joined.slice(0, 400),
		);

		const alsoDelivered = session.said.slice(from).filter((message) => message.customType === "subagent-delivery" && message.run?.startsWith("join-"));
		check(
			"nothing was said twice: a result the join collected was not also delivered",
			alsoDelivered.length === 0 ? undefined : `${alsoDelivered.length} joined result(s) were delivered as well: ${alsoDelivered.map((message) => message.run).join(", ")}`,
		);
	}

	console.log("\n--- 4. the widget, over the whole session ---");
	{
		const named = drawnBlocks(session.widgets);
		check("it drew a block while runs were active", named.length > 0 ? undefined : "no block was ever handed over");
		check(
			"it reported what a run was doing, not just that it existed",
			named.some((lines) => lines.some((line) => /running · \S/.test(line))) ? undefined : "no line ever named a tool the child was inside",
			lastWhere(named, (lines) => lines.some((line) => /running · \S/.test(line)))?.join("\n"),
		);
		check(
			"it went away once every run had finished",
			latestBlock(session.widgets) === undefined ? undefined : `the block is still up: ${latestBlock(session.widgets)?.join(" / ")}`,
		);
	}

	console.log("\n--- 5. shutdown, with a run still alive ---");
	{
		const from = session.said.length;
		// A Waiting Run is the one that is still there to reap: its child stays up
		// holding the context an answer would land in, so it is what a session that
		// quits with work outstanding actually leaves behind.
		await session.call("subagent", {
			agent: "asker",
			name: "abandoned",
			task: "Write the one-line release note for this project's next version. Nobody has told you which version that is.",
			model,
		});
		await waitFor("the run to go Waiting on its question", () => session.saidSince(from, "subagent-question"));

		const alive = runPids(cliPath);
		check("a waiting run's child is still up, holding the context an answer would land in", alive.length > 0 ? undefined : "no child process was alive to reap");

		await session.shutdown();
		const gone = await Promise.all(alive.map(reaped));
		check(
			"`session_shutdown` reaped every child",
			gone.every(Boolean) ? undefined : `still alive: ${alive.filter((_pid, index) => !gone[index]).join(", ")}`,
			`pids ${alive.join(", ")}`,
		);
		const remaining = runPids(cliPath);
		check("and left none of its own behind", remaining.length === 0 ? undefined : `${remaining.length} pi child process(es) remain: ${remaining.join(", ")}`);

		const reported = session.saidSince(from, "subagent-delivery", "abandoned");
		check(
			"the abandoned run was accounted for, without waking a session that is leaving",
			reported ? (reported.triggerTurn ? "it started a turn in a session that asked everything to stop" : undefined) : "nothing was said about it at all",
			reported?.content.slice(0, 200),
		);
	}
} catch (error) {
	failures++;
	console.log(`FAIL  the run stopped early\n${indented(messageOf(error))}`);
} finally {
	// Whatever happened above, no pi child outlives this process: an orphaned one
	// burns tokens invisibly, which is exactly what the extension exists not to do.
	await session.shutdown();
	const strays = runPids(cliPath);
	if (strays.length > 0) {
		failures++;
		console.log(`FAIL  children outlived the runner\n${indented(`pids ${strays.join(", ")} — kill them`)}`);
	}
}

console.log(failures === 0 ? "\nAll cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
