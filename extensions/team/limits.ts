/**
 * The core's classifier of a Teammate's `StopFailure`: what kind of failure
 * Claude Code's `error` and its message name, and when a usage limit resets.
 *
 * The limit-message text is a fragile dependency on Claude Code's wording, so it
 * is parsed here and nowhere else: the core asks {@link classify} and acts on the
 * kind it gets back. A message this module does not recognise is `unknown`, which
 * the core hands to the Lead rather than guessing.
 */

/** A usage limit as Claude Code names it: the whole account's, or one model family's. */
export type LimitKind = "session" | "weekly" | "opus" | "sonnet";

/** The model families a limit or a usage-credit confirm can hold a Role on. */
export type Family = "opus" | "sonnet" | "fable";

/** A failure that clears by itself: retried on the ladder, never a pause. */
export type TransientWhy = "throttle" | "overloaded" | "server_error";

export type Failure =
	/** A usage limit. `reset` is when it lifts, when the message says so; `armed` when Claude Code will continue by itself. */
	| { kind: "limit"; limit: LimitKind; reset?: string; armed: boolean }
	/** Claude Code asked to spend usage credits and nobody confirmed: only the human answers that. */
	| { kind: "consent" }
	| { kind: "transient"; why: TransientWhy }
	| { kind: "unknown"; error?: string };

/** The model family each model-scoped limit belongs to. */
export const LIMIT_FAMILY: Partial<Record<LimitKind, Family>> = { opus: "opus", sonnet: "sonnet" };

/** The family a usage-credit confirm holds: the one Claude Code charges credits for. */
export const CONSENT_FAMILY: Family = "fable";

const LIMIT = /hit your (session|5-hour|weekly|opus|sonnet) limit/i;
const RESETS = /resets\s+([^\n·]+)/i;
const ARMED = /continuing automatically/i;

/**
 * What a `StopFailure` is. `error` is Claude Code's error code and `message` the
 * text it showed; `at` is when it failed and `offsetMinutes` the machine's UTC
 * offset, which a reset naming no time zone is read in.
 */
export function classify(error: string | undefined, message: string | undefined, at: string, offsetMinutes = 0): Failure {
	const text = message ?? "";
	if (/went unanswered/i.test(text)) return { kind: "consent" };
	if (/not your usage limit/i.test(text)) return { kind: "transient", why: "throttle" };
	const limit = LIMIT.exec(text);
	if (limit) {
		const named = limit[1].toLowerCase();
		const kind: LimitKind = named === "5-hour" ? "session" : (named as LimitKind);
		const resets = RESETS.exec(text);
		const reset = resets ? resetAt(resets[1], at, offsetMinutes) : undefined;
		return { kind: "limit", limit: kind, ...(reset ? { reset } : {}), armed: ARMED.test(text) };
	}
	if (error === "overloaded" || /\b529\b|overloaded/i.test(text)) return { kind: "transient", why: "overloaded" };
	if (error === "server_error") return { kind: "transient", why: "server_error" };
	return error ? { kind: "unknown", error } : { kind: "unknown" };
}

/** A model's family, from an alias (`opus`, `sonnet[1m]`) or a full id (`claude-opus-4-1`). */
export function familyOf(model: string | undefined): Family | undefined {
	if (!model) return undefined;
	if (/opus/i.test(model)) return "opus";
	if (/sonnet/i.test(model)) return "sonnet";
	if (/fable/i.test(model)) return "fable";
	return undefined;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The next moment after `at` that a reset like `3:45pm`, `Mon 12:00am`,
 * `Nov 20, 9am` or `3pm (Asia/Saigon)` names, as an ISO time; undefined when the
 * words are not a time this reads.
 */
function resetAt(words: string, at: string, offsetMinutes: number): string | undefined {
	const zone = /\(([^)]+)\)/.exec(words)?.[1];
	const offset = (zone === undefined ? undefined : zoneOffset(zone, at)) ?? offsetMinutes;
	const text = words.replace(/\([^)]*\)/, "").trim().toLowerCase();
	const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/.exec(text);
	if (!time || (!time[3] && !time[2])) return undefined;
	let hours = Number(time[1]);
	const minutes = Number(time[2] ?? 0);
	if (time[3]) {
		if (hours < 1 || hours > 12) return undefined;
		hours = (hours % 12) + (time[3] === "pm" ? 12 : 0);
	}
	if (hours > 23 || minutes > 59) return undefined;
	const head = text.slice(0, time.index).replace(/[,\s]+$/, "");

	const now = Date.parse(at);
	const local = new Date(now + offset * MINUTE);
	const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
	const clockTime = (hours * 60 + minutes) * MINUTE;
	const toUtc = (localMs: number) => localMs - offset * MINUTE;

	let candidate: number;
	const monthDay = /^([a-z]{3})[a-z]*\s+(\d{1,2})$/.exec(head);
	const weekday = WEEKDAYS.indexOf(head.slice(0, 3));
	if (monthDay && MONTHS.includes(monthDay[1])) {
		const month = MONTHS.indexOf(monthDay[1]);
		candidate = toUtc(Date.UTC(local.getUTCFullYear(), month, Number(monthDay[2])) + clockTime);
		if (candidate <= now) candidate = toUtc(Date.UTC(local.getUTCFullYear() + 1, month, Number(monthDay[2])) + clockTime);
	} else if (head === "") {
		candidate = toUtc(dayStart + clockTime);
		if (candidate <= now) candidate += DAY;
	} else if (weekday >= 0) {
		candidate = toUtc(dayStart + ((weekday - local.getUTCDay() + 7) % 7) * DAY + clockTime);
		if (candidate <= now) candidate += 7 * DAY;
	} else return undefined;
	return new Date(candidate).toISOString();
}

/** A named time zone's UTC offset in minutes at `at`, or undefined when the zone is not one this machine knows. */
function zoneOffset(zone: string, at: string): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
		}).formatToParts(new Date(at));
		const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
		const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
		const instant = Math.floor(Date.parse(at) / MINUTE) * MINUTE;
		return Math.round((wall - instant) / MINUTE);
	} catch {
		return undefined;
	}
}
