# Implementation

`cacheGoalHistory` resolved the live-state message with `messages.at(-1)` and
returned early when that message was not a user message. Resolve a
`tailMessageIndex` instead: the highest index whose `content` is a non-empty
string, a non-empty array, or any other non-nullish value. Both existing
branches then work from that index rather than from the array length, leaving
the Anthropic `cache_control` and Bedrock `cachePoint` relocations otherwise
unchanged.

A contentless message can hold no breakpoint and contributes nothing to the
cached prefix, so skipping it cannot move a marker the host intended to keep.
A trailing message that does carry content is still a foreign tail: the last
content block no longer equals `liveContent`, the existing guard fails, and the
function returns `undefined`.

Cover the Anthropic and Bedrock shapes with the suffix present, and assert that
a content-bearing foreign tail leaves the payload byte-identical. Verify that
the new case fails against the previous implementation so the regression is not
vacuous.
