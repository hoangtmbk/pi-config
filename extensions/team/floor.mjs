/**
 * The floor classifier: a pure function from a Bash command and the Workspace
 * to "a floor action or not, and which kind".
 *
 * The floor is the fixed set of irreversible outward actions that always reach
 * the human: push to a shared remote, publish, deploy, delete outside the
 * Workspace and send to an outside service. (Spending money is on the floor
 * too, but no command spells it, so it reaches the human through the kinds
 * that do.) Read-only fetches of public URLs aren't on the floor.
 *
 * Two callers share it: the hook script's `PreToolUse` floor hook, which
 * returns `ask` so the human sees a prompt even in `auto`, and `team_answer`'s
 * guard, which refuses an uncited `allow`. The hook runs under plain Node
 * outside pi, so this is JavaScript with no dependencies; `floor.d.mts` types
 * it for the TypeScript side.
 *
 * It reads the command the way a shell would, well enough for a guardrail:
 * quotes and escapes, `;` `&&` `||` `|` `&` and newlines between commands,
 * `$(…)` and backticks, `sh -c` and `eval` scripts, env assignments and
 * wrappers such as `sudo`, `env` and `npx`, a `cd` that surely runs in this
 * shell for where a relative delete lands, and simple assignments of a path
 * that a later delete uses. It is a
 * guardrail, not a security boundary: a command built to hide what it does
 * will get past it.
 */

import { homedir } from "node:os";
import { posix } from "node:path";

/**
 * The floor action a Bash command takes, or undefined when it takes none.
 *
 * A delete is inside when it reaches only what is under the Workspace or
 * under one of `roots`: other folders that are the Teammate's own, such as
 * its Claude Code job temp folder. A root that is relative, `/` or the home
 * folder itself is ignored, so a bad value never widens what is inside.
 *
 * A path is read under `home` only when it starts with a home prefix the
 * shell is sure to expand ({@link HOME_START}) and nothing in the command
 * line names HOME otherwise ({@link namesHome}). In the same way, a path is
 * read under `jobDir`, the Teammate's trusted Claude Code job folder, only
 * when it starts with `$CLAUDE_JOB_DIR/` or `${CLAUDE_JOB_DIR}/`
 * ({@link JOB_START}) and nothing in the command line names CLAUDE_JOB_DIR
 * otherwise ({@link namesJob}); unquoted, only when bash can't split it
 * either ({@link splittable}). A name the command itself sets reads as the
 * path it holds, under the conservative rules of {@link bindings}; unquoted,
 * under the same rule as `$CLAUDE_JOB_DIR`. Any other spelling of `~` or a
 * variable leaves the path unknown, so outside.
 *
 * @param {string} command the Bash command as the Teammate wrote it
 * @param {{ workspace: string, cwd?: string, roots?: string[], home?: string, jobDir?: string }} where the Workspace, the directory the command runs in (the Workspace when not given), the other folders a delete under counts as inside, the home folder (this user's when not given), and the trusted value of `$CLAUDE_JOB_DIR` (unknown when not given)
 * @returns {{ kind: "push" | "publish" | "deploy" | "delete" | "send", command: string } | undefined}
 */
export function floorAction(command, where) {
	const workspace = posix.resolve(where.workspace);
	const home = posix.resolve(where.home ?? homedir());
	const own = (where.roots ?? []).filter((root) => posix.isAbsolute(root)).map((root) => posix.resolve(root));
	const roots = [workspace, ...own.filter((root) => root !== "/" && root !== home)];
	const job = typeof where.jobDir === "string" && posix.isAbsolute(where.jobDir) && !namesJob(command) ? posix.resolve(where.jobDir) : undefined;
	return scan(
		command,
		{ command, roots, home: namesHome(command) ? undefined : home, job, bareJob: job === undefined || splittable(job, command) ? undefined : job, cwd: where.cwd === undefined ? workspace : posix.resolve(where.cwd) },
		0,
	);
}

/**
 * Whether a command line names HOME other than as `$HOME` or `${HOME}`: an
 * assignment, `export`, `declare`, `local`, `unset`, `read` or anything else
 * that may change it. Then no `~` or `$HOME` in it is read as the home folder.
 */
function namesHome(command) {
	return /\bHOME\b/.test(command.replace(/\$\{HOME\}|\$HOME\b/g, ""));
}

/**
 * Whether a command line names CLAUDE_JOB_DIR other than as
 * `$CLAUDE_JOB_DIR` or `${CLAUDE_JOB_DIR}`, in any spelling: with quotes and
 * backslashes taken out first, so `export CLAUDE_JOB\_DIR=…` and
 * `declare "CLAUDE_JOB"_DIR=…` count, as does any `$'…'` string, which can
 * spell the name in escapes. Then no `$CLAUDE_JOB_DIR` in it is read as the
 * job folder.
 */
function namesJob(command) {
	const rest = command.replace(/\$\{CLAUDE_JOB_DIR\}|\$CLAUDE_JOB_DIR(?![A-Za-z0-9_])/g, "");
	return rest.includes("$'") || /CLAUDE_JOB_DIR/.test(unquoted(rest));
}

/**
 * Whether bash may split or glob an unquoted expansion of `value` in this
 * command line: the value holds whitespace or a glob character, or the line
 * names IFS in any spelling. zsh doesn't split by default, but the floor
 * can't tell which shell runs the line.
 */
function splittable(value, command) {
	return /[\s*?[\]{}]/.test(value) || /IFS/.test(unquoted(command));
}

