/**
 * The floor classifier: a Bash command and the Workspace in, "a floor action
 * or not, and which kind" out. One table, each row asserted floor or not with
 * its kind.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { posix } from "node:path";
import { describe, it } from "node:test";
import { claudeConfigDir, floorAction, ownFolders, simpleCommands } from "../floor.mjs";

const WORKSPACE = "/work/effort";

/** `[command, kind]`, where `undefined` means the command is not on the floor. */
const TABLE: [string, string | undefined][] = [
	// Pushes, in every spelling.
	["git push", "push"],
	["git push origin main", "push"],
	["git -C . push", "push"],
	["git -C /work/effort push origin HEAD", "push"],
	["git -c core.sshCommand=ssh push", "push"],
	["git --no-pager --git-dir=.git push", "push"],
	["sh -c 'git push'", "push"],
	['bash -lc "cd sub && git push -u origin feature"', "push"],
	["git push --force", "push"],
	["git push origin main --force", "push"],
	["git push -f origin main", "push"],
	["npm test && git push", "push"],
	["echo done; git push", "push"],
	["FOO=1 git push", "push"],
	["env GIT_TRACE=1 git push", "push"],
	["sudo git push", "push"],
	["echo $(git push)", "push"],
	["git push --dry-run", undefined],
	["git push -n", undefined],
	["git status", undefined],
	["git commit -m 'git push later'", undefined],
	["echo git push", undefined],
	["git log --grep push", undefined],
	["gh pr create --fill", "send"],
	["gh pr merge 12 --squash", "push"],
	["gh repo sync", "push"],

	// Publishes.
	["npm publish", "publish"],
	["npm publish --access public", "publish"],
	["npm publish --dry-run", undefined],
	["pnpm publish", "publish"],
	["yarn npm publish", "publish"],
	["yarn publish", "publish"],
	["npm unpublish pkg@1.0.0", "publish"],
	["cargo publish", "publish"],
	["cargo publish --dry-run", undefined],
	["twine upload dist/*", "publish"],
	["python -m twine upload dist/*", "publish"],
	["poetry publish --build", "publish"],
	["gem push pkg.gem", "publish"],
	["docker push ghcr.io/me/app:1", "publish"],
	["gh release create v1.0.0", "publish"],
	["npm pack", undefined],
	["npm install", undefined],

	// Deploy CLIs.
	["vercel --prod", "deploy"],
	["vercel deploy", "deploy"],
	["netlify deploy --prod", "deploy"],
	["fly deploy", "deploy"],
	["flyctl deploy", "deploy"],
	["firebase deploy", "deploy"],
	["wrangler deploy", "deploy"],
	["npx wrangler deploy", "deploy"],
	["kubectl apply -f k8s/", "deploy"],
	["kubectl get pods", undefined],
	["helm upgrade --install app ./chart", "deploy"],
	["helm template ./chart", undefined],
	["terraform apply -auto-approve", "deploy"],
	["terraform plan", undefined],
	["pulumi up --yes", "deploy"],
	["cdk deploy", "deploy"],
	["serverless deploy", "deploy"],
	["gcloud run deploy app", "deploy"],
	["aws s3 cp build s3://bucket --recursive", "deploy"],
	["aws s3 ls", undefined],
	["npm run deploy", "deploy"],
	["make deploy", "deploy"],
	["npm run build", undefined],

	// HTTP: non-GET to an outside host is a send; a read-only fetch is not.
	["curl -X POST https://api.example.com/hook", "send"],
	["curl -XPOST https://api.example.com/hook", "send"],
	["curl --request PUT https://api.example.com/x", "send"],
	["curl -d '{\"a\":1}' https://api.example.com/x", "send"],
	["curl --data-binary @file https://api.example.com/x", "send"],
	["curl -F file=@a.txt https://api.example.com/upload", "send"],
	["curl --json '{}' https://api.example.com/x", "send"],
	["curl https://example.com", undefined],
	["curl -sSL https://example.com/install.sh -o install.sh", undefined],
	["curl -X GET https://api.example.com/x", undefined],
	["curl -I https://example.com", undefined],
	["curl -X POST http://localhost:3000/api", undefined],
	["curl -X POST http://127.0.0.1:8080/api", undefined],
	// A local host written out, with the port or path in a variable (#142).
	['curl -X PUT -d v "http://127.0.0.1:$PORT/keys/a"', undefined],
	['curl -X PUT -d v "http://localhost:${PORT}/keys/$KEY"', undefined],
	['curl -X DELETE "http://[::1]:$PORT/keys/a"', undefined],
	["curl -X PUT -d v 127.0.0.1:$PORT/keys/a", undefined],
	// A host that isn't written out, or isn't only a local one.
	['curl -X POST -d x "$URL"', "send"],
	['curl -X PUT -d v "$URL/keys/a"', "send"],
	['URL=http://127.0.0.1:7070 && curl -X PUT -d v "$URL/keys/a"', "send"],
	['curl -X PUT -d v "http://$HOST:7070/keys/a"', "send"],
	['curl -X PUT -d v "http://127.0.0.1$SUFFIX/keys/a"', "send"],
	['curl -X PUT -d v "http://localhost$SUFFIX/keys/a"', "send"],
	['curl -X PUT -d v "http://127.0.0.1:80$X/keys/a"', "send"],
	["curl -X POST http://127.attacker.example/x", "send"],
	['curl -X POST "http://api.example.com?@127.0.0.1/"', "send"],
	['curl -X POST "http://api.example.com#@127.0.0.1/"', "send"],
	["wget --method=PUT http://$HOST/x", "send"],
	["wget https://example.com/file.tgz", undefined],
	["wget --post-data a=1 https://api.example.com/x", "send"],
	["http POST api.example.com/x a=1", "send"],
	["http GET api.example.com/x", undefined],
	["gh issue create --title t --body b", "send"],
	["gh issue comment 3 --body hi", "send"],
	["gh issue view 3", undefined],
	["gh api repos/o/r/issues -f title=t", "send"],
	["gh api -X POST repos/o/r/issues", "send"],
	["gh api repos/o/r/issues", undefined],
	["scp build.tgz host:/srv", "send"],
	["rsync -a dist/ host:/srv/www", "send"],
	["rsync -a dist/ backup/", undefined],
	["ssh deploy@host ./restart.sh", "send"],

	// Deletes, inside versus outside the Workspace.
	["rm -rf build", undefined],
	["rm -rf ./node_modules dist", undefined],
	["rm /work/effort/tmp.txt", undefined],
	["rm -rf /work/effort", "delete"],
	["rm -rf /tmp/scratch", "delete"],
	["rm -rf ../other", "delete"],
	["rm -rf ~/projects", "delete"],
	["rm -rf $HOME/x", "delete"],
	["rm -rf /", "delete"],
	["cd /tmp && rm -rf scratch", "delete"],
	["cd sub && rm -rf build", undefined],
	["rm -rf /work/effort-other", "delete"],
	["sh -c 'rm -rf /etc/x'", "delete"],
	["find / -name '*.log' -delete", "delete"],
	["find . -name '*.log' -delete", undefined],
	["find /var/log -exec rm {} \\;", "delete"],
	["rmdir /opt/old", "delete"],
	["unlink ../x", "delete"],
	["ls -la", undefined],
	["npm test", undefined],
];

