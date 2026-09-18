# Cache breakpoint relocation on hosts that append a payload suffix

The 0.31.6 breakpoint relocation must survive host payload shapes that place a
message after the request-only goal state. Pi 0.85.1 appends
`{role: "system", content: []}` to every Anthropic payload carrying
`output_config`, so the relocation never runs on those models and #67's
amplification returns in full: the breakpoint stays on goal state that is
rewritten every request, and only the system prompt is reusable.

Relocation must key on the last message that carries content rather than on the
final array element. Payloads without an explicit marker, implicit-cache
providers, and a trailing message belonging to another extension must continue
to be left untouched.