/** A command line with its quotes and backslashes taken out, so a name spelled in parts reads whole. */
function unquoted(command) {
	return command.replace(/[\\'"]/g, "");
}

/**
 * Claude Code's config folder, where its job folders are: `$CLAUDE_CONFIG_DIR`,
 * else `~/.claude`. pi's Teammates inherit pi's environment, so the floor
 * hook and `team_answer` read the same one.
 *
 * @param {Record<string, string | undefined>} [env] the environment (this process's when not given)
 * @param {string} [fallback] the folder when `CLAUDE_CONFIG_DIR` isn't set (`~/.claude` when not given)
 * @returns {string}
 */
export function claudeConfigDir(env = process.env, fallback = posix.join(homedir(), ".claude")) {
	return env.CLAUDE_CONFIG_DIR || fallback;
}

/**
 * A Teammate's own folders, as both callers of {@link floorAction} work them
 * out: its Claude Code job folder, trusted only when it is a folder directly
 * under `jobs` in the config folder (as Claude Code itself checks), whose
 * `tmp` is where Claude Code tells a background session to keep scratch
 * files; and the session's scratchpad, when the hook payload names one. The
 * result spreads into `floorAction`'s `where`.
 *
 * @param {{ config: string, job?: string, scratchpad?: unknown }} from the config folder ({@link claudeConfigDir}), the job folder (`$CLAUDE_JOB_DIR`, or `<config>/jobs/<short id>`), and the payload's `scratchpad_dir`
 * @returns {{ jobDir?: string, roots: string[] }}
 */
export function ownFolders(from) {
	const { config, job, scratchpad } = from;
	const trusted = typeof job === "string" && posix.isAbsolute(job) && posix.isAbsolute(config) && posix.dirname(posix.resolve(job)) === posix.resolve(config, "jobs");
	const jobDir = trusted ? posix.resolve(job) : undefined;
	const roots = [...(jobDir === undefined ? [] : [posix.join(jobDir, "tmp")]), ...(typeof scratchpad === "string" ? [scratchpad] : [])];
	return jobDir === undefined ? { roots } : { jobDir, roots };
}

/**
 * The simple commands in a Bash command, each as its words with env
 * assignments and wrappers stripped, `sh -c` and `eval` scripts read as
 * commands of their own. Permission rules such as `Bash(git push --force:*)`
 * are matched against these.
 *
 * @param {string} command
 * @returns {string[][]}
 */
export function simpleCommands(command) {
	const found = [];
	const walk = (text, depth) => {
		for (const segment of segments(text)) {
			const { words } = unwrap(segment.words);
			const script = depth < MAX_DEPTH ? innerScript(words) : undefined;
			if (script !== undefined) walk(script, depth + 1);
			else if (words.length > 0) found.push(words.map(plain));
		}
	};
	walk(command, 0);
	return found;
}

/** How deep `sh -c` and `eval` scripts are followed. */
const MAX_DEPTH = 8;

/**
 * Scan one command text in its context; a `cd` may move the context's
 * directory for the commands after it ({@link moves}), and a plain assignment
 * may bind a name for them ({@link bindings}). A shell of its own (`sh -c`)
 * may run without `CLAUDE_JOB_DIR`, under `sudo` or `env -i` say, so the job
 * folder is unknown in its script; `eval` runs in this shell, so it keeps it.
 * Neither sees the names this text binds.
 */
function scan(text, context, depth) {
	const all = segments(text);
	const names = bindings(all, context.command);
	const folder = moves(all, context.cwd);
	for (const segment of all) {
		const here = { ...context, cwd: folder.cwd(), vars: names.visible() };
		const kind = scanSegment(segment, here, depth);
		if (kind) return kind;
		folder.after(segment, here);
		if (!segment.nested) names.after(segment, here);
	}
	return undefined;
}

/**
 * The directory a command text's commands run in, followed simply and
 * conservatively. A `cd` or `pushd` moves it only when it surely runs in this
 * shell before the commands after it, and the floor takes it to succeed:
 *
 * - it is a plain `cd <folder>` or `pushd <folder>` (or `builtin cd`), with
 *   no option, at this text's own level: not in a `$(…)`, a process
 *   substitution, a `( … )`, a `{ … }` group, a function's body or a compound
 *   command, and not led by `!`, `time` or `coproc`, nor run by another
 *   program (`env`, `xargs`);
 * - it leads its list, after only plain assignments and other such `cd`s, each
 *   joined to the next by `&&`, and is itself followed by `&&`, the list's end,
 *   or `|| exit` that ends the list; so it isn't in a pipeline, behind `&&` or
 *   `||`, or in a list that `&` backgrounds.
 *
 * Any other `cd`, `pushd` or `popd`, and any `eval`, `source` or `.` (which
 * run code in this shell out of sight), leaves the directory unknown from
 * there, and a relative delete in an unknown directory is outside. So does a
 * list that a `cd` led, past an `||` (which runs when the `cd` failed), when it
 * is backgrounded, or past a group or subshell, whose separators after it the
 * floor doesn't keep.
 */
function moves(all, start) {
	let cwd = start;
	// Where the walk is in the list: whether only plain assignments and moving `cd`s joined by `&&` have run
	// since it began, and whether a `cd` in it moved the directory.
	let head = true;
	let moved = false;
	const after = (segment, context) => {
		const change = dirChange(segment);
		if (segment.nested) {
			if (change) cwd = undefined;
			return;
		}
		const inner = segment.inner || segment.body;
		const exits = segment.sep === "||" && exitsAfter(all, segment);
		if (change) {
			if (change.clean && head && !inner && (segment.sep === "&&" || segment.sep === ";" || exits)) {
				cwd = change.target === undefined ? undefined : changeDir(cwd, expanded(change.target, context));
				moved = true;
			} else cwd = undefined;
		}
		const assigns = !inner && segment.words.every((_, k) => segment.values[k] !== undefined);
		head = head && (change?.clean || assigns) && segment.sep === "&&";
		if (moved && (inner || segment.sep === "&" || (segment.sep === "||" && !exits))) cwd = undefined;
		if (LIST_END.has(segment.sep)) {
			head = true;
			moved = false;
		}
	};
	return { cwd: () => cwd, after };
}

/** The separators that end a list. */
const LIST_END = new Set([";", "&", "(", ")"]);

/**
 * Whether a command may change the directory: a `cd`, `pushd` or `popd`, or
 * an `eval`, `source` or `.`. `clean` when it is a plain `cd` or `pushd` with
 * one folder and no option, as {@link moves} may follow, its folder `target`.
 */
function dirChange(segment) {
	let words = segment.words;
	let led = false;
	while (words.length > 0 && (COMPOUND_OPEN.has(words[0]) || COMPOUND_LEADS.has(words[0]))) {
		words = words.slice(1);
		led = true;
	}
	const run = unwrap(words).words;
	const head = run[0];
	if (head === "eval" || head === "source" || head === ".") return { clean: false };
	if (head !== "cd" && head !== "pushd" && head !== "popd") return undefined;
	let written = words;
	while (written.length > 0 && ASSIGNMENT.test(written[0])) written = written.slice(1);
	if (written[0] === "builtin") written = written.slice(1);
	const clean = !led && head !== "popd" && written[0] === head && run.length === 2 && !plain(run[1]).startsWith("-");
	return clean ? { clean, target: run[1] } : { clean };
}

/** Whether the command after `segment` at its level is a plain `exit` that ends its list, as `cd X || exit 1;` has. */
function exitsAfter(all, segment) {
	const next = all.slice(all.indexOf(segment) + 1).find((other) => !other.nested);
	if (next === undefined || next.inner || next.body || next.sep !== ";") return false;
	return next.words[0] === "exit" && (next.words.length === 1 || (next.words.length === 2 && /^\d+$/.test(next.words[1])));
}

/** The floor action of one simple command, or undefined; a `sh -c` or `eval` script is scanned through. */
function scanSegment(segment, context, depth) {
	const { words, xargs } = unwrap(segment.words);
	if (words.length === 0 || words[0] === "cd" || words[0] === "pushd" || words[0] === "popd") return undefined;
	const script = depth < MAX_DEPTH ? innerScript(words) : undefined;
	if (script !== undefined) return scan(script, { ...context, vars: undefined, ...(words[0] === "eval" ? {} : { job: undefined, bareJob: undefined }) }, depth + 1);
	const kind = classify(words, { ...context, xargs });
	return kind ? { kind, command: segment.text } : undefined;
}

/**
 * The names a command text sets for the commands after it, followed simply
 * and conservatively. A name is bound to a path only when all of these hold;
 * any doubt leaves it unknown, so a delete through it stays outside:
 *
 * - it is set by a plain assignment that is a whole simple command
 *   (`NAME=value`, not `NAME=value cmd`, `export` or `read`), at this text's
 *   own level: not in a `$(…)`, a pipeline or a list that `&` backgrounds;
 * - the whole command line names it nowhere else but as `$NAME` or
 *   `${NAME}` ({@link mentions}), so nothing sets it twice, exports, reads or
 *   unsets it, and it isn't one the shell gives a value of its own
 *   ({@link SHELL_NAMES});
 * - the text has no group, subshell, loop, `if` or `case`, and no `eval`,
 *   `source` or `.` ({@link TRACK_STOP}), any of which may set it out of
 *   sight; a function may be defined, as `name() { …; }` or
 *   `function name { …; }`, when nothing in its body may change a name it
 *   doesn't spell out ({@link mayChange}); an assignment in a body binds
 *   nothing;
 * - its value is a path the floor already reads: a literal absolute path, or
 *   one that starts with `$PWD` (while the directory is known and nothing
 *   names PWD otherwise), the trusted `$CLAUDE_JOB_DIR`, or a name bound
 *   before it, and holds no other `$`;
 * - it is sure to have run where the name is used: earlier in the same `&&`
 *   chain, or in an earlier list it starts (after only plain assignments of
 *   known paths, by `&&`), and that list isn't backgrounded.
 *
 * Where it is used, it is read in the double-quoted form ({@link VAR_START}),
 * or unquoted where bash can't split or glob its value ({@link BARE_VAR_START}).
 */
function bindings(all, command) {
	const bound = new Map();
	const tracking = all.every((segment) => {
		if (segment.nested) return true;
		if (segment.define) return !segment.unreadable;
		if (segment.body) return !mayChange(segment);
		return !segment.grouped && segment.sep !== "(" && segment.sep !== ")" && !TRACK_STOP.has(plain(segment.words[0] ?? "")) && !TRACK_STOP.has(unwrap(segment.words).words[0] ?? "");
	});
	// Where the walk is: the list's number, whether every separator since the list began is `&&`, whether every
	// command since it began is a plain assignment of a known path, and whether the last separator was `|`.
	let list = 0;
	let chain = true;
	let known = true;
	let piped = false;
	const visible = () => {
		const vars = new Map();
		for (const [name, binding] of bound) if ((binding.list === list && chain) || (binding.list < list && binding.certain)) vars.set(name, binding.path);
		return vars;
	};
	const after = (segment, context) => {
		const assigns = !segment.body && segment.words.every((_, k) => segment.values[k] !== undefined);
		if (tracking && assigns && !piped && segment.sep !== "|" && segment.sep !== "&") {
			const vars = new Map(context.vars);
			for (const [k, word] of segment.words.entries()) {
				const name = word.slice(0, word.indexOf("="));
				const path = SHELL_NAMES.has(name) || mentions(name, command) !== 1 ? undefined : valuePath(segment.values[k], word.slice(name.length + 1), { ...context, vars }, command);
				if (path === undefined) known = false;
				else {
					vars.set(name, path);
					bound.set(name, { path, list, certain: chain && known });
				}
			}
		} else known = false;
		if (segment.sep === "&&") piped = false;
		else if (segment.sep === "||") {
			chain = false;
			piped = false;
		} else if (segment.sep === "|") piped = true;
		else {
			if (segment.sep === "&") for (const [name, binding] of bound) if (binding.list === list) bound.delete(name);
			list++;
			chain = true;
			known = true;
			piped = false;
		}
	};
	return { visible, after };
}

/** Words that end the following of names in a text: a construct that may set a name out of sight. */
const TRACK_STOP = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "select", "do", "done", "case", "esac", "function", "coproc", "eval", "source", "."]);

