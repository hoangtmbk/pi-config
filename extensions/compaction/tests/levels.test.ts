/**
 * Pressure levels from settings: how the three levels resolve for the current
 * model out of `pressureLevels` in pi's settings — per-level fallback, model
 * overrides, scaling on small windows, bad values — and how they follow a
 * settings change or a model switch from one turn to the next.
 *
 * Driven only through the recording fake pi. A level is read back from what it
 * does: notice and warning each send their steer as pressure first reaches
 * them, and the warning toast names forced.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { fakePi, MODEL } from "./fake-pi.ts";

type Pi = ReturnType<typeof fakePi>;

/** The level each steer sent so far was for, in order. */
function steered(pi: Pi): unknown[] {
	return pi.sent.map((m) => (m.details as { level: string }).level);
}

/** The `notify` warnings about configuration, leaving out the warning-level toast. */
function configWarnings(pi: Pi): string[] {
	return pi.notifications.filter((n) => !n.message.startsWith("Context at ")).map((n) => n.message);
}

/** The forced level, as the warning toast names it. */
function forcedNamed(pi: Pi): string | undefined {
	return pi.notifications.find((n) => n.message.startsWith("Context at "))?.message.match(/forced at (\d+k)\./)?.[1];
}

describe("the plain setting", () => {
	it("moves notice to `pressureLevels.notice`", async () => {
		const pi = fakePi({ settings: { pressureLevels: { notice: 80_000 } } });
		await pi.turnEnd({ tokens: 79_999 });
		assert.deepEqual(steered(pi), []);
		await pi.turnEnd({ tokens: 80_000 });
		assert.deepEqual(steered(pi), ["notice"]);
	});
});

describe("a model override", () => {
	it("sets just the levels it names for that exact `provider/modelId`, the rest falling back to the plain setting, then the default", async () => {
		const pi = fakePi({
			settings: { pressureLevels: { warning: 140_000, modelOverrides: { "anthropic/fable-5": { forced: 180_000 } } } },
		});
		await pi.turnEnd({ tokens: 119_999 });
		assert.deepEqual(steered(pi), []);
		await pi.turnEnd({ tokens: 120_000 });
		await pi.turnEnd({ tokens: 140_000 });
		assert.deepEqual(steered(pi), ["notice", "warning"]);
		assert.equal(forcedNamed(pi), "180k");
	});

	it("is keyed exactly and case-sensitively, as pi's own `compaction.modelOverrides` are", async () => {
		const pi = fakePi({
			settings: { pressureLevels: { modelOverrides: { "Anthropic/Fable-5": { notice: 50_000 }, "fable-5": { notice: 60_000 } } } },
		});
		await pi.turnEnd({ tokens: 100_000 });
		assert.deepEqual(steered(pi), []);
		assert.deepEqual(configWarnings(pi), []);
	});
});

/** A model whose 128K window is smaller than the built-in levels allow for. */
const SMALL = { ...MODEL, provider: "openai", id: "mini-4", contextWindow: 128_000 } as Model<any>;

/** A model with a 1M window. */
const LARGE = { ...MODEL, provider: "openai", id: "gpt-6.1-sol", contextWindow: 1_000_000 } as Model<any>;

describe("scaling on a small window", () => {
	it("scales all three by one factor so forced sits at 85% of pi's trigger (128K, default reserve: about 67K / 84K / 95K)", async () => {
		// pi's trigger is 128,000 − 16,384 = 111,616; 85% of it is 94,874.
		const pi = fakePi({ model: SMALL });
		await pi.turnEnd({ tokens: 66_969 });
		assert.deepEqual(steered(pi), []);
		await pi.turnEnd({ tokens: 66_970 });
		assert.deepEqual(steered(pi), ["notice"]);
		await pi.turnEnd({ tokens: 83_711 });
		assert.deepEqual(steered(pi), ["notice"]);
		await pi.turnEnd({ tokens: 83_712 });
		assert.deepEqual(steered(pi), ["notice", "warning"]);
		assert.equal(forcedNamed(pi), "95k");
		assert.deepEqual(configWarnings(pi), []);
	});

	it("takes pi's `reserveTokens` for that model: its override, then the plain setting", async () => {
		// Trigger 128,000 − 28,000 = 100,000, so forced lands at 85,000.
		const pi = fakePi({
			model: SMALL,
			settings: { compaction: { reserveTokens: 4_000, modelOverrides: { "openai/mini-4": { reserveTokens: 28_000 } } } },
		});
		await pi.turnEnd({ tokens: 59_999 });
		await pi.turnEnd({ tokens: 60_000 });
		await pi.turnEnd({ tokens: 74_999 });
		await pi.turnEnd({ tokens: 75_000 });
		assert.deepEqual(steered(pi), ["notice", "warning"]);
		assert.equal(forcedNamed(pi), "85k");
	});

	it("scales the plain setting too, once its forced is not below pi's trigger", async () => {
		// Trigger 200,000 − 16,384 = 183,616; a forced of 200,000 is past it, so
		// it lands at 156,074, notice (half of forced) at 78,037 and warning
		// (three quarters) at 117,055.
		const pi = fakePi({ settings: { pressureLevels: { notice: 100_000, warning: 150_000, forced: 200_000 } } });
		await pi.turnEnd({ tokens: 78_036 });
		await pi.turnEnd({ tokens: 78_037 });
		assert.deepEqual(steered(pi), ["notice"]);
		await pi.turnEnd({ tokens: 117_054 });
		await pi.turnEnd({ tokens: 117_055 });
		assert.deepEqual(steered(pi), ["notice", "warning"]);
		assert.equal(forcedNamed(pi), "156k");
	});

	it("leaves levels alone whose forced is below pi's trigger", async () => {
		const pi = fakePi({ model: SMALL, settings: { pressureLevels: { notice: 50_000, warning: 70_000, forced: 90_000 } } });
		await pi.turnEnd({ tokens: 50_000 });
		await pi.turnEnd({ tokens: 70_000 });
		assert.deepEqual(steered(pi), ["notice", "warning"]);
		assert.equal(forcedNamed(pi), "90k");
	});

	it("does not touch a set that took any level from the model's override, and says nothing about it", async () => {
		// Deliberately left to pi's backstop: forced is past the window itself.
		const pi = fakePi({ model: SMALL, settings: { pressureLevels: { modelOverrides: { "openai/mini-4": { forced: 600_000 } } } } });
		await pi.turnEnd({ tokens: 119_999 });
		assert.deepEqual(steered(pi), []);
		await pi.turnEnd({ tokens: 120_000 });
		assert.deepEqual(steered(pi), ["notice"]);
		assert.deepEqual(configWarnings(pi), []);
	});
});

