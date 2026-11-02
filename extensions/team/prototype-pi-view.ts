/**
 * PROTOTYPE, throwaway. Not part of the extension and not in package.json's
 * `pi.extensions`. Lives on `prototype/team-pi-view`, never merged.
 *
 * Question (map #74, ticket #91 "What the human sees in pi"): what does the
 * human see of the Team in pi, and how do they get from there into a
 * Teammate's terminal?
 *
 * Three structurally different variants over the same fake Effort:
 *   A  Dashboard: a framed block above the editor, there for the whole Effort.
 *                 `/team` opens a Teammate picker, which leads to the attach menu.
 *   B  Console:   one footer segment only. `/team` opens a tabbed overlay
 *                 (Teammates, Queue, Waiting on you, Reports).
 *   C  Alerts:    nothing above the editor unless the human is needed, one
 *                 actionable line per alert. Teammates show as dots in the footer.
 *                 `/team attach` goes straight in.
 *
 * Switch with `/proto next`, `/proto A|B|C` and `/proto scenario
 * running|takeover|usage-paused|quiet`.
 * Every variant has `/team attach [id]`, `/team pending`, `/team reports`,
 * `/team handback <id> [note]` and `/team pause|resume`. All of them act on
 * fake data in memory.
 *
 * Attaching is real. "Attach here" stops pi's TUI the way pi's external-editor
 * key does, runs `claude attach <target>`, and restarts the TUI when that exits.
 * The target is $TEAM_PROTO_ATTACH (an id, or part of a name, from
 * `claude agents`). Without it, a stand-in shell runs instead.
 *
 * Run it with `npm run proto:team-view`.
 *
 * Tried on pi 1.3.0 and Claude Code 2.1.316, in tmux:
 *   - Attaching for real from inside pi works, and pi's input is fine afterwards.
 *   - Ctrl+Z in the attached session ends `claude attach` (exit 0, no stopped
 *     process) and pi comes back. The session keeps running.
 *   - ← does NOT return to pi. It opens Claude Code's agent view, which lists
 *     every session on the account and offers to start a new one. Esc there
 *     ends `claude attach` and pi comes back.
 */

import { spawn } from "node:child_process";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Fake data ──────────────────────────────────────────────────────────────

type MateState = "busy" | "waiting" | "idle" | "stopped";

interface Mate {
	id: string;
	role: string;
	model: string;
	/** The short id `claude attach` takes. */
	short: string;
	/** Set when a fresh session changed the short id since the human last attached. */
	prevShort?: string;
	task?: string;
	state: MateState;
	doing?: string;
	ctxPct?: number;
	mode: string;
	roleMode: string;
	takeover?: { since: number; how: string; held: number };
}

interface Pending {
	id: string;
	kind: "approval" | "permission" | "question";
	title: string;
	from: string;
	at: number;
	floor?: boolean;
	options: string[];
}

interface Queued {
	task: string;
	role: string;
	why: string;
}

interface Report {
	n: number;
	title: string;
	at: number;
	headline: string;
	body: string;
}

interface Window {
	pct: number;
	resets: number;
}