/**
 * Whether a command in a function's body may set a name it doesn't spell out,
 * as `eval "$1"`, `read -r "$1"` or `declare "$1=…"` do, past the words that
 * may lead it ({@link BODY_LEADS}), assignments and any wrapper: it is one of
 * {@link CHANGERS}, `printf -v`, or a command the floor can't read, one held
 * in a variable or a substitution.
 */
function mayChange(segment) {
	let words = segment.words;
	while (words.length > 0 && (BODY_LEADS.has(words[0]) || ASSIGNMENT.test(words[0]))) words = words.slice(1);
	const heads = [plain(words[0] ?? ""), plain(unwrap(words).words[0] ?? "")];
	return heads.some((head) => head.includes("$") || CHANGERS.has(head) || (head === "printf" && words.some((word) => plain(word).startsWith("-v"))));
}

/** Commands that may set a name given in a variable, or run code that may. */
const CHANGERS = new Set(["read", "export", "unset", "declare", "local", "typeset", "readonly", "eval", "source", ".", "mapfile", "readarray", "getopts", "let", "trap"]);

/** Words that may come before the command itself in a function's body. */
const BODY_LEADS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "time"]);

/** Names bash or zsh gives a value of their own, or that the floor reads otherwise: never bound. */
const SHELL_NAMES = new Set([
	...["HOME", "PWD", "OLDPWD", "IFS", "PATH", "CDPATH", "CLAUDE_JOB_DIR", "RANDOM", "SRANDOM", "SECONDS", "LINENO", "BASHPID", "PPID", "UID", "EUID", "GROUPS"],
	...["FUNCNAME", "HISTCMD", "EPOCHSECONDS", "EPOCHREALTIME", "OPTIND", "OPTARG", "REPLY", "PIPESTATUS", "SHLVL", "DIRSTACK", "ERRNO", "TTYIDLE"],
	...["argv", "status", "pipestatus", "path", "cdpath", "fpath", "manpath", "mailpath", "psvar"],
]);

/**
 * How often a command line names `name` other than as `$name` or `${name}`,
 * in any spelling: with quotes and backslashes taken out first. Any `$'…'`
 * string, which can spell a name in escapes, counts as naming it twice.
 */
function mentions(name, command) {
	const rest = command.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "g"), "");
	if (rest.includes("$'")) return 2;
	return (unquoted(rest).match(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g")) ?? []).length;
}

/**
 * The path a plain assignment's value holds, as {@link bindings} reads it, or
 * undefined. `from` is the name the value starts with, or "" for none.
 */
function valuePath(from, value, context, command) {
	if (from === "") return value.startsWith("/") && !value.includes("$") ? value : undefined;
	const braced = `\${${from}}`;
	const rest = value.slice(value.startsWith(braced) ? braced.length : from.length + 1);
	if (rest.includes("$")) return undefined;
	const base = from === "CLAUDE_JOB_DIR" ? context.job : from === "PWD" ? (mentions("PWD", command) === 0 ? context.cwd : undefined) : SHELL_NAMES.has(from) ? undefined : context.vars.get(from);
	return base === undefined ? undefined : `${base}${rest}`;
}

function changeDir(cwd, target) {
	if (target === undefined || target.startsWith("-") || target.startsWith("~") || target.includes("$") || cwd === undefined && !target.startsWith("/")) return undefined;
	return posix.resolve(cwd ?? "/", target);
}

/**
 * The home prefixes the shell is sure to expand, as written at a word's start
 * with their quotes: `~/`, `$HOME/` and `${HOME}/` unquoted, or `$HOME` and
 * `${HOME}` as a whole double-quoted token, the `/` after it inside the quotes
 * or not. Any other spelling, quoted or escaped in part, isn't one.
 */
const HOME_START = /~\/|\$HOME\/|\$\{HOME\}\/|"\$HOME"?\/|"\$\{HOME\}"?\//y;

/** A home prefix once its quotes are gone, as it starts a {@link HOME} word. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/)/;

/**
 * The job folder prefixes the shell is sure to expand, as written at a word's
 * start: `$CLAUDE_JOB_DIR` or `${CLAUDE_JOB_DIR}` as a whole double-quoted
 * token, the `/` after it inside the quotes or not (group 1), or unquoted
 * (group 2), which bash may split ({@link splittable}). Any other spelling,
 * quoted or escaped in part, isn't one.
 */
const JOB_START = /("\$CLAUDE_JOB_DIR"?\/|"\$\{CLAUDE_JOB_DIR\}"?\/)|(\$CLAUDE_JOB_DIR\/|\$\{CLAUDE_JOB_DIR\}\/)/y;

/** A job folder prefix once its quotes are gone, as it starts a {@link JOB} or {@link BARE_JOB} word. */
const JOB_PREFIX = /^(?:\$CLAUDE_JOB_DIR|\$\{CLAUDE_JOB_DIR\})(?=\/)/;

/**
 * A name at a word's start, as a whole double-quoted token: `"$NAME"` or
 * `"${NAME}"`, with the quote closing right after it or a `/` after it inside
 * the quotes (group 1 or 2 the name). The name is read as a path only when
 * the command itself sets it ({@link bindings}).
 */
const VAR_START = /"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})(?=["/])/y;

