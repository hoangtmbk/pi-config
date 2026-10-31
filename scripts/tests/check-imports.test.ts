/**
 * The import check, run against small throwaway repos written to a temp dir, so
 * each rule is seen both broken and kept.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkImports, PI_INTERNALS } from "../check-imports.ts";

/** A repo holding `files` (path → contents) and a package.json listing `extensions`. */
function repo(files: Record<string, string>, extensions = ["./extensions/demo/index.ts"]): string {
	const root = mkdtempSync(join(tmpdir(), "pi-check-imports-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions } }));
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

describe("checkImports: the code pi loads must not depend on tests/", () => {
	it("passes a tree whose load path stays out of tests/", () => {
		const root = repo({
			"extensions/demo/index.ts": `import { a } from "./a.ts";`,
			"extensions/demo/a.ts": `export const a = 1;`,
			"extensions/demo/tests/fake.ts": `import { a } from "../a.ts";`,
			"extensions/demo/tests/a.test.ts": `import { fake } from "./fake.ts";`,
		});
		assert.deepEqual(checkImports(root), []);
	});

	it("flags an entry that imports from tests/", () => {
		const root = repo({
			"extensions/demo/index.ts": `\nimport { fake } from "./tests/fake.ts";`,
			"extensions/demo/tests/fake.ts": `export const fake = 1;`,
		});
		const [problem, ...rest] = checkImports(root);
		assert.deepEqual(rest, []);
		assert.match(problem!, /^extensions\/demo\/index\.ts:2: imports "\.\/tests\/fake\.ts" from a tests\/ folder/);
	});

	it("flags a transitive import and names the chain from the entry", () => {
		const root = repo({
			"extensions/demo/index.ts": `export * from "./lib/a.ts";`,
			"extensions/demo/lib/a.ts": `export type { Fake } from "../tests/fake.ts";`,
			"extensions/demo/tests/fake.ts": `export type Fake = 1;`,
		});
		const [problem] = checkImports(root);
		assert.match(problem!, /^extensions\/demo\/lib\/a\.ts:1: /);
		assert.match(problem!, /\(extensions\/demo\/index\.ts -> extensions\/demo\/lib\/a\.ts\)$/);
	});

	it("treats every extensions/<name>/index.ts as an entry, listed or not", () => {
		const root = repo(
			{
				"extensions/unlisted/index.ts": `const m = await import("./tests/fake.ts");`,
				"extensions/unlisted/tests/fake.ts": ``,
			},
			[],
		);
		assert.equal(checkImports(root).length, 1);
	});

	it("treats a module beside the ones pi loads as load-path, even when nothing imports it", () => {
		const root = repo({
			"extensions/demo/index.ts": ``,
			"extensions/demo/replay-session.ts": `import { fake } from "./tests/fake.ts";`,
			"extensions/demo/tests/fake.ts": ``,
		});
		const [problem, ...rest] = checkImports(root);
		assert.deepEqual(rest, []);
		assert.match(problem!, /^extensions\/demo\/replay-session\.ts:1: .*\(extensions\/demo\/replay-session\.ts\)$/);
	});

	it("leaves code pi never loads free to use tests/", () => {
		const root = repo({
			"extensions/demo/index.ts": ``,
			"extensions/demo/test.ts": `import { run } from "./harness/run.ts";`,
			"extensions/demo/harness/run.ts": `import { fake } from "../tests/fake.ts";`,
			"extensions/demo/tests/fake.ts": ``,
		});
		assert.deepEqual(checkImports(root), []);
	});

	it("reports a pi.extensions entry that does not exist", () => {
		const root = repo({}, ["./extensions/gone/index.ts"]);
		assert.deepEqual(checkImports(root), [
			"package.json: pi.extensions lists ./extensions/gone/index.ts, which does not exist",
		]);
	});
});

describe("checkImports: pi's build internals stay behind one module", () => {
	it("flags dist/ and node_modules/ paths in any other file, whatever the import form", () => {
		const root = repo({
			"extensions/demo/index.ts": [
				`import { x } from "@earendil-works/pi-coding-agent/dist/core/x.js";`,
				`type T = typeof import("@earendil-works/pi-ai/dist/types.js");`,
			].join("\n"),
			"extensions/demo/tests/helper.ts": `const m = require("../../../node_modules/@earendil-works/pi-coding-agent/dist/a.js");`,
		});
		const problems = checkImports(root);
		assert.equal(problems.length, 3);
		assert.match(problems[0]!, /^extensions\/demo\/index\.ts:1: imports pi's internal build path/);
		assert.match(problems[1]!, /^extensions\/demo\/index\.ts:2: /);
		assert.match(problems[2]!, /^extensions\/demo\/tests\/helper\.ts:1: /);
	});

	it("allows them in the one allowlisted module, and allows pi's public entry points everywhere", () => {
		const root = repo({
			"extensions/demo/index.ts": `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			[PI_INTERNALS]: `export { a } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";`,
		});
		assert.deepEqual(checkImports(root), []);
	});
});
