/**
 * Import check: two mechanical mistakes, caught before code review rather than at it.
 *
 * 1. **The code pi loads must not depend on `tests/`.** pi loads the files in
 *    `package.json`'s `pi.extensions`, plus everything they import. The entries
 *    checked are those, plus every top-level module of an extension folder
 *    (`extensions/<name>/*.ts`) but its live runner `test.ts`: an extension not on
 *    by default yet is still loaded by hand with `pi -e .../index.ts`, and a module
 *    sitting beside the ones pi loads reads as one of them. Every file reachable
 *    from an entry through relative imports is load-path code, and none of it may
 *    import a file under a `tests/` folder. Code pi never loads — the offline suite
 *    in `tests/`, the live runner, and dev harness in a subfolder that only the
 *    runner imports (`extensions/compaction/replay/`) — may use test doubles.
 *
 * 2. **pi's build internals stay behind one module.** Importing
 *    `@earendil-works/<pkg>/dist/...`, or reaching into `node_modules/` by a
 *    relative path, ties the code to a file layout pi does not promise. Only
 *    {@link PI_INTERNALS} may do it, so an upgrade that moves those files breaks in
 *    one place.
 *
 * Specifiers are read with the TypeScript parser, not a regex: static imports and
 * re-exports, `import type`, dynamic `import()`, `require()`, `import x = require()`
 * and `typeof import()` types all count.
 *
 * Run with:
 *
 *   npm run check:imports            # this repo
 *   tsx scripts/check-imports.ts DIR # another checkout of it
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The one module allowed to import pi's internal build paths. */
export const PI_INTERNALS = "extensions/compaction/tests/pi-internals.ts";

/** Folders whose `.ts` files are checked, relative to the repo root. */
const SCANNED = ["extensions", "scripts"];

/** The one top-level module of an extension that pi never loads: the live test runner. */
const LIVE_RUNNER = "test.ts";

interface Specifier {
	text: string;
	line: number;
}

/** Repo-relative path with forward slashes, the way the rules and messages name files. */
function rel(root: string, file: string): string {
	return relative(root, file).split(sep).join("/");
}

function isTestsPath(relPath: string): boolean {
	return relPath.split("/").includes("tests");
}

function isPiInternal(specifier: string): boolean {
	return /^@earendil-works\/[^/]+\/dist(\/|$)/.test(specifier) || /(^|\/)node_modules\//.test(specifier);
}

/** Every `.ts` file under `dir`, skipping `node_modules`. */
function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...tsFiles(path));
		else if (name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** The module specifiers `file` names, in source order. */
function specifiersOf(file: string): Specifier[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const found: Specifier[] = [];
	const add = (literal: ts.Node) => {
		if (!ts.isStringLiteralLike(literal)) return;
		found.push({ text: literal.text, line: source.getLineAndCharacterOfPosition(literal.getStart()).line + 1 });
	};
	const visit = (node: ts.Node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
			add(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			add(node.moduleReference.expression);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
			node.arguments[0]
		) {
			add(node.arguments[0]);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			add(node.argument.literal);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** The `.ts` file a relative specifier names, or undefined if it is not one. */
function resolveLocal(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
	const base = resolve(dirname(from), specifier);
	const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
	return candidates.find((path) => path.endsWith(".ts") && existsSync(path) && statSync(path).isFile());
}

/** Where load-path code starts: `pi.extensions`, plus each extension's top-level modules but `test.ts`. */
function entriesOf(root: string): { entries: string[]; problems: string[] } {
	const problems: string[] = [];
	const entries = new Set<string>();
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	for (const listed of manifest.pi?.extensions ?? []) {
		const path = resolve(root, listed);
		if (existsSync(path)) entries.add(path);
		else problems.push(`package.json: pi.extensions lists ${listed}, which does not exist`);
	}
	const extensions = join(root, "extensions");
	const folders = existsSync(extensions)
		? readdirSync(extensions)
				.map((name) => join(extensions, name))
				.filter((path) => statSync(path).isDirectory())
		: [];
	// index.ts before the other top-level modules, so a module index.ts imports is
	// reported as reached from it rather than as an entry of its own.
	for (const folder of folders) {
		if (existsSync(join(folder, "index.ts"))) entries.add(join(folder, "index.ts"));
	}
	for (const folder of folders) {
		for (const file of readdirSync(folder)) {
			const path = join(folder, file);
			if (file.endsWith(".ts") && file !== LIVE_RUNNER && statSync(path).isFile()) entries.add(path);
		}
	}
	return { entries: [...entries], problems };
}

/** Every rule broken under `root`, one line each; empty when the tree is clean. */
export function checkImports(root: string): string[] {
	const files = SCANNED.flatMap((dir) => tsFiles(join(root, dir)));
	const specifiers = new Map(files.map((file) => [file, specifiersOf(file)]));
	const problems: string[] = [];

	for (const [file, found] of specifiers) {
		if (rel(root, file) === PI_INTERNALS) continue;
		for (const { text, line } of found) {
			if (isPiInternal(text)) {
				problems.push(
					`${rel(root, file)}:${line}: imports pi's internal build path "${text}"; only ${PI_INTERNALS} may`,
				);
			}
		}
	}

	const { entries, problems: entryProblems } = entriesOf(root);
	problems.push(...entryProblems);
	// Breadth-first from each entry in turn, keeping how each file was first reached.
	const reachedVia = new Map<string, string | undefined>();
	for (const entry of entries) {
		if (reachedVia.has(entry)) continue;
		reachedVia.set(entry, undefined);
		const queue = [entry];
		while (queue.length > 0) {
			const file = queue.shift()!;
			for (const { text, line } of specifiers.get(file) ?? specifiersOf(file)) {
				const target = resolveLocal(file, text);
				if (!target) continue;
				if (isTestsPath(rel(root, target)) && !isTestsPath(rel(root, file))) {
					const chain: string[] = [];
					for (let at: string | undefined = file; at; at = reachedVia.get(at)) chain.unshift(rel(root, at));
					problems.push(
						`${rel(root, file)}:${line}: imports "${text}" from a tests/ folder, but is load-path code (${chain.join(" -> ")})`,
					);
				}
				if (!reachedVia.has(target)) {
					reachedVia.set(target, file);
					queue.push(target);
				}
			}
		}
	}
	return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
	const problems = checkImports(root);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) {
		console.error(`\ncheck:imports: ${problems.length} problem(s)`);
		process.exit(1);
	}
	console.log("check:imports: ok");
}