/**
 * A name at a word's start, unquoted: `$NAME` or `${NAME}`, followed by a `/`,
 * a quote or the word's end (group 1 or 2 the name). Bash may split or glob
 * it, so it is read as a path only when the command itself sets it
 * ({@link bindings}) and bash can't split its value ({@link splittable}).
 */
const BARE_VAR_START = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})(?=[/"'\s;&|<>()]|$)/y;

/**
 * A name at the start of a plain assignment's value: `$NAME`, `${NAME}`,
 * either double-quoted or not, followed by a `/` or the value's end (group 1
 * or 2 the name). An assignment's value is never split or globbed, so the
 * unquoted form is as sure as the quoted one.
 */
const VALUE_START = /"?\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})"?(?=\/|[\s;&|)]|$)/y;

/**
 * The marks {@link segments} puts before a word that starts with a
 * {@link HOME_START} prefix, a double-quoted {@link JOB_START} prefix, an
 * unquoted one, or a {@link VAR_START} or {@link BARE_VAR_START} name (as
 * `VAR name VAR` or `BARE_VAR name BARE_VAR`, since the quotes that ended the
 * name are gone). No shell word can hold them, and {@link plain} takes them
 * off.
 */
const HOME = "\u0000";
const JOB = "\u0001";
const BARE_JOB = "\u0002";
const VAR = "\u0003";
const BARE_VAR = "\u0004";

/** A word without its mark. */
function plain(word) {
	if (word.startsWith(VAR) || word.startsWith(BARE_VAR)) return word.slice(word.indexOf(word[0], 1) + 1);
	return word.startsWith(HOME) || word.startsWith(JOB) || word.startsWith(BARE_JOB) ? word.slice(1) : word;
}

/**
 * A word with its prefix read as the folder its mark names, when the context
 * knows that folder: {@link HOME} as `home`, {@link JOB} as `job`,
 * {@link BARE_JOB} as `bareJob` and {@link VAR} as the path the context's
 * `vars` hold for the name, as does {@link BARE_VAR} when bash can't split
 * that path. Any other word as it is written.
 */
function expanded(word, context) {
	const bare = plain(word);
	if (word.startsWith(VAR) || word.startsWith(BARE_VAR)) {
		const name = word.slice(1, word.indexOf(word[0], 1));
		const value = context.vars?.get(name);
		if (value === undefined || (word.startsWith(BARE_VAR) && splittable(value, context.command))) return bare;
		const braced = `\${${name}}`;
		return value + bare.slice(bare.startsWith(braced) ? braced.length : name.length + 1);
	}
	if (word.startsWith(HOME)) return context.home === undefined ? bare : bare.replace(HOME_PREFIX, () => context.home);
	const job = word.startsWith(JOB) ? context.job : word.startsWith(BARE_JOB) ? context.bareJob : undefined;
	return job === undefined ? bare : bare.replace(JOB_PREFIX, () => job);
}

// ---------------------------------------------------------------------------
// Reading the shell text.

/**
 * The simple commands in a shell text, each with its words (quotes removed)
 * and the text it was written as. A `$(…)` or backtick substitution is a
 * command of its own, `nested`, listed before the command it sits in; its
 * place in that command's word reads as `$(…)`, an unknown value. A word that
 * starts, as written, with a {@link HOME_START}, {@link JOB_START},
 * {@link VAR_START} or {@link BARE_VAR_START} prefix carries the mark for it.
 *
 * A function's header, `name()` or `function name` (with or without `()`),
 * is a command of its own, `define`, and the commands in its `{ … }` body are
 * `body`. A header whose body isn't a `{ … }` group, or never closes, is
 * `unreadable`.
 *
 * A process substitution, `<(…)` or `>(…)`, is read as a `$(…)` is.
 *
 * Each also has the separator after it as `sep` (`;` for a newline or the
 * end, `&&`, `||`, `|`, `&`, `(` or `)`), whether a `{` or `}` group word
 * other than a function body's came before it (`grouped`), whether it runs
 * inside a `( … )`, a `{ … }` group or a compound command (`if`, `while`,
 * `until`, `for`, `select`, `case`), comes after a here-document's start
 * (whose lines are read as commands, though they may be none), or is led by
 * a compound command's word, `!`, `time` or `coproc` (`inner`), and per word
 * in `values`: for a plain assignment
 * word (`NAME=…`, the name and `=` unquoted and unescaped), the name its value
 * starts with ({@link VALUE_START}), or "" for none; undefined for any other
 * word.
 */
function segments(text) {
	const out = [];
	let words = [];
	let word = "";
	let inWord = false;
	let start = -1;
	let end = 0;
	let redirect = false;
	let atCommandStart = true;
	// Whether a `{` or `}` group word other than a function body's has been read so far.
	let grouped = false;
	// How many `{` groups are open, and the function bodies among them, each with its depth and header.
	let depth = 0;
	const bodies = [];
	// How many `(` are open, and the compound commands (`if`, loops, `case`) open, by their opening word.
	let parens = 0;
	const compounds = [];
	// Whether a here-document has begun: its lines are read as commands, though they may be none.
	let heredoc = false;
	// Whether a command is in a subshell, a group other than a function body or a compound command, after
	// a here-document's start, or is led by a compound command's word, `!`, `time` or `coproc`; this
	// updates the open compound commands.
	const inner = (sep) => {
		let led = false;
		for (const word of words) {
			if (COMPOUND_OPEN.has(word)) {
				compounds.push(word);
				led = true;
				if (COMPOUND_HEADER.has(word)) break;
			} else if (COMPOUND_CLOSE.has(word)) {
				// In a `case`, a word before `)` is a pattern.
				if (!(compounds.at(-1) === "case" && sep === ")") && COMPOUND_CLOSE.get(word).includes(compounds.at(-1))) compounds.pop();
				led = true;
			} else if (COMPOUND_LEADS.has(word)) led = true;
			else break;
		}
		return led || heredoc || parens > 0 || depth > bodies.length || compounds.length > 0;
	};
	// The mark for the prefix the word, as written, starts with, when the shell is sure to expand it.
	let mark = "";
	// Whether the word so far is written in plain characters only: no quote, escape or substitution.
	let literal = true;
	// For a plain assignment word, the name its value starts with ({@link VALUE_START}), or "" for none.
	let value;
	let values = [];
	const endWord = () => {
		if (!inWord) return;
		if (redirect) redirect = false;
		else {
			words.push(`${mark}${word}`);
			values.push(value);
		}
		word = "";
		inWord = false;
		mark = "";
		literal = true;
		value = undefined;
	};
	const endSegment = (sep = ";") => {
		endWord();
		if (words.length > 0) out.push({ words, values, text: text.slice(start, end).trim(), sep, nested: false, grouped, body: bodies.length > 0, inner: inner(sep) });
		words = [];
		values = [];
		start = -1;
		atCommandStart = true;
	};
	// The words so far as a function's header, its body read next.
	const header = () => {
		const segment = { words, values, text: text.slice(start, end).trim(), sep: ";", nested: false, grouped, body: bodies.length > 0, inner: inner(";"), define: true, unreadable: false };
		out.push(segment);
		words = [];
		values = [];
		start = -1;
		atCommandStart = true;
		return segment;
	};
	const openBody = (segment) => {
		depth++;
		bodies.push({ depth, segment });
	};
	const begin = (i) => {
		if (start < 0) start = i;
		if (!inWord) {
			HOME_START.lastIndex = i;
			JOB_START.lastIndex = i;
			VAR_START.lastIndex = i;
			BARE_VAR_START.lastIndex = i;
			const job = JOB_START.exec(text);
			const named = VAR_START.exec(text);
			const bare = BARE_VAR_START.exec(text);
			if (HOME_START.test(text)) mark = HOME;
			else if (job) mark = job[1] === undefined ? BARE_JOB : JOB;
			else if (named) mark = `${VAR}${named[1] ?? named[2]}${VAR}`;
			else if (bare) mark = `${BARE_VAR}${bare[1] ?? bare[2]}${BARE_VAR}`;
			else mark = "";
		}
		inWord = true;
	};
	const substitution = (inner) => {
		out.push(...segments(inner).map((segment) => ({ ...segment, nested: true })));
		word += "$(…)";
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			begin(i);
			literal = false;
			if (text[i + 1] === "\n") i += 2;
			else {
				word += text[i + 1] ?? "";
				i += 2;
			}
			end = i;
			continue;
		}
		if (c === "'") {
			begin(i);
			literal = false;
			const close = text.indexOf("'", i + 1);
			const stop = close < 0 ? text.length : close;
			word += text.slice(i + 1, stop);
			i = stop + 1;
			end = i;
			continue;
		}
		if (c === '"') {
			begin(i);
			literal = false;
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) {
					word += text[i + 1];
					i += 2;
				} else if (text[i] === "$" && text[i + 1] === "(") {
					const close = matchParen(text, i + 1);
					substitution(text.slice(i + 2, close));
					i = close + 1;
				} else if (text[i] === "`") {
					const close = text.indexOf("`", i + 1);
					const stop = close < 0 ? text.length : close;
					substitution(text.slice(i + 1, stop));
					i = stop + 1;
				} else word += text[i++];
			}
			i++;
			end = i;
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			begin(i);
			literal = false;
			const close = matchParen(text, i + 1);
			substitution(text.slice(i + 2, close));
			i = close + 1;
			end = i;
			continue;
		}
		if (c === "`") {
			begin(i);
			literal = false;
			const close = text.indexOf("`", i + 1);
			const stop = close < 0 ? text.length : close;
			substitution(text.slice(i + 1, stop));
			i = stop + 1;
			end = i;
			continue;
		}
		if (c === "#" && !inWord) {
			const newline = text.indexOf("\n", i);
			i = newline < 0 ? text.length : newline;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			if (words.length > 0) atCommandStart = false;
			i++;
			continue;
		}
		if ((c === "<" || c === ">") && text[i + 1] === "(") {
			// A process substitution runs in a shell of its own, as a `$(…)` does.
			begin(i);
			literal = false;
			const close = matchParen(text, i + 1);
			substitution(text.slice(i + 2, close));
			i = close + 1;
			end = i;
			continue;
		}
		if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			const from = i;
			while (i < text.length && "<>&|".includes(text[i])) i++;
			if (text.startsWith("<<", from) && !text.startsWith("<<<", from)) heredoc = true;
			redirect = true;
			// `2>&1` names a descriptor, not a file: nothing to skip.
			if (/^\d/.test(text[i] ?? "") && text[i - 1] === "&") redirect = false;
			continue;
		}
		if (c === "(") {
			endWord();
			FUNCTION_PARENS.lastIndex = i;
			if (isHeader(words) && FUNCTION_PARENS.test(text)) {
				end = FUNCTION_PARENS.lastIndex;
				const segment = header();
				i = end;
				BODY_OPEN.lastIndex = i;
				if (BODY_OPEN.test(text)) {
					openBody(segment);
					i = BODY_OPEN.lastIndex;
				} else segment.unreadable = true;
				continue;
			}
		}
		if (c === "{" && !inWord && words.length === 2 && words[0] === "function" && isHeader(words) && /\s/.test(text[i + 1] ?? "")) {
			openBody(header());
			i++;
			continue;
		}
		if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
			// `&&` and `||` are one separator; `|&` is a pipe.
			const double = (c === "&" || c === "|") && text[i + 1] === c;
			endSegment(c === "\n" ? ";" : double ? `${c}${c}` : c);
			if (c === "(") parens++;
			else if (c === ")") parens = Math.max(0, parens - 1);
			i += double || (c === "|" && text[i + 1] === "&") ? 2 : 1;
			continue;
		}
		if ((c === "{" || c === "}") && !inWord && atCommandStart && /[\s;]/.test(text[i + 1] ?? " ")) {
			if (c === "}" && bodies.at(-1)?.depth === depth) bodies.pop();
			else grouped = true;
			depth = c === "{" ? depth + 1 : Math.max(0, depth - 1);
			i++;
			continue;
		}
		begin(i);
		word += c;
		i++;
		end = i;
		if (c === "=" && literal && value === undefined && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(word)) {
			VALUE_START.lastIndex = i;
			const named = VALUE_START.exec(text);
			value = named ? (named[1] ?? named[2]) : "";
		}
	}
	endSegment();
	for (const { segment } of bodies) segment.unreadable = true;
	return out;
}

