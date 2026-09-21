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
