# PRODUCT — Silent unfocused sessions

## Problem

Goals live in the project-wide `.pi/goals/` pool, while focus is per session.
When one session in a project had an open goal, every other unfocused session in
the same project received a model-facing `[PI GOAL UNFOCUSED]` reminder asking
the user to focus a goal. That applied to regular and Sisyphus goals alike.
Ordinary work in the second session was steered toward goal handling it never
requested.

## Behavior

- A session with no focused goal receives no model-facing reminder about open
  goals owned or focused elsewhere, regardless of goal mode or count.
- A session that previously carried goal instructions in model context receives
  exactly one `[PI GOAL INACTIVE]` snapshot, superseding those instructions. It
  is not repeated while the state is unchanged.
- Open goals remain discoverable through the dashboard, status hint, and
  `/goal-list`. `hideUnfocusedBanner` stays a purely visual setting.
- Focus stays an explicit user choice: `/goal-focus`, `/goal-resume`, the
  existing resume picker, or opt-in `autoSelectSingleGoal`.
- Stale continuation checkpoints are still rejected before any unfocused
  handling.

## Out of scope

Ownership checks on goal mutations and accounting remain focus-based; scheduler
ownership is unchanged.