/** The words that open a compound command, and those of them whose words up to the next separator are a header, not a command. */
const COMPOUND_OPEN = new Set(["if", "while", "until", "for", "select", "case"]);
const COMPOUND_HEADER = new Set(["for", "select", "case"]);

/** The words that close a compound command, each with the words it closes. */
const COMPOUND_CLOSE = new Map([["fi", ["if"]], ["done", ["while", "until", "for", "select"]], ["esac", ["case"]]]);

/** The words that may lead a command inside a compound command, or run it apart from a plain command. */
const COMPOUND_LEADS = new Set(["then", "elif", "else", "do", "!", "time", "coproc"]);

/** Whether the words so far are a function's name, `name` or `function name`, as a `(` or `{` after them would make a header. */
function isHeader(words) {
	const name = words.length === 1 ? words[0] : words.length === 2 && words[0] === "function" ? words[1] : undefined;
	return name !== undefined && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) && !TRACK_STOP.has(name);
}

/** The `()` of a function's header, from its `(`. */
const FUNCTION_PARENS = /\([ \t]*\)/y;

/** The `{` that opens a function's body, after its header. */
const BODY_OPEN = /[ \t\n]*\{(?=\s)/y;

/** The index of the `)` closing the `(` at `open`, or the text's end. */
function matchParen(text, open) {
	let depth = 0;
	let quote;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = undefined;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === "\\") i++;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return text.length;
}

