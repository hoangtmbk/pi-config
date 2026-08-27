/**
 * JSON renderers, driven by hand-written payloads trimmed to the fields each
 * renderer claims to use. The HTML→markdown step is stubbed: what is under test
 * is the selection and ordering of fields, not turndown.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderKnownJson } from "../renderers.ts";

/** Stands in for extract.ts's converter: enough to prove the body went through it. */
function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "").trim();
}

function render(url: string, json: unknown): string | undefined {
	return renderKnownJson(new URL(url), json, stripTags);
}

const SE_URL = "https://api.stackexchange.com/2.3/questions/11227809?site=stackoverflow&filter=withbody";

function question(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		items: [
			{
				title: "Why is processing a sorted array faster?",
				body: "<p>Here is some <code>C++</code> code.</p>",
				score: 27_000,
				answer_count: 2,
				is_answered: true,
				link: "https://stackoverflow.com/questions/11227809",
				tags: ["java", "c++"],
				owner: { display_name: "GManNickG" },
				creation_date: 1_340_797_920,
			},
		],
		...extra,
	};
}

describe("renderKnownJson: stackexchange", () => {
	it("renders the question with a meta line and a converted body", () => {
		const markdown = render(SE_URL, question());
		assert.ok(markdown !== undefined);
		assert.match(markdown, /^# Why is processing a sorted array faster\?\n\n/);
		assert.match(
			markdown,
			/score 27000 · 2 answers · answered · java, c\+\+ · GManNickG · asked 2012-06-27 · https:\/\/stackoverflow\.com/,
		);
		assert.ok(markdown.includes("Here is some C++ code."), markdown);
		assert.ok(!markdown.includes("<p>"), "body should be converted, not raw HTML");
	});

	it("renders attached answers accepted-first then by score", () => {
		const markdown = render(
			SE_URL,
			question({
				answers: [
					{ body: "<p>low</p>", score: 3, is_accepted: false, owner: { display_name: "Ann" } },
					{ body: "<p>accepted</p>", score: 5, is_accepted: true, owner: { display_name: "Bob" } },
					{ body: "<p>high</p>", score: 90, is_accepted: false },
				],
			}),
		);
		assert.ok(markdown !== undefined);
		const headings = markdown.match(/^## Answer.*$/gm);
		assert.deepEqual(headings, [
			"## Answer (score 5, accepted) — Bob",
			"## Answer (score 90)",
			"## Answer (score 3) — Ann",
		]);
		assert.ok(markdown.indexOf("accepted\n") < markdown.indexOf("high"), markdown);
	});

	it("caps answers at ten", () => {
		const answers = Array.from({ length: 15 }, (_, index) => ({ body: `<p>answer ${index}</p>`, score: index }));
		const markdown = render(SE_URL, question({ answers }));
		assert.equal(markdown?.match(/^## Answer/gm)?.length, 10);
		assert.ok(markdown?.includes("answer 14"), "the highest-scoring answer must survive the cap");
		assert.ok(!markdown?.includes("answer 0"), "the lowest-scoring answers must be dropped");
	});

	it("returns undefined for an empty or unrecognised payload", () => {
		assert.equal(render(SE_URL, { items: [] }), undefined);
		assert.equal(render(SE_URL, { error_id: 404 }), undefined);
		assert.equal(render("https://example.com/x.json", question()), undefined);
	});
});

describe("renderKnownJson: npm registry", () => {
	const packument = {
		name: "left-pad",
		description: "String left pad",
		"dist-tags": { latest: "1.3.0" },
		license: "WTFPL",
		homepage: "https://github.com/stevemao/left-pad",
		repository: { type: "git", url: "git+https://github.com/stevemao/left-pad.git" },
		versions: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`1.0.${index}`, {}])),
		time: Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => [
				`1.0.${index}`,
				`2016-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`,
			]),
		),
		readme: "# left-pad\n\nUse it like this.",
	};

	it("renders a packument lean: header, links, recent versions, README", () => {
		const markdown = render("https://registry.npmjs.org/left-pad", packument);
		assert.ok(markdown !== undefined);
		assert.match(markdown, /^# left-pad 1\.3\.0\n\nString left pad\n\n/);
		assert.ok(markdown.includes("WTFPL · https://github.com/stevemao/left-pad · https://github.com/stevemao/left-pad"));
		assert.ok(!markdown.includes("git+"), "the git+ prefix and .git suffix are noise");
		assert.equal(markdown.match(/^- 1\.0\./gm)?.length, 10, "only the ten most recent versions");
		assert.match(markdown, /## Versions\n- 1\.0\.11 — 2016-12-01\n- 1\.0\.10 — 2016-11-01\n/);
		assert.ok(!markdown.includes("- 1.0.0 —"), "oldest versions are dropped");
		assert.ok(markdown.endsWith("## README\n\n# left-pad\n\nUse it like this."), markdown);
	});

	it("renders a single-version document with its dependencies and no README", () => {
		const markdown = render("https://registry.npmjs.org/left-pad/1.3.0", {
			name: "left-pad",
			version: "1.3.0",
			description: "String left pad",
			dependencies: { "safe-buffer": "^5.1.1" },
			readme: "ignored",
		});
		assert.equal(markdown, "# left-pad 1.3.0\n\nString left pad\n\n## Dependencies\n- safe-buffer ^5.1.1");
	});

	it("returns undefined when the payload is not a registry document", () => {
		assert.equal(render("https://registry.npmjs.org/nope", { error: "Not found" }), undefined);
		assert.equal(render("https://registry.npmjs.org/nope", { name: "nope" }), undefined);
	});
});

describe("renderKnownJson: pypi", () => {
	it("renders info, project urls, requirements and the description", () => {
		const markdown = render("https://pypi.org/pypi/requests/json", {
			info: {
				name: "requests",
				version: "2.31.0",
				summary: "Python HTTP for Humans.",
				home_page: "https://requests.readthedocs.io",
				project_urls: { Homepage: "https://requests.readthedocs.io", Source: "https://github.com/psf/requests" },
				requires_python: ">=3.7",
				requires_dist: ["urllib3 (<3,>=1.21.1)", "idna (<4,>=2.5)"],
				description: "# Requests\n\nMake a request.",
				description_content_type: "text/markdown",
			},
			releases: { "2.31.0": [] },
		});
		assert.equal(
			markdown,
			[
				"# requests 2.31.0",
				"Python HTTP for Humans.",
				"Requires Python >=3.7",
				"Homepage: https://requests.readthedocs.io\nSource: https://github.com/psf/requests",
				"## Requires\n- urllib3 (<3,>=1.21.1)\n- idna (<4,>=2.5)",
				"## Description\n\n# Requests\n\nMake a request.",
			].join("\n\n"),
		);
	});

	it("skips empty fields and falls back to home_page", () => {
		const markdown = render("https://pypi.org/pypi/tiny/json", {
			info: {
				name: "tiny",
				version: "0.1",
				summary: "",
				home_page: "https://tiny.test",
				requires_dist: null,
				description: "Plain RST prose\n===============",
			},
		});
		assert.equal(markdown, "# tiny 0.1\n\nhttps://tiny.test\n\n## Description\n\nPlain RST prose\n===============");
	});

	it("returns undefined without an info object", () => {
		assert.equal(render("https://pypi.org/pypi/nope/json", { message: "Not Found" }), undefined);
		assert.equal(render("https://pypi.org/project/requests/", { info: { name: "requests" } }), undefined);
	});
});
