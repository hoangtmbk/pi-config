/**
 * Markdown renderers for the JSON that `rewrite.ts` steers us to.
 *
 * A registry packument or a StackExchange answer dump is mostly punctuation by
 * weight; dumping it raw burns context for nothing. Each renderer keeps the few
 * fields a reader actually wants and drops the rest. Unknown shapes return
 * undefined so the caller can fall back to pretty-printed JSON.
 */

/** Supplied by the caller (extract.ts owns the HTML→markdown pipeline). */
export type HtmlToMarkdown = (html: string) => string;

/** Answers are the point of a StackExchange question; more than this is noise. */
const MAX_ANSWERS = 10;

/** Registry packuments list every version ever published. Recent ones suffice. */
const MAX_VERSIONS = 10;

/**
 * Render `json` fetched from `finalUrl` as markdown, or undefined when neither
 * the host nor the payload shape is one we know.
 */
export function renderKnownJson(finalUrl: URL, json: unknown, htmlToMarkdown: HtmlToMarkdown): string | undefined {
	if (!isRecord(json)) return undefined;
	const host = finalUrl.hostname.toLowerCase();
	if (host === "api.stackexchange.com") return stackExchange(json, htmlToMarkdown);
	if (host === "registry.npmjs.org") return npm(json);
	if (host === "pypi.org" && finalUrl.pathname.startsWith("/pypi/")) return pypi(json);
	return undefined;
}

/** A question plus, if the caller attached them, its answers. */
function stackExchange(json: Record<string, unknown>, htmlToMarkdown: HtmlToMarkdown): string | undefined {
	const question = arr(json.items)?.filter(isRecord)[0];
	const title = str(question?.title);
	if (question === undefined || title === undefined) return undefined;

	const meta = [
		`score ${num(question.score) ?? 0}`,
		`${num(question.answer_count) ?? 0} answers`,
		question.is_answered === true ? "answered" : undefined,
		arr(question.tags)?.filter(isString).join(", "),
		str(isRecord(question.owner) ? question.owner.display_name : undefined),
		// Staleness is the first thing to check on an answer about software.
		asked(question.creation_date),
		str(question.link),
	].filter(isNonEmpty);

	const sections = [`# ${title}`, meta.join(" · "), body(question.body, htmlToMarkdown)];

	// Task 5b attaches the answers request's `items` here.
	const answers = arr(json.answers)
		?.filter(isRecord)
		.sort((a, b) => rank(b) - rank(a))
		.slice(0, MAX_ANSWERS);
	for (const answer of answers ?? []) {
		const marks = [`score ${num(answer.score) ?? 0}`, answer.is_accepted === true ? "accepted" : undefined];
		const owner = str(isRecord(answer.owner) ? answer.owner.display_name : undefined);
		sections.push(
			`## Answer (${marks.filter(isNonEmpty).join(", ")})${owner === undefined ? "" : ` — ${owner}`}`,
			body(answer.body, htmlToMarkdown),
		);
	}
	return join(sections);
}

/** `creation_date` is unix seconds; the day is all a reader needs. */
function asked(creationDate: unknown): string | undefined {
	const seconds = num(creationDate);
	// A junk timestamp must not throw out of a renderer; 1e12 s is well past any real one.
	if (seconds === undefined || Math.abs(seconds) > 1e12) return undefined;
	return `asked ${new Date(seconds * 1000).toISOString().slice(0, 10)}`;
}

/** Accepted first, then by score — the order a reader wants to scan. */
function rank(answer: Record<string, unknown>): number {
	return (answer.is_accepted === true ? 1e9 : 0) + (num(answer.score) ?? 0);
}

function body(html: unknown, htmlToMarkdown: HtmlToMarkdown): string | undefined {
	const source = str(html);
	return source === undefined ? undefined : htmlToMarkdown(source).trim();
}

/** A registry packument, or the single-version document under `/{name}/{version}`. */
function npm(json: Record<string, unknown>): string | undefined {
	const name = str(json.name);
	if (name === undefined) return undefined;

	const distTags = isRecord(json["dist-tags"]) ? json["dist-tags"] : undefined;
	const version = str(distTags?.latest) ?? str(json.version);
	const sections = [`# ${name}${version === undefined ? "" : ` ${version}`}`, str(json.description)];

	if (!isRecord(json.versions)) {
		// Single-version document: no README, no history, just what it depends on.
		if (str(json.version) === undefined) return undefined;
		const dependencies = isRecord(json.dependencies) ? Object.entries(json.dependencies) : [];
		if (dependencies.length !== 0) {
			sections.push(`## Dependencies\n${dependencies.map(([n, range]) => `- ${n} ${str(range) ?? ""}`.trim()).join("\n")}`);
		}
		return join(sections);
	}

	const repository = isRecord(json.repository) ? str(json.repository.url) : str(json.repository);
	sections.push(
		[str(json.license), str(json.homepage), repository?.replace(/^git\+/, "").replace(/\.git$/, "")]
			.filter(isNonEmpty)
			.join(" · "),
	);

	const time = isRecord(json.time) ? json.time : {};
	const released = Object.keys(json.versions)
		.map((v) => ({ version: v, date: str(time[v]) }))
		.filter((entry) => entry.date !== undefined)
		.sort((a, b) => b.date!.localeCompare(a.date!))
		.slice(0, MAX_VERSIONS);
	if (released.length !== 0) {
		sections.push(`## Versions\n${released.map((e) => `- ${e.version} — ${e.date!.slice(0, 10)}`).join("\n")}`);
	}

	const readme = str(json.readme);
	if (readme !== undefined) sections.push(`## README\n\n${readme.trim()}`);
	return join(sections);
}

/** The PyPI JSON API's project document. */
function pypi(json: Record<string, unknown>): string | undefined {
	const info = isRecord(json.info) ? json.info : undefined;
	const name = str(info?.name);
	if (info === undefined || name === undefined) return undefined;

	const version = str(info.version);
	const sections = [`# ${name}${version === undefined ? "" : ` ${version}`}`, str(info.summary)];

	const requiresPython = str(info.requires_python);
	if (requiresPython !== undefined) sections.push(`Requires Python ${requiresPython}`);

	const urls = isRecord(info.project_urls) ? Object.entries(info.project_urls) : [];
	const links = urls.length !== 0 ? urls.map(([label, url]) => `${label}: ${str(url) ?? ""}`) : [str(info.home_page)];
	const linkList = links.filter(isNonEmpty);
	if (linkList.length !== 0) sections.push(linkList.join("\n"));

	const requires = arr(info.requires_dist)?.filter(isString) ?? [];
	if (requires.length !== 0) sections.push(`## Requires\n${requires.map((r) => `- ${r}`).join("\n")}`);

	// Verbatim either way: markdown passes through, and RST reads fine as prose.
	const description = str(info.description);
	if (description !== undefined) sections.push(`## Description\n\n${description.trim()}`);
	return join(sections);
}

function join(sections: (string | undefined)[]): string {
	return sections.filter(isNonEmpty).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNonEmpty(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arr(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