// ---------------------------------------------------------------------------
// Words to the command that actually runs.

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Options of a wrapper that take the next word as their value. */
const WRAPPER_VALUES = {
	sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "--user", "--group", "--host", "--prompt", "--chdir"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	nice: ["-n", "--adjustment"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	xargs: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"],
	npx: ["-p", "--package", "-c", "--call"],
	command: [],
	exec: ["-a"],
	nohup: [],
	time: [],
	builtin: [],
	doas: ["-u", "-C"],
	stdbuf: ["-i", "-o", "-e"],
	bunx: [],
	uvx: ["--from", "--with"],
	dotenv: ["-e", "-c", "-v"],
};

/** Wrappers whose first positional word is not the command but their own argument. */
const WRAPPER_ARGUMENT = new Set(["timeout"]);

/**
 * The command a word list runs, past env assignments and wrappers, and
 * whether it reads its arguments from stdin (`xargs`), so its targets are
 * unknown.
 */
function unwrap(input) {
	let words = input;
	let xargs = false;
	for (let guard = 0; guard < 16; guard++) {
		while (words.length > 0 && ASSIGNMENT.test(words[0])) words = words.slice(1);
		const head = words[0];
		if (head === undefined) break;
		const name = posix.basename(head);
		if (name in WRAPPER_VALUES) {
			if (name === "xargs") xargs = true;
			words = skipOptions(words.slice(1), WRAPPER_VALUES[name], name === "env");
			if (WRAPPER_ARGUMENT.has(name)) words = words.slice(1);
			if (name === "dotenv" && words[0] === "--") words = words.slice(1);
			continue;
		}
		if ((name === "pnpm" || name === "yarn") && (words[1] === "dlx" || words[1] === "exec")) {
			words = skipOptions(words.slice(2), []);
			continue;
		}
		if (name === "pipx" && words[1] === "run") {
			words = skipOptions(words.slice(2), ["--spec"]);
			continue;
		}
		if ((name === "uv" || name === "poetry" || name === "pdm" || name === "hatch") && words[1] === "run") {
			words = skipOptions(words.slice(2), ["--with", "--from", "--python", "-p", "-e", "--env"]);
			continue;
		}
		if (/^python(\d+(\.\d+)?)?$/.test(name) && words[1] === "-m" && words[2] !== undefined) {
			words = words.slice(2);
			continue;
		}
		if (head !== name && words.length > 0) {
			words = [name, ...words.slice(1)];
			continue;
		}
		break;
	}
	return { words, xargs };
}

/** Drop leading options (and the values of those in `withValue`); `env` also drops assignments. */
function skipOptions(words, withValue, assignments = false) {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") return words.slice(i + 1);
		if (assignments && ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (!word.startsWith("-") || word === "-") break;
		i += withValue.includes(word) ? 2 : 1;
	}
	return words.slice(i);
}

/** The script a shell or `eval` runs, when the words are `sh -c '<script>'` or `eval <words>`. */
function innerScript(words) {
	const name = words[0];
	if (name === "eval") return words.slice(1).map(plain).join(" ");
	if (!SHELLS.has(name)) return undefined;
	let command = false;
	for (const word of words.slice(1)) {
		if (word.startsWith("-") && !word.startsWith("--")) {
			if (word.slice(1).includes("c")) command = true;
			continue;
		}
		if (word.startsWith("--")) continue;
		return command ? plain(word) : undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Which kind of floor action a command is.

/** The positional words, past options; `withValue` names options whose value is the next word. */
function positionals(args, withValue = []) {
	const out = [];
	let rest = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (rest) out.push(word);
		else if (word === "--") rest = true;
		else if (word.startsWith("-") && word !== "-") {
			if (withValue.includes(word)) i++;
		} else out.push(word);
	}
	return out;
}

const has = (args, ...flags) => args.some((word) => flags.includes(word));
const dryRun = (args) => has(args, "--dry-run", "--dryrun", "-n");

/** Script and make-target names that deploy or publish. */
const DEPLOY_NAME = /^(deploy|ship)([-:_.].*)?$/;
const PUBLISH_NAME = /^(publish|release)([-:_.].*)?$/;

function scriptKind(name) {
	if (name === undefined) return undefined;
	if (DEPLOY_NAME.test(name)) return "deploy";
	if (PUBLISH_NAME.test(name)) return "publish";
	return undefined;
}

const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"];

function git(args) {
	const at = firstPositional(args, GIT_VALUES);
	const sub = args[at];
	const rest = args.slice(at + 1);
	if (sub === "push") return dryRun(rest) || has(rest, "--help", "-h") ? undefined : "push";
	if (sub === "send-email") return dryRun(rest) ? undefined : "send";
	if (sub === "svn" && rest[0] === "dcommit") return "push";
	return undefined;
}

/** The index of the first positional word, skipping options and the values of those in `withValue`. */
function firstPositional(args, withValue) {
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "--") return i + 1;
		if (!word.startsWith("-")) return i;
		if (withValue.includes(word)) i++;
	}
	return args.length;
}

const GH_WRITES = {
	pr: { create: "send", merge: "push", comment: "send", review: "send", close: "send", edit: "send", ready: "send", reopen: "send", lock: "send", unlock: "send" },
	issue: { create: "send", comment: "send", close: "send", edit: "send", reopen: "send", delete: "send", transfer: "send", lock: "send", unlock: "send", pin: "send", unpin: "send", develop: "send" },
	release: { create: "publish", upload: "publish", edit: "publish", delete: "send", "delete-asset": "send" },
	repo: { create: "send", delete: "send", edit: "send", fork: "send", rename: "send", archive: "send", unarchive: "send", sync: "push" },
	gist: { create: "send", edit: "send", delete: "send" },
	secret: { set: "send", delete: "send" },
	variable: { set: "send", delete: "send" },
	workflow: { run: "deploy", enable: "send", disable: "send" },
	run: { rerun: "deploy", cancel: "send", delete: "send" },
	label: { create: "send", edit: "send", delete: "send", clone: "send" },
};

function gh(args) {
	const [group, action] = positionals(args, ["-R", "--repo"]);
	if (group === "api") return apiMethod(args) === "GET" ? undefined : "send";
	return GH_WRITES[group]?.[action];
}

/** The method `gh api` sends: `-X`/`--method`, else POST when it carries fields or input, else GET. */
function apiMethod(args) {
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "-X" || word === "--method") return (args[i + 1] ?? "").toUpperCase();
		if (word.startsWith("-X") && word.length > 2) return word.slice(2).toUpperCase();
		if (word.startsWith("--method=")) return word.slice("--method=".length).toUpperCase();
	}
	return has(args, "-f", "-F", "--field", "--raw-field", "--input") || args.some((word) => /^(-f|-F|--field|--raw-field)=?/.test(word) && word.length > 2) ? "POST" : "GET";
}

/** `npm`, `pnpm`, `yarn` and `bun`: publishing, and scripts named for a deploy or a release. */
function packageManager(name, args) {
	const [sub, ...rest] = positionals(args, ["-w", "--workspace", "--filter", "-F", "--cwd", "-C", "--prefix"]);
	const tail = args.slice(args.indexOf(sub) + 1);
	if (sub === "publish" || sub === "unpublish") return dryRun(tail) ? undefined : "publish";
	if (name === "yarn" && sub === "npm" && rest[0] === "publish") return dryRun(tail) ? undefined : "publish";
	if (sub === "run" || sub === "run-script") return scriptKind(rest[0]);
	if (name === "yarn" && sub !== undefined) return scriptKind(sub);
	return undefined;
}

const PUBLISHERS = {
	cargo: ["publish", "yank", "owner"],
	twine: ["upload", "register"],
	poetry: ["publish"],
	uv: ["publish"],
	flit: ["publish"],
	hatch: ["publish"],
	gem: ["push", "yank", "owner"],
	docker: ["push"],
	podman: ["push"],
	buildah: ["push"],
	helm: ["push"],
	vsce: ["publish", "unpublish"],
	ovsx: ["publish"],
	jsr: ["publish"],
	deno: ["publish"],
	mvn: ["deploy", "release:perform"],
	gradle: ["publish"],
	gradlew: ["publish"],
	pod: ["trunk"],
	dotnet: ["nuget"],
	nuget: ["push"],
	swift: ["package-registry"],
};

