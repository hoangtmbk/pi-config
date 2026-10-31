/**
 * pi's own compaction preparation, which the fake pi, the tests and the
 * replay check use to do exactly what pi does for `/compact` and its backstop.
 *
 * Not exported from the package root, and the package's `exports` map has no
 * entry for its file (only "." and "./rpc-entry"), so it can't be reached by a
 * package specifier: it is reached by path into the installed package. That
 * path is pi's own layout, not its API, so it lives here alone, and a pi
 * upgrade that moves it breaks this one line.
 *
 * Never imported by the modules pi loads. Not a `.test.ts` file, so
 * `npm test` does not run it on its own.
 */

export {
	type CompactionPreparation,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
