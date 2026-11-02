/**
 * The floor classifier: a Bash command and the Workspace in, "a floor action
 * or not, and which kind" out. One table, each row asserted floor or not with
 * its kind.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { floorAction } from "../floor.mjs";

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

	it("names the command it caught", () => {
		assert.equal(floorAction("npm test && git -C . push origin main", { workspace: WORKSPACE })?.command, "git -C . push origin main");
	});
});