const DEPLOYERS = {
	netlify: ["deploy", "sites:delete", "env:set"],
	fly: ["deploy", "launch", "destroy", "scale", "secrets"],
	flyctl: ["deploy", "launch", "destroy", "scale", "secrets"],
	firebase: ["deploy", "hosting:channel:deploy", "functions:delete"],
	wrangler: ["deploy", "publish", "delete", "rollback", "secret"],
	kubectl: ["apply", "create", "delete", "replace", "patch", "rollout", "scale", "set", "edit", "run", "expose", "annotate", "label", "drain", "cordon", "uncordon", "taint", "autoscale"],
	helm: ["install", "upgrade", "uninstall", "rollback", "delete"],
	terraform: ["apply", "destroy", "import", "taint"],
	tofu: ["apply", "destroy", "import", "taint"],
	terragrunt: ["apply", "destroy", "run-all"],
	pulumi: ["up", "update", "destroy", "import"],
	cdk: ["deploy", "destroy"],
	cdktf: ["deploy", "destroy"],
	serverless: ["deploy", "remove"],
	sls: ["deploy", "remove"],
	sam: ["deploy", "delete", "sync"],
	railway: ["up", "deploy", "redeploy", "down"],
	heroku: ["create", "destroy", "apps:destroy", "releases:rollback", "config:set", "ps:scale"],
	eb: ["deploy", "create", "terminate"],
	cf: ["push", "delete"],
	render: ["deploy"],
	vercel: ["deploy", "promote", "rollback", "redeploy", "remove", "rm", "alias"],
	"ansible-playbook": [],
	surge: [],
	"gh-pages": [],
};

/** Commands that deploy whenever they run (no subcommand needed). */
const ALWAYS_DEPLOY = new Set(["ansible-playbook", "surge", "gh-pages"]);

/** `vercel` subcommands that read or work locally; a bare `vercel` (or a path) deploys. */
const VERCEL_LOCAL = new Set(["dev", "build", "login", "logout", "env", "pull", "link", "whoami", "logs", "ls", "list", "inspect", "help", "init", "switch", "teams", "domains", "dns", "certs", "projects", "git", "telemetry", "bisect"]);

function deploy(name, args) {
	if (ALWAYS_DEPLOY.has(name)) return "deploy";
	const words = positionals(args, ["-f", "--file", "-n", "--namespace", "--context", "-c", "--config", "--env", "-e", "-a", "--app", "--project", "--region", "-s", "--stack", "--profile", "--scope", "--token"]);
	if (name === "vercel") return words[0] === undefined || !VERCEL_LOCAL.has(words[0]) ? (has(args, "--help", "-h", "--version", "-v") ? undefined : "deploy") : undefined;
	if (name === "wrangler" && words[0] === "pages") return words.slice(1).some((word) => DEPLOYERS.wrangler.includes(word)) ? "deploy" : undefined;
	if (name === "gcloud" || name === "az") return words.some((word) => word === "deploy" || word === "up") ? "deploy" : undefined;
	return DEPLOYERS[name]?.includes(words[0]) ? "deploy" : undefined;
}

/** `aws`: an s3 copy up or a removal, or any operation that isn't a read. */
function aws(args) {
	const words = positionals(args, ["--profile", "--region", "--endpoint-url", "--output", "--query"]);
	const [service, operation, ...rest] = words;
	if (service === undefined || operation === undefined || has(args, "help", "--dryrun", "--dry-run")) return undefined;
	if (service === "s3") {
		if (["rm", "mb", "rb"].includes(operation)) return "deploy";
		if (["cp", "mv", "sync"].includes(operation)) return (rest.at(-1) ?? "").startsWith("s3://") ? "deploy" : undefined;
		return undefined;
	}
	if (/^(describe|list|get|head|ls|wait|help|batch-get|query|scan|lookup|search|filter|simulate|estimate|validate|test|preview|generate|decode|select)/.test(operation)) return undefined;
	if (service === "sts" || service === "configure" || service === "sso" || service === "ecr" && operation === "get-login-password") return undefined;
	return "deploy";
}

/** `gsutil`: copying up to, or removing from, a bucket. */
function gsutil(args) {
	const [operation, ...rest] = positionals(args, ["-o", "-h"]);
	if (operation === "rm" || operation === "rb") return "deploy";
	if (["cp", "mv", "rsync"].includes(operation)) return (rest.at(-1) ?? "").startsWith("gs://") ? "deploy" : undefined;
	return undefined;
}

/** Hosts that are this machine, written out in full, so a request to them stays inside. */
function isLocalHost(host) {
	const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
	return bare === "localhost" || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/.test(bare) || /^127(?:\.\d{1,3}){1,3}$/.test(bare) || bare === "::1" || bare === "0.0.0.0" || bare === "host.docker.internal";
}

/** A port as a URL may write it: digits, or one variable such as `$PORT` or `${PORT}`. */
const URL_PORT = String.raw`(?::(?:\d*|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}))?`;

/**
 * The host a URL-ish word names, or undefined when the word isn't one. The
 * host is read only when it is written out: a variable in the port or the
 * path leaves it readable (`http://127.0.0.1:$PORT/keys/$KEY`), one in the
 * host or the user part doesn't, and then the whole authority is the host,
 * which no local host matches. A variable port is taken to be a number, as
 * the Teammate preamble asks; one built to hold an `@` would get past this.
 */
function hostOf(word) {
	const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(word);
	if (scheme) {
		const authority = scheme[1];
		const read = new RegExp(String.raw`^(?:[^@$]*@)?(\[[^\]$]*\]|[^:@$\[\]]*)${URL_PORT}$`).exec(authority);
		return read ? read[1] : authority;
	}
	const bare = new RegExp(String.raw`^(?:[^@/?#\s$]*@)?(localhost|\[[^\]]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+)${URL_PORT}(?:[/?#]|$)`, "i").exec(word);
	return bare ? bare[1] : undefined;
}

/** The outside hosts among some words; a word that's no URL is no host. */
function outsideHosts(words) {
	return words.map(hostOf).filter((host) => host !== undefined && !isLocalHost(host));
}

const CURL_VALUES = ["-o", "--output", "-H", "--header", "-A", "--user-agent", "-u", "--user", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-x", "--proxy", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-K", "--config", "--cacert", "--cert", "--key", "-r", "--range", "--retry", "-z", "--time-cond", "--resolve", "--connect-to", "-E", "--limit-rate", "-Y", "-y", "--max-redirs", "--interface", "--dns-servers", "-D", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--unix-socket", "--abstract-unix-socket", "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "--json", "-T", "--upload-file", "--url", "-U", "--proxy-user", "--oauth2-bearer", "--aws-sigv4", "--variable", "--expand-url"];
const CURL_DATA = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "--json", "-T", "--upload-file"];

