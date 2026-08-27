/**
 * Rewrite rules, one table row per rule and per way of getting the rule wrong.
 *
 * The negatives matter more than the positives here: a rewrite that fires on
 * the wrong URL silently fetches the wrong document.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteUrl } from "../rewrite.ts";

interface Case {
	name: string;
	url: string;
	/** Absent means "leave this URL alone". */
	expect?: { url: string; note: string; fallback?: string };
}

const CASES: Case[] = [
	{
		name: "github blob → raw",
		url: "https://github.com/openai/whisper/blob/main/README.md",
		expect: { url: "https://raw.githubusercontent.com/openai/whisper/main/README.md", note: "github blob → raw" },
	},
	{
		name: "github blob keeps line fragments",
		url: "https://github.com/nodejs/node/blob/v22.x/lib/fs.js#L10-L20",
		expect: { url: "https://raw.githubusercontent.com/nodejs/node/v22.x/lib/fs.js#L10-L20", note: "github blob → raw" },
	},
	{
		name: "github blob with a nested path and a sha ref",
		url: "https://github.com/o/r/blob/0a1b2c3/src/deep/file.ts?plain=1",
		expect: { url: "https://raw.githubusercontent.com/o/r/0a1b2c3/src/deep/file.ts", note: "github blob → raw" },
	},
	{ name: "github tree is untouched", url: "https://github.com/openai/whisper/tree/main/whisper" },
	{ name: "github issues are untouched", url: "https://github.com/openai/whisper/issues/42" },
	{ name: "github pulls are untouched", url: "https://github.com/openai/whisper/pull/42" },
	{ name: "github repo root is untouched", url: "https://github.com/openai/whisper" },
	{ name: "github blob without a file path is untouched", url: "https://github.com/openai/whisper/blob/main" },
	{
		name: "stackoverflow question with a slug",
		url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/11227809?site=stackoverflow&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster",
		},
	},
	{
		name: "stackoverflow short /q/ form, query dropped",
		url: "https://stackoverflow.com/q/11227809?rq=1",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/11227809?site=stackoverflow&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://stackoverflow.com/q/11227809?rq=1",
		},
	},
	{ name: "answer ids cannot be looked up as questions", url: "https://stackoverflow.com/a/11227902" },
	{ name: "non-numeric question id is untouched", url: "https://stackoverflow.com/questions/ask" },
	{ name: "stackoverflow tag pages are untouched", url: "https://stackoverflow.com/tags/rust" },
	{
		name: "superuser maps to its own site",
		url: "https://superuser.com/questions/1234",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/1234?site=superuser&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://superuser.com/questions/1234",
		},
	},
	{
		name: "serverfault maps to its own site",
		url: "https://serverfault.com/questions/5678/nginx-config",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/5678?site=serverfault&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://serverfault.com/questions/5678/nginx-config",
		},
	},
	{
		name: "askubuntu maps to its own site",
		url: "https://askubuntu.com/questions/9/apt",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/9?site=askubuntu&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://askubuntu.com/questions/9/apt",
		},
	},
	{
		name: "stackexchange subdomain becomes the site parameter",
		url: "https://unix.stackexchange.com/questions/321/find-usage",
		expect: {
			url: "https://api.stackexchange.com/2.3/questions/321?site=unix&filter=withbody",
			note: "stackoverflow → StackExchange API",
			fallback: "https://unix.stackexchange.com/questions/321/find-usage",
		},
	},
	{ name: "the API host itself is not rewritten again", url: "https://api.stackexchange.com/2.3/questions/321" },
	{
		name: "npm package → registry",
		url: "https://www.npmjs.com/package/left-pad",
		expect: {
			url: "https://registry.npmjs.org/left-pad",
			note: "npm → registry",
			fallback: "https://www.npmjs.com/package/left-pad",
		},
	},
	{
		name: "scoped npm package split across segments",
		url: "https://www.npmjs.com/package/@types/node",
		expect: {
			url: "https://registry.npmjs.org/@types%2Fnode",
			note: "npm → registry",
			fallback: "https://www.npmjs.com/package/@types/node",
		},
	},
	{
		name: "scoped npm package already encoded",
		url: "https://www.npmjs.com/package/@types%2Fnode",
		expect: {
			url: "https://registry.npmjs.org/@types%2Fnode",
			note: "npm → registry",
			fallback: "https://www.npmjs.com/package/@types%2Fnode",
		},
	},
	{
		name: "npm version page → version document",
		url: "https://www.npmjs.com/package/left-pad/v/1.3.0",
		expect: {
			url: "https://registry.npmjs.org/left-pad/1.3.0",
			note: "npm → registry",
			fallback: "https://www.npmjs.com/package/left-pad/v/1.3.0",
		},
	},
	{
		name: "scoped npm version page → version document",
		url: "https://www.npmjs.com/package/@types/node/v/22.0.0",
		expect: {
			url: "https://registry.npmjs.org/@types%2Fnode/22.0.0",
			note: "npm → registry",
			fallback: "https://www.npmjs.com/package/@types/node/v/22.0.0",
		},
	},
	{ name: "npm search pages are untouched", url: "https://www.npmjs.com/search?q=left-pad" },
	{
		name: "wikipedia article → Parsoid HTML",
		url: "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
		expect: {
			url: "https://en.wikipedia.org/api/rest_v1/page/html/Transformer_(deep_learning_architecture)",
			note: "wikipedia → Parsoid HTML",
			fallback: "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
		},
	},
	{
		name: "any language subdomain works and encoding is preserved",
		url: "https://de.wikipedia.org/wiki/Caf%C3%A9",
		expect: {
			url: "https://de.wikipedia.org/api/rest_v1/page/html/Caf%C3%A9",
			note: "wikipedia → Parsoid HTML",
			fallback: "https://de.wikipedia.org/wiki/Caf%C3%A9",
		},
	},
	{ name: "Special: namespace is untouched", url: "https://en.wikipedia.org/wiki/Special:Random" },
	{ name: "an encoded namespace colon is still a namespace", url: "https://en.wikipedia.org/wiki/File%3AExample.jpg" },
	{ name: "wikipedia search pages are untouched", url: "https://en.wikipedia.org/w/index.php?search=cat" },
	{
		name: "arxiv abs → html",
		url: "https://arxiv.org/abs/1706.03762",
		expect: {
			url: "https://arxiv.org/html/1706.03762",
			note: "arxiv abs → html",
			fallback: "https://arxiv.org/abs/1706.03762",
		},
	},
	{
		name: "arxiv version suffixes are kept",
		url: "https://arxiv.org/abs/1706.03762v5",
		expect: {
			url: "https://arxiv.org/html/1706.03762v5",
			note: "arxiv abs → html",
			fallback: "https://arxiv.org/abs/1706.03762v5",
		},
	},
	{
		name: "arxiv old-style ids keep their archive prefix",
		url: "https://arxiv.org/abs/hep-th/9901001",
		expect: {
			url: "https://arxiv.org/html/hep-th/9901001",
			note: "arxiv abs → html",
			fallback: "https://arxiv.org/abs/hep-th/9901001",
		},
	},
	{ name: "arxiv pdf stays on the PDF path", url: "https://arxiv.org/pdf/1706.03762" },
	{ name: "arxiv listings are untouched", url: "https://arxiv.org/list/cs.CL/recent" },
	{ name: "an unparseable arxiv id is untouched", url: "https://arxiv.org/abs/not-an-id" },
	{
		name: "pypi project → JSON API",
		url: "https://pypi.org/project/requests/",
		expect: {
			url: "https://pypi.org/pypi/requests/json",
			note: "pypi → JSON API",
			fallback: "https://pypi.org/project/requests/",
		},
	},
	{
		name: "pypi pinned version → versioned JSON",
		url: "https://pypi.org/project/requests/2.31.0/",
		expect: {
			url: "https://pypi.org/pypi/requests/2.31.0/json",
			note: "pypi → JSON API",
			fallback: "https://pypi.org/project/requests/2.31.0/",
		},
	},
	{ name: "pypi search pages are untouched", url: "https://pypi.org/search/?q=requests" },
	{ name: "unrelated hosts are untouched", url: "https://example.com/questions/123" },
	{ name: "a lookalike host is untouched", url: "https://github.com.evil.test/o/r/blob/main/README.md" },
];

describe("rewriteUrl", () => {
	for (const testCase of CASES) {
		it(testCase.name, () => {
			const rewrite = rewriteUrl(new URL(testCase.url));
			if (testCase.expect === undefined) {
				assert.equal(rewrite, undefined);
				return;
			}
			assert.ok(rewrite !== undefined, "expected a rewrite");
			assert.equal(rewrite.url.href, testCase.expect.url);
			assert.equal(rewrite.note, testCase.expect.note);
			assert.equal(rewrite.fallback?.href, testCase.expect.fallback);
		});
	}
});