describe("a settings change", () => {
	it("is what the next turn goes by", async () => {
		// pi's in-memory settings, which change on `/reload` or pi's own setters.
		const pi = fakePi();
		await pi.turnEnd({ tokens: 90_000 });
		pi.settings = { pressureLevels: { notice: 85_000 } };
		await pi.turnEnd({ tokens: 90_000 });
		assert.deepEqual(steered(pi), ["notice"]);
		pi.settings = {};
		await pi.turnEnd({ tokens: 95_000 });
		assert.equal(pi.status(), undefined);
	});
});

describe("a model switch", () => {
	const SOL_OVERRIDE = { pressureLevels: { modelOverrides: { "openai/gpt-6.1-sol": { notice: 400_000, warning: 500_000, forced: 600_000 } } } };

	it("re-resolves the levels for the new model, and only the highest level already past acts", async () => {
		// From a 1M-window model at 100K to a 128K one: forced (about 95K) is
		// past, so it is what acts and the steers under it are moot.
		const pi = fakePi({ model: LARGE, settings: SOL_OVERRIDE });
		await pi.turnEnd({ tokens: 100_000 });
		assert.deepEqual(pi.statuses, []);
		pi.model = SMALL;
		await pi.turnEnd({ tokens: 100_000 });
		assert.deepEqual(steered(pi), []);
		assert.equal(pi.status(), "<warning>ctx warning · 100k</warning>");
		// Every level under it counts as crossed, so none speaks up later.
		await pi.turnEnd({ tokens: 90_000 });
		await pi.turnEnd({ tokens: 70_000 });
		assert.deepEqual(steered(pi), []);
	});

	it("sends warning's steer alone when the switch lands between warning and forced", async () => {
		const pi = fakePi({ model: LARGE, settings: SOL_OVERRIDE });
		await pi.turnEnd({ tokens: 90_000 });
		pi.model = SMALL;
		await pi.turnEnd({ tokens: 90_000 });
		assert.deepEqual(steered(pi), ["warning"]);
		assert.equal(forcedNamed(pi), "95k");
	});

	it("re-arms the levels a switch to a larger model puts back above pressure", async () => {
		const pi = fakePi({ model: SMALL, settings: SOL_OVERRIDE });
		await pi.turnEnd({ tokens: 70_000 });
		assert.deepEqual(steered(pi), ["notice"]);
		pi.model = LARGE;
		await pi.turnEnd({ tokens: 70_000 });
		assert.equal(pi.status(), undefined);
		await pi.turnEnd({ tokens: 400_000 });
		assert.deepEqual(steered(pi), ["notice", "notice"]);
	});
});

describe("pi's settings", () => {
	it("are never written, and nothing is added under `compaction.*`", async () => {
		const settings = {
			compaction: { enabled: true, reserveTokens: 16_384 },
			pressureLevels: { notice: "x", modelOverrides: { "openai/mini-4": { forced: 600_000 } } },
		};
		const before = structuredClone(settings);
		const pi = fakePi({ model: SMALL, settings });
		for (const tokens of [50_000, 70_000, 90_000, 100_000]) await pi.turnEnd({ tokens });
		pi.model = MODEL;
		for (const tokens of [130_000, 160_000, 175_000]) await pi.turnEnd({ tokens });
		assert.deepEqual(settings, before);
		assert.deepEqual(pi.errors, []);
	});
});

