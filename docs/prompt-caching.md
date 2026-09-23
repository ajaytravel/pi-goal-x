# Prompt caching

pi-goal-x keeps the provider prompt prefix stable by appending goal text and never rewriting it. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas. Goal text is not added to the system prompt, and an ordinary turn does not change the tool list.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. A persisted goal snapshot, appended only when the model-visible goal text changes. Usage, budget, and turn counters stay on the dashboard and are not part of that text. Scheduling instructions (next action, repair guidance, and wait identity/deadline) remain model-visible. An objective edit appends a new snapshot and leaves the earlier one byte-identical.

The context hook does not add a request-only goal tail and does not replay one. A normal turn and a continuation therefore extend the previous provider request instead of replacing a disappearing tail. Old snapshots and checkpoints remain until Pi compacts history. Display-only auditor messages are excluded, and tool calls stay adjacent to their results.

Snapshots are published on user-driven starts and immediately before autonomous checkpoints (which skip `before_agent_start`). Budget exhaustion during a tool loop queues a persisted wrap-up snapshot after the tool results. Clearing/completing a goal supersedes active instructions on the next user-driven start. Compaction invalidates snapshot deduplication so current state can be republished. Delegated workers exclude inherited parent snapshots without changing the parent's history. If building or submitting a continuation's snapshot throws, dispatch pauses rather than proceeding with stale instructions; resume can retry the snapshot. Pi reports asynchronous session-write failures through its extension error channel instead of throwing to the caller.

The extension does not move cache breakpoints, set cache keys, enable paid extended retention, or replace provider defaults. With explicit caching enabled, Pi marks the last history block. That marker can move between requests, but the earlier message content remains identical. Implicit-cache serializers preserve the earlier message-array prefix byte-for-byte.

Execution tools use an idempotent profile on ordinary turns. Lifecycle changes such as reaching a budget limit can remove task tools; switching into/out of drafting or changing disableTasks can also change tools and legitimately rebuild the cache. This change does not alter those tool-availability policies. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by compaction, branch/session changes, model/provider or effort switches, another extension editing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction.

Validation covers actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention. An extension-driven continuation-after-edit test passes its generated snapshot text to real OpenAI serializers and checks exact prefix bytes across a tool result and continuation. Real SDK scheduler tests exercise wait, repair, retry, budget wrap-up, and compaction paths against a local fixture server. Serializer captures stop before HTTP dispatch; no tests measure live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.
