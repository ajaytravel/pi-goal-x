import { createHash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Prefix-stable retention for request-only goal-state tails.
 *
 * The context hook appends live goal state to every provider request without
 * persisting it. When the next request arrives, the completed assistant turn
 * occupies the position where the previous tail sat, so request N is no
 * longer a prefix of request N+1 and implicit prompt caches (OpenAI Responses
 * / Chat Completions, which carry no explicit marker) freeze at the first
 * injection point.
 *
 * This module makes each request a true prefix of the next: previously sent
 * tails are re-inserted verbatim at their recorded anchor (the session length
 * when they were emitted, verified by a digest of the anchor message), and
 * only genuinely new tail content is appended. Identical content across
 * repeated requests appends nothing, so tool loops and idle re-requests cost
 * zero growth. A stable-state change, an anchor mismatch (compaction, resume,
 * session-tree moves, filter changes), an unsafe insertion point, or overflow
 * all perform one documented full reset instead of silently shifting the
 * prefix or corrupting message structure.
 */

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

export type LiveTailKind = "goal-state" | "goal-counters";

/**
 * Upper bound on retained tails per session. Retained tails are small (the
 * per-turn volatile counters), so the steady-state wire overhead stays near
 * a few kilobytes; exceeding the bound performs a single full reset, i.e. at
 * most one prefix break per MAX_RETAINED_LIVE_TAILS state changes.
 */
export const MAX_RETAINED_LIVE_TAILS = 32;

/** Upper bound on concurrently tracked sessions (parent plus isolated runs). */
export const MAX_TRACKED_SESSIONS = 16;

export interface FreshLiveTails {
	state: string;
	counters?: string | undefined;
}

interface RetainedTail {
	anchorIndex: number;
	anchorFingerprint: string;
	content: string;
	kind: LiveTailKind;
}

interface SessionRetention {
	tails: RetainedTail[];
	lastFresh: FreshLiveTails | undefined;
}

function freshBlocks(fresh: FreshLiveTails): string[] {
	return fresh.counters === undefined ? [fresh.state] : [fresh.state, fresh.counters];
}

/**
 * Full-message digest. A truncated sample would let two different histories
 * share an anchor, and a mismatch is not merely a cache miss: a retained tail
 * replayed at the wrong index can land between a tool call and its results.
 */
function fingerprintAnchor(message: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(message) ?? "undefined";
	} catch {
		// Unserializable messages can never be proven identical: force a reset.
		return `unhashable:${Math.random()}`;
	}
	return createHash("sha256").update(serialized).digest("base64");
}

/**
 * Tool results must stay adjacent to the call they answer, so a retained tail
 * may never be inserted directly before one. Providers either reject a split
 * batch or the SDK synthesizes placeholder results for the orphaned calls.
 */
function splitsToolBatch(next: unknown): boolean {
	const record = asRecord(next);
	return record?.role === "toolResult";
}

function makeLiveMessage(content: string, kind: LiveTailKind): unknown {
	return {
		role: "custom",
		customType: LIVE_CONTEXT_TYPE,
		content,
		display: false,
		timestamp: 0,
		details: { version: 1, kind },
	};
}

export class LiveTailRetention {
	private readonly sessions = new Map<string, SessionRetention>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveTails | null): { messages: T[]; transientContents: string[] } {
		if (fresh === null) {
			this.sessions.delete(sessionKey);
			return { messages: [...base], transientContents: [] };
		}
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = { tails: [], lastFresh: undefined };
			if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.sessions.keys().next();
				if (!oldest.done) this.sessions.delete(oldest.value);
			}
			this.sessions.set(sessionKey, session);
		}
		const reset = () => {
			session!.tails = [];
			session!.lastFresh = undefined;
		};
		// A changed state block supersedes every previously sent tail: start
		// fresh rather than leave a stale objective or a cancelled scheduling
		// instruction lingering mid-history.
		if (session.lastFresh !== undefined && session.lastFresh.state !== fresh.state) reset();
		// Truncate at the first anchor that no longer matches or that would now
		// split a tool-call batch: compaction, resume, tree moves, and filter
		// changes all rewrite history. Re-appending below guarantees the live
		// state is never lost silently.
		let valid = 0;
		while (valid < session.tails.length) {
			const tail = session.tails[valid]!;
			if (tail.anchorIndex > base.length) break;
			if (tail.anchorIndex > 0 && fingerprintAnchor(base[tail.anchorIndex - 1]) !== tail.anchorFingerprint) break;
			if (splitsToolBatch(base[tail.anchorIndex])) break;
			valid++;
		}
		if (valid < session.tails.length) {
			session.tails = session.tails.slice(0, valid);
			session.lastFresh = undefined;
		}
		const blocks = freshBlocks(fresh);
		// Append only the suffix that differs from the last emitted tails, so
		// unchanged content across repeats, tool loops, and history advances
		// adds zero blocks while keeping the prefix literal.
		const previous = session.lastFresh === undefined ? [] : freshBlocks(session.lastFresh);
		let shared = 0;
		while (shared < blocks.length && shared < previous.length && blocks[shared] === previous[shared]) shared++;
		// Overflow is measured against what this request actually appends: an
		// unchanged request adds nothing and must never trigger a reset.
		if (session.tails.length + (blocks.length - shared) > MAX_RETAINED_LIVE_TAILS) {
			reset();
			shared = 0;
		}
		const messages = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, { ...(makeLiveMessage(tail.content, tail.kind) as object) } as T);
		}
		for (let i = shared; i < blocks.length; i++) {
			const content = blocks[i]!;
			const kind: LiveTailKind = i === 0 ? "goal-state" : "goal-counters";
			messages.push(makeLiveMessage(content, kind) as T);
			session.tails.push({ anchorIndex: base.length, anchorFingerprint: base.length === 0 ? "root" : fingerprintAnchor(base[base.length - 1]), content, kind });
		}
		session.lastFresh = { state: fresh.state, counters: fresh.counters };
		return { messages, transientContents: [...new Set([...session.tails.map(tail => tail.content), ...blocks])] };
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
