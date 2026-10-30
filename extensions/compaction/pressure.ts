/**
 * Pressure: the Pressure levels, and which one a `turn_end` acts on.
 *
 * Pure — no pi, no I/O. It resolves the levels for a model from the settings
 * it is handed, and is handed a token count at each boundary and says which
 * level, if any, has just been crossed; the caller does the acting.
 */

export type Level = "notice" | "warning" | "forced";

/** The three Pressure levels, as token counts. Always notice < warning < forced. */
export type Levels = Record<Level, number>;

/** The levels a session gets when nothing else says otherwise. */
export const DEFAULT_LEVELS: Levels = { notice: 120_000, warning: 150_000, forced: 170_000 };

/** Lowest first, which is the order crossings are checked in. */
const LEVELS: readonly Level[] = ["notice", "warning", "forced"];

/** pi's merged settings, as `pi.getSettings()` hands them over: read, never trusted. */
export type SettingsLike = Record<string, unknown>;

/** What resolving the levels needs to know of the model: its key, and its window if it reports one. */
export interface ModelLike {
	provider: string;
	id: string;
	contextWindow?: number;
}

/** pi's built-in `compaction.*` token settings. */
const PI_COMPACTION_TOKENS = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

/** Where forced lands when the levels are scaled: this share of pi's own trigger. */
const SCALED_FORCED = 0.85;

/** A plain object: `typeof` alone lets arrays and `null` through. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pi's own `compaction` settings, read but never trusted. */
function piCompaction(settings: SettingsLike): Record<string, unknown> {
	return isObject(settings.compaction) ? settings.compaction : {};
}

/**
 * One of pi's `compaction.*` token settings for `model`: its override, then
 * the plain setting, then pi's default — the way pi's
 * `getCompactionTokenSetting` resolves it, so that `/compact`, pi's backstop
 * and our levels go by the same numbers. pi throws on a bad value; here it
 * falls through instead, and pi will report it itself.
 */
export function piCompactionTokens(settings: SettingsLike, model: ModelLike | undefined, field: keyof typeof PI_COMPACTION_TOKENS): number {
	const compaction = piCompaction(settings);
	const overrides = isObject(compaction.modelOverrides) ? compaction.modelOverrides : {};
	const override = model ? overrides[`${model.provider}/${model.id}`] : undefined;
	const usable = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	const candidates = [isObject(override) ? override[field] : undefined, compaction[field]];
	return candidates.find(usable) ?? PI_COMPACTION_TOKENS[field];
}

/**
 * pi's `compaction.enabled`, which here decides only whether forced may
 * compact. Turned off, notice, warning, the steers and everything else go on
 * working: nothing compacts unless someone chooses it.
 */
export function forcedEnabled(settings: SettingsLike): boolean {
	return Boolean(piCompaction(settings).enabled ?? true);
}

/**
 * Bring `levels` inside a small window: one factor for all three, so that
 * forced sits at 85% of pi's trigger (window − `reserveTokens`) and the
 * spacing between them holds. Left alone when the model reports no window, or
 * forced is already below the trigger — or the trigger is no use to aim at.
 */
function scaled(levels: Levels, settings: SettingsLike, model: ModelLike | undefined): Levels {
	const window = model?.contextWindow;
	if (!model || typeof window !== "number" || window <= 0) return levels;
	const trigger = window - piCompactionTokens(settings, model, "reserveTokens");
	if (trigger <= 0 || levels.forced < trigger) return levels;
	const target = trigger * SCALED_FORCED;
	const scale = (tokens: number) => Math.max(1, Math.round((tokens * target) / levels.forced));
	return { notice: scale(levels.notice), warning: scale(levels.warning), forced: scale(levels.forced) };
}

/** The levels a model goes by, and what was wrong with the configuration, if anything. */
export interface ResolvedLevels {
	levels: Levels;
	/** One line per problem, each naming the bad key. Empty when the configuration is sound. */
	problems: string[];
}

const FALLBACK = "Using the default Pressure levels.";

