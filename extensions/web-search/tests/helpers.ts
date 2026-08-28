/**
 * Shared plumbing for the web-search suite.
 *
 * Nothing here touches the network: `fakeFetch` stands in for the platform
 * `fetch` so a test can assert the exact request a search sends and choose the
 * exact response it gets back.
 */

export interface Call {
	url: string;
	init: RequestInit;
}

/** A `fetch` that records its calls and replies with `respond`. */
export function fakeFetch(respond: (call: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const call = { url: String(input), init };
		calls.push(call);
		return respond(call);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

/**
 * A `fetch` that never answers, and rejects when the request is aborted.
 *
 * An already-aborted signal rejects at once, exactly as the platform `fetch`
 * does — a request that is never made cannot wait for an abort event that has
 * already fired.
 *
 * While it stalls it holds a timer, which is not busywork. A real request in
 * flight holds an open socket and that socket keeps the event loop alive; this
 * stand-in holds nothing, and the deadline waiting on it cannot help, because
 * the timer behind `AbortSignal.timeout` is deliberately unref'd. So a test
 * whose only pending work is a stalled request can leave the process with
 * nothing to do, and Node exits before the timeout it is testing ever fires.
 * `node:test` reports that as "Promise resolution is still pending but the
 * event loop has already resolved", and cancels every test after it in the
 * file — intermittently, since whether the loop is empty depends on what else
 * happens to be running.
 */
export function stalledFetch(): typeof globalThis.fetch {
	return (async (_input: RequestInfo | URL, init: RequestInit = {}) =>
		new Promise<Response>((_resolve, reject) => {
			if (init.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			// Only when something can actually end the wait. A keep-alive on a
			// request with no signal would hang the run rather than fail it.
			if (!init.signal) return;

			const socket = setInterval(() => {}, 1_000);
			init.signal.addEventListener("abort", () => {
				clearInterval(socket);
				reject(new Error("aborted"));
			});
		})) as typeof globalThis.fetch;
}

export function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The error a promise rejects with — assertions read better than matchers. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to reject");
}

/** The error a synchronous call throws. */
export function thrown(call: () => unknown): Error {
	try {
		call();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to throw");
}
