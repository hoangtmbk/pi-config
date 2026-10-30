/**
 * The writer chain: who writes a Handoff's judgment part, and what happens when
 * one of them can't.
 *
 * Writers are tried in order, and the first to succeed writes it. The chain is
 * fork → serialized mode → pi's own summarizer on every path; pi's summarizer
 * is always last, so that even then the parts code writes survive inside our
 * Handoff. A writer fails by throwing, with the reason as its message, and the
 * next one runs. An abort is not a failure: it stops the chain where it is.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, generateSummaryWithUsage, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Judgment } from "./handoff.ts";
import type { LedgerProposal } from "./instruction.ts";

/** The writers, by the name `details.writer` records. */
export type WriterName = "fork" | "serialized" | "pi-default";

/** One writer that failed, and why. */
export interface Attempt {
	writer: WriterName;
	reason: string;
}

/** What every writer is handed. */
export interface WriterJob {
	/** The removed span, oldest first. */
	span: readonly AgentMessage[];
	/** What stays after the Handoff, verbatim, oldest first. A writer writes as of its end. */
	tail: readonly AgentMessage[];
	/** The previous Handoff's judgment part, to be edited rather than rewritten. */
	previousJudgment?: string;
	/** The previous Handoff as the agent read it, whole: what a writer of ours edits. */
	previousHandoff?: string;
	/** `/compact <instructions>`. */
	focus?: string;
	/** The agent's own note, on Self-compaction. */
	note?: string;
	signal: AbortSignal | undefined;
}

export interface Written {
	judgment: Judgment;
	/** What the call cost, for pi's cost line under the compaction card. */
	usage?: Usage;
	/** What the writer proposed for the Constraint ledger. `undefined` from a writer that proposes none, or a reply with no `<ledger>`. */
	ledger?: LedgerProposal;
}

export interface Writer {
	name: WriterName;
	/** Write the judgment part, or throw saying why not. */
	write(job: WriterJob): Promise<Written>;
}

export type ChainOutcome =
	| { status: "written"; writer: WriterName; written: Written; attempts: Attempt[] }
	| { status: "aborted" }
	| { status: "failed"; attempts: Attempt[] };

/** Run `writers` in order until one writes the judgment part. */
export async function runChain(writers: readonly Writer[], job: WriterJob): Promise<ChainOutcome> {
	const attempts: Attempt[] = [];
	for (const writer of writers) {
		if (job.signal?.aborted) return { status: "aborted" };
		try {
			const written = await writer.write(job);
			// A writer that came back after Escape wrote something nobody wants now.
			if (job.signal?.aborted) return { status: "aborted" };
			return { status: "written", writer: writer.name, written, attempts };
		} catch (error) {
			if (job.signal?.aborted) return { status: "aborted" };
			attempts.push({ writer: writer.name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { status: "failed", attempts };
}

/** The model call every writer makes, shaped as pi's summarizer takes it. */
export type StreamFn = NonNullable<Parameters<typeof generateSummaryWithUsage>[9]>;

/** A clock and a timer: what the writers' stall timeout runs on. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long a model call may go with nothing streamed before the attempt counts as hung. */
export const STALL_MS = 60_000;

/**
 * Run one writer's attempt so that a hung provider can't hang the run.
 *
 * `work` makes its model calls through the `stream` it is handed. Every event
 * a call streams resets a 60s timer; if it fires, the call is aborted and the
 * attempt fails at once, without waiting on a provider that may ignore the
 * abort. Only silence counts: there is no cap on a call that keeps streaming,
 * and the time between calls — pi's summarizer backing off to retry — is not
 * counted. Nothing is retried here.
 */
export async function guardStall<T>(stream: StreamFn, clock: Clock, work: (stream: StreamFn) => Promise<T>): Promise<T> {
	const stall = new AbortController();
	let timer: unknown;
	const disarm = () => {
		if (timer !== undefined) clock.clearTimeout(timer);
		timer = undefined;
	};
	let fail!: (error: Error) => void;
	const stalled = new Promise<never>((_, reject) => (fail = reject));
	const arm = () => {
		disarm();
		timer = clock.setTimeout(() => {
			timer = undefined;
			stall.abort();
			fail(new Error(`the provider streamed nothing for ${STALL_MS / 1000}s`));
		}, STALL_MS);
	};

	const guarded: StreamFn = async (model, context, options) => {
		const signal = options?.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
		arm();
		let events: Awaited<ReturnType<StreamFn>>;
		try {
			events = await stream(model, context, { ...options, signal });
		} catch (error) {
			disarm();
			throw error;
		}
		// Watched beside whoever reads the result: the events are only counted.
		void (async () => {
			try {
				for await (const _ of events) if (!stall.signal.aborted) arm();
			} finally {
				if (!stall.signal.aborted) disarm();
			}
		})();
		return events;
	};

	const attempt = work(guarded);
	// Lost to a stall, the attempt may still settle later; nobody is waiting on it then.
	attempt.catch(() => {});
	try {
		return await Promise.race([attempt, stalled]);
	} finally {
		disarm();
	}
}

/**
 * The model that wrote the conversation's last reply, which is what a writer
 * runs on: under a virtual model, that is the physical one behind it. The
 * session's model when no reply says otherwise.
 */
export function replyModel(ctx: ExtensionContext, branch: readonly SessionEntry[]): Model<any> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return ctx.modelRegistry.find(entry.message.provider, entry.message.model) ?? ctx.model;
	}
	return ctx.model;
}

/** pi's retry policy for summaries, read from its `retry` settings with pi's own defaults. */
export function retryPolicy(settings: { retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number } }): RetryPolicy {
	const retry = settings.retry ?? {};
	return {
		enabled: retry.enabled ?? true,
		maxRetries: retry.maxRetries ?? 3,
		baseDelayMs: retry.baseDelayMs ?? 2_000,
		...(retry.maxAgentDelayMs === undefined ? {} : { maxAgentDelayMs: retry.maxAgentDelayMs }),
	};
}

export interface PiDefaultDeps {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	sessionId: string;
	stream: StreamFn;
	clock: Clock;
	retry: RetryPolicy;
}

/**
 * pi's own summarizer, `generateSummaryWithUsage`, as the last writer.
 *
 * It runs over the removed span with pi's own prompt and retry policy, updating
 * the previous judgment part when there is one, and its text stands in for the
 * six judgment sections without being checked against their headings. It throws
 * on a provider error, a reply cut off at the token cap or a tool call, which
 * is this writer failing.
 */
export function piDefaultWriter(deps: PiDefaultDeps): Writer {
	return {
		name: "pi-default",
		async write(job) {
			const model = deps.model;
			if (!model) throw new Error("no model to summarize with");
			const { text, usage } = await guardStall(deps.stream, deps.clock, (stream) =>
				generateSummaryWithUsage(
					[...job.span],
					model,
					undefined,
					undefined,
					undefined,
					job.signal,
					job.focus,
					job.previousJudgment,
					deps.thinkingLevel,
					stream,
					undefined,
					deps.retry,
					undefined,
					deps.sessionId,
				),
			);
			if (!text.trim()) throw new Error("pi's summarizer replied with no text");
			return { judgment: { piDefault: text.trim() }, usage };
		},
	};
}
