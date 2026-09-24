# Implementation log

- Diagnosed from two sessions in one project: the focused session owned an open
  goal; the other received `[PI GOAL UNFOCUSED]` though it never focused a goal.
  Sisyphus goals share the same pool and path.
- Regression tests first: unrelated sessions beside regular and Sisyphus goals
  (with `hideUnfocusedBanner` on and off), unfocus after an active snapshot,
  resume of a session holding an old unfocused reminder, and resume/tree
  restoration. They failed against `d1b4967` and pass with the change.
- Review found the removed builder was still imported by
  `experiments/bench/b7-feature-matrix.mjs`, which broke `run-bench.mjs` at
  import. Removed the row and retired it in the B6 gate. Verified both
  `extension-review-plan` and `naf` gates pass with the row absent from an
  after run, using temporary copies rather than rewriting committed baselines.
- `context:gate` was already failing on the base branch for all 24 fixtures:
  the harness read only `systemPrompt`, but append-only goal state is returned
  as a `before_agent_start` message, so goal snapshots were invisible and the
  active-goal checks filtered a retired message type. Fixing capture also
  cleared the pre-existing `post-compaction-turn` failure. The "tail" rule was
  replaced by "at most once" because later tool results follow append-only
  snapshots.
- Measured old versus new extension code with the fixed harness: only
  `unfocused-multiple-goals` changed — `unfocusedSafety` 1 → 0, 436
  extension-message characters removed. The new invariant fails on the old code.
  With semantic gates passing, `baseline-main.json` was regenerated; this also
  records the append-only branch's intended request-shape changes.
- Validation: `npm run check`, `npm run lint`, `npm run test:unit`,
  `npm run context:gate`, B7 import, and synthetic B6 gates. Not installed or
  reloaded in the configured package.
