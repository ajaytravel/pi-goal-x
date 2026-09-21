import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention, MAX_RETAINED_LIVE_TAILS } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);

test("retained tails make each request a literal prefix of the next", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	const first = retention.apply("s", base1, { state: "S", counters: "V1" });
	assert.deepEqual(contents(first.messages), ["h", "S", "V1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	const second = retention.apply("s", base2, { state: "S", counters: "V2" });
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(contents(second.messages), ["h", "S", "V1", "a", "V2"]);
});

test("unchanged content across repeats and advances adds zero blocks", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "S", counters: "V" };
	const first = retention.apply("s", base, fresh);
	const repeat = retention.apply("s", base, fresh);
	assert.deepEqual(repeat.messages, first.messages);
	const advanced = [...base, msg("assistant", "a", 2)];
	const third = retention.apply("s", advanced, fresh);
	assert.deepEqual(third.messages.slice(0, first.messages.length), first.messages);
	assert.equal(third.messages.length, first.messages.length + 1);
});

test("rewritten history resets once and never loses the live state", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [msg("user", "h", 1)], { state: "S", counters: "V1" });
	const compacted = [msg("user", "compacted summary", 10)];
	const next = retention.apply("s", compacted, { state: "S", counters: "V1" });
	assert.deepEqual(contents(next.messages), ["compacted summary", "S", "V1"]);
});

test("a changed policy block drops stale tails and starts a fresh prefix", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S1", counters: "V1" });
	const next = retention.apply("s", base, { state: "S2", counters: "V2" });
	assert.deepEqual(contents(next.messages), ["h", "S2", "V2"]);
});

test("retained growth is bounded with one amortized reset per window", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let previous: any[] | null = null;
	let breaks = 0;
	for (let i = 0; i < MAX_RETAINED_LIVE_TAILS + 8; i++) {
		const out = retention.apply("s", base, { state: "S", counters: `V${i}` });
		if (previous !== null && JSON.stringify(out.messages.slice(0, previous.length)) !== JSON.stringify(previous)) breaks++;
		previous = out.messages;
		assert.ok(out.messages.length <= base.length + MAX_RETAINED_LIVE_TAILS, "wire overhead stays within the retention window");
	}
	assert.equal(breaks, 1);
});

test("sessions are tracked independently", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("a", base, { state: "SA", counters: "VA" });
	const other = retention.apply("b", base, { state: "SB", counters: "VB" });
	assert.deepEqual(contents(other.messages), ["h", "SB", "VB"]);
	const again = retention.apply("a", base, { state: "SA", counters: "VA" });
	assert.deepEqual(contents(again.messages), ["h", "SA", "VA"]);
});

test("null fresh clears the session so the next request starts over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", counters: "V" });
	const cleared = retention.apply("s", base, null);
	assert.deepEqual(cleared.messages, base);
	assert.deepEqual(cleared.transientContents, []);
	const advanced = [...base, msg("assistant", "a", 2)];
	const next = retention.apply("s", advanced, { state: "S", counters: "V" });
	assert.deepEqual(contents(next.messages), ["h", "a", "S", "V"]);
});

test("transient contents cover retained and fresh tails for marker relocation", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", counters: "V1" });
	const advanced = [...base, msg("assistant", "a", 2)];
	const next = retention.apply("s", advanced, { state: "S", counters: "V2" });
	assert.deepEqual(next.transientContents, ["S", "V1", "V2"]);
});

test("a retained tail never splits a tool-call batch when history diverges", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const call = (ids: string[]): any => ({ role: "assistant", timestamp: 2, content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) });
	const result = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false });
	const fresh = { state: "S", counters: "V" };
	retention.apply("s", [user, call(["a"]), result("a")], fresh);
	// A different branch with the same shape must not inherit the old anchor.
	const out = retention.apply("s", [user, call(["b", "c"]), result("b"), result("c")], fresh).messages;
	const roles = out.map((m: any) => m.role);
	const firstResult = roles.indexOf("toolResult");
	assert.deepEqual(roles.slice(firstResult, firstResult + 2), ["toolResult", "toolResult"], "tool results stay adjacent");
	assert.deepEqual(roles.slice(-2), ["custom", "custom"], "live state rides at the tail");
});

test("an unchanged request near capacity keeps its prefix instead of resetting", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let previous: any[] = [];
	for (let i = 0; i < MAX_RETAINED_LIVE_TAILS - 2; i++) previous = retention.apply("s", base, { state: "S", counters: `V${i}` }).messages;
	const repeat = retention.apply("s", base, { state: "S", counters: `V${MAX_RETAINED_LIVE_TAILS - 3}` }).messages;
	assert.deepEqual(repeat, previous, "a zero-growth request appends nothing and drops nothing");
});

test("a middle-message rewrite resets even when the trailing message is identical", () => {
	const retention = new LiveTailRetention();
	const fresh = { state: "S", counters: "V" };
	retention.apply("s", [msg("user", "early", 1), msg("user", "late", 2)], fresh);
	// Same tail, same length, but the earlier message was rewritten.
	const out = retention.apply("s", [msg("user", "edited", 1), msg("user", "late", 2)], fresh).messages;
	const customs = out.filter((m: any) => m.role === "custom");
	assert.equal(customs.length, 2, "full reset: only the fresh pair, no retained mid-history tails");
	assert.deepEqual(contents(out).slice(0, 2), ["edited", "late"]);
});

test("a retained tail never lands before a wire tool-role result", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const callMsg: any = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] };
	const wireResult: any = { role: "tool", toolCallId: "a", timestamp: 3, content: [{ type: "text", text: "OK" }] };
	const fresh = { state: "S", counters: "V" };
	retention.apply("s", [user, callMsg, wireResult], fresh);
	const blockResult: any = { role: "assistant", timestamp: 3, content: [{ type: "tool_result", text: "OK" }] };
	const out = retention.apply("s", [user, callMsg, blockResult], fresh).messages;
	const roles = out.map((m: any) => m.role);
	assert.deepEqual(roles.slice(-2), ["custom", "custom"], "live state rides at the tail, never inside the tool pair");
	assert.ok(!roles.slice(0, -2).includes("custom"), "no retained tail splits the rewritten tool batch");
});

test("tails anchored on empty history reset once real history arrives", () => {
	const retention = new LiveTailRetention();
	const fresh = { state: "S", counters: "V" };
	const first = retention.apply("s", [], fresh).messages;
	assert.deepEqual(contents(first), ["S", "V"]);
	const out = retention.apply("s", [msg("user", "h", 1)], fresh).messages;
	assert.deepEqual(contents(out), ["h", "S", "V"], "fresh tails anchor at the tail, nothing lingers at the head");
});
