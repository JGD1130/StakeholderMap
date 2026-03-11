# Session Snapshot

Last updated: 2026-03-11

## Current focus

- Planning Scenario and Reno Scenario layout editing on floorplans.
- Goal: allow merge, remove-divider, and split operations to coexist in one scenario session without losing prior scenario rooms.

## Recent completed work

- Added seat ratio numbers and dashboard charts to the floor summary dashboard.
- Added Reno Scenario panel and conceptual cost estimator for selected planning-scenario rooms.
- Added scenario-only room geometry edits:
  - Merge rooms
  - Remove divider
  - Split room

## Current behavior

- Dashboard seat-ratio features are working, but may still be optional.
- Individual layout-edit features work on their own.
- Scenario layout state is stored locally in scenario operations and rendered as synthetic scenario rooms.

## Fix applied on 2026-03-11

- Updated planning-scenario layout selection logic so previously created synthetic scenario rooms can remain selected while applying a new merge/remove-divider/split edit.
- Updated layout operations so they replace only the rooms affected by the current edit instead of replacing the entire scenario selection.
- Updated scenario operation logging so layout ops persist the explicit source room ids they acted on.
- Updated planning and reno PDF exports to highlight only the effective selected scenario rooms, avoiding adjacent/source-room over-highlighting in exported floorplan images.
- Fixed synthetic scenario room registration so later department commits can apply consistently to split rooms as well as merged rooms.
- Updated split validation so a new split can target the most recently selected scenario room even while earlier scenario rooms remain selected in the same session.
- Hardened split geometry fallback so concave rooms like corridors get clipped back to the selected room shape instead of creating shortcut triangles through adjacent space.
- Added first-pass Planning Scenario save/load/rename/duplicate using Firestore-backed scenario documents with saved room metadata, operations, overrides, and Reno settings for current-floor reloads.

## Known follow-up checks

- Verify in UI that:
  - Merge one adjacent room set, then merge a second unrelated adjacent room set in the same session.
  - Keep prior merged rooms visible in Planning Scenario totals and Reno Scenario totals after the second merge.
  - Split still works when exactly one active room is targeted.
  - Remove Divider still works with prior synthetic scenario rooms already present in the session.

## Working rule for future sessions

- Treat this file as the durable handoff when chat history is lost.
- After major changes, append a short note here with:
  - what changed
  - what still needs testing
  - any known regressions or open questions
