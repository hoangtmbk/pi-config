/**
 * URL rewrites: swap a human-facing page for the machine-readable source behind
 * it (raw file, API document, Parsoid HTML). Rendering the rewritten payload is
 * `renderers.ts`; fetching it — and falling back — is the fetch layer's job.
 *
 * Pure and I/O-free: every rule is a string transform on a parsed URL, so the
 * whole module is table-testable.
 */

export interface Rewrite {
	/** Where to fetch instead of the original. */
	url: URL;
	/** One-line explanation, surfaced to the caller so the swap is never silent. */
	note: string;
	/**
	 * Fetch this if `url` answers non-2xx. Every rule sets it to the original
	 * URL: a rewrite is a guess about where the content lives — an API can
	 * rate-limit, an arXiv paper can have no HTML rendering, and a raw-file
	 * address can be wrong — and losing the page beats showing an error.
	 */
	fallback?: URL;
}

/** StackExchange sites reachable under their own domain rather than `*.stackexchange.com`. */
const STACK_EXCHANGE_DOMAINS: Record<string, string> = {
	"stackoverflow.com": "stackoverflow",
	"superuser.com": "superuser",
	"serverfault.com": "serverfault",
	"askubuntu.com": "askubuntu",
};

/** Question ids are numeric everywhere on the network. */
const QUESTION_ID = /^\d+$/;

/** `1706.03762`, `1706.03762v5`, and the pre-2007 `hep-th/9901001` form. */
const ARXIV_NEW_ID = /^\d{4}\.\d{4,5}(v\d+)?$/;
const ARXIV_OLD_ID = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;

/**
 * Rewrite `url` to a machine-readable equivalent, or return undefined to leave
 * it alone. Query strings on the source are dropped unless a rule needs them.
 */
export function rewriteUrl(url: URL): Rewrite | undefined {
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const host = url.hostname.replace(/^www\./, "").toLowerCase();
	// Encoded segments are kept as-is: the targets take the same encoding.
	const path = url.pathname.split("/").filter((segment) => segment !== "");

	if (host === "github.com") return github(url, path);
	if (host === "npmjs.com") return npm(url, path);
	if (host === "arxiv.org") return arxiv(url, path);
	if (host === "pypi.org") return pypi(url, path);
	if (host.endsWith(".wikipedia.org")) return wikipedia(url, host, path);

	const site = STACK_EXCHANGE_DOMAINS[host] ?? stackExchangeSubdomain(host);
	if (site !== undefined) return stackExchange(url, path, site);
	return undefined;
}

/** `github.com/{owner}/{repo}/blob/{ref}/{path...}` → the raw file. */
function github(url: URL, path: string[]): Rewrite | undefined {
	const [owner, repo, kind, ...rest] = path;
	if (kind !== "blob" || owner === undefined || repo === undefined || rest.length < 2) return undefined;
	// Line fragments survive the swap: they are what the user was pointing at.
	const raw = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`);
	raw.hash = url.hash;
	// A ref may contain slashes (`release/1.0`, `dependabot/npm_and_yarn/...`), and
	// nothing in the URL says where the ref ends and the path begins — so the split
	// above is a guess, and a wrong guess 404s. The blob page catches those.
	return { url: raw, note: "github blob → raw", fallback: url };
}

/** `{site}.stackexchange.com`, minus the API host itself. */
function stackExchangeSubdomain(host: string): string | undefined {
	if (!host.endsWith(".stackexchange.com")) return undefined;
	const site = host.slice(0, -".stackexchange.com".length);
	if (site === "" || site === "api" || site.includes(".")) return undefined;
	return site;
}

/**
 * A question page → the API document for that question. `/a/{id}` is an answer
 * id, which the questions endpoint cannot resolve, so it is left alone.
 */
function stackExchange(url: URL, path: string[], site: string): Rewrite | undefined {
	const [kind, id] = path;
	if (kind !== "questions" && kind !== "q") return undefined;
	if (id === undefined || !QUESTION_ID.test(id)) return undefined;
	return {
		url: new URL(`https://api.stackexchange.com/2.3/questions/${id}?site=${site}&filter=withbody`),
		note: "stackoverflow → StackExchange API",
		fallback: url,
	};
}

/** `npmjs.com/package/{name}[/v/{version}]` → the registry document. */
function npm(url: URL, path: string[]): Rewrite | undefined {
	if (path[0] !== "package" || path.length < 2) return undefined;
	let rest = path.slice(1);
	// A scope may arrive as one already-encoded segment or as two path segments.
	let name = rest[0]!;
	if (name.startsWith("@") && !name.includes("%2F") && !name.includes("%2f")) {
		if (rest.length < 2) return undefined;
		name = `${name}%2F${rest[1]}`;
		rest = rest.slice(1);
	}
	rest = rest.slice(1);

	let target = `https://registry.npmjs.org/${name}`;
	if (rest.length !== 0) {
		if (rest.length !== 2 || rest[0] !== "v") return undefined;
		target += `/${rest[1]}`;
	}
	return { url: new URL(target), note: "npm → registry", fallback: url };
}

/** `{lang}.wikipedia.org/wiki/{Title}` → Parsoid HTML, which has no site chrome. */
function wikipedia(url: URL, host: string, path: string[]): Rewrite | undefined {
	const lang = host.slice(0, -".wikipedia.org".length);
	if (lang === "" || lang.includes(".")) return undefined;
	if (path[0] !== "wiki" || path.length !== 2) return undefined;
	const title = path[1]!;
	// `Special:`, `File:`, `Talk:` … — non-article namespaces have no useful Parsoid form.
	if (decodeURIComponent(title).includes(":")) return undefined;
	return {
		url: new URL(`https://${host}/api/rest_v1/page/html/${title}`),
		note: "wikipedia → Parsoid HTML",
		fallback: url,
	};
}

/** `arxiv.org/abs/{id}` → the HTML rendering. `/pdf/` is left to the PDF path. */
function arxiv(url: URL, path: string[]): Rewrite | undefined {
	if (path[0] !== "abs" || path.length < 2) return undefined;
	const id = path.slice(1).join("/");
	if (!ARXIV_NEW_ID.test(id) && !ARXIV_OLD_ID.test(id)) return undefined;
	// Papers older than late 2023 have no HTML rendering; the abs page is the fallback.
	return { url: new URL(`https://arxiv.org/html/${id}`), note: "arxiv abs → html", fallback: url };
}

/** `pypi.org/project/{name}[/{version}]` → the JSON API. */
function pypi(url: URL, path: string[]): Rewrite | undefined {
	if (path[0] !== "project" || path.length < 2 || path.length > 3) return undefined;
	const suffix = path.length === 3 ? `${path[1]}/${path[2]}` : path[1];
	return { url: new URL(`https://pypi.org/pypi/${suffix}/json`), note: "pypi → JSON API", fallback: url };
}
