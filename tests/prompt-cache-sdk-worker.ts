import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";

// Explicit-cache metadata moves with Pi's last-message breakpoint. Compare
// content separately; implicit-cache payloads must remain byte-identical.
const contentBytes = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);

// Four real serializers, with no extension payload rewriting and no HTTP calls.
for (const flavor of ["anthropic-messages", "openai-completions", "openai-responses", "anthropic-compatible-completions"] as const) {
	const api = flavor === "anthropic-compatible-completions" ? "openai-completions" : flavor;
	test(`real ${flavor} serialization keeps appended snapshots and honors cache retention`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-wire-"));
		try {
			const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
			runtime.registerProvider("cache-fixture", { baseUrl: "http://127.0.0.1:1", api, apiKey: "fixture-only", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 128 }] });
			const model = runtime.getModel("cache-fixture", "fixture")!;
			if (flavor === "anthropic-compatible-completions") model.compat = { cacheControlFormat: "anthropic", supportsLongCacheRetention: true };
			const explicit = api === "anthropic-messages" || flavor === "anthropic-compatible-completions";
			const snapshot = { role: "custom" as const, customType: "pi-goal-snapshot", content: "[PI GOAL ACTIVE goalId=fixture]\nObjective: ship the export", display: false, timestamp: 2 };
			const history = [{ role: "user" as const, content: "unchanging history", timestamp: 1 }, snapshot];
			const continued = [...history, { role: "custom" as const, customType: "pi-goal-event", content: '<pi_goal_continuation goal_id="fixture" kind="checkpoint" v="2"/>', display: false, timestamp: 3 }];
			const edited = [...continued, { ...snapshot, content: "[PI GOAL ACTIVE goalId=fixture]\nObjective: ship the revised export", timestamp: 4 }];
			for (const cacheRetention of ["short", "long", "none"] as const) {
				const capture = async (messages: typeof history) => {
					let payload: any;
					await runtime.streamSimple(model, { systemPrompt: "unchanging policy", messages: convertToLlm(messages) }, {
						cacheRetention, sessionId: "same-session", onPayload: value => {
							payload = value;
							throw new Error("Intentional capture before network dispatch");
						},
					}).result();
					assert.ok(payload);
					return payload.messages ?? payload.input;
				};
				const first = await capture(history);
				const second = await capture(continued);
				const third = await capture(edited);
				for (const [before, after] of [[first, second], [second, third]]) {
					const bytes = explicit ? contentBytes : JSON.stringify;
					assert.equal(bytes(after.slice(0, before.length)), bytes(before), "earlier content stays an identical serialized prefix");
					assert.ok(after.length > before.length, "the request advances");
				}
				assert.ok(JSON.stringify(third).includes("ship the export"), "the old snapshot remains");
				assert.ok(JSON.stringify(third.at(-1)).includes("ship the revised export"));
				assert.doesNotMatch(JSON.stringify(third), /Usage:|Autonomous runs|pi-goal-live-context/);
				if (explicit) {
					for (const conversation of [first, second, third]) {
						const marker = conversation.at(-1).content.at(-1).cache_control;
						if (cacheRetention === "none") assert.equal(marker, undefined);
						else {
							assert.equal(marker.type, "ephemeral");
							assert.equal(marker.ttl, cacheRetention === "long" ? "1h" : undefined);
						}
					}
				}
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}
