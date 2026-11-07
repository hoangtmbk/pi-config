/**
 * When the Lead hears from the extension: at once while its model is idle,
 * or held until its run settles.
 *
 * pi starts one more model turn for anything sent during a run (see
 * `docs/pi-api/limits.md`, "A steer sent at a run's last turn starts one more
 * model turn"), so wakes about Teammates wait for the run to settle and go
 * together. The end-of-Effort message is stored, never a wake: sent while no
 * run is active, pi appends it to the session at once and starts no turn, so
 * it is in the session file even if pi exits before another prompt (#143).
 */

/** The two ways a message reaches the Lead's session. */
export interface LeadSends {
	/** Send `text` and start a turn on it. */
	wake(customType: string, text: string): void;
	/** Store the end-of-Effort message `content` without starting a turn; called only while no run is active. */
	store(content: string): void;
}

export interface LeadWakes {
	/** pi's `agent_start`: the Lead's model is working on a prompt. */
	started(): void;
	/**
	 * pi's `agent_settled`: the held end message is stored, then the Lead is
	 * woken with what waited, followed by `fresh()`, what is new since.
	 */
	settled(fresh: () => string[]): void;
	/** Wake the Lead about its Teammates now, or with everything else once its prompt settles. */
	teammates(texts: string[]): void;
	/** Wake the Lead with what a pick-up after a restart found, now or once its prompt settles. */
	away(text: string): void;
	/** The Lead's end-of-Effort message: stored now while no run is active, else once the run settles. */
	ended(content: string): void;
	/** While the Effort is picked up after a restart, wakes about Teammates are collected into `into` instead, to be said once at the end; undefined ends that. */
	collectInto(into: string[] | undefined): void;
}

export function leadWakes(send: LeadSends): LeadWakes {
	let busy = false;
	let waiting: string[] = [];
	let endHeld: string | undefined;
	let recovering: string[] | undefined;

	function teammates(texts: string[]): void {
		if (recovering) recovering.push(...texts);
		else if (busy) waiting.push(...texts);
		else if (texts.length > 0) send.wake("team-teammate", texts.join("\n\n"));
	}

	return {
		started() {
			busy = true;
		},
		settled(fresh) {
			busy = false;
			// pi marks the run over before this event, so the message is stored at once and starts no turn.
			if (endHeld !== undefined) send.store(endHeld);
			endHeld = undefined;
			// A doorbell is only a nudge: whatever the journals hold now is applied, rung or not.
			const texts = [...waiting, ...fresh()];
			waiting = [];
			teammates(texts);
		},
		teammates,
		away(text) {
			if (busy) waiting.push(text);
			else send.wake("team-away", text);
		},
		ended(content) {
			// Anything sent during a run starts one more model turn, so the message waits for the run to settle.
			if (busy) endHeld = content;
			else send.store(content);
		},
		collectInto(into) {
			recovering = into;
		},
	};
}
