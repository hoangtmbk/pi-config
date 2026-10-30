/**
 * PROTOTYPE — throwaway, never merged. Lives on the `prototype/pressure-levels` branch.
 *
 * Answers "How Pressure levels look": three variants of how notice, warning and
 * forced show in the main session, how a Run's Pressure level shows in the Runs
 * widget and the Inspector, and what the user sees while a compaction runs and
 * once it has finished. Pressure is fake; nothing here reads real context or
 * compacts anything.
 *
 *   npm run prototype:pressure
 *
 *   alt+] / alt+[   next / previous variant
 *   alt+= / alt+-   main pressure ±10k (crossing forced starts a fake compaction)
 *   /pp <k>                     set main pressure, e.g. /pp 152
 *   /pp <run> <k>               set a Run's pressure, e.g. /pp fix-flaky-tests 153
 *   /pc [self|forced|manual|stuck] [<run>]   fake a compaction (stuck = leaves it above warning)
 *   /pinspect [<run>]           open the Inspector mock on a Run
 *   /pwalk                      scripted walk: main and a Run climb through every level
 *
 * The variants:
 *   A Quiet     nothing below notice; one footer status from notice on; a toast at warning;
 *               pi's own working row while compacting. Runs carry a level word only once at notice.
 *   B Gauge     always on: pi's footer with the window percentage replaced by a token gauge
 *               ticked at notice and warning; every Run row carries a small gauge.
 *   C Narrated  nothing persistent: each crossing, and each compaction, is a dim line in the
 *               transcript saying what happened and what the agent was told; a step box while
 *               compacting. Runs say only "compacting"; the Inspector transcript carries the lines.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Run } from "../subagents/supervisor.ts";
import { age, renderRuns } from "../subagents/widget.ts";

const NOTICE = 120_000;
const WARNING = 150_000;
const FORCED = 170_000;
const AFTER = 38_000;
const STUCK = 156_000;

type Variant = "A" | "B" | "C";
const VARIANTS: Variant[] = ["A", "B", "C"];
const VARIANT_NAMES: Record<Variant, string> = { A: "Quiet", B: "Gauge", C: "Narrated" };

type Level = "below" | "notice" | "warning" | "forced";
type Kind = "self" | "forced" | "manual" | "stuck";
type Step = "pruning" | "handoff";

interface Compacting {
	kind: Kind;
	step: Step;
	from: number;
	pruned?: number;
}

interface Finished {
	kind: Kind;
	from: number;
	to: number;
	at: number;
}

interface Pressure {
	name: string;
	tokens: number;
	armed: { notice: boolean; warning: boolean };
	compacting?: Compacting;
	last?: Finished;
	/** What variant C narrates into this context's transcript. Only the Inspector mock reads a Run's. */
	log: { text: string; level: Level }[];
}

interface FakeRun extends Pressure {
	agent: string;
	activity: string;
	askedAt: number;
}