interface Scenario {
	effort: string;
	team: string;
	phase: string;
	plan: { accepted: number; total: number };
	mates: Mate[];
	queue: Queued[];
	pending: Pending[];
	pauses: { human?: { since: number }; lead?: { reason: string }; usage?: { limit: string; resets: number } };
	/** This account reports only `seven_day`, so `five` is often missing. */
	usage: { five?: Window; week?: Window; source: string; at: number };
	heldRoles?: string;
	reports: Report[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function reports(now: number): Report[] {
	return [
		{
			n: 1,
			title: "Plan",
			at: now - 3 * HOUR,
			headline: "on track: 4 Tasks planned, every acceptance criterion covered",
			body: "# Report 001: Plan\n\n**On track.** 4 Tasks planned; AC-1..AC-4 covered.\n\n## Plan\n\n| Task | Role | Covers |\n|---|---|---|\n| 001-architect-design | architect | AC-1 |\n| 002-dev-cache | dev | AC-2 |\n| 003-dev-ttl | dev | AC-3 |\n| 004-qa-cache | qa | AC-2, AC-3, AC-4 |\n\n## Teammate modes\n\n- architect `auto`, dev `auto`, qa `auto` (all as their Roles say)\n\n## Usage\n\n- week **61%** (resets Thu 09:00), 5h n/a on this account\n",
		},
		{
			n: 2,
			title: "Design accepted",
			at: now - 50 * MIN,
			headline: "on track: design accepted, devs started in parallel",
			body: "# Report 002: Design accepted\n\n**On track.** Design accepted after one send-back.\n\n## Since the last report\n\n- accepted **001-architect-design** → `tasks/001-architect-design/result-2.md`\n- sent back once (1/3): missing eviction policy\n- started **002-dev-cache** (dev-1), **003-dev-ttl** (dev-2, isolated)\n\n## Decided for you\n\n- allowed `npm test` for dev-1 (rule `Bash(npm test:*)`, fits the Role)\n- answered architect: \"Redis or in-process?\" → in-process, from Brief scope\n\n## Usage\n\n- week **68%** (+7 since the Effort began, *includes your own use outside the Team*)\n- architect 412k tokens · dev 96k · *API-price equivalent ≈ $3.10, not your bill*\n",
		},
	];
}

function scenario(name: string, now: number): Scenario {
	const base: Scenario = {
		effort: "flaky-cache",
		team: "software",
		phase: "build",
		plan: { accepted: 1, total: 4 },
		mates: [
			{ id: "architect", role: "architect", model: "opus", short: "a1b2c3", task: "001-architect-design", state: "idle", doing: "accepted", ctxPct: 18, mode: "auto", roleMode: "auto" },
			{ id: "dev-1", role: "dev", model: "sonnet", short: "d4e5f6", task: "002-dev-cache", state: "busy", doing: "Edit src/cache/store.ts", ctxPct: 41, mode: "auto", roleMode: "auto" },
			{ id: "dev-2", role: "dev", model: "sonnet", short: "g7h8i9", task: "003-dev-ttl", state: "waiting", doing: "permission → Lead", ctxPct: 22, mode: "auto", roleMode: "auto" },
		],
		queue: [{ task: "004-qa-cache", role: "qa", why: "cap 3 reached; waits for 002 and 003" }],
		pending: [
			{ id: "p1", kind: "permission", title: "dev-2: git push origin team/flaky-cache-ttl", from: "dev-2", at: now - 2 * MIN, floor: true, options: ["Allow", "Deny", "Later"] },
			{ id: "p2", kind: "approval", title: "Brief change: also cover the LRU size limit (affects 003)", from: "Lead", at: now - 6 * MIN, options: ["Approve", "Send back with a note", "Later"] },
		],
		pauses: {},
		usage: { week: { pct: 73, resets: nextThursday(now) }, source: "dev-1's status line", at: now - 12_000 },
		reports: reports(now),
	};

	if (name === "takeover") {
		base.mates[1] = { ...base.mates[1], state: "busy", doing: "your prompt: \"try a write-through instead\"", takeover: { since: now - 23 * MIN, how: "you typed a prompt", held: 1 } };
		base.mates[2] = { ...base.mates[2], state: "busy", doing: "Bash npm test", mode: "acceptEdits", short: "k3l4m5", prevShort: "g7h8i9" };
		base.pending = [base.pending[1]];
	}

	if (name === "usage-paused") {
		base.mates = base.mates.map((mate) => ({ ...mate, state: mate.id === "architect" ? "stopped" : "idle", doing: mate.id === "architect" ? "idle-stopped" : "finished its Task, paused", ctxPct: mate.id === "architect" ? undefined : mate.ctxPct }));
		base.queue = [{ task: "004-qa-cache", role: "qa", why: "Effort paused" }];
		base.pending = [];
		base.pauses = { usage: { limit: "weekly limit", resets: now + 2 * HOUR + 10 * MIN } };
		base.usage = { week: { pct: 100, resets: now + 2 * HOUR + 10 * MIN }, source: "get_usage", at: now - 3 * MIN };
	}

	if (name === "quiet") {
		base.phase = "intake";
		base.plan = { accepted: 0, total: 0 };
		base.mates = [];
		base.queue = [];
		base.pending = [{ id: "p3", kind: "approval", title: "Approve the Brief (brief.draft.md, sha 9f3c…)", from: "Lead", at: now - 1 * MIN, options: ["Approve", "Send back with a note", "Later"] }];
		base.pauses = { human: { since: now - 40 * MIN } };
		base.usage = { week: { pct: 58, resets: nextThursday(now) }, source: "get_usage (no Teammate live)", at: now - 30_000 };
		base.reports = [];
	}

	return base;
}

function nextThursday(now: number): number {
	const date = new Date(now);
	date.setDate(date.getDate() + ((4 - date.getDay() + 7) % 7 || 7));
	date.setHours(9, 0, 0, 0);
	return date.getTime();
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function ago(ms: number): string {
	if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
	return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / MIN)}m`;
}

function clock(ts: number): string {
	const date = new Date(ts);
	const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const sameDay = new Date().toDateString() === date.toDateString();
	return sameDay ? hm : `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${hm}`;
}

function windowText(label: string, window: Window | undefined): string {
	return window ? `${label} ${window.pct}% ↻${clock(window.resets)}` : `${label} n/a`;
}

function usageText(s: Scenario): string {
	return `${windowText("5h", s.usage.five)} · ${windowText("week", s.usage.week)}`;
}

/** Every pause, said separately: the human's, the Lead's, and a usage pause. */
function pauseText(s: Scenario, now: number): string {
	const parts: string[] = [];
	if (s.pauses.human) parts.push(`paused by you ${ago(now - s.pauses.human.since)} ago`);
	if (s.pauses.lead) parts.push(`paused by Lead: ${s.pauses.lead.reason}`);
	if (s.pauses.usage) parts.push(`paused: ${s.pauses.usage.limit}, resumes ${clock(s.pauses.usage.resets)} (in ${ago(s.pauses.usage.resets - now)})`);
	return parts.length ? parts.join(" · ") : "running";
}

function stateColor(state: MateState): "success" | "warning" | "muted" | "dim" {
	return state === "busy" ? "success" : state === "waiting" ? "warning" : state === "idle" ? "muted" : "dim";
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

/** One Teammate in a row: id, short id, state, Task and what it is doing, context, mode, and any flags. */
function mateRow(mate: Mate, theme: Theme, now: number, width: number): string {
	const id = pad(mate.id, 10);
	const short = mate.prevShort ? theme.fg("warning", `${mate.short}*`) : theme.fg("dim", mate.short);
	if (mate.takeover) {
		const yours = theme.fg("accent", `✋ YOURS ${ago(now - mate.takeover.since)}`);
		return fit(`${id} ${pad(short, 7)} ${yours}  ${mate.takeover.how} · /team handback ${mate.id}`, width);
	}
	const state = theme.fg(stateColor(mate.state), pad(mate.state, 8));
	const ctx = mate.ctxPct === undefined ? theme.fg("dim", "ctx —  ") : `ctx ${String(mate.ctxPct).padStart(2)}%`;
	const mode = mate.mode === mate.roleMode ? theme.fg("dim", mate.mode) : theme.fg("warning", `${mate.mode}≠${mate.roleMode}`);
	const what = [mate.task, mate.doing].filter(Boolean).join(" · ");
	const right = `  ${ctx}  ${mode}`;
	const left = `${id} ${pad(short, 7)} ${state} `;
	return `${left}${pad(fit(what, width - visibleWidth(left) - visibleWidth(right)), width - visibleWidth(left) - visibleWidth(right))}${right}`;
}

function frame(title: string, right: string, body: string[], theme: Theme, width: number): string[] {
	const inner = width - 4;
	const top = `╭─ ${title} `;
	const tail = ` ${right} ─╮`;
	const fill = Math.max(1, width - visibleWidth(top) - visibleWidth(tail));
	return [
		theme.fg("borderMuted", top) + theme.fg("borderMuted", "─".repeat(fill)) + tail,
		...body.map((line) => `${theme.fg("borderMuted", "│")} ${pad(fit(line, inner), inner)} ${theme.fg("borderMuted", "│")}`),
		theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`),
	];
}

