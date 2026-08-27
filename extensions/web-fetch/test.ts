/**
 * Manual test runner: exercises the fetch + extract pipeline against real sites
 * and a set of error cases. Not part of the extension load path.
 *
 * Run with:  npx tsx test.ts
 */

import { extract } from "./extract.ts";
import { fetchPage } from "./fetch.ts";

interface Case {
	name: string;
	url: string;
	raw?: boolean;
	/** Returns an error string when the case fails its expectations. */
	check: (result: { markdown: string; title?: string; mode: string; contentType: string }) => string | undefined;
}

const cases: Case[] = [
	{
		name: "article extraction (Wikipedia)",
		url: "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
		check: (r) =>
			r.mode !== "article"
				? `expected article mode, got ${r.mode}`
				: !/attention/i.test(r.markdown)
					? "expected body text about attention"
					: /<script|<div|<span/i.test(r.markdown)
						? "raw HTML leaked into markdown"
						: undefined,
	},
	{
		name: "blog post with code blocks (nodejs.org)",
		url: "https://nodejs.org/en/blog/release/v22.0.0",
		check: (r) =>
			!r.title?.includes("22.0.0")
				? `unexpected title: ${r.title}`
				: !r.markdown.includes("```")
					? "expected fenced code blocks"
					: undefined,
	},
	{
		name: "repo page (GitHub)",
		url: "https://github.com/zcag/readdown",
		check: (r) =>
			/\[\s*\]\(/.test(r.markdown)
				? "empty links were not stripped"
				: !/readdown/i.test(r.markdown)
					? "expected repo content"
					: undefined,
	},
	{
		name: "listing page, relative links resolved (Hacker News)",
		url: "https://news.ycombinator.com/",
		raw: true,
		check: (r) =>
			/\]\((?!https?:|mailto:|#)/.test(r.markdown)
				? `unresolved relative link: ${r.markdown.match(/\]\((?!https?:|mailto:|#)[^)]*\)/)?.[0]}`
				: !r.markdown.includes("news.ycombinator.com")
					? "expected absolute HN links"
					: undefined,
	},
	{
		name: "JSON API",
		url: "https://api.github.com/repos/nodejs/node",
		check: (r) =>
			r.mode !== "json"
				? `expected json mode, got ${r.mode}`
				: !r.markdown.startsWith("{\n  ")
					? "expected pretty-printed JSON"
					: undefined,
	},
	{
		name: "github blob → raw file (rewrite)",
		url: "https://github.com/mozilla/readability/blob/main/README.md",
		check: (r) =>
			r.mode !== "text"
				? `expected text mode from the raw file, got ${r.mode}`
				: !/Readability/i.test(r.markdown)
					? "expected the README body"
					: /<div|<span/i.test(r.markdown)
						? "got the GitHub page rather than the raw file"
						: undefined,
	},
	{
		name: "npm package → registry document (rewrite + renderer)",
		url: "https://www.npmjs.com/package/turndown",
		check: (r) =>
			r.mode !== "json"
				? `expected json mode, got ${r.mode}`
				: !/^# turndown/m.test(r.markdown)
					? "expected the rendered package heading"
					: r.markdown.includes('"dist-tags"')
						? "raw packument leaked into the output"
						: undefined,
	},
	{
		name: "PDF text (arXiv)",
		url: "https://arxiv.org/pdf/1706.03762",
		check: (r) =>
			r.mode !== "pdf"
				? `expected pdf mode, got ${r.mode}`
				: !/attention/i.test(r.markdown)
					? "expected the paper's text"
					: undefined,
	},
	{
		name: "plain text",
		url: "https://www.rfc-editor.org/rfc/rfc7231.txt",
		check: (r) =>
			r.mode !== "text" ? `expected text mode, got ${r.mode}` : !r.markdown.includes("HTTP") ? "expected RFC body" : undefined,
	},
];

interface ErrorCase {
	name: string;
	url: string;
	expect: RegExp;
}

const errorCases: ErrorCase[] = [
	{ name: "404 status", url: "https://httpbin.org/status/404", expect: /HTTP 404/ },
	{ name: "unresolvable host", url: "https://this-host-does-not-exist-xyz123.invalid/", expect: /Could not reach/ },
	{ name: "bad protocol", url: "ftp://example.com/file.txt", expect: /Unsupported protocol/ },
	{ name: "not a URL", url: "!!! not a url !!!", expect: /Not a valid URL|Could not reach/ },
	{ name: "binary content", url: "https://httpbin.org/image/png", expect: /Refusing binary content/ },
];

let failures = 0;

console.log("--- content cases ---");
for (const testCase of cases) {
	try {
		const page = await fetchPage(testCase.url, undefined, { allowPdf: true });
		const extracted = await extract(page, testCase.raw === true);
		const problem = testCase.check({
			markdown: extracted.markdown,
			title: extracted.title,
			mode: extracted.mode,
			contentType: page.contentType,
		});

		const ratio = ((extracted.markdown.length / Math.max(page.bytes, 1)) * 100).toFixed(1);
		const stats = `${page.bytes}B → ${extracted.markdown.length}B (${ratio}%, ~${Math.round(extracted.markdown.length / 4)} tok, ${extracted.mode})`;

		if (problem) {
			failures++;
			console.log(`FAIL  ${testCase.name}\n      ${problem}\n      ${stats}`);
		} else {
			console.log(`ok    ${testCase.name}\n      ${stats}`);
		}
	} catch (error) {
		failures++;
		console.log(`FAIL  ${testCase.name}\n      threw: ${error instanceof Error ? error.message : error}`);
	}
}

console.log("\n--- error cases ---");
for (const testCase of errorCases) {
	try {
		const page = await fetchPage(testCase.url);
		await extract(page, false);
		failures++;
		console.log(`FAIL  ${testCase.name}\n      expected a throw, got success`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (testCase.expect.test(message)) {
			console.log(`ok    ${testCase.name}\n      ${message.slice(0, 100)}`);
		} else {
			failures++;
			console.log(`FAIL  ${testCase.name}\n      expected ${testCase.expect}, got: ${message.slice(0, 150)}`);
		}
	}
}

console.log(failures === 0 ? "\nAll cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