const NOTE = "tests green on auth; next: wire the RPC pressure event into the Runs widget";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function (pi: ExtensionAPI) {
	let variant: Variant = "A";
	let ui: ExtensionContext["ui"] | undefined;
	let modelLabel = "model";
	let frame = 0;
	let ticking: ReturnType<typeof setInterval> | undefined;

	const main: Pressure = fresh("main", 96_000);
	const runs: FakeRun[] = [
		{ ...fresh("scout-auth", 64_000), agent: "scout", activity: "read src/auth/session.ts", askedAt: Date.now() - 95_000 },
		{ ...fresh("fix-flaky-tests", 131_000), agent: "worker", activity: "bash pnpm test --filter auth", askedAt: Date.now() - 192_000 },
	];

	function fresh(name: string, tokens: number): Pressure {
		return { name, tokens, armed: { notice: tokens < NOTICE, warning: tokens < WARNING }, log: [] };
	}

	// ── pressure → level, crossings, fake compaction ─────────────────────────

	function levelOf(tokens: number): Level {
		if (tokens >= FORCED) return "forced";
		if (tokens >= WARNING) return "warning";
		if (tokens >= NOTICE) return "notice";
		return "below";
	}

	function setTokens(p: Pressure, tokens: number): void {
		p.tokens = Math.max(0, tokens);
		for (const level of ["notice", "warning"] as const) {
			const at = level === "notice" ? NOTICE : WARNING;
			if (p.tokens < at) p.armed[level] = true;
			else if (p.armed[level]) {
				p.armed[level] = false;
				// A jump straight to forced compacts at once; a steer for a level it skipped says nothing.
				if (p.tokens < FORCED) crossed(p, level);
			}
		}
		if (p.tokens >= FORCED && !p.compacting) void compact(p, "forced");
		paint();
	}

	/** The moment the agent gets its one steer message. What the *user* sees of it depends on the variant. */
	function crossed(p: Pressure, level: "notice" | "warning"): void {
		const k = kilo(p.tokens);
		const text =
			level === "notice"
				? `context at ${k} · notice · agent told it's a good time to compact`
				: `context at ${k} · warning · agent told again it's a good time to compact`;
		p.log.push({ text, level });
		if (variant === "A" && level === "warning" && p === main) {
			ui?.notify(`Context at ${k} (warning). The agent has been told it's a good time to compact; forced at ${kilo(FORCED)}.`, "warning");
		}
		if (variant === "C" && p === main) pi.appendEntry("pp-narration", { text, level });
	}

	async function compact(p: Pressure, kind: Kind): Promise<void> {
		if (p.compacting) return;
		p.compacting = { kind, step: "pruning", from: p.tokens };
		paint();
		await sleep(1400);
		p.compacting.pruned = 18_000;
		p.compacting.step = "handoff";
		paint();
		await sleep(3200);
		const to = kind === "stuck" ? STUCK : AFTER;
		p.last = { kind, from: p.compacting.from, to, at: Date.now() };
		p.compacting = undefined;
		p.armed = { notice: true, warning: true };
		p.tokens = to;
		if (to >= NOTICE) p.armed.notice = false;
		if (to >= WARNING) p.armed.warning = false;

		const done = `compacted ${kilo(p.last.from)} → ${kilo(to)} · ${kindLabel(kind)}${kind === "self" ? ` · note "${NOTE}"` : ""} · ledger 14 quotes · 9 files`;
		p.log.push({ text: done, level: levelOf(to) });
		if (p === main) {
			// What pi itself draws for a compaction entry, in every variant: the baseline.
			pi.appendEntry("pp-pi-compaction", { tokensBefore: p.last.from });
			if (variant === "C") pi.appendEntry("pp-narration", { text: done, level: levelOf(to) });
		}
		if (to >= WARNING && p === main) {
			// Standing decision from "When and how the agent may Self-compact": notify at warning level.
			ui?.notify(`Compaction left context at ${kilo(to)}, still above warning. Forced compaction is paused until it drops.`, "warning");
		}
		paint();
	}

	function kindLabel(kind: Kind): string {
		if (kind === "self") return "self_compact";
		if (kind === "manual") return "/compact";
		return "forced";
	}

	// ── surfaces ──────────────────────────────────────────────────────────────

	function paint(): void {
		if (!ui) return;
		const t = ui.theme;
		const busy = main.compacting || runs.some((r) => r.compacting);
		if (busy && !ticking) ticking = setInterval(() => (frame++, paint()), 120);
		if (!busy && ticking) {
			clearInterval(ticking);
			ticking = undefined;
		}

		// Main session: footer and the strip above the editor.
		ui.setStatus("pp-pressure", variant === "A" ? quietStatus(t) : undefined);
		if (variant === "B") ui.setFooter((_tui, theme, data) => gaugeFooter(theme, data));
		else ui.setFooter(undefined);
		ui.setWidget("pp-compacting", compactingLines(t), { placement: "aboveEditor" });

		// Runs widget: the real renderer, fed fake Runs whose activity carries the variant's marker.
		ui.setWidget("pp-runs", renderRuns(runs.map(asRun), Date.now()), { placement: "aboveEditor" });

		ui.setWidget("pp-switcher", switcher(t), { placement: "belowEditor" });
	}

	function quietStatus(t: Theme): string | undefined {
		const p = main;
		if (p.compacting) return undefined; // the working row says it
		const level = levelOf(p.tokens);
		if (level === "below") return undefined;
		const text = `ctx ${level} · ${kilo(p.tokens)}`;
		return level === "notice" ? t.fg("muted", text) : t.fg(level === "warning" ? "warning" : "error", text);
	}

	/** What shows above the editor while the main session compacts, per variant. */
	function compactingLines(t: Theme): string[] | undefined {
		const c = main.compacting;
		if (!c) return undefined;
		const spin = t.fg("accent", SPINNER[frame % SPINNER.length]);
		const why = c.kind === "self" ? "Self-compacting" : c.kind === "manual" ? "Compacting (/compact)" : `Compacting at ${kilo(c.from)} (forced)`;
		if (variant === "A") {
			// Mimics pi's working row, which `setWorkingMessage` would set for real.
			const step = c.step === "pruning" ? "pruning old tool output" : "writing Handoff";
			return ["", `${spin} ${t.fg("muted", `${why} · ${step}… (esc to cancel)`)}`];
		}
		if (variant === "B") {
			return ["", `${spin} ${t.fg("muted", `${why}…`)}`];
		}
		const rows = [
			c.step === "pruning" ? `${spin} Pruning old tool output` : t.fg("success", `✓ Pruned 6 tool results (−${kilo(c.pruned ?? 0)})`),
			c.step === "handoff" ? `${spin} Writing Handoff (fork, warm cache)` : t.fg("dim", "· Writing Handoff"),
			t.fg("dim", "· Keeping the last 20k verbatim"),
		];
		return box(`${why}`, rows, t);
	}

	function gaugeFooter(theme: Theme, data: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> }): Component {
		return {
			invalidate() {},
			render(width: number): string[] {
				const branch = data.getGitBranch();
				const pwd = theme.fg("dim", `~/workspace/pi-config${branch ? ` (${branch})` : ""}`);
				const stats = theme.fg("dim", "↑1.2M ↓84k R9.8M W310k CH96.1% $4.210 ");
				const right = theme.fg("dim", modelLabel);
				const left = `${stats}${mainGauge(theme)}`;
				const pad = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
				const lines = [truncateToWidth(pwd, width), truncateToWidth(left + " ".repeat(pad) + right, width)];
				const statuses = [...data.getExtensionStatuses()].filter(([k]) => !k.startsWith("pp-")).map(([, v]) => v);
				if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width));
				return lines;
			},
		};
	}

	function mainGauge(t: Theme): string {
		const p = main;
		if (p.compacting) return t.fg("accent", `ctx ▕${"compacting".padEnd(17, "·")}▏ ${kilo(p.compacting.from)}`);
		const level = levelOf(p.tokens);
		const color = level === "below" ? "dim" : level === "notice" ? "accent" : level === "warning" ? "warning" : "error";
		const recent = p.last && Date.now() - p.last.at < 15_000 ? t.fg("success", ` ↓ from ${kilo(p.last.from)}`) : "";
		return `${t.fg("dim", "ctx ")}${t.fg(color, `▕${gauge(p.tokens, 17)}▏ ${kilo(p.tokens)}`)}${t.fg("dim", `/${kilo(FORCED)}`)}${recent}`;
	}

	/** A Run, as the real Runs widget would get it, with this variant's pressure marker folded into its activity. */
	function asRun(r: FakeRun): Run {
		return { name: r.name, agent: r.agent, task: "", state: "running", askedAt: r.askedAt, activity: runActivity(r) } as Run;
	}

	function runActivity(r: FakeRun): string {
		if (variant === "A") {
			if (r.compacting) return "compacting";
			const level = levelOf(r.tokens);
			return level === "below" ? r.activity : `${level} ${kilo(r.tokens)} · ${r.activity}`;
		}
		if (variant === "B") {
			if (r.compacting) return `▕compact·▏ ${r.activity}`;
			return `▕${gauge(r.tokens, 8)}▏ ${kilo(r.tokens)} · ${r.activity}`;
		}
		return r.compacting ? `compacting · ${r.compacting.step === "pruning" ? "pruning" : "handoff"}` : r.activity;
	}

	/** The Inspector header's extra part for a Run, per variant. */
	function inspectorPressure(r: FakeRun): string {
		if (r.compacting) return "compacting";
		if (variant === "B") return `▕${gauge(r.tokens, 8)}▏ ${kilo(r.tokens)}`;
		const level = levelOf(r.tokens);
		if (variant === "A") return level === "below" ? "" : `${level} ${kilo(r.tokens)}`;
		return kilo(r.tokens);
	}

	function switcher(t: Theme): string[] {
		const label = ` ◀ alt+[   PROTOTYPE · ${variant} (${VARIANT_NAMES[variant]}) · main ${kilo(main.tokens)} ${levelOf(main.tokens)}   alt+] ▶ `;
		return [
			t.bold(t.fg("accent", label)),
			t.fg("dim", " alt+=/- ±10k · /pp [run] <k> · /pc self|forced|manual|stuck [run] · /pinspect [run] · /pwalk"),
		];
	}

	// ── the Inspector mock ────────────────────────────────────────────────────

	async function inspect(ctx: ExtensionContext, name: string | undefined): Promise<void> {
		const r = runs.find((x) => x.name === name) ?? runs[1];
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const repaint = setInterval(() => tui.requestRender(), 250);
				return {
					invalidate() {},
					dispose() {
						clearInterval(repaint);
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape)) done();
					},
					render(width: number): string[] {
						const inner = width - 4;
						const head = [r.name, r.agent, "running", age(asRun(r), Date.now()), inspectorPressure(r)].filter(Boolean).join(" · ");
						const body = [
							theme.fg("dim", "› read src/auth/session.ts"),
							theme.fg("dim", "› bash pnpm test --filter auth"),
							"  3 failing: session refresh races the token rotation…",
							...(variant === "C" ? r.log.map((l) => theme.fg(levelColor(l.level), `── ${l.text} ──`)) : []),
							...(r.last && variant !== "C" ? [theme.fg("customMessageLabel", `[compaction] Compacted from ${r.last.from.toLocaleString()} tokens`)] : []),
						];
						const lines = [theme.bold(head), "", ...body, "", theme.fg("dim", "esc to close · (editor omitted in the mock)")];
						return box(`Inspector (mock) · variant ${variant}`, lines.map((l) => truncateToWidth(l, inner)), theme, width);
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
		);
	}

	// ── wiring ────────────────────────────────────────────────────────────────

	pi.registerEntryRenderer<{ text: string; level: Level }>("pp-narration", (entry, _o, theme) =>
		new Text(theme.fg(levelColor(entry.data?.level ?? "below"), `── ${entry.data?.text} ──`), 1, 0),
	);
	pi.registerEntryRenderer<{ tokensBefore: number }>("pp-pi-compaction", (entry, _o, theme) => {
		const n = (entry.data?.tokensBefore ?? 0).toLocaleString();
		const card = [
			theme.fg("customMessageLabel", theme.bold("[compaction]")),
			"",
			theme.fg("customMessageText", `Compacted from ${n} tokens (ctrl+o to expand)`),
		].join("\n");
		return new Text(`${theme.bg("customMessageBg", card)}\n${theme.fg("warning", "Compaction: 41k tokens billed (~$0.09)")}`, 1, 1);
	});

	pi.on("session_start", async (_e, ctx) => {
		ui = ctx.ui;
		modelLabel = ctx.model ? `${ctx.model.id}` : "model";
		paint();
	});

	const cycle = (by: number) => () => {
		variant = VARIANTS[(VARIANTS.indexOf(variant) + by + VARIANTS.length) % VARIANTS.length];
		paint();
	};
	pi.registerShortcut("alt+]", { description: "PROTOTYPE: next pressure variant", handler: cycle(1) });
	pi.registerShortcut("alt+[", { description: "PROTOTYPE: previous pressure variant", handler: cycle(-1) });
	pi.registerShortcut("alt+=", { description: "PROTOTYPE: main pressure +10k", handler: () => setTokens(main, main.tokens + 10_000) });
	pi.registerShortcut("alt+-", { description: "PROTOTYPE: main pressure −10k", handler: () => setTokens(main, main.tokens - 10_000) });

	pi.registerCommand("pp", {
		description: "PROTOTYPE: set pressure in k — /pp <k> or /pp <run> <k>",
		handler: async (args) => {
			const [a, b] = args.trim().split(/\s+/);
			const run = runs.find((r) => r.name === a);
			if (run && b) setTokens(run, Number(b) * 1000);
			else if (a && Number.isFinite(Number(a))) setTokens(main, Number(a) * 1000);
		},
	});
	pi.registerCommand("pc", {
		description: "PROTOTYPE: fake a compaction — /pc [self|forced|manual|stuck] [run]",
		handler: async (args) => {
			const [a, b] = args.trim().split(/\s+/);
			const kind = (["self", "forced", "manual", "stuck"] as const).find((k) => k === a) ?? "self";
			const target = runs.find((r) => r.name === (b ?? (runs.some((r) => r.name === a) ? a : undefined))) ?? main;
			void compact(target, kind);
		},
	});
	pi.registerCommand("pinspect", {
		description: "PROTOTYPE: open the Inspector mock on a Run",
		handler: async (args, ctx) => inspect(ctx, args.trim() || undefined),
	});
	pi.registerCommand("pwalk", {
		description: "PROTOTYPE: walk main and fix-flaky-tests through every level",
		handler: async () => {
			const run = runs[1];
			setTokens(main, 96_000);
			setTokens(run, 131_000);
			for (const [p, k] of [
				[main, 121],
				[run, 153],
				[main, 138],
				[main, 152],
				[run, 171],
				[main, 163],
				[main, 172],
			] as const) {
				await sleep(2600);
				setTokens(p, k * 1000);
			}
		},
	});
}

