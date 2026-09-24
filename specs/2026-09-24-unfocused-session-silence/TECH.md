# TECH — Silent unfocused sessions

- `snapshotText()` in `extensions/goal-events.ts`: with no focused goal, return
  the inactive snapshot only when this session already published or restored a
  goal snapshot (`lastSnapshot`); otherwise return nothing. The stale-checkpoint
  branch still runs first. Publication dedupes on the full snapshot text.
- `unfocusedOpenGoalsPrompt` is removed. `get_goal` keeps its own unfocused
  summary, which directs the user to `/goal-focus`; the unfocused tool profile
  remains `create_goal` and `get_goal`.
- The inactive wording no longer claims "no open goal". Sessions that already
  hold the previous inactive text receive one replacement snapshot.
- Context harness: `capture-context.mjs` records the `before_agent_start` custom
  message, where append-only goal state is published. `run-gate.mjs` reads
  `pi-goal-snapshot`, requires at most one per captured request, and fails any
  fixture carrying `[PI GOAL UNFOCUSED]`.
- Bench: the `B7.runtime.unfocusedPrompt` row is removed and listed in
  `RETIRED_ROWS` in `b6-gate.mjs`, so historical baselines stay unedited.