describe("the floor classifier", () => {
	for (const [command, kind] of TABLE) {
		it(`${JSON.stringify(command)} is ${kind === undefined ? "not on the floor" : `a floor ${kind}`}`, () => {
			assert.equal(floorAction(command, { workspace: WORKSPACE })?.kind, kind);
		});
	}

	it("reads relative deletes against the command's own directory, not just the Workspace", () => {
		assert.equal(floorAction("rm -rf build", { workspace: WORKSPACE, cwd: "/work/effort/sub" })?.kind, undefined);
		assert.equal(floorAction("rm -rf ../../x", { workspace: WORKSPACE, cwd: "/work/effort/sub" })?.kind, "delete");
		assert.equal(floorAction("rm -rf build", { workspace: WORKSPACE, cwd: "/elsewhere" })?.kind, "delete");
	});

	it("counts a delete under the Teammate's own temp folder as inside, but not the folder itself or a `../` out of it", () => {
		const where = { workspace: WORKSPACE, roots: ["/home/qa/.claude/jobs/bad941c8/tmp"] };
		assert.equal(floorAction("rm -f /home/qa/.claude/jobs/bad941c8/tmp/x", where)?.kind, undefined);
		assert.equal(floorAction("rm -rf /home/qa/.claude/jobs/bad941c8/tmp/clone build", where)?.kind, undefined);
		assert.equal(floorAction("find /home/qa/.claude/jobs/bad941c8/tmp -name '*.log' -delete", where)?.kind, undefined);
		assert.equal(floorAction("rm -rf /home/qa/.claude/jobs/bad941c8/tmp", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf /home/qa/.claude/jobs/bad941c8/tmp/../state.json", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf /home/qa/.claude/jobs/bad941c8/tmp-other", where)?.kind, "delete");
		assert.equal(floorAction("rm -f /home/qa/.claude/jobs/bad941c8/tmp/x", { workspace: WORKSPACE })?.kind, "delete");
	});

	it("ignores a root that is `/`, relative or the home folder itself, so it never widens what is inside", () => {
		const home = "/home/qa";
		for (const [root, command] of [
			["/", "rm -rf /tmp/important"],
			["/", "find / -delete"],
			["//", "find / -delete"],
			[".", `rm -rf ${posix.resolve("x")}`],
			["tmp", `rm -rf ${posix.resolve("tmp", "x")}`],
			[home, "rm -rf ~/projects"],
			[`${home}/`, "rm -rf /home/qa/projects"],
		]) {
			assert.equal(floorAction(command, { workspace: WORKSPACE, home, roots: [root] })?.kind, "delete", `root ${JSON.stringify(root)}, \`${command}\``);
		}
	});

	it("reads `~/` and `$HOME/` as the home folder, and any other variable as unknown, so outside", () => {
		const where = { workspace: WORKSPACE, home: "/home/qa", roots: ["/home/qa/.claude/jobs/bad941c8/tmp"] };
		assert.equal(floorAction("rm -f ~/.claude/jobs/bad941c8/tmp/x", where)?.kind, undefined);
		assert.equal(floorAction("rm -rf $HOME/.claude/jobs/bad941c8/tmp/clone", where)?.kind, undefined);
		assert.equal(floorAction('rm -rf "${HOME}/.claude/jobs/bad941c8/tmp/clone"', where)?.kind, undefined);
		assert.equal(floorAction("cd ~/.claude/jobs/bad941c8/tmp && rm -rf clone", where)?.kind, undefined);
		assert.equal(floorAction("rm -rf ~/.claude/jobs/bad941c8/tmp/../../other", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf ~/projects", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf ~", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf ~qa/.claude/jobs/bad941c8/tmp/x", where)?.kind, "delete");
		assert.equal(floorAction("J=~/.claude/jobs/bad941c8/tmp; rm -rf $J/clone", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf $HOME$SUB/x", where)?.kind, "delete");
		assert.equal(floorAction("rm -rf ~/.claude/jobs/bad941c8/tmp/`whoami`", where)?.kind, "delete");
		assert.equal(floorAction("rm -f /work/effort/~/x", where)?.kind, undefined);
	});

	describe("reads the home folder only from an unquoted `~/`, `$HOME/` or `${HOME}/`, or a double-quoted `$HOME` token, and only while nothing reassigns HOME", () => {
		const where = { workspace: WORKSPACE, home: "/home/qa", roots: ["/home/qa/.claude/jobs/bad941c8/tmp"] };
		const path = ".claude/jobs/bad941c8/tmp/x";
		/** `[target as written, inside]`: each is run as `cd /etc && rm -rf <target>`. */
		const targets: [string, boolean][] = [
			[`~/${path}`, true],
			[`$HOME/${path}`, true],
			[`\${HOME}/${path}`, true],
			[`"$HOME"/${path}`, true],
			[`"\${HOME}"/${path}`, true],
			[`"$HOME/${path}"`, true],
			[`"\${HOME}/${path}"`, true],
			[`'~/${path}'`, false],
			[`"~/${path}"`, false],
			[`\\~/${path}`, false],
			[`''~/${path}`, false],
			[`'$HOME'/${path}`, false],
			[`\\$HOME/${path}`, false],
			[`"\\$HOME/${path}"`, false],
			[`"\\$HOME"/${path}`, false],
			[`$'HOME'/${path}`, false],
			[`"$"HOME/${path}`, false],
			[`$\\HOME/${path}`, false],
			[`$HOM\\E/${path}`, false],
			[`$H""OME/${path}`, false],
			[`$"HOME"/${path}`, false],
			[`""$HOME/${path}`, false],
			[`~"/${path}"`, false],
			[`~'/${path}'`, false],
			[`~\\/${path}`, false],
			[`~""/${path}`, false],
		];
		for (const [target, inside] of targets) {
			const command = `cd /etc && rm -rf ${target}`;
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "outside"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		for (const command of [
			"cd '~/.claude/jobs/bad941c8/tmp' && rm -rf x",
			'cd ~"/.claude/jobs/bad941c8/tmp" && rm -rf x',
			"HOME=/etc; rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"export HOME=/etc; rm -rf $HOME/.claude/jobs/bad941c8/tmp/x",
			"declare -x HOME=/etc; rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"typeset HOME=/etc; rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"f() { local HOME=/etc; rm -rf ~/.claude/jobs/bad941c8/tmp/x; }; f",
			"unset HOME; rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"read HOME < f; rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"HOME=/etc rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"env HOME=/etc rm -rf ~/.claude/jobs/bad941c8/tmp/x",
			"rm -rf ~/.claude/jobs/bad941c8/tmp/x; sh -c 'HOME=/etc'",
		]) {
			it(`${JSON.stringify(command)} is outside`, () => {
				assert.equal(floorAction(command, where)?.kind, "delete");
			});
		}

		it("still reads a variable merely named like HOME, or `$HOME` used again, as no reassignment", () => {
			assert.equal(floorAction("MY_HOME=/etc HOME_DIR=/etc; rm -rf ~/.claude/jobs/bad941c8/tmp/x", where)?.kind, undefined);
			assert.equal(floorAction('echo "$HOME" && rm -rf ${HOME}/.claude/jobs/bad941c8/tmp/x', where)?.kind, undefined);
		});
	});

	describe("reads `$CLAUDE_JOB_DIR` as the trusted job folder, and only while nothing reassigns it", () => {
		const job = "/home/qa/.claude/jobs/02878adf";
		const where = { workspace: WORKSPACE, home: "/home/qa", jobDir: job, roots: [`${job}/tmp`] };
		/** `[command, inside]`, each read with the Teammate's own job folder. */
		const commands: [string, boolean][] = [
			// The three deletes the dogfood run held (#130).
			['cd $CLAUDE_JOB_DIR/tmp/qa-gg && grep -c "Victory!" fastwin.mjs; rm -f fastwin-done.flag', true],
			["cd $CLAUDE_JOB_DIR/tmp/qa-gg && rm -rf mut && mkdir mut", true],
			["rm -rf $CLAUDE_JOB_DIR/tmp/old", true],
			// Every spelling the shell is sure to expand.
			["rm -rf ${CLAUDE_JOB_DIR}/tmp/old", true],
			['rm -rf "$CLAUDE_JOB_DIR/tmp/old"', true],
			['rm -rf "$CLAUDE_JOB_DIR"/tmp/old', true],
			['rm -rf "${CLAUDE_JOB_DIR}/tmp/old"', true],
			['rm -rf "${CLAUDE_JOB_DIR}"/tmp/old', true],
			['cd "$CLAUDE_JOB_DIR/tmp" && rm -rf old', true],
			["find $CLAUDE_JOB_DIR/tmp/qa-gg -name '*.log' -delete", true],
			['echo "$CLAUDE_JOB_DIR" && rm -rf $CLAUDE_JOB_DIR/tmp/old', true],
			// The job folder and its temp root themselves, and a way out of them.
			["rm -rf $CLAUDE_JOB_DIR", false],
			['rm -rf "$CLAUDE_JOB_DIR"', false],
			["rm -rf $CLAUDE_JOB_DIR/tmp", false],
			["rm -rf $CLAUDE_JOB_DIR/tmp/", false],
			["rm -rf $CLAUDE_JOB_DIR/tmp/../state.json", false],
			["cd $CLAUDE_JOB_DIR/tmp && rm -rf ../state.json", false],
			["cd $CLAUDE_JOB_DIR && rm -rf tmp", false],
			// Spellings that aren't the variable, or not only it.
			["rm -rf '$CLAUDE_JOB_DIR/tmp/old'", false],
			["rm -rf \\$CLAUDE_JOB_DIR/tmp/old", false],
			["rm -rf $CLAUDE_JOB_DIRX/tmp/old", false],
			["rm -rf ${CLAUDE_JOB_DIR}x/tmp/old", false],
			['rm -rf "$CLAUDE_JOB_DIR"x/tmp/old', false],
			["rm -rf $CLAUDE_JOB_DIR$SUB/tmp/old", false],
			["rm -rf $CLAUDE_JOB_\\DIR/tmp/old", false],
			// A name set to it reads as the folder, unquoted too where bash can't split it (#141, #144).
			["J=$CLAUDE_JOB_DIR/tmp; rm -rf $J/old", true],
			// A line that names CLAUDE_JOB_DIR otherwise, in any spelling, may change it.
			["CLAUDE_JOB_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["CLAUDE_JOB_DIR=/etc rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["export CLAUDE_JOB_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["export CLAUDE_JOB\\_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			['export "CLAUDE_JOB"_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x', false],
			["declare CLAUDE_JOB''_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["typeset -x CLAUDE_JOB_DIR=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["read -r CLAUDE_JOB_DIR <<< /etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["unset CLAUDE_JOB_DIR; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["printf -v CLAUDE_JOB_DIR /etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			['eval "CLAUDE_JOB""_DIR=/etc"; rm -rf $CLAUDE_JOB_DIR/tmp/x', false],
			["export $'CLAUDE_JOB_\\x44IR'=/etc; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			[": ${CLAUDE_JOB_DIR:=/etc}; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["rm -rf $CLAUDE_JOB_DIR/tmp/x; sh -c 'CLAUDE_JOB_DIR=/etc'", false],
			// A shell of its own may not have the variable at all (`sudo`, `env -i`).
			["sudo sh -c 'rm -rf $CLAUDE_JOB_DIR/tmp/x'", false],
			["env -i bash -c 'rm -rf \"$CLAUDE_JOB_DIR\"/tmp/x'", false],
			// Unquoted, bash splits it on IFS.
			["IFS=/; rm -rf $CLAUDE_JOB_DIR/tmp/x", false],
			["I\\FS=/; rm -rf ${CLAUDE_JOB_DIR}/tmp/x", false],
			['IFS=/; rm -rf "$CLAUDE_JOB_DIR"/tmp/x', true],
		];
		for (const [command, inside] of commands) {
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "a floor delete"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		it("reads it as unknown, so outside, when no trusted job folder is given", () => {
			assert.equal(floorAction("rm -rf $CLAUDE_JOB_DIR/tmp/old", { workspace: WORKSPACE, roots: [`${job}/tmp`] })?.kind, "delete");
			assert.equal(floorAction('rm -rf "$CLAUDE_JOB_DIR/tmp/old"', { workspace: WORKSPACE, roots: [`${job}/tmp`] })?.kind, "delete");
			assert.equal(floorAction("rm -rf $CLAUDE_JOB_DIR/tmp/old", { workspace: WORKSPACE, jobDir: "jobs/02878adf", roots: [`${job}/tmp`] })?.kind, "delete");
		});

		it("reads the unquoted form as unknown when the job folder's path holds whitespace or a glob character", () => {
			for (const spaced of ["/home/John Smith/.claude/jobs/02878adf", "/home/qa/.claude*/jobs/02878adf"]) {
				const at = { workspace: WORKSPACE, jobDir: spaced, roots: [`${spaced}/tmp`] };
				assert.equal(floorAction("rm -rf $CLAUDE_JOB_DIR/tmp/x", at)?.kind, "delete", spaced);
				assert.equal(floorAction("rm -rf ${CLAUDE_JOB_DIR}/tmp/x", at)?.kind, "delete", spaced);
				assert.equal(floorAction('rm -rf "$CLAUDE_JOB_DIR/tmp/x"', at)?.kind, undefined, spaced);
			}
		});
	});

	describe("reads a name the command itself sets once, plainly, before a quoted use, as the path it holds (#141)", () => {
		const job = "/home/qa/.claude/jobs/02878adf";
		const where = { workspace: WORKSPACE, home: "/home/qa", jobDir: job, roots: [`${job}/tmp`] };
		/** `[command, inside]`, each read with the Teammate's own job folder and the Workspace as its directory. */
		const commands: [string, boolean][] = [
			// The scratch deletes the dogfood run held.
			['T="$CLAUDE_JOB_DIR/tmp/smoke" && rm -rf "$T"', true],
			['M=$CLAUDE_JOB_DIR/tmp/mut; rm -rf "$M"', true],
			['TMP=/work/effort/.scratch && D="$TMP/v1" && rm -f "$D/kv.json"', true],
			['TMP=$PWD/.scratch && rm -rf "$TMP"', true],
			// Other spellings of the same thing.
			['T="${CLAUDE_JOB_DIR}"/tmp/x\nrm -rf "${T}"/y', true],
			['TMP="$PWD"/.scratch; rm -rf "$TMP/soak2"', true],
			['A=/work/effort/a B="$A/b"; rm -rf "$B"', true],
			['T=/work/effort/.s && cd "$T" && rm -rf old', true],
			['T=$PWD/.s; cd /; rm -rf "$T"', true],
			['T=/work/effort/.s && find "$T" -name "*.log" -delete', true],
			// The value isn't a path the floor reads.
			['T=/etc && rm -rf "$T"', false],
			['T=$(pwd) && rm -rf "$T"', false],
			['T=`pwd` && rm -rf "$T"', false],
			['T=/work/effort/x$Y && rm -rf "$T"', false],
			['T=~/x && rm -rf "$T"', false],
			['T=$HOME/x && rm -rf "$T"', false],
			['T=x && rm -rf "$T"', false],
			["T='$PWD/x' && rm -rf \"$T\"", false],
			['cd /tmp; T=$PWD/x; rm -rf "$T"', false],
			['PWD=/etc; T=$PWD/x; rm -rf "$T"', false],
			['T=$U/x && rm -rf "$T"', false],
			// The root itself, or a way out of it.
			['T="$CLAUDE_JOB_DIR/tmp" && rm -rf "$T"', false],
			['T="$CLAUDE_JOB_DIR"/tmp; rm -rf "$T"', false],
			['T=/work/effort && rm -rf "$T"', false],
			['T=/work/effort/x && rm -rf "$T/../../etc"', false],
			['T=/work/effort && rm -rf "$T"-other', false],
			// Assigned more than once, or named otherwise.
			['T="$CLAUDE_JOB_DIR/tmp/x"; T=/etc; rm -rf "$T"', false],
			['T=/work/effort/x; export T; rm -rf "$T"', false],
			['export T=/work/effort/x; rm -rf "$T"', false],
			['T=/work/effort/x; read -r T < f; rm -rf "$T"', false],
			['T=/work/effort/x; unset T; rm -rf "$T"', false],
			['T=/work/effort/x; : ${T:=/etc}; rm -rf "$T"', false],
			['T=/work/effort/x; echo $(T=/etc); rm -rf "$T"', false],
			// Not sure to run before the use, or run apart from it.
			['T="$CLAUDE_JOB_DIR/tmp/x" && cmd & rm -rf "$T"', false],
			['T=/work/effort/x & rm -rf "$T"', false],
			['T=/work/effort/x | rm -rf "$T"', false],
			['false && T=/work/effort/x; rm -rf "$T"', false],
			['true || T=/work/effort/x; rm -rf "$T"', false],
			['T=/work/effort/x || rm -rf "$T"', false],
			['cd sub && T=/work/effort/x; rm -rf "$T"', false],
			['rm -rf "$T"; T=/work/effort/x', false],
			['T=/work/effort/x rm -rf "$T"', false],
			['(T=/work/effort/x); rm -rf "$T"', false],
			['{ T=/work/effort/x; }; rm -rf "$T"', false],
			['if true; then T=/work/effort/x; fi; rm -rf "$T"', false],
			['for d in a; do T=/work/effort/x; done; rm -rf "$T"', false],
			['f() { T=/etc; }; f; rm -rf "$T"', false],
			['T=/work/effort/x; source ./env.sh; rm -rf "$T"', false],
			['T=/work/effort/x; eval "$CMD"; rm -rf "$T"', false],
			["T=/work/effort/x; sh -c 'rm -rf \"$T\"'", false],
			// Unquoted, only where bash can't split or glob it (#144).
			["T=/work/effort/x; rm -rf $T", true],
			["T=/work/effort/x; rm -rf ${T}/y", true],
			["T='/work/effort/a b'; rm -rf $T", false],
			// A name the shell gives a value of its own.
			['RANDOM=/work/effort/x; rm -rf "$RANDOM"', false],
		];
		for (const [command, inside] of commands) {
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "a floor delete"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		it("lists a quoted name's word for permission rules as it is written, unmarked", () => {
			assert.deepEqual(simpleCommands('T=/work/effort/x && rm -rf "$T"/y "${T}"'), [["rm", "-rf", "$T/y", "${T}"]]);
		});
	});

	describe("reads a name unquoted where bash can't split it, and past a function that can't change it (#144)", () => {
		const where = { workspace: WORKSPACE, home: "/home/qa", jobDir: "/abs/own", roots: ["/abs/own/tmp"] };
		/** `[command, inside]`, each read with the Teammate's own job folder and the Workspace as its directory. */
		const commands: [string, boolean][] = [
			// The deletes the dogfood run held, cut down.
			["Q=/abs/own/tmp/qa\nrm -f $Q/a", true],
			['Q=/abs/own/tmp/qa\nrm -f "$Q"/a; K(){ node x "$@"; }', true],
			// Unquoted, a literal with no whitespace or glob character, on a line that doesn't name IFS.
			["Q=/abs/own/tmp/qa; rm -f $Q/a $Q/b", true],
			["Q=/abs/own/tmp/qa; rm -rf ${Q}/a", true],
			["Q=/abs/own/tmp/qa; rm -rf $Q", true],
			["Q=/abs/own/tmp/qa && cd $Q && rm -f a", true],
			["T=$CLAUDE_JOB_DIR/tmp/x; rm -rf $T/y", true],
			["A=/abs/own/tmp; B=$A/qa; rm -rf $B/y", true],
			["Q='/abs/own/tmp/a b'; rm -f $Q/x", false],
			['Q="/abs/own/tmp/a b"; rm -f $Q/x', false],
			["Q=/abs/own/tmp/a\\ b; rm -f $Q/x", false],
			["Q='/abs/own/tmp/a*'; rm -f $Q/x", false],
			["Q='/abs/own/tmp/[ab]'; rm -f $Q/x", false],
			["IFS=/; Q=/abs/own/tmp/qa; rm -f $Q/x", false],
			["Q=/abs/own/tmp/qa; IFS=/ rm -f $Q/x", false],
			["Q=/abs/own/tmp/qa; rm -f $Q.bak", false],
			["Q=/abs/own/tmp/qa; rm -f $Qx/a", false],
			["Q=/abs/own/tmp; rm -rf $Q", false],
			// A function whose body can't change the name.
			['Q=/abs/own/tmp/qa; K(){ node x "$@"; }; K set a 1; rm -f "$Q"/a', true],
			['K() { node x "$@"; }\nQ=/abs/own/tmp/qa\nrm -f $Q/a', true],
			["K()\n{\n  node x \"$@\"\n}\nQ=/abs/own/tmp/qa; rm -f $Q/a", true],
			['function K { node x "$@"; }; Q=/abs/own/tmp/qa; rm -f $Q/a', true],
			['function K() { echo "$Q"; }; Q=/abs/own/tmp/qa; rm -f $Q/a', true],
			['Q=/abs/own/tmp/qa; K(){ if [ -f "$1" ]; then cat "$1"; fi; }; K "$Q"/a; rm -f $Q/a', true],
			["Q=/abs/own/tmp/qa; K(){ printf '%s\\n' \"$@\"; X=1; }; rm -f $Q/a", true],
			['Q=/abs/own/tmp/qa; K(){ out=$(node x "$@"); echo "$out"; }; rm -f $Q/a', true],
			['Q=/abs/own/tmp/qa; K(){ case "$1" in a) node x;; esac; }; rm -f $Q/a', true],
			// A function whose body may change it, or that the floor can't read.
			['Q=/abs/own/tmp/qa; K(){ Q=/etc; }; K; rm -f "$Q"/x', false],
			['Q=/abs/own/tmp/qa; K(){ eval "$1"; }; K "$X"; rm -f "$Q"/x', false],
			['Q=/abs/own/tmp/qa; K(){ if true; then eval "$1"; fi; }; K "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ command eval "$1"; }; K "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ X=1 eval "$1"; }; K "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ case "$1" in a) eval "$2";; esac; }; K a "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ builtin eval "$1"; }; K "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; function K { \\eval "$1"; }; K "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ source ./env.sh; }; K; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ . ./env.sh; }; K; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ declare -g "$1=/etc"; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ local "$1"; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ typeset "$1=/etc"; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ export "$1=/etc"; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ read -r "$1"; }; K "$N" < f; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ unset "$1"; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ printf -v "$1" %s /etc; }; K "$N"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ "$@"; }; K eval "$X"; rm -f $Q/x', false],
			['Q=/abs/own/tmp/qa; K(){ $CMD; }; K; rm -f $Q/x', false],
			["Q=/abs/own/tmp/qa; K() ( node x ); K; rm -f $Q/x", false],
			["Q=/abs/own/tmp/qa; K(){ node x; rm -f $Q/x", false],
			// A function body runs where it's called: a delete in it before the name is set doesn't read it.
			["K(){ rm -rf $Q/x; }; Q=/abs/own/tmp/qa; K", false],
			// An assignment in a function body binds nothing.
			['K(){ T=/abs/own/tmp/qa; }; rm -rf "$T"/x', false],
			// Groups outside a function's body still end the following of names.
			["{ :; }; Q=/abs/own/tmp/qa; rm -f $Q/x", false],
		];
		for (const [command, inside] of commands) {
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "a floor delete"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		it("lists an unquoted name's word and a function's header for permission rules as written, unmarked", () => {
			assert.deepEqual(simpleCommands("Q=/x; rm -f $Q/y ${Q}"), [["rm", "-f", "$Q/y", "${Q}"]]);
			assert.deepEqual(simpleCommands('K(){ node x "$@"; }; function L { git push; }'), [["K"], ["node", "x", "$@"], ["function", "L"], ["git", "push"]]);
		});
	});

	describe("follows a `cd` only where it surely runs in this shell, and reads the folder as unknown after any other (#146)", () => {
		const where = { workspace: "/ws", cwd: "/ws" };
		/** `[command, inside]`, each read with `/ws` as the Workspace and the directory it runs in. */
		const commands: [string, boolean][] = [
			// The cases the issue found: each deletes /etc.
			["cd /; (cd /ws); rm -rf etc", false],
			["cd /; true || cd /ws; rm -rf etc", false],
			["cd /; false && cd /ws; rm -rf etc", false],
			["cd /; echo $(cd /ws); rm -rf etc", false],
			["cd /; echo `cd /ws`; rm -rf etc", false],
			["cd /; K(){ cd /ws; }; rm -rf etc", false],
			["cd /; function K { cd /ws; }; rm -rf etc", false],
			["cd /; cd /ws &\nrm -rf etc", false],
			// A `cd` in a compound command, a group, a process substitution or a coprocess.
			["cd /; if true; then cd /ws; fi; rm -rf etc", false],
			["cd /ws; if true; then cd /; fi; rm -rf etc", false],
			["cd /; if cd /ws; then :; fi; rm -rf etc", false],
			["cd /; while false; do\ncd /ws\ndone\nrm -rf etc", false],
			["cd /; until true; do cd /ws; done; rm -rf etc", false],
			["cd /; for d in /ws; do cd $d; done; rm -rf etc", false],
			["cd /; for d in /ws; do\ncd /ws\ndone\nrm -rf etc", false],
			["cd /; select d in /ws; do cd /ws; break; done; rm -rf etc", false],
			["cd /; case x in y) cd /ws;; esac; rm -rf etc", false],
			["cd /; case x in\n(y) cd /ws;;\nesac\nrm -rf etc", false],
			["cd /; case x in a) :;; done) cd /ws;; esac; rm -rf etc", false],
			["cd /; coproc cd /ws; rm -rf etc", false],
			["cd /; { cd /ws; } &\nrm -rf etc", false],
			["cd /; { cd /ws; }; rm -rf etc", false],
			["cd /; cat <(cd /ws); rm -rf etc", false],
			["cd /; diff <(cd /ws) >(cd /ws); rm -rf etc", false],
			["cd /; X=$(cd /ws && pwd); rm -rf etc", false],
			["cd /; ! cd /ws; rm -rf etc", false],
			// A here-document's lines may be no commands at all.
			["cd /; cat <<EOF\ncd /ws\nEOF\nrm -rf etc", false],
			["cd /; cat <<-EOF\n\tcd /ws\n\tEOF\nrm -rf etc", false],
			["cd /ws; cat <<< x; rm -rf etc", true],
			// A `cd` in a pipeline, or run by another program, never moves this shell.
			["cd /; cd /ws | cat; rm -rf etc", false],
			["cd /; echo | cd /ws; rm -rf etc", false],
			["cd /; echo /ws | xargs cd; rm -rf etc", false],
			["cd /; env cd /ws; rm -rf etc", false],
			["cd /; find /ws -maxdepth 0 -exec cd {} \\;; rm -rf etc", false],
			["cd /; bash -c 'cd /ws'; rm -rf etc", false],
			// Code run in this shell out of sight may change the folder.
			['cd /ws; eval "cd /"; rm -rf etc', false],
			["cd /ws; source ./env.sh; rm -rf etc", false],
			["cd /ws; . ./env.sh; rm -rf etc", false],
			// After a leading `cd` chain, past a `||`, a backgrounded list or a group the floor can't see through.
			["cd /; cd /ws && make || rm -rf etc", false],
			["cd /; cd /ws && make &\nrm -rf etc", false],
			["cd /; cd /ws && { make; } || rm -rf etc", false],
			["cd /; cd /ws && (make) || rm -rf etc", false],
			["cd /; cd /ws || return; rm -rf etc", false],
			["cd /; cd /ws || exit &\nrm -rf etc", false],
			["cd /ws; cd -L /; rm -rf etc", false],
			["cd /; popd; rm -rf etc", false],
			// A plain `cd` at a list's head, alone or leading an `&&` chain, still moves the folder.
			["cd /ws/sub && rm -rf build", true],
			["cd /ws/sub; rm -rf build", true],
			["cd /ws/sub\nrm -rf build", true],
			["cd /; cd /ws && rm -rf etc", true],
			["cd / && cd /ws && rm -rf etc", true],
			["cd /ws/sub && make | tee log && rm -rf build", true],
			["cd /ws/sub && grep x f; rm -rf build", true],
			["cd /; cd /ws || exit 1; rm -rf etc", true],
			["cd /; cd /ws || exit\nrm -rf etc", true],
			["cd /; T=/ws && cd $T && rm -rf etc", true],
			["cd /; pushd /ws && rm -rf etc", true],
			["cd /; builtin cd /ws && rm -rf etc", true],
			['cd /; bash -c "cd /ws && rm -rf etc"', true],
			["if true; then :; fi; cd /ws/sub && rm -rf build", true],
			["(cd /tmp && make); cd /ws/sub && rm -rf build", true],
			// A `cd` that `;` or a newline follows may fail: the folder before it and its own both count (#146).
			["cd /; cd /ws; rm -rf etc", false],
			["cd /; cd /ws/missing; rm -rf etc", false],
			["cd /; cd /ws/missing\nrm -rf etc", false],
			["cd /; cd /ws && make; rm -rf etc", false],
			["cd /ws/sub; cd /; rm -rf etc", false],
			["cd sub; rm -rf build", true],
			["cd sub; cd deeper; rm -rf build", true],
			["cd sub; rm -rf ../build", false],
			["cd sub && rm -rf ../build", true],
			["cd sub; rm -rf ../../etc", false],
			["cd /ws/a; cd /ws/b; cd /ws/c; rm -rf x", true],
			["cd a; cd b; cd c; rm -rf x", false],
			["cd /; cd /ws || exit; cd sub && rm -rf x", true],
			["cd sub; T=$PWD/x; rm -rf \"$T\"", false],
			// A line that names CDPATH may send a `cd` anywhere.
			["CDPATH=/; cd ws && rm -rf etc", false],
			["export CDPATH=/x; cd /ws/sub && rm -rf build", false],
			// A `cd` that `find -exec` runs leaves this shell where it was.
			["cd /ws; find . -exec cd / \\;; rm -rf etc", true],
		];
		for (const [command, inside] of commands) {
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "a floor delete"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		it("reads a command in a process substitution as a command of its own", () => {
			assert.equal(floorAction("cat <(rm -rf /etc)", where)?.kind, "delete");
			assert.deepEqual(simpleCommands("diff <(git show a) >(tee b)"), [["git", "show", "a"], ["tee", "b"], ["diff", "$(…)", "$(…)"]]);
		});
	});

	describe("skips a here-document's lines when it follows a `cd`, and reads the folder as unknown when their end never comes (#149)", () => {
		const job = "/x/jobs/02878adf";
		const where = { workspace: "/ws", cwd: "/ws", jobDir: job, roots: [`${job}/tmp`] };
		/** `[command, inside]`, each read with `/ws` as the Workspace and the directory it runs in, and the job folder's `tmp` as the Teammate's own. */
		const commands: [string, boolean][] = [
			// The issue's replay: only a here-document in the `cd`'s list lost the folder.
			['cd "$CLAUDE_JOB_DIR"/tmp/merged && echo hi\ncp a ./fp.mjs && node fp.mjs; rm fp.mjs', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/merged && cat > x <<\'EOF\'\nhello\nEOF\ncp a ./fp.mjs && node fp.mjs; rm fp.mjs', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/merged && cat > x <<\'EOF\'\nhello\nEOF\nrm fp.mjs', true],
			["cat > x <<'EOF'\nhello\nEOF\nrm fp.mjs", true],
			// Done when: the `cd` and the cwd are both the Teammate's own; from `/`, not.
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<\'EOF\'\nbody\nEOF\nrm f', true],
			["cd / && cat > f <<'EOF'\nbody\nEOF\nrm etc", false],
			// A `cd` written in a here-document's lines doesn't move the folder.
			["cd /; cat <<'EOF'\ncd /ws\nEOF\nrm -rf etc", false],
			["cd /ws && cat <<'EOF'\ncd /\nEOF\nrm -rf etc", false],
			// `<<-` ends at a tab-indented delimiter; `<<` doesn't, so its end never comes.
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<-EOF\n\tbody\n\tEOF\nrm f', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<EOF\n\tbody\n\tEOF\nrm f', false],
			// A quoted or an unquoted delimiter.
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<"EOF"\nbody\nEOF\nrm f', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<EOF\nbody $X\nEOF\nrm f', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<\\EOF\nbody\nEOF\nrm f', true],
			// Two here-documents on one line: their bodies follow in order.
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat <<A <<\'B\' > f\na\nA\nb\nB\nrm f', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat <<A > f; cat <<B > g\na\nA\nb\nB\nrm f g', true],
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat <<A <<B > f\na\nA\nb\nrm f', false],
			// A here-document whose end never comes leaves the folder unknown from its start.
			['cd "$CLAUDE_JOB_DIR"/tmp/x && cat > f <<\'EOF\'\nbody\nrm f', false],
			['cd "$CLAUDE_JOB_DIR"/tmp/x; cat > f <<\'EOF\'\nbody\nrm f', false],
			["cat > f <<'EOF'\nbody\nrm f", false],
			// A `cd` after the here-document ends follows the usual rules.
			['cat > f <<\'EOF\'\nbody\nEOF\ncd "$CLAUDE_JOB_DIR"/tmp/x && rm f', true],
			["cat <<'EOF'\nbody\nEOF\ncd /ws/sub; rm -rf build", true],
			["cat <<'EOF'\nbody\nEOF\ncd /; rm -rf etc", false],
			["cat <<'EOF'\nbody\nEOF\ncd /; cd /ws && make || rm -rf etc", false],
			["cat <<'EOF'\nbody\nEOF\ncd /; (cd /ws); rm -rf etc", false],
			// The `cd`'s `&&` chain goes on past the body, on the line or after it.
			["cd /ws/sub && cat <<'EOF' && rm -rf build\nbody\nEOF", true],
			["cd /ws/sub && cat <<'EOF' &&\nbody\nEOF\nrm -rf build", true],
			["cd /; cd /ws && cat <<'EOF' &&\nbody\nEOF\nrm -rf etc", true],
			["cd /; cd /ws && cat <<'EOF'\nbody\nEOF\nrm -rf etc", false],
			// A body's quote doesn't run on past its end, and a substitution in an unquoted body still runs.
			["cat > f <<'EOF'\ndon't\nEOF\nrm -rf /etc", false],
			["cat > f <<EOF\n$(rm -rf /etc)\nEOF", false],
			// The held request, req-be3070db in Effort software-2026-11-07-2.
			[
				"cd \"$CLAUDE_JOB_DIR\"/tmp/merged && cat > \"$CLAUDE_JOB_DIR\"/tmp/fp.mjs <<'EOF'\nimport { chooseOp } from \"./scripts/soak.js\";\nconst r=0.45;\nconsole.log(\"design putShare\", (1-r)*(0.4/0.55), \"design getThr\", (1-r)*(0.4/0.55)+r);\nconsole.log(\"impl putThr\", (1-r)*8/11, \"impl getThr\", 1-(1-r)*3/11);\nconsole.log(\"design at 0.85 ->\", 0.85 < (1-r)*(0.4/0.55)+r ? \"get\" : \"del\", \"; impl at 0.85 ->\", chooseOp(0.85, r));\n// monotonic / sanity sweep\nlet bad=0, maxErr=0;\nfor (let i=0;i<=100000;i++){const x=i/100000; const rest=1-x; const p=rest*8/11, g=1-rest*3/11;\n if (!(p<=g)) bad++; maxErr=Math.max(maxErr, Math.abs((g-p)-x));}\nconsole.log(\"ratios with putThr>getThr:\", bad, \"max |getShare - ratio|:\", maxErr);\nconsole.log(\"ratio0: putThr\", 8/11, \"getThr\", 1-3/11, \"gap\", (1-3/11)-8/11);\n// is there any roll that gives get at ratio 0?\nconsole.log(\"get at ratio0 for roll=8/11:\", chooseOp(8/11,0));\nconsole.log(\"ratio1 roll 0 ->\", chooseOp(0,1), \" roll 0.9999999 ->\", chooseOp(0.9999999,1));\nEOF\ncp \"$CLAUDE_JOB_DIR\"/tmp/fp.mjs ./fp.mjs && node fp.mjs; rm fp.mjs",
				true,
			],
		];
		for (const [command, inside] of commands) {
			it(`${JSON.stringify(command)} is ${inside ? "inside" : "a floor delete"}`, () => {
				assert.equal(floorAction(command, where)?.kind, inside ? undefined : "delete");
			});
		}

		it("still reads a here-document's lines for floor actions, as a shell fed them would run them", () => {
			assert.equal(floorAction("bash <<'EOF'\ngit push origin main\nEOF", where)?.kind, "push");
			assert.deepEqual(simpleCommands("cat > f <<'EOF'\nit's\nEOF\nrm f").at(-1), ["rm", "f"]);
		});
	});

	describe("the Teammate's own folders, worked out once for the hook and team_answer", () => {
		it("reads Claude Code's config folder from `CLAUDE_CONFIG_DIR`, else `~/.claude`", () => {
			assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" }, "/home/qa/.claude"), "/x");
			assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/home/qa/.claude"), "/home/qa/.claude");
			assert.equal(claudeConfigDir({}, "/home/qa/.claude"), "/home/qa/.claude");
			assert.equal(claudeConfigDir({}), posix.join(homedir(), ".claude"));
		});

		it("trusts a job folder only directly under the config folder's `jobs`, and adds the scratchpad", () => {
			assert.deepEqual(ownFolders({ config: "/x", job: "/x/jobs/02878adf", scratchpad: "/tmp/s/scratchpad" }), { jobDir: "/x/jobs/02878adf", roots: ["/x/jobs/02878adf/tmp", "/tmp/s/scratchpad"] });
			assert.deepEqual(ownFolders({ config: "/x", job: "/x/jobs/02878adf/" }), { jobDir: "/x/jobs/02878adf", roots: ["/x/jobs/02878adf/tmp"] });
			for (const job of ["/home/qa/.claude/jobs/02878adf", "/x/jobs", "/x/jobs/a/b", "/x/jobs/../y", "/x/jobs/..", "/x/jobs/.", "jobs/02878adf", "", undefined]) {
				assert.deepEqual(ownFolders({ config: "/x", job }), { roots: [] }, String(job));
			}
			assert.deepEqual(ownFolders({ config: "x", job: "x/jobs/02878adf" }), { roots: [] });
			assert.deepEqual(ownFolders({ config: "/x", scratchpad: 42 }), { roots: [] });
		});

		it("with `CLAUDE_CONFIG_DIR=/x`, reads a delete under `/x/jobs/<id>/tmp` as inside and one under `~/.claude/jobs/<id>/tmp` as a floor delete", () => {
			const where = { workspace: WORKSPACE, home: "/home/qa", ...ownFolders({ config: claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" }, "/home/qa/.claude"), job:"/x/jobs/02878adf" }) };
			assert.equal(floorAction("rm -rf /x/jobs/02878adf/tmp/a", where)?.kind, undefined);
			assert.equal(floorAction("rm -rf $CLAUDE_JOB_DIR/tmp/a", where)?.kind, undefined);
			assert.equal(floorAction("rm -rf ~/.claude/jobs/02878adf/tmp/a", where)?.kind, "delete");
		});
	});

	it("lists a quoted `~` or `$HOME` word for permission rules as it is written, unmarked", () => {
		assert.deepEqual(simpleCommands("rm -rf '~/x' \\$HOME/y && eval rm \\~/z && sh -c '$HOME'"), [
			["rm", "-rf", "~/x", "$HOME/y"],
			["rm", "~/z"],
			["$HOME"],
		]);
	});

	it("names the command it caught", () => {
		assert.equal(floorAction("npm test && git -C . push origin main", { workspace: WORKSPACE })?.command, "git -C . push origin main");
	});
});