// ── small pieces ─────────────────────────────────────────────────────────────

function kilo(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

/** Plain text, so a Run's row stays colourless: filled to `tokens`, ticked at notice and warning, full at forced. */
function gauge(tokens: number, cells: number): string {
	const per = FORCED / cells;
	const ticks = new Set([Math.round(NOTICE / per) - 1, Math.round(WARNING / per) - 1]);
	let out = "";
	for (let i = 0; i < cells; i++) out += tokens >= (i + 1) * per ? "█" : ticks.has(i) ? "┊" : "·";
	return out;
}

function levelColor(level: Level): "dim" | "accent" | "warning" | "error" | "success" {
	if (level === "notice") return "accent";
	if (level === "warning") return "warning";
	if (level === "forced") return "error";
	return "dim";
}

function box(title: string, rows: string[], t: Theme, width?: number): string[] {
	const inner = Math.max(visibleWidth(title) + 2, ...rows.map(visibleWidth), (width ?? 0) - 4);
	const top = `╭─ ${title} ${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}╮`;
	const body = rows.map((r) => `│ ${r}${" ".repeat(Math.max(0, inner - visibleWidth(r)))} │`);
	return [t.fg("dim", top), ...body.map((b) => b), t.fg("dim", `╰${"─".repeat(inner + 2)}╯`)];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
