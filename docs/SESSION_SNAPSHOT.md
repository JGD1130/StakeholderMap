# Session Snapshot

Last updated: 2026-03-17

## Session continuity note

- Re-enabled this file as the durable handoff for future sessions and crash/restart recovery.
- After meaningful code changes, capture:
  - what changed
  - what still needs testing
  - any blockers, regressions, or next recommended step
- Workflow preference: Codex should commit and push completed fixes to `main` after changes until the user says otherwise.

## Latest session note

- 2026-03-30: Fifth Planner Copilot refinement to address user feedback that strict mode still "looks the same" and does not feel agentic. Added explicit practical floor-first recovery controls to copilot strict runs: client now sends `practicalFloorFirstOnStrictMiss=true` with `practicalNearRangeTolerance=0.12`, and server fallback ranking now prioritizes near-range options inside the practical band (+/-12%) before emergency nearest-fit options when strict +/-5% cannot be met. Added explanatory notes in returned assumptions/criteria to make this behavior visible. Validation: `node --check ai-server/server.js` passed and `npm.cmd run build` passed.
- 2026-03-30: Fourth Planner Copilot fix targeted user-reported “no learning / still same underfit option.” Root cause identified: client-side pre-AI inventory downsampling was too aggressive for copilot mode (campus inventory cut to small subsets), causing solver to miss viable strict-fit one-building candidates that exist in full data. Increased copilot inventory intake and trim ceilings substantially in `onCreateMoveScenario` (campus load cap, fallback rows cap, and trim options/max per type) while keeping standard mode trims unchanged. Validation: `node --check ai-server/server.js` passed and `npm.cmd run build` passed.
- 2026-03-30: Third Planner Copilot tuning pass after user validation still showed underfit/scattered fallback. Added explicit floor-first fallback candidate generation in the AI server (`buildFloorBlockFallbackOptions`) that evaluates contiguous single-floor and same-building two-floor block options before room-level fallback. Wired these as strict fallback passes (`Auto-relax FB1/FB2`) to bias toward whole-floor or near-whole-floor outcomes. Also cleaned client-side criteria messaging so local “hard excluded” notes are suppressed when selected fallback assumptions indicate family-relaxed fallback was used. Validation: `node --check ai-server/server.js` passed and `npm.cmd run build` passed.
- 2026-03-30: Second Planner Copilot strict-fit tuning pass focused on floor-first outcomes. Raised strict fallback minimum coverage threshold (80%), changed strict fallback selection to rank multiple relax passes (instead of locking early to one weak nearest-fit option), added contiguous floor-block fallback pass, and fixed relax-pass room-source widening so support/public fallback can actually draw from broader assignable inventory when strict fails. Added fallback ranking preference for floor concentration and explicit “best fallback SF gap” notes. Validation: `node --check ai-server/server.js` passed and `npm.cmd run build` passed.
- 2026-03-30: Hardened Planner Copilot to avoid strict-fit dead-end failures in `Create planning scenario`. Removed strict one-building hard-stop throw so infeasible one-building strict requests still return closest options. Relaxed strict fallback acceptance thresholds and added emergency closest-fit fallback passes so strict mode returns a bounded best-effort option (with explicit under-target warnings) instead of only erroring out. In `StakeholderMap`, relaxed retries now disable academic-fit low-fit pruning, and strict dead-end errors in copilot mode auto-trigger one relaxed retry before surfacing an error. Validation: `node --check ai-server/server.js` passed and `npm.cmd run build` passed.
- 2026-03-18: Restored technical-assessment workflow and added dedicated technical routes. Routing now includes `/:universityId/technical`, `/:universityId/admin/technical`, and `/:universityId/admin/engagement`. `StakeholderMap` now accepts `technicalMode`, defaults technical routes to Assessment view, re-enables admin map-view options (`Space Data`, `Assessment`, `Technical`), and fixes technical panel navigation by switching map view when opening/closing technical assessment. Implemented Firestore-backed `handleConditionSave` (was a no-op) and local `handleAssessmentSave` state sync. Updated smoke checks to cover technical routes and handlers. Validation: `npm.cmd run smoke` passed and `npm.cmd run build` passed.
- 2026-03-17: Hotfix for runtime load failure (`Cannot read properties of undefined (reading 'createContext')` from `vendor-misc` after deploy). Root cause was aggressive Vite `manualChunks` splitting. Reverted custom chunk splitting in `vite.config.js` to restore stable default bundling. `npm.cmd run build` passed and app load expected to recover on next Pages deploy.
- 2026-03-17: Completed cleanup + reliability + bundling pass. Heatmap cleanup removed leftover legacy `engagement-heat-rarely-glow` plumbing and kept only the current `rarely` green halo path. Added `npm run smoke` guardrail checks via `scripts/smoke-check.mjs` for critical flows (directional halving controls, engagement room metadata fields on marker save, help-panel close wiring, and green halo layer presence). Added Vite manual chunking and chunk warning tuning in `vite.config.js` to split heavy vendor code (`mapbox`, `firebase`, `turf`, `pdf`, `canvas`, etc.) and eliminate previous large-chunk warnings in build output. Validation: `npm.cmd run smoke` passed and `npm.cmd run build` passed.
- 2026-03-17: Replaced the `rarely/never` circle-based glow with a dedicated green-only heatmap halo layer (`engagement-heat-rarely-halo-layer`) so green uses the same halo-style rendering model as other heat colors, but without introducing blue tint. Kept the `rarely` minimum weight floor and left all non-green category ramps unchanged. `npm.cmd run build` passed.
- 2026-03-17: Applied isolated `rarely/never` visibility improvements without changing other heat categories: added a dedicated `engagement-heat-rarely-glow` circle layer (`#7AFEB1`) for a stronger local glow and added a category-only minimum weight floor for `rarely` (`max(weight, 0.92)` before multiplier). Non-green heatmap ramps/behavior remain unchanged. `npm.cmd run build` passed.
- 2026-03-17: Rolled engagement heatmap behavior back to the pre-tuning baseline for non-green categories by restoring `src/components/StakeholderMap.jsx` from commit `1bfe83d`. Kept the updated marker/sentiment palette (`rarely` = `#7AFEB1`, `outdated` = `#67e8f9`) and applied one green-only guard: excluded `rarely` from the shared cool thermal halo so green points no longer pick up a blue core. `npm.cmd run build` passed.
- 2026-03-17: Reconfirmed `docs/SESSION_SNAPSHOT.md` as the restart-safe handoff file for this repo. No product code changed in this step. Next time a substantial feature, bug fix, or review is completed, append a short snapshot here summarizing the change, validation status, and any follow-up risk.
- 2026-03-17: Patched scenario halving axis lock so `Halve Vertical` / `Halve Horizontal` no longer fall back to nearest-point endpoint snapping when axis intersections are insufficient. This prevents diagonal cuts from being accepted during directional halving. `npm.cmd run build` passed. Still needs UI retest on the previously failing room from the admin floorplan screenshot.
- 2026-03-17: Reworked directional halving to use axis-aligned half-plane clipping (instead of the generic split solver) so `Halve Vertical` and `Halve Horizontal` can only produce axis-aligned divider edges. Also tightened validation to require exactly one selected room for split/halve and removed the `Halve Room` button from Layout Edit Mode. `npm.cmd run build` passed.
- 2026-03-17: Engagement map marker flow updates. Added floor-click room detection so engagement markers on loaded floorplans now persist room metadata (`roomId`, `roomNumber`, `roomLabel`, `roomGuid`, `revitId`) alongside building/floor fields. Added marker-save fallback so if Firestore blocks writes, marker still appears as local/session marker and users are warned once. Updated Firestore rules so marker create is allowed for `hastings` and `hastings-demo` (admin still required for marker update/delete). `npm.cmd run build` passed. Firestore rules still require deployment to take effect.
- 2026-03-17: Updated engagement marker palette across marker dots, legend, heatmaps, and room sentiment: set `I rarely or never use this space` to `#7AFEB1`; moved prior cyan (`#67e8f9`) to `This space feels outdated or run down`; kept `I do not feel safe in this space` as existing blue (`#1d4ed8`). `npm.cmd run build` passed.
- 2026-03-17: Disabled thermal blended engagement heat overlay so the heatmap now uses category-specific colors only, matching marker dots and room sentiment colors exactly (including the new `#7AFEB1` rarely-used color). `npm.cmd run build` passed.
- 2026-03-17: Restored thermal engagement heat overlay behavior and tuned cool ramp early stops toward the new `#7AFEB1` so rarely-used heat better tracks marker/sentiment color without changing overall heatmap behavior. Also hardened `How to Use This Map` panel dismiss handling by adding an explicit close handler and click-propagation guards so `X` and `Close` can dismiss reliably. `npm.cmd run build` passed.
- 2026-03-17: Refined the `I rarely or never use this space` heat rendering: kept thermal behavior, but excluded `rarely` from the shared cool halo blend and gave `rarely` a slightly darker green heat core with lighter green bleed (`rgb 86,222,150` -> `halo 207,252,228`) while keeping marker dot color at `#7AFEB1`. `npm.cmd run build` passed.
- 2026-03-17: Increased `rarely/never` heat visibility without reintroducing blue by boosting that category layer only (higher weight, intensity, radius, and opacity in both floor and campus profiles). `npm.cmd run build` passed.
- 2026-03-17: Further increased `rarely/never` visibility per feedback: darker green core (`rgb 58,188,118`), stronger green-only category heat color ramp at lower densities, plus higher weight/intensity/radius/opacity so center appears bolder and rooms do not fade out. Marker dot color remains `#7AFEB1`. `npm.cmd run build` passed.
- 2026-03-17: Adjusted `rarely/never` heatmap to be true gradient by setting center color to exact marker hue (`#7AFEB1` / `rgb 122,254,177`) and fading to lighter green shades outward. Also reduced over-saturation so points render as a heat scale instead of flat solid dots. `npm.cmd run build` passed.
- 2026-03-17: Rebased engagement heat rendering onto marker-matched category colors (disabled thermal blended overlay) so categories no longer wash into each other. For `rarely/never`, set center to exact marker hue (`#7AFEB1`) with lighter green falloff and substantially boosted visibility (weight/intensity/radius/opacity) to prevent fade-out. `npm.cmd run build` passed.

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
- Disabled the entire right-side building/floor floating space panel in the stakeholder engagement map so clicking buildings or loading floorplans there no longer opens the admin/public analytics panel.

## Fix applied on 2026-03-12

- Updated Remove Divider targeting so when prior synthetic scenario rooms remain selected, the action can still operate on exactly two newly selected non-synthetic adjacent rooms instead of failing on the full active selection.
- Remove Divider now uses the validated working pair directly when applying the operation, keeping it aligned with merge-room selection handling.

## Known follow-up checks

- Verify in UI that:
  - Merge one adjacent room set, then merge a second unrelated adjacent room set in the same session.
  - Keep prior merged rooms visible in Planning Scenario totals and Reno Scenario totals after the second merge.
  - Split still works when exactly one active room is targeted.
  - Remove Divider still works when prior synthetic scenario rooms remain selected and the new divider-removal pair is adjacent.

## Working rule for future sessions

- Treat this file as the durable handoff when chat history is lost.
- After major changes, append a short note here with:
  - what changed
  - what still needs testing
  - any known regressions or open questions
