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
 * when they were emitted, verified by a bounded fingerprint of the anchor
 * message), and only genuinely new tail content is appended. Identical
 * content across repeated requests appends nothing, so tool loops and idle
 * re-requests cost zero growth. A stable-state change, an anchor mismatch
 * (compaction, resume, session-tree moves, filter changes), or overflow all
 * perform one documented full reset instead of silently shifting the prefix.
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

/** Bounded, non-cryptographic identity for an anchor message. Collisions only cost a cache miss. */
function fingerprintAnchor(message: unknown): string {
	const record = asRecord(message);
	const role = typeof record?.role === "string" ? record.role : "?";
	const timestamp = typeof record?.timestamp === "number" ? record.timestamp : 0;
	const content = record?.content;
	const length = typeof (content as { length?: unknown } | null | undefined)?.length === "number"
		? (content as { length: number }).length
		: -1;
	let sample = "?";
	try {
		sample = (JSON.stringify(content) ?? "?").slice(0, 120);
	} catch {
		sample = "?";
	}
	return `${role}|${timestamp}|${length}|${sample}`;
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
		// A changed policy block supersedes every previously sent tail: start
		// fresh rather than leave stale objectives lingering mid-history.
		if (session.lastFresh !== undefined && session.lastFresh.state !== fresh.state) {
			session.tails = [];
			session.lastFresh = undefined;
		}
		// Truncate at the first anchor that no longer matches: compaction,
		// resume, tree moves, and filter changes all rewrite history. Forcing
		// a re-append below guarantees the live state is never lost silently.
		let valid = 0;
		while (valid < session.tails.length) {
			const tail = session.tails[valid]!;
			if (tail.anchorIndex > base.length) break;
			if (tail.anchorIndex > 0 && fingerprintAnchor(base[tail.anchorIndex - 1]) !== tail.anchorFingerprint) break;
			valid++;
		}
		if (valid < session.tails.length) {
			session.tails = session.tails.slice(0, valid);
			session.lastFresh = undefined;
		}
		const blocks = freshBlocks(fresh);
		// Overflow resets fully: dropping the oldest tail would break the
		// prefix on every subsequent request, while one reset per window
		// keeps the amortized hit rate near (MAX - 1) / MAX.
		if (session.tails.length + blocks.length > MAX_RETAINED_LIVE_TAILS) {
			session.tails = [];
			session.lastFresh = undefined;
		}
		const messages = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, { ...(makeLiveMessage(tail.content, tail.kind) as object) } as T);
		}
		// Append only the suffix that differs from the last emitted tails, so
		// unchanged content across repeats, tool loops, and history advances
		// adds zero blocks while keeping the prefix literal.
		const previous = session.lastFresh === undefined ? [] : freshBlocks(session.lastFresh);
		let shared = 0;
		while (shared < blocks.length && shared < previous.length && blocks[shared] === previous[shared]) shared++;
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
