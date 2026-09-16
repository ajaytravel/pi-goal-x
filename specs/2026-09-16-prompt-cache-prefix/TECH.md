# Implementation

Move goal prompt rendering from before_agent_start into a request-only context tail shared by normal and custom-message runs. Keep before_agent_start preflight/accounting/scheduler behavior and stale-dispatch aborts. Render current lifecycle state on every context event; consume one-shot reminders there. Never modify the host system prompt.

Normalize every checkpoint independently to its bounded v2 trigger at its existing index; do not delete earlier markers or derive historical metadata from live state. Pi's real compaction can retire old history. Display-only audit filtering remains deterministic. Existing fixed execution tool profiles stay idempotent; explicit drafting/settings changes are legitimate schema boundaries.

Test prefix equality across consecutive serialized requests, current state freshness, lifecycle safety, and real SDK provider conversion/cache controls. Audit child session prompt ordering and provider defaults. Run typecheck, lint, all tests and context checks, updating obsolete checkpoint/context expectations.

Explicit caches need a reusable write point, not just a stable prefix. Add a narrow before_provider_request transform that relocates Pi's existing final live-state breakpoint onto the preceding history block for Anthropic cache_control and Bedrock cachePoint payloads. Preserve TTL, do not increase the breakpoint count, and leave implicit caches / caching disabled untouched. This avoids writing only a unique ephemeral suffix on each call.
