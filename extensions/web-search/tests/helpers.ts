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
 */
export function stalledFetch(): typeof globalThis.fetch {
	return (async (_input: RequestInfo | URL, init: RequestInit = {}) =>
		new Promise<Response>((_resolve, reject) => {
			if (init.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
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
