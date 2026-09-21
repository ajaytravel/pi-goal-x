import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { cacheGoalHistory } from "../extensions/goal-prompt-cache.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";

const live = "[PI GOAL ACTIVE goalId=fixture]\nUsage: 123 tokens";
// Exercise Pi's actual serializers. onPayload throws before HTTP dispatch, so
// these checks require neither credentials nor a paid request.
for (const flavor of ["anthropic-messages", "openai-completions", "openai-responses", "anthropic-compatible-completions"] as const) {
 const api = flavor === "anthropic-compatible-completions" ? "openai-completions" : flavor;
 test(`real ${flavor} serialization preserves history and honors cache retention`, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-wire-"));
  try {
   const runtime = await ModelRuntime.create({authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
   runtime.registerProvider("cache-fixture", {baseUrl: "http://127.0.0.1:1", api, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 128}]});
   const model = runtime.getModel("cache-fixture", "fixture")!;
   if (flavor === "anthropic-compatible-completions") model.compat = {cacheControlFormat: "anthropic", supportsLongCacheRetention: true};
   for (const cacheRetention of ["short", "long", "none"] as const) {
    const capture = async (text: string) => {
     let payload: any;
     const messages = convertToLlm([{role: "user", content: "unchanging history", timestamp: 1}, {role: "custom", customType: "pi-goal-live-context", content: text, display: false, timestamp: 0}]);
     await runtime.streamSimple(model, {systemPrompt: "unchanging policy", messages}, {cacheRetention, sessionId: "same-session", onPayload: value => {
      payload = value;
      cacheGoalHistory(payload, text);
      throw new Error("Intentional capture before network dispatch");
     }}).result();
     assert.ok(payload);
     return payload;
    };
    const first = await capture(live);
    const second = await capture(live.replace("123", "456"));
    const conversation = (p: any) => p.messages ?? p.input;
    assert.deepEqual(conversation(first).slice(0, -1), conversation(second).slice(0, -1), "serialized prefix is identical");
    assert.ok(JSON.stringify(conversation(second).at(-1)).includes("456 tokens"));
    if (api === "anthropic-messages" || flavor === "anthropic-compatible-completions") {
     const historyMessage = first.messages.find((m: any) => m.role === "user");
     const marker = Array.isArray(historyMessage.content) ? historyMessage.content.at(-1).cache_control : undefined;
     if (cacheRetention === "none") assert.equal(marker, undefined);
     else assert.equal(marker.type, "ephemeral");
     assert.ok(!JSON.stringify(first.messages.at(-1)).includes("cache_control"));
    }
   }
  } finally { rmSync(cwd, {recursive: true, force: true}); }
 });
}

// Advancing-history regression: a completed assistant turn entering history must
// not displace the previously sent goal-state tail. The production retention
// helper builds each request, so this exercises the real injection path: request
// N's serialized conversation must be an exact prefix of request N+1's, letting
// implicit caches (OpenAI Responses / Chat Completions, which carry no explicit
// marker) reuse the full prefix instead of freezing at the first injection point.
for (const flavor of ["openai-completions", "openai-responses"] as const) {
	test(`real ${flavor} serialization keeps an advancing prefix across assistant turns`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-advance-"));
		try {
			const runtime = await ModelRuntime.create({authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
			runtime.registerProvider("advance-fixture", {baseUrl: "http://127.0.0.1:1", api: flavor, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 128}]});
			const model = runtime.getModel("advance-fixture", "fixture")!;
			const retention = new LiveTailRetention();
			const capture = async (session: any[], fresh: { state: string; counters: string }) => {
				const { messages, transientContents } = retention.apply("advance-session", session, fresh);
				let payload: any;
				const wire = convertToLlm(messages);
				await runtime.streamSimple(model, {systemPrompt: "unchanging policy", messages: wire}, {cacheRetention: "short", sessionId: "same-session", onPayload: value => {
					payload = value;
					cacheGoalHistory(payload, transientContents);
					throw new Error("Intentional capture before network dispatch");
				}}).result();
				assert.ok(payload);
				return payload;
			};
			const session: any[] = [{role: "user", content: "unchanging history", timestamp: 1}];
			// A completed assistant turn carries usage and a terminal stopReason, exactly
			// as the SDK produces for real turns (the token estimator reads usage).
			const turn = (n: number, timestamp: number) => ({role: "assistant", content: [{type: "text", text: `completed result ${n}`}], stopReason: "stop", usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15}, timestamp});
			const state = "[PI GOAL ACTIVE goalId=fixture]\nObjective: hold the line";
			const first = await capture(session, {state, counters: "Usage: 100 tokens"});
			session.push(turn(1, 2));
			const second = await capture(session, {state, counters: "Usage: 200 tokens"});
			session.push(turn(2, 3));
			const third = await capture(session, {state, counters: "Usage: 300 tokens"});
			const conversation = (p: any) => p.messages ?? p.input;
			const a = conversation(first), b = conversation(second), c = conversation(third);
			assert.ok(a.length < b.length && b.length < c.length, "each advanced request carries its completed turn");
			assert.deepEqual(b.slice(0, a.length), a, "request N is an exact prefix of request N+1");
			assert.deepEqual(c.slice(0, b.length), b, "request N+1 is an exact prefix of request N+2");
			// Two advances add at most the completed turns plus their small counter tails:
			// the stable policy block is retained in place, never resent.
			assert.ok(c.length - a.length <= 4, "retained tails grow by state changes, not by requests");
		} finally { rmSync(cwd, {recursive: true, force: true}); }
	});
}