// ─── The prototype ──────────────────────────────────────────────────────────

const VARIANTS = { A: "Dashboard", B: "Console", C: "Alerts" } as const;
type Variant = keyof typeof VARIANTS;
const SCENARIOS = ["running", "takeover", "usage-paused", "quiet"];

export default function (pi: ExtensionAPI) {
	let variant: Variant = "A";
	let scenarioName = "running";
	let s = scenario(scenarioName, Date.now());
	let ui: ExtensionContext["ui"] | undefined;
	let ticking: ReturnType<typeof setInterval> | undefined;

	const attachTarget = process.env.TEAM_PROTO_ATTACH;

	function paint(): void {
		if (!ui) return;
		ui.setWidget("team-proto", undefined);
		ui.setStatus("team-proto", undefined);

		if (variant === "A") {
			ui.setWidget("team-proto", (_tui, theme) => staticComponent((width) => dashboard(theme, Math.min(width, 96))));
		}
		if (variant === "B") {
			ui.setStatus("team-proto", footerB(ui.theme));
		}
		if (variant === "C") {
			ui.setWidget("team-proto", (_tui, theme) => staticComponent((width) => alerts(theme, width)));
			ui.setStatus("team-proto", footerC(ui.theme));
		}

		const bar = `PROTOTYPE  ◀ ${variant} · ${VARIANTS[variant]} ▶  /proto next   scenario: ${scenarioName}  /proto scenario <${SCENARIOS.join("|")}>   attach → ${attachTarget ?? "stand-in shell ($TEAM_PROTO_ATTACH unset)"}`;
		ui.setWidget("team-proto-bar", (_tui, theme) => staticComponent((width) => [theme.bg("selectedBg", theme.fg("accent", pad(fit(bar, width), width)))]), { placement: "belowEditor" });
	}

	// ── A: Dashboard ──
	function dashboard(theme: Theme, width: number): string[] {
		const now = Date.now();
		const inner = width - 4;
		const body: string[] = [];
		const paused = pauseText(s, now);
		body.push(`${paused === "running" ? theme.fg("success", "● running") : theme.fg("warning", `⏸ ${paused}`)}  ·  ${s.phase} · ${s.plan.accepted}/${s.plan.total} Tasks accepted`);
		body.push(`${usageText(s)}  ${theme.fg("dim", `· ${s.usage.source}, ${ago(now - s.usage.at)} ago`)}`);
		if (s.mates.length === 0) body.push(theme.fg("dim", "no Teammates live"));
		for (const mate of s.mates) body.push(mateRow(mate, theme, now, inner));
		for (const q of s.queue) body.push(theme.fg("muted", `queued  ${q.task} (${q.role}): ${q.why}`));
		const pendingText = s.pending.length ? theme.fg("warning", `▲ ${s.pending.length} waiting on you  /team pending`) : theme.fg("dim", "nothing waiting on you");
		body.push(`${pendingText}   ${theme.fg("dim", `reports ${s.reports.length}  /team reports   attach  /team`)}`);
		return frame(`Team · ${s.team} · ${s.effort}`, `${s.mates.length} live`, body, theme, width);
	}

	// ── B: Console ──
	function footerB(theme: Theme): string {
		const now = Date.now();
		const parts = [theme.fg("accent", "team")];
		const paused = pauseText(s, now);
		parts.push(paused === "running" ? "running" : theme.fg("warning", "⏸ paused"));
		parts.push(`${s.mates.length} live${s.queue.length ? ` +${s.queue.length} queued` : ""}`);
		const yours = s.mates.filter((m) => m.takeover).length;
		if (yours) parts.push(theme.fg("accent", `✋${yours}`));
		if (s.pending.length) parts.push(theme.fg("warning", `▲${s.pending.length}`));
		parts.push(usageText(s));
		return `${parts.join(" · ")} ${theme.fg("dim", "(/team)")}`;
	}

	// ── C: Alerts ──
	function alerts(theme: Theme, width: number): string[] {
		const now = Date.now();
		const lines: string[] = [];
		const act = (text: string, cmd: string) => `${pad(fit(text, width - visibleWidth(cmd) - 2), width - visibleWidth(cmd) - 2)}  ${theme.fg("dim", cmd)}`;
		for (const p of s.pending) {
			const tag = p.floor ? theme.fg("error", " [floor]") : "";
			lines.push(act(`${theme.fg("warning", "▲")} ${p.title}${tag} ${theme.fg("dim", `(${p.from}, ${ago(now - p.at)})`)}`, "/team pending"));
		}
		for (const m of s.mates.filter((m) => m.takeover)) {
			const t = m.takeover!;
			lines.push(act(`${theme.fg("accent", "✋")} ${m.id} is yours since ${clock(t.since)} (${ago(now - t.since)}), ${t.how}; Lead holds ${t.held} send`, `/team handback ${m.id}`));
		}
		if (s.pauses.human || s.pauses.lead || s.pauses.usage) lines.push(act(`${theme.fg("warning", "⏸")} ${pauseText(s, now)}`, s.pauses.human ? "/team resume" : ""));
		for (const m of s.mates.filter((m) => m.mode !== m.roleMode)) lines.push(act(`${theme.fg("warning", "≠")} ${m.id} is in ${m.mode}, its Role says ${m.roleMode}`, `/team attach ${m.id}`));
		for (const m of s.mates.filter((m) => m.prevShort)) lines.push(act(`${theme.fg("warning", "↻")} ${m.id} has a fresh session: attach to ${m.short} (was ${m.prevShort})`, `/team attach ${m.id}`));
		return lines.length ? lines.map((line) => fit(line, width)) : [];
	}

	function footerC(theme: Theme): string {
		const dots = s.mates.map((m) => (m.takeover ? theme.fg("accent", "✋") : theme.fg(stateColor(m.state), m.state === "busy" ? "●" : m.state === "waiting" ? "◐" : "○"))).join("");
		const queued = s.queue.length ? theme.fg("dim", `+${s.queue.length}q`) : "";
		return `${theme.fg("accent", "team")} ${dots || theme.fg("dim", "—")}${queued} ${usageText(s)}`;
	}

	// ── Attaching ──
	async function attachMenu(ctx: ExtensionCommandContext, mate: Mate): Promise<void> {
		const cmd = `claude attach ${attachTarget ?? mate.short}`;
		const options = ["Attach here (pi steps aside; Ctrl+Z returns, ← is Claude's agent view, Esc there returns)"];
		if (process.env.TMUX) options.push("Open in a new tmux window");
		options.push(`Copy \`${cmd}\``);
		if (mate.takeover) options.push("Hand back to the Lead");
		const head = `${mate.id} · ${mate.role} · ${mate.model} · ${mate.task ?? "no Task"}${mate.prevShort ? ` · NEW session ${mate.short} (was ${mate.prevShort})` : ""}`;
		const choice = await ctx.ui.select(head, options);
		if (!choice) return;
		if (choice.startsWith("Attach here")) {
			mate.prevShort = undefined;
			await attachHere(ctx, mate);
		} else if (choice.startsWith("Open in a new tmux")) {
			spawn("tmux", ["new-window", "-n", mate.id, cmd], { stdio: "ignore", detached: true }).unref();
			mate.prevShort = undefined;
		} else if (choice.startsWith("Copy")) {
			await copyToClipboard(cmd);
			ctx.ui.notify(`Copied: ${cmd}`, "info");
		} else if (choice.startsWith("Hand back")) {
			await handback(ctx, mate, "");
		}
		paint();
	}

	async function attachHere(ctx: ExtensionCommandContext, mate: Mate): Promise<void> {
		await ctx.ui.custom<void>((tui: TUI, _theme, _kb, done) => {
			tui.stop();
			const [command, args] = attachTarget
				? ["claude", ["attach", attachTarget]]
				: ["sh", ["-c", `clear; printf '\\n  [stand-in] pi has stepped aside.\\n  For real, \\033[1mclaude attach ${mate.short}\\033[0m would be running here (${mate.id}).\\n  Set TEAM_PROTO_ATTACH to a background session from \\033[1mclaude agents\\033[0m to try it.\\n\\n  Press Enter to return to pi. '; read _`]];
			process.stdout.write(`\nAttaching to ${mate.id}… pi resumes when you leave the session.\n`);
			const child = spawn(command as string, args as string[], { stdio: "inherit" });
			const back = (why: string) => {
				tui.start();
				tui.requestRender(true);
				ctx.ui.notify(`Back in pi from ${mate.id} (${why})`, "info");
				done();
			};
			child.on("error", (error) => back(`error: ${error.message}`));
			child.on("close", (code, signal) => back(signal ? `signal ${signal}` : `exit ${code}`));
			return staticComponent(() => []);
		});
	}

	async function handback(ctx: ExtensionCommandContext, mate: Mate, note: string): Promise<void> {
		if (!mate.takeover) {
			ctx.ui.notify(`${mate.id} isn't taken over`, "warning");
			return;
		}
		const ok = await ctx.ui.confirm(
			`Hand ${mate.id} back to the Lead?`,
			`The Lead reviews what you did against the Task and the Brief.\n${mate.takeover.held} held send(s) will be dropped and the Lead decides afresh.\nThe next new Task will clear ${mate.id}'s context.${note ? `\nYour note: ${note}` : ""}`,
		);
		if (!ok) return;
		mate.takeover = undefined;
		mate.doing = "handed back · Lead reviewing";
		ctx.ui.notify(`${mate.id} handed back`, "info");
		paint();
	}

	// ── Shared pickers ──
	async function pickMate(ctx: ExtensionCommandContext, title: string): Promise<Mate | undefined> {
		if (s.mates.length === 0) {
			ctx.ui.notify("No Teammates live yet", "info");
			return undefined;
		}
		const now = Date.now();
		const rows = s.mates.map((m) => `${pad(m.id, 10)} ${m.takeover ? `✋ yours ${ago(now - m.takeover.since)}` : pad(m.state, 8)}  ${m.task ?? ""}${m.prevShort ? "  ↻ new session" : ""}`);
		const choice = await ctx.ui.select(title, rows);
		return choice ? s.mates[rows.indexOf(choice)] : undefined;
	}

	async function pending(ctx: ExtensionCommandContext): Promise<void> {
		if (s.pending.length === 0) return ctx.ui.notify("Nothing is waiting on you", "info");
		const now = Date.now();
		const rows = s.pending.map((p) => `[${p.kind}] ${p.title}${p.floor ? " [floor]" : ""}  (${p.from}, ${ago(now - p.at)})`);
		const choice = await ctx.ui.select("Waiting on you", rows);
		if (!choice) return;
		const item = s.pending[rows.indexOf(choice)];
		const answer = await ctx.ui.select(item.title, item.options);
		if (!answer || answer === "Later") return;
		s.pending = s.pending.filter((p) => p !== item);
		ctx.ui.notify(`(prototype) ${answer}: ${item.title}`, "info");
		paint();
	}

	async function openReports(ctx: ExtensionCommandContext): Promise<void> {
		if (s.reports.length === 0) return ctx.ui.notify("No reports yet. /team report asks the Lead for one.", "info");
		const rows = [...s.reports].reverse().map((r) => `${String(r.n).padStart(3, "0")}  ${clock(r.at)}  ${r.title}: ${r.headline}`);
		const choice = await ctx.ui.select("Reports (reports/ in the Effort directory)", rows);
		if (!choice) return;
		const report = [...s.reports].reverse()[rows.indexOf(choice)];
		await viewReport(ctx, report);
	}

	async function viewReport(ctx: ExtensionCommandContext, report: Report): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const md = new Markdown(report.body, 1, 0, getMarkdownTheme());
				let top = 0;
				return {
					render(width: number) {
						const lines = md.render(width - 4);
						const height = Math.max(5, (tui.terminal?.rows ?? 30) * 0.8 - 2);
						top = Math.max(0, Math.min(top, lines.length - height));
						return frame(`reports/${String(report.n).padStart(3, "0")}.md`, "↑↓ scroll · esc", lines.slice(top, top + height), theme, width);
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || data === "q") return done();
						if (matchesKey(data, Key.down)) top++;
						if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
						tui.requestRender();
					},
					invalidate() {
						md.invalidate();
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
		);
	}

	// ── B's console overlay ──
	type ConsoleAction = { kind: "mate"; mate: Mate } | { kind: "pending" } | { kind: "report"; report: Report } | undefined;

	async function consoleB(ctx: ExtensionCommandContext): Promise<void> {
		const action = await ctx.ui.custom<ConsoleAction>(
			(tui, theme, _kb, done) => {
				const tabs = ["Teammates", "Queue", "Waiting on you", "Reports"];
				let tab = s.pending.length ? 2 : 0;
				let row = 0;
				const items = () => [s.mates, s.queue, s.pending, [...s.reports].reverse()][tab] as unknown[];
				const timer = setInterval(() => tui.requestRender(), 1000);
				return {
					render(width: number) {
						const now = Date.now();
						const inner = width - 4;
						const head = tabs.map((t, i) => {
							const count = [s.mates.length, s.queue.length, s.pending.length, s.reports.length][i];
							const label = ` ${t} ${count} `;
							return i === tab ? theme.bg("selectedBg", theme.fg("accent", label)) : theme.fg("muted", label);
						});
						const body: string[] = [head.join(" "), ""];
						const paused = pauseText(s, now);
						body.push(paused === "running" ? theme.fg("success", "● running") : theme.fg("warning", `⏸ ${paused}`));
						body.push(`${usageText(s)}  ${theme.fg("dim", `${s.usage.source}, ${ago(now - s.usage.at)} ago`)}`);
						if (s.heldRoles) body.push(theme.fg("warning", s.heldRoles));
						body.push("");
						const list = items();
						row = Math.min(row, Math.max(0, list.length - 1));
						const lines = list.map((item) => {
							if (tab === 0) return mateRow(item as Mate, theme, now, inner - 2);
							if (tab === 1) return `${(item as Queued).task} (${(item as Queued).role}): ${(item as Queued).why}`;
							if (tab === 2) {
								const p = item as Pending;
								return `[${p.kind}] ${p.title}${p.floor ? theme.fg("error", " [floor]") : ""}  ${theme.fg("dim", `${p.from}, ${ago(now - p.at)}`)}`;
							}
							const r = item as Report;
							return `${String(r.n).padStart(3, "0")}  ${clock(r.at)}  ${r.title}: ${r.headline}`;
						});
						if (lines.length === 0) body.push(theme.fg("dim", "  (empty)"));
						lines.forEach((line, i) => body.push(`${i === row ? theme.fg("accent", "›") : " "} ${line}`));
						body.push("", theme.fg("dim", "tab/←→ switch · ↑↓ move · enter open · esc close"));
						return frame(`Team · ${s.team} · ${s.effort}`, `${s.phase} · ${s.plan.accepted}/${s.plan.total} accepted`, body, theme, width);
					},
					handleInput(data: string) {
						const list = items();
						if (matchesKey(data, Key.escape)) return done(undefined);
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							tab = (tab + 1) % tabs.length;
							row = 0;
						} else if (matchesKey(data, Key.left)) {
							tab = (tab + tabs.length - 1) % tabs.length;
							row = 0;
						} else if (matchesKey(data, Key.down)) row = Math.min(list.length - 1, row + 1);
						else if (matchesKey(data, Key.up)) row = Math.max(0, row - 1);
						else if (matchesKey(data, Key.enter) && list.length) {
							if (tab === 0) return done({ kind: "mate", mate: list[row] as Mate });
							if (tab === 2) return done({ kind: "pending" });
							if (tab === 3) return done({ kind: "report", report: list[row] as Report });
						}
						tui.requestRender();
					},
					invalidate() {},
					dispose() {
						clearInterval(timer);
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "85%", minWidth: 60, maxHeight: "80%", anchor: "center" } },
		);
		if (action?.kind === "mate") await attachMenu(ctx, action.mate);
		if (action?.kind === "pending") await pending(ctx);
		if (action?.kind === "report") await viewReport(ctx, action.report);
	}

	// ── C's bare /team ──
	async function menuC(ctx: ExtensionCommandContext): Promise<void> {
		const now = Date.now();
		const options = [
			`Attach to a Teammate (${s.mates.length} live)`,
			`Waiting on you (${s.pending.length})`,
			`Reports (${s.reports.length})`,
			s.pauses.human ? "Resume the Effort" : "Pause the Effort",
		];
		const title = `${s.effort} · ${pauseText(s, now)} · ${usageText(s)}`;
		const choice = await ctx.ui.select(title, options);
		if (!choice) return;
		if (choice.startsWith("Attach")) {
			const mate = await pickMate(ctx, "Attach to…");
			if (mate) {
				mate.prevShort = undefined;
				await attachHere(ctx, mate);
			}
		}
		if (choice.startsWith("Waiting")) await pending(ctx);
		if (choice.startsWith("Reports")) await openReports(ctx);
		if (choice.startsWith("Pause") || choice.startsWith("Resume")) togglePause(ctx);
		paint();
	}

	function togglePause(ctx: ExtensionCommandContext): void {
		s.pauses.human = s.pauses.human ? undefined : { since: Date.now() };
		ctx.ui.notify(s.pauses.human ? "Paused: nothing new starts; running Teammates finish their Task" : "Your pause is lifted", "info");
		paint();
	}

	// ── Commands ──
	pi.registerCommand("team", {
		description: "PROTOTYPE Team view: attach | pending | reports | handback <id> [note] | pause | resume",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const [sub, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const byId = (wanted?: string) => s.mates.find((m) => m.id === wanted);
			if (sub === "attach") {
				const mate = byId(id) ?? (await pickMate(ctx, "Attach to…"));
				if (!mate) return;
				if (variant === "C") {
					mate.prevShort = undefined;
					await attachHere(ctx, mate);
				} else await attachMenu(ctx, mate);
				return paint();
			}
			if (sub === "pending") return pending(ctx);
			if (sub === "reports") return openReports(ctx);
			if (sub === "pause" || sub === "resume") return togglePause(ctx);
			if (sub === "handback") {
				const mate = byId(id) ?? (await pickMate(ctx, "Hand back…"));
				return mate ? handback(ctx, mate, rest.join(" ")) : undefined;
			}
			if (variant === "A") {
				const mate = await pickMate(ctx, `Teammates · ${pauseText(s, Date.now())} · ${usageText(s)}`);
				if (mate) await attachMenu(ctx, mate);
			}
			if (variant === "B") await consoleB(ctx);
			if (variant === "C") await menuC(ctx);
		},
	});

	pi.registerCommand("proto", {
		description: "PROTOTYPE switcher: next | prev | A | B | C | scenario <running|takeover|usage-paused|quiet>",
		getArgumentCompletions: (prefix) =>
			["next", "prev", "A", "B", "C", ...SCENARIOS.map((name) => `scenario ${name}`)].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const [first, second] = args.trim().split(/\s+/);
			const keys = Object.keys(VARIANTS) as Variant[];
			if (first === "scenario") {
				scenarioName = SCENARIOS.includes(second) ? second : SCENARIOS[(SCENARIOS.indexOf(scenarioName) + 1) % SCENARIOS.length];
				s = scenario(scenarioName, Date.now());
			} else if (first === "prev") variant = keys[(keys.indexOf(variant) + keys.length - 1) % keys.length];
			else if (keys.includes(first?.toUpperCase() as Variant)) variant = first.toUpperCase() as Variant;
			else variant = keys[(keys.indexOf(variant) + 1) % keys.length];
			paint();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		paint();
		ticking = setInterval(paint, 5000);
		ticking.unref();
	});

	pi.on("session_shutdown", () => {
		if (ticking) clearInterval(ticking);
	});
}

function staticComponent(render: (width: number) => string[]): Component {
	return { render, invalidate() {} };
}
