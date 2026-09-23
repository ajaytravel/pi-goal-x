import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";

const input = JSON.parse(process.argv[2] ?? "");
const oldText = String(input.oldText ?? "");
const newText = String(input.newText ?? "");
const checkpoint = String(input.checkpoint ?? "");
assert.notEqual(oldText, newText);
assert.doesNotMatch(`${oldText}\n${newText}`, /Usage:|Autonomous runs/);

const cwd = mkdtempSync(path.join(tmpdir(), "goal-edit-prefix-"));
try {
	const runtime = await ModelRuntime.create({
		authPath: path.join(cwd, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const history = [
		{ role: "user" as const, content: "Work on the goal", timestamp: 1 },
		{ role: "custom" as const, customType: "pi-goal-snapshot", content: oldText, display: false, timestamp: 2 },
	];
	const afterTool = [
		...history,
		{
			role: "assistant" as const,
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 3,
		},
		{ role: "toolResult" as const, toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 4 },
	];
	const afterEdit = [
		...afterTool,
		{ role: "custom" as const, customType: "pi-goal-snapshot", content: newText, display: false, timestamp: 5 },
		{ role: "custom" as const, customType: "pi-goal-event", content: checkpoint, display: false, timestamp: 6 },
	];
	for (const api of ["openai-completions", "openai-responses"] as const) {
		runtime.registerProvider("cache-fixture", {
			baseUrl: "http://127.0.0.1:1",
			api,
			apiKey: "fixture-only",
			models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 128 }],
		});
		const model = runtime.getModel("cache-fixture", "fixture")!;
		const capture = async (messages: typeof history) => {
			let payload: any;
			await runtime.streamSimple(model, { systemPrompt: "host policy", messages: convertToLlm(messages) }, {
				cacheRetention: "short",
				sessionId: "same-session",
				onPayload: value => {
					payload = value;
					throw new Error("capture");
				},
			}).result();
			assert.ok(payload, api);
			return payload.messages ?? payload.input;
		};
		const before = await capture(history);
		const tooled = await capture(afterTool as typeof history);
		assert.equal(JSON.stringify(tooled.slice(0, before.length)), JSON.stringify(before), `${api} tool loop preserves serialized prefix bytes`);
		const edited = await capture(afterEdit as typeof history);
		assert.equal(JSON.stringify(edited.slice(0, tooled.length)), JSON.stringify(tooled), `${api} continuation after the edit preserves serialized prefix bytes`);
		assert.equal(afterEdit[1]?.content, oldText);
	}
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
