/**
 * Pressure: the Pressure levels, and which one a `turn_end` acts on.
 *
 * Pure — no pi, no I/O. It is handed a token count at each boundary and says
 * which level, if any, has just been crossed; the caller does the acting.
 */

export type Level = "notice" | "warning" | "forced";

/** The three Pressure levels, as token counts. Always notice < warning < forced. */
export type Levels = Record<Level, number>;

/** The levels a session gets when nothing else says otherwise. */
export const DEFAULT_LEVELS: Levels = { notice: 120_000, warning: 150_000, forced: 170_000 };

/** Lowest first, which is the order crossings are checked in. */
const LEVELS: readonly Level[] = ["notice", "warning", "forced"];

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
