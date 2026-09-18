# Implementation log

- Observed #67's symptom on 0.31.6 with a focused goal on `claude-opus-5`:
  `cacheRead` frozen across consecutive requests while `liveContent` changed
  length every request. Ruled out TTL expiry, aside sessions, lazy MCP tool
  loading, and thinking blocks by controlled comparison before reading code.
- Instrumented `before_provider_request` in an isolated working directory to
  record breakpoint positions and evaluate the existing guard. The guard
  reported `last.role=system`, so relocation never ran and the breakpoint
  stayed on the volatile block.
- Established that the trailing `{role: "system", content: []}` is Pi's own:
  it survives `--no-extensions`. A payload sweep showed it on `claude-opus-5`
  and `claude-fable-5-1`, both of which carry `output_config`, and not on
  `claude-sonnet-5` or `claude-haiku-4-5`, which do not. The trigger is the
  payload shape, not a model.
- Confirmed the fault is specific to explicit breakpoints. On
  `openai-responses` the message field is `input`, no `cache_control` appears,
  and the volatile block sits strictly at the tail, so the prefix still
  extends; `cacheGoalHistory` already declines those payloads.
- Implemented `tailMessageIndex` and derived both loops from it. Confirmed the
  new regression fails against the previous implementation (3 pass, 1 fail)
  and passes with the change.
- Validation: `npm run check`, `npm run lint`, `npm run test:all` (1,008
  passing tests across 79 files), `npm run test:selfcheck` (957), `npm run
  context:gate` (24 fixtures, baseline unchanged), and `npm run
  context:provider-check` (6 real SDK payloads, no network). No paid provider
  requests were made; these checks verify request construction rather than
  live hit rates.
