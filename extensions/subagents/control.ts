/**
 * The control plane: what a human can do to a Run directly, from outside the
 * parent conversation.
 *
 * Types only. The implementation lives inside `registerSubagents`, next to the
 * children and the Supervisor it has to reach, and is handed out from there; the
 * Inspector consumes it without knowing a process or a Supervisor exists.
 *
 * Two verbs and no more, deliberately. Everything else a human could want —
 * reading a Run, waiting on one — is already something the parent does or the
 * transcript shows, and a control plane that grew a third verb for it would be a
 * second way into the lifecycle that the parent's tools do not go through.
 */

/**
 * What became of a human message sent into a Run.
 *
 * `as` says which of the two meanings it took, because that was decided by the
 * Run's state at the moment it was sent rather than by the person typing it: a
 * running Run takes a steer, and a Waiting one takes its Question's answer.
 *
 * A refusal is one line, shown to the user verbatim. It is never a thrown error,
 * because nothing here is a fault: a Run that finished between the keypress and
 * the send is the ordinary race of steering something that is moving, and the
 * honest answer to it is a sentence, not a stack.
 */
export type SendOutcome =
	| { ok: true; as: "steer" | "answer" }
	| {
			ok: false;
			/** Why nothing was sent, in one line, said to the user as it stands. */
			reason: string;
	  };

/** What the Inspector is handed to act on a Run with. */
export interface RunControl {
	/**
	 * Send a human message into a Run, its meaning decided by the Run's state at
	 * call time.
	 *
	 * A running Run is steered: its child takes the message at its next turn
	 * boundary. A Waiting Run is answered, exactly as `subagent_answer` would have
	 * answered it — and a later `subagent_answer` for that same Question is then
	 * refused as already answered by the user. Either way the parent conversation
	 * is told, without being woken, so that the Delivery arriving later is not
	 * the first it hears of the Run's direction changing.
	 *
	 * Anything else — a queued Run with no child yet, a finished one whose child is
	 * gone — comes back refused, never silently dropped.
	 */
	send(name: string, text: string): Promise<SendOutcome>;
	/**
	 * End one Run, the way the user asked for: it fails as stopped, its failure is
	 * delivered to the parent like any other, and its child is reaped.
	 *
	 * Works on a queued Run too, which leaves the queue without ever starting.
	 * Resolves false for a Run that had already stopped, or a name this session
	 * never started — there was nothing left to kill.
	 */
	kill(name: string): Promise<boolean>;
}
