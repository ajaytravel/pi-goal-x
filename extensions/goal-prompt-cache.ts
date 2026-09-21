import { asRecord } from "./goal-record.ts";

/**
 * Pi marks the final user block for explicit caching. Our request-only state
 * never enters history, so that block cannot be reused on the next request.
 * Move that existing breakpoint to the preceding cacheable history block.
 * Implicit caches and cacheRetention=none have no marker and are untouched.
 * Reuse the provider's TTL and marker count rather than enabling caching here.
 *
 * The live tail may span several request-only blocks (stable goal state plus
 * volatile counters) and previously sent tails may be retained verbatim
 * mid-history for implicit-prefix stability. Every such block is transient:
 * the breakpoint must skip all of them and land on real history.
 */
export function cacheGoalHistory(payload: unknown, liveContent: string | readonly string[] | undefined): unknown {
	const live = liveContent === undefined
		? undefined
		: new Set((typeof liveContent === "string" ? [liveContent] : liveContent).filter(text => text.length > 0));
	const root = asRecord(payload);
	if (!live || live.size === 0 || !Array.isArray(root?.messages)) return undefined;
	const messages = root.messages;
	const last = asRecord(messages.at(-1));
	if (last?.role !== "user" || !Array.isArray(last.content)) return undefined;
	// Match on text membership, not the type tag: Bedrock payloads use
	// typeless { text } blocks, and neither cachePoint markers nor thinking
	// blocks carry a text field, so they can never match by accident.
	const isLiveText = (block: unknown): boolean => {
		const record = asRecord(block);
		return typeof record?.text === "string" && live.has(record.text);
	};
	// Bedrock represents its breakpoint as a separate content block. The tail
	// may be several live blocks; skip back over all of them.
	const bedrockPoint = asRecord(last.content.at(-1));
	if (asRecord(bedrockPoint?.cachePoint)) {
		const rest = last.content.slice(0, -1);
		if (!rest.every(isLiveText)) return undefined;
		let i = messages.length - 2;
		while (i >= 0) {
			const candidate = asRecord(messages[i]);
			if (!candidate || candidate.role !== "user" || !Array.isArray(candidate.content) || candidate.content.length === 0) break;
			if (!candidate.content.every(isLiveText)) break;
			i--;
		}
		for (; i >= 0; i--) {
			const previous = asRecord(messages[i]);
			if (!Array.isArray(previous?.content) || previous.content.length === 0) continue;
			if (!previous.content.some(block => asRecord(block)?.cachePoint)) previous.content.push(bedrockPoint);
			last.content.pop();
			return payload;
		}
		return undefined;
	}
	const tail = asRecord(last.content.at(-1));
	if (tail?.type !== "text" || typeof tail.text !== "string" || !live.has(tail.text) || !asRecord(tail.cache_control)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = asRecord(messages[i]);
		if (!message || !["user", "assistant", "tool"].includes(String(message.role))) continue;
		if (typeof message.content === "string" && message.content.length > 0) {
			message.content = [{ type: "text", text: message.content, cache_control: tail.cache_control }];
			delete tail.cache_control;
			return payload;
		}
		if (!Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = asRecord(message.content[j]);
			// Thinking blocks cannot carry cache_control. Never split/reorder tool pairs.
			// Live tails are transient by construction: never anchor the breakpoint on one.
			if (!block || isLiveText(block) || !["text", "image", "tool_use", "tool_result"].includes(String(block.type))) continue;
			block.cache_control ??= tail.cache_control;
			delete tail.cache_control;
			return payload;
		}
	}
	return undefined;
}
