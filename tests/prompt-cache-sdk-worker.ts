import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { cacheGoalHistory } from "../extensions/goal-prompt-cache.ts";

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