/** A setting's value as the user wrote it in `settings.json`. */
function written(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

/**
 * The levels `settings` give `model`, from the top-level `pressureLevels` key.
 *
 * Each level resolves on its own: the model's override, keyed by its exact
 * `provider/modelId` as pi's own `compaction.modelOverrides` are, then the
 * plain setting, then the built-in default. A set that took no level from the
 * override is then scaled to the model's window; one that did is used exactly
 * as written, even past pi's trigger, so a model can be left to pi's backstop
 * on purpose.
 *
 * Bad configuration never throws. A level that isn't a positive safe integer,
 * a shape that isn't an object, or a set that isn't strictly notice < warning
 * < forced puts the model on the defaults — still scaled — and says why.
 */
export function resolveLevels(settings: SettingsLike, model: ModelLike | undefined): ResolvedLevels {
	const defaults = (problems: string[]): ResolvedLevels => ({ levels: scaled(DEFAULT_LEVELS, settings, model), problems });
	const notObject = (key: string, value: unknown) => `Invalid ${key}: ${written(value)} is not an object. ${FALLBACK}`;

	const config = settings.pressureLevels;
	if (config === undefined) return defaults([]);
	if (!isObject(config)) return defaults([notObject("pressureLevels", config)]);
	const overrides = config.modelOverrides ?? {};
	if (!isObject(overrides)) return defaults([notObject("pressureLevels.modelOverrides", overrides)]);
	const modelKey = model ? `${model.provider}/${model.id}` : undefined;
	const overrideKey = `pressureLevels.modelOverrides[${JSON.stringify(modelKey)}]`;
	const override = modelKey === undefined ? undefined : overrides[modelKey];
	if (override !== undefined && !isObject(override)) return defaults([notObject(overrideKey, override)]);

	// Each level, and the key it came from: `undefined` for the default.
	const levels = { ...DEFAULT_LEVELS };
	const from: Partial<Record<Level, string>> = {};
	const problems: string[] = [];
	let fromOverride = false;
	for (const level of LEVELS) {
		const [key, value] =
			override?.[level] !== undefined
				? [`${overrideKey}.${level}`, override[level]]
				: config[level] !== undefined
					? [`pressureLevels.${level}`, config[level]]
					: [undefined, undefined];
		if (key === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			problems.push(`Invalid ${key}: ${written(value)} is not a positive whole number of tokens. ${FALLBACK}`);
			continue;
		}
		levels[level] = value;
		from[level] = key;
		if (override?.[level] !== undefined) fromOverride = true;
	}
	if (problems.length > 0) return defaults(problems);

	const named = (level: Level) => `${level} (${levels[level]}, ${from[level] ?? "the default"})`;
	for (const [lower, upper] of [["notice", "warning"], ["warning", "forced"]] as const) {
		if (levels[lower] >= levels[upper]) {
			return defaults([`Invalid pressureLevels: ${named(lower)} must be below ${named(upper)}. ${FALLBACK}`]);
		}
	}

	return { levels: fromOverride ? levels : scaled(levels, settings, model), problems: [] };
}

/** The highest level `tokens` is at or above, or `undefined` below notice. */
export function levelAt(tokens: number, levels: Levels): Level | undefined {
	return [...LEVELS].reverse().find((level) => tokens >= levels[level]);
}

/**
 * Which levels are crossed, and the one a boundary acts on.
 *
 * A level counts as crossed while pressure is at or above it, and re-arms only
 * once pressure falls below it again — so a level acts once per crossing, not
 * once per turn spent above it. When one boundary crosses several levels at
 * once, only the highest acts; the ones under it are marked crossed without
 * acting, because what they would have said is moot.
 */
export class Crossings {
	private readonly crossed = new Set<Level>();

	/** Take a reading. Returns the level newly crossed at it, if any — the highest, when several are. */
	observe(tokens: number, levels: Levels): Level | undefined {
		let acts: Level | undefined;
		for (const level of LEVELS) {
			if (tokens < levels[level]) this.crossed.delete(level);
			else if (!this.crossed.has(level)) {
				this.crossed.add(level);
				acts = level;
			}
		}
		return acts;
	}
}

/**
 * Whether forced compacts at a boundary, and the guards that hold it back.
 *
 * Unlike notice and warning, forced is not spent by crossing it: it acts at
 * every boundary at or above it until a compaction lands, so one that Escape
 * stopped happens at the next boundary instead. What holds it back:
 *
 * - `compaction.enabled: false`, for as long as it is set;
 * - the warning-pause guard: once a compaction, on either path, has left
 *   pressure at or above warning, forcing waits until pressure drops below
 *   warning, so compactions that can't keep up don't follow each other every
 *   turn;
 * - every writer failing, which disarms it for the rest of the run.
 */
export class Forced {
	private paused = false;
	private disarmed = false;
	/** A compaction landed, and no reading since has said what it left. */
	private landed = false;

	/** A compaction landed. The next reading says whether it kept up. */
	compacted(): void {
		this.landed = true;
	}

	/** Every writer failed: no forcing again this run. */
	disarm(): void {
		this.disarmed = true;
	}

	/** A new run, in which forcing that failed in the last may be tried again. */
	rearm(): void {
		this.disarmed = false;
	}

	/**
	 * Take a reading. `leftHigh` says this is the first reading after a
	 * compaction and it is still at or above warning: the guard has gone on.
	 */
	observe(tokens: number, levels: Levels, enabled: boolean): { forces: boolean; leftHigh: boolean } {
		let leftHigh = false;
		if (this.landed) {
			this.landed = false;
			if (tokens >= levels.warning) this.paused = leftHigh = true;
		}
		if (tokens < levels.warning) this.paused = false;
		return { forces: enabled && !this.paused && !this.disarmed && tokens >= levels.forced, leftHigh };
	}
}