describe("bad configuration", () => {
	it("falls back to the defaults on a level that isn't a positive whole number, with one warning naming the key", async () => {
		for (const bad of ["80k", 0, -5, 80_000.5, 2 ** 60, null, true]) {
			const pi = fakePi({ settings: { pressureLevels: { notice: bad, warning: 140_000 } } });
			await pi.turnEnd({ tokens: 119_999 });
			await pi.turnEnd({ tokens: 140_000 });
			assert.deepEqual(steered(pi), ["notice"], `notice: ${String(bad)}`);
			await pi.turnEnd({ tokens: 150_000 });
			assert.deepEqual(steered(pi), ["notice", "warning"], `notice: ${String(bad)}`);
			assert.deepEqual(configWarnings(pi), [
				`Invalid pressureLevels.notice: ${JSON.stringify(bad) ?? String(bad)} is not a positive whole number of tokens. Using the default Pressure levels.`,
			]);
			assert.equal(pi.notifications.find((n) => n.message.startsWith("Invalid"))?.type, "warning");
			assert.deepEqual(pi.errors, []);
		}
	});

	it("names a bad level in the model's override, and still scales the defaults it falls back to", async () => {
		const pi = fakePi({ model: SMALL, settings: { pressureLevels: { modelOverrides: { "openai/mini-4": { forced: "lots" } } } } });
		await pi.turnEnd({ tokens: 66_969 });
		assert.deepEqual(steered(pi), []);
		await pi.turnEnd({ tokens: 66_970 });
		assert.deepEqual(steered(pi), ["notice"]);
		assert.deepEqual(configWarnings(pi), [
			'Invalid pressureLevels.modelOverrides["openai/mini-4"].forced: "lots" is not a positive whole number of tokens. Using the default Pressure levels.',
		]);
	});

	it("falls back to the defaults on a set that isn't strictly notice < warning < forced, naming the keys", async () => {
		const pi = fakePi({ settings: { pressureLevels: { notice: 130_000, warning: 130_000 } } });
		await pi.turnEnd({ tokens: 120_000 });
		assert.deepEqual(steered(pi), ["notice"]);
		assert.deepEqual(configWarnings(pi), [
			"Invalid pressureLevels: notice (130000, pressureLevels.notice) must be below warning (130000, pressureLevels.warning). Using the default Pressure levels.",
		]);

		const over = fakePi({ settings: { pressureLevels: { modelOverrides: { "anthropic/fable-5": { warning: 175_000 } } } } });
		await over.turnEnd({ tokens: 150_000 });
		assert.deepEqual(steered(over), ["warning"]);
		assert.deepEqual(configWarnings(over), [
			'Invalid pressureLevels: warning (175000, pressureLevels.modelOverrides["anthropic/fable-5"].warning) must be below forced (170000, the default). Using the default Pressure levels.',
		]);
	});

	it("never throws, whatever shape `pressureLevels` has", async () => {
		const cases: [unknown, string][] = [
			["120000", 'Invalid pressureLevels: "120000" is not an object. Using the default Pressure levels.'],
			[[120_000], "Invalid pressureLevels: [120000] is not an object. Using the default Pressure levels."],
			[{ modelOverrides: 7 }, "Invalid pressureLevels.modelOverrides: 7 is not an object. Using the default Pressure levels."],
			[
				{ modelOverrides: { "anthropic/fable-5": null } },
				'Invalid pressureLevels.modelOverrides["anthropic/fable-5"]: null is not an object. Using the default Pressure levels.',
			],
		];
		for (const [pressureLevels, warning] of cases) {
			const pi = fakePi({ settings: { pressureLevels } });
			await pi.turnEnd({ tokens: 120_000 });
			assert.deepEqual(steered(pi), ["notice"]);
			assert.deepEqual(configWarnings(pi), [warning]);
			assert.deepEqual(pi.errors, []);
		}
	});

	it("does not trip over a bad `compaction.reserveTokens`, which pi reports itself", async () => {
		const pi = fakePi({ model: SMALL, settings: { compaction: { reserveTokens: "big", modelOverrides: [] } } });
		await pi.turnEnd({ tokens: 66_970 });
		assert.deepEqual(steered(pi), ["notice"]);
		assert.deepEqual(configWarnings(pi), []);
		assert.deepEqual(pi.errors, []);
	});

	it("warns once per distinct problem per session, however many turns it lasts", async () => {
		const pi = fakePi({ settings: { pressureLevels: { notice: "x" } } });
		await pi.turnEnd({ tokens: 10_000 });
		await pi.turnEnd({ tokens: 20_000 });
		pi.settings = { pressureLevels: { warning: "y" } };
		await pi.turnEnd({ tokens: 30_000 });
		await pi.turnEnd({ tokens: 40_000 });
		pi.settings = { pressureLevels: { notice: "x" } };
		await pi.turnEnd({ tokens: 50_000 });
		assert.deepEqual(configWarnings(pi), [
			'Invalid pressureLevels.notice: "x" is not a positive whole number of tokens. Using the default Pressure levels.',
			'Invalid pressureLevels.warning: "y" is not a positive whole number of tokens. Using the default Pressure levels.',
		]);
	});
});
