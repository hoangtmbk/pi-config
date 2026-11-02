#!/usr/bin/env node
/**
 * The command every Teammate hook runs: `node hook.mjs <effort dir> <teammate id>`,
 * with the hook's JSON payload on stdin.
 *
 * Claude Code runs it with plain Node, outside pi, so it is JavaScript. It
 * reads the payload and exits 0, which lets every event through unchanged.
 */

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
