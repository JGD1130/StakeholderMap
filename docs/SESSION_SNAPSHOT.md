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
- Added browser-local fallback for Planning Scenario save/duplicate/rename so saved scenarios still work when Firestore write permissions block scenario documents.
- Added browser-local fallback for Reno Scenario save so the conceptual renovation snapshot persists even when Firestore blocks remote writes.
- Updated merge validation so a new merge can ignore already-selected synthetic merged rooms when at least two newly selected non-synthetic rooms are present, allowing distinct adjacent merged sets to remain separate.
- Moved Scenario Impact to the bottom of the Planning Scenario panel and made it collapsed by default so layout-edit controls stay visible first.
- Moved both Scenario Overrides and Scenario Impact to the bottom of the Planning Scenario panel and made both collapsed by default.
- Added a repo-managed `firestore.rules` file and wired `firebase.json` to deploy it, covering public map reads, admin writes, scenario saves, and public drawing-entry submissions.
- Added a Planning Scenario baseline-to-scenario slider that crossfades baseline fill/line/label layers against the live scenario layout.
- Added a Program Test Fit tool shell with launchers from building panel, floor panel, and selected rooms, including program rows, fit calculations, and PDF export.
- Updated Program Test Fit to use an explicit primary `Run Test Fit` action, keep displayed results tied to the last run, auto-refresh results after the first run, and populate program row space types from current room-type options in the selected target area.
- Added a `Fit Quality Warning` layer to Program Test Fit so results now compare requested space types against the current target-area room mix, flag missing specialized spaces, and generate a short planning note alongside the SF fit result.
- Disabled the right-side floor summary panel in the stakeholder engagement map so floorplans can still load there without opening the full Floor Panel UI.

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
