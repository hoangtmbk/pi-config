/**
 * What the Lead costs, from pi's session entries.
 */

/**
 * What the Lead's session has cost, as pi's own usage totals add it up: each
 * entry's `usage.cost.total`, from assistant replies, tool results that made
 * model calls, usage entries, and compaction and branch summaries. pi doesn't
 * export the sum (`getUsageCostBreakdown`), so it is mirrored here.
 */
export function leadCost(entries: readonly unknown[]): number {
	let total = 0;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const { type, message, usage } = entry as { type?: unknown; message?: { role?: unknown; usage?: unknown }; usage?: unknown };
		const counted =
			type === "message" && (message?.role === "assistant" || message?.role === "toolResult") ? message.usage : type === "usage" || type === "compaction" || type === "branch_summary" ? usage : undefined;
		const cost = (counted as { cost?: { total?: unknown } } | undefined)?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
	}
	return total;
}
