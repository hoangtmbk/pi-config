/**
 * The writer chain for one compaction, assembled: which writers run, in what
 * order, on what model, with which of pi's settings.
 *
 * Apart from `writers.ts`, which the writers themselves import, so that
 * importing them here makes no cycle.
 */

import type { Message, ThinkingBudgets, Transport } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { forkWriter } from "./fork.ts";
import { piCompactionTokens, type SettingsLike } from "./pressure.ts";
import { serializedWriter } from "./serialized.ts";
import { type Clock, piDefaultWriter, replyModel, retryPolicy, type StreamFn, SYSTEM_CLOCK, type Writer } from "./writers.ts";

/** pi's merged settings, with the request options the agent's own requests carry. */
type ChainSettings = SettingsLike & { transport?: Transport; thinkingBudgets?: ThinkingBudgets };

/** What stands in for the real model call and clock: see `CompactionOptions`. */
export interface ChainInjected {
	stream?: ExtensionContext["modelRegistry"]["streamSimple"];
	clock?: Clock;
}

/**
 * The writers for one compaction, in chain order: the forked call, then
 * serialized mode, then pi's summarizer. The fork is left out when there is
 * no `transcript` — the live context — to send: when it overflowed.
 */
export function writerChain(
	ctx: ExtensionContext,
	settings: SettingsLike,
	branch: readonly SessionEntry[],
	transcript: readonly Message[] | undefined,
	injected: ChainInjected,
): Writer[] {
	const stream: StreamFn = (model, context, streamOptions) =>
		(injected.stream ?? ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry))(model, context, streamOptions);
	const model = replyModel(ctx, branch);
	const options = settings as ChainSettings;
	const window = model?.contextWindow;
	const shared = {
		model,
		thinkingLevel: ctx.thinkingLevel,
		sessionId: ctx.sessionManager.getSessionId(),
		stream,
		clock: injected.clock ?? SYSTEM_CLOCK,
	};
	const fork = transcript
		? forkWriter({
				...shared,
				transcript,
				keptTokens: piCompactionTokens(settings, model, "keepRecentTokens"),
				// As pi's settings manager hands them to the agent.
				transport: options.transport ?? "auto",
				thinkingBudgets: options.thinkingBudgets,
			})
		: undefined;
	return [
		...(fork ? [fork] : []),
		// What it sends must leave the room pi keeps back for a reply.
		serializedWriter({
			...shared,
			room: model && window && window > 0 ? window - piCompactionTokens(settings, model, "reserveTokens") : undefined,
		}),
		piDefaultWriter({ ...shared, retry: retryPolicy(settings) }),
	];
}