function curl(args) {
	let method;
	let data = false;
	let get = false;
	let local = false;
	const urls = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		const [flag, joined] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
		if (flag === "-X" || flag === "--request") method = (joined ?? args[++i] ?? "").toUpperCase();
		else if (/^-X./.test(word)) method = word.slice(2).toUpperCase();
		else if (CURL_DATA.includes(flag)) {
			data = true;
			if (joined === undefined) i++;
		} else if (/^-[dFT]./.test(word)) data = true;
		else if (flag === "--url") urls.push(joined ?? args[++i] ?? "");
		else if (flag === "--unix-socket" || flag === "--abstract-unix-socket") {
			local = true;
			if (joined === undefined) i++;
		} else if (flag === "-G" || flag === "--get") get = true;
		else if (flag === "-I" || flag === "--head") method ??= "HEAD";
		else if (CURL_VALUES.includes(flag)) {
			if (joined === undefined) i++;
		} else if (!word.startsWith("-")) urls.push(word);
	}
	const sent = method ?? (data && !get ? "POST" : "GET");
	if (sent === "GET" || sent === "HEAD" || sent === "OPTIONS" || local) return undefined;
	const hosts = urls.map(hostOf);
	return hosts.length === 0 || hosts.some((host) => host === undefined || !isLocalHost(host)) ? "send" : undefined;
}

function wget(args) {
	let method = "GET";
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "--method") method = (args[++i] ?? "").toUpperCase();
		else if (word.startsWith("--method=")) method = word.slice("--method=".length).toUpperCase();
		else if (/^--(post|body)-(data|file)/.test(word) && method === "GET") method = "POST";
	}
	if (method === "GET" || method === "HEAD") return undefined;
	const hosts = outsideHosts(positionals(args, ["--method", "--post-data", "--post-file", "--body-data", "--body-file", "-O", "-o", "-P", "--header", "-U"]));
	return hosts.length > 0 ? "send" : undefined;
}

const HTTPIE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

/** HTTPie (`http`, `https`) and `xh`: a method word, or data items that make it a POST. */
function httpie(args) {
	const words = positionals(args, ["-a", "--auth", "--session", "-o", "--output", "--verify", "--cert", "--cert-key", "--proxy", "--timeout"]);
	let method;
	let rest = words;
	if (words[0] !== undefined && HTTPIE_METHODS.has(words[0])) {
		method = words[0];
		rest = words.slice(1);
	}
	const [url, ...items] = rest;
	if (url === undefined) return undefined;
	const data = items.some((item) => /^[^=:]+(=|:=|@|=@|:=@)/.test(item) && !/^[^=:]+==/.test(item)) || has(args, "-f", "--form", "--raw");
	const sent = method ?? (data ? "POST" : "GET");
	if (sent === "GET" || sent === "HEAD" || sent === "OPTIONS") return undefined;
	const host = hostOf(url) ?? (url.startsWith(":") ? "localhost" : url.split(/[/:]/)[0]);
	return isLocalHost(host) ? undefined : "send";
}

/** `scp`, `rsync` and `sftp`: a copy whose destination is another machine. */
function remoteCopy(name, args) {
	const words = positionals(args, ["-e", "--rsh", "-P", "-i", "-o", "-F", "-c", "-l", "-S", "-J", "--port", "--exclude", "--include", "--filter", "--chmod", "--rsync-path"]);
	if (name === "sftp") return words.length > 0 ? "send" : undefined;
	const destination = words.at(-1);
	if (words.length < 2 || destination === undefined) return undefined;
	const remote = /^(?:[^/:@]+@)?(\[[^\]]+\]|[^/:]+):/.exec(destination) ?? /^rsync:\/\/([^/]+)/.exec(destination);
	return remote && !isLocalHost(remote[1]) ? "send" : undefined;
}

const MAILERS = new Set(["mail", "mailx", "sendmail", "msmtp", "mutt"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put"]);

/**
 * Is a path, as the command names it, outside the Workspace and the other
 * roots? A root itself counts as outside unless `within` says a deletion
 * there only reaches what is under it (as `find`'s starting point does).
 * A home or job folder prefix is that folder only in a word with its mark
 * ({@link expanded}); anything else unknown counts as outside.
 */
function outside(written, context, within = false) {
	const target = expanded(written, context);
	if (target === "" || target.startsWith("~") || target.includes("$") || target.includes("`")) return true;
	if (!target.startsWith("/") && context.cwd === undefined) return true;
	const resolved = posix.resolve(context.cwd ?? "/", target);
	return !context.roots.some((root) => resolved.startsWith(`${root}/`) || (within && resolved === root));
}

function remove(name, args, context) {
	if (context.xargs) return "delete";
	const targets = name === "shred" ? positionals(args, ["-n", "--iterations", "-s", "--size", "--random-source"]) : positionals(args);
	return targets.some((target) => outside(target, context)) ? "delete" : undefined;
}

/** `find` that deletes what it finds: `-delete`, or `-exec rm` and its kin. The starting points are what it deletes under. */
function find(args, context) {
	const deletes = args.some((word, i) => word === "-delete" || (["-exec", "-execdir", "-ok", "-okdir"].includes(word) && DELETERS.has(posix.basename(args[i + 1] ?? ""))));
	if (!deletes) return undefined;
	const roots = [];
	for (const word of args) {
		if (word.startsWith("-") || word === "(" || word === "!") {
			if (["-H", "-L", "-P"].includes(word) && roots.length === 0) continue;
			break;
		}
		roots.push(word);
	}
	return (roots.length === 0 ? ["."] : roots).some((root) => outside(root, context, true)) ? "delete" : undefined;
}

function make(args) {
	const targets = positionals(args, ["-C", "-f", "--file", "--directory", "-j", "-I", "-o", "-W"]).filter((word) => !ASSIGNMENT.test(word));
	for (const target of targets) {
		const kind = scriptKind(target);
		if (kind) return kind;
	}
	return undefined;
}

/** The floor kind of one simple command, past its wrappers, or undefined. Only deletes read the marks {@link segments} puts on words. */
function classify(marked, context) {
	const words = marked.map(plain);
	const [head, ...args] = words;
	const name = posix.basename(head);
	if (name === "git") return git(args);
	if (name === "gh") return gh(args);
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) return packageManager(name, args);
	if (name === "make" || name === "just" || name === "task") return make(args);
	if (name === "aws") return aws(args);
	if (name === "gsutil") return gsutil(args);
	if (name === "curl") return curl(args);
	if (name === "wget") return wget(args);
	if (name === "http" || name === "https" || name === "xh" || name === "xhs") return httpie(args);
	if (name === "scp" || name === "rsync" || name === "sftp") return remoteCopy(name, args);
	if (name === "ssh") return positionals(args, ["-i", "-p", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-m", "-S", "-w", "-B", "-e", "-Q"]).length > 0 ? "send" : undefined;
	if (MAILERS.has(name)) return "send";
	if (DELETERS.has(name)) return remove(name, marked.slice(1), context);
	if (name === "find") return find(marked.slice(1), context);
	if (name === "dotnet" && args[0] === "nuget" && args[1] === "push") return "publish";
	if (name in PUBLISHERS && name !== "dotnet" && name !== "helm") {
		const [sub, ...rest] = positionals(args, ["--registry", "-r", "--token", "--repository", "--index", "-u", "--username", "-p", "--password"]);
		if (PUBLISHERS[name].includes(sub)) return dryRun(rest) || has(args, "--dry-run") ? undefined : "publish";
		if ((name === "docker" || name === "podman") && (sub === "buildx" || sub === "build") && has(args, "--push")) return "publish";
		return undefined;
	}
	if (name === "helm" && positionals(args)[0] === "push") return "publish";
	if (name in DEPLOYERS || name === "gcloud" || name === "az") return deploy(name, args);
	return undefined;
}
