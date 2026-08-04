# Stakeholder Map — Handoff Document

> Written for AI assistants and new developers. Read this first. Update it whenever significant changes are made.

---

## What This App Does

A multi-tenant facility assessment and stakeholder engagement platform. Each client (university, county, healthcare org) gets the same application codebase pointed at their own spatial data, configuration, and Firestore database collection. The product has several modes:

- **Public / engagement** — survey-style map where stakeholders drop markers and draw paths
- **Admin** — full drawing, annotation, condition scoring, and data management
- **Technical** — building-by-building technical assessment (scored across 3 sections), with map colors showing completion progress per building

---

## Architecture

```
Browser (React + Mapbox GL JS)
    │
    ├─── Firebase Firestore (real-time DB: markers, paths, assessments, room edits)
    ├─── Firebase Auth (admin sign-in gates cloud saves)
    ├─── Firebase Cloud Functions (admin role assignment, AI floor explanations)
    │
    ├─── AI Server (Node.js/Express, runs separately as ai-server/)
    │       ├── Proxies all Airtable API calls (room data read/write)
    │       ├── OpenAI calls (room/floor explanations, document Q&A)
    │       └── PDF/XLSX export generation
    │
    └─── GitHub Pages (static hosting for the built React app)
             Deployed via GitHub Actions (.github/)
```

### Key technology choices

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (Vite), Mapbox GL JS | Single codebase, all clients |
| Spatial data | GeoJSON (floor plans, boundaries) | Loaded from `public/floorplans/` |
| Room data source | Airtable | Fetched via AI server at `/ai/api/rooms` |
| Real-time DB | Firebase Firestore | Markers, paths, assessments, room edits |
| Auth | Firebase Auth | Email/password; admin role via custom claim |
| AI / LLM | OpenAI (gpt-4.1 default) | Routed through AI server, never called directly from browser |
| Hosting | GitHub Pages | Static, deployed by GitHub Actions |
| Serverless | Firebase Cloud Functions | `addAdminRole`, `aiExplainFloor` |

### Airtable's role

Airtable is the **source of truth for room/space attribute data** (department, room type, occupancy status, seat count, occupant, etc.). The AI server (`ai-server/server.js`) proxies all Airtable traffic:

- `GET /ai/api/rooms` — fetches all rooms for the configured Airtable base/table/view
- `PATCH /ai/api/rooms/:id` — writes room edits back to Airtable
- Field names are configured via env vars (`AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`, `AIRTABLE_VIEW`, and per-field overrides)

The frontend merges Airtable room data with GeoJSON floor plan geometry via `mergeAirtableRoomsWithManifest()` in `StakeholderMap.jsx`. If Airtable data is unavailable, it falls back to the local `manifest.json` room list.

**Airtable is per-deployment, not per-tenant** — the env vars are set on the AI server instance, so each deployed environment points to one Airtable base.

---

## Folder Structure

```
stakeholder-map/
│
├── src/
│   ├── App.jsx                      # Router: reads URL slug → resolves tenant → renders mode
│   ├── firebaseConfig.js            # Single Firebase project shared by all tenants
│   ├── configLoader.js              # Loads per-tenant JSON config at runtime
│   ├── surveyConfigs.js             # Shared survey question and color definitions
│   │
│   ├── tenants/
│   │   └── registry.js              # Tenant registry: IDs, URL aliases, feature flags
│   │
│   ├── Configs/                     # ONE FILE PER CLIENT
│   │   ├── Hastings.json
│   │   ├── SarpyCounty.json
│   │   ├── CherokeeMentalHealth.json
│   │   ├── Rockhurst.json
│   │   └── geojson/                 # Boundary + building footprint GeoJSON per client
│   │
│   ├── components/                  # ⚠️ SHARED — changes here affect every client
│   │   ├── StakeholderMap.jsx       # Core map component (~25k lines)
│   │   ├── AssessmentPanel.jsx      # Technical assessment form + draft autosave
│   │   ├── BuildingInteractionPanel.jsx
│   │   ├── SpaceDashboardPanel.jsx
│   │   └── ...
│   │
│   ├── pages/
│   │   ├── PublicMapPage.jsx        # Public/survey mode
│   │   └── AdminMapPage.jsx         # Admin/edit mode
│   │
│   ├── utils/                       # Shared helpers (idUtils, floorSummary, etc.)
│   ├── style/roomColors.js          # Room-type color palette
│   └── dashboard/spaceDashboard.js
│
├── public/
│   ├── floorplans/                  # ONE FOLDER PER CLIENT
│   │   ├── Hastings/                # Per-building: affine.json, manifest.json, Rooms/*.geojson
│   │   └── SarpyCounty/
│   └── Data/                        # Logos and static imagery
│
├── ai-server/                       # Separate Node.js/Express process
│   └── server.js                    # Airtable proxy + OpenAI + PDF/XLSX export
│
├── functions/                       # Firebase Cloud Functions
│   └── index.js                     # addAdminRole(), aiExplainFloor()
│
├── scripts/                         # One-off data processing utilities
│   ├── generateFloorplansManifest.mjs
│   ├── backfillRooms.mjs
│   ├── transform-sarpy-admin-courthouse-airtable.cjs
│   └── ...
│
└── .github/                         # GitHub Actions: build + deploy to GitHub Pages
```

---

## Client List

| Client | URL slug(s) | Config file | Status | Floor plans | Assessment mode |
|---|---|---|---|---|---|
| Hastings College | `hastings`, `hastings-demo` | `Configs/Hastings.json` | Active | Yes — 20+ buildings | `building` (shared record per building) |
| Sarpy County | `sarpy-county`, `sarpy`, `sarpy-ne` | `Configs/SarpyCounty.json` | Planned | Yes — partial | — |
| Cherokee Mental Health | `cherokee-mental-health`, `cherokee`, `cherokee-mh` | `Configs/CherokeeMentalHealth.json` | Active | No | `per-assessor` (separate record per person) |
| Rockhurst University | `rockhurst` | `Configs/Rockhurst.json` | — | No | — |

URL pattern: `/{slug}/{mode}` — e.g. `/hastings/admin`, `/cherokee-mental-health`, `/sarpy-county`

Aliases are defined in `src/tenants/registry.js` and are case-insensitive.

---

## Shared vs Tenant-Specific Code

### ⚠️ Critical rule: `src/components/` is 100% shared

Every file in `src/components/` runs for **every client**. There is no per-client component code. When you edit `StakeholderMap.jsx`, `AssessmentPanel.jsx`, or any other component, you are changing behavior for all tenants simultaneously.

Client-specific behavior is controlled entirely through:
1. The tenant's JSON config file (`src/Configs/{Client}.json`)
2. Feature flags in `src/tenants/registry.js`
3. Data assets in `public/floorplans/{Campus}/` and `src/Configs/geojson/`

### What is shared (no client logic)

- All React components — `src/components/`, `src/pages/`
- Firebase config and Firestore collection structure — `firebaseConfig.js`
- Config loader — `configLoader.js`
- Survey question definitions — `surveyConfigs.js`
- Color palettes — `style/roomColors.js`
- AI server — `ai-server/`
- Cloud Functions — `functions/index.js`
- Build and deploy pipeline — `.github/`

### What is tenant-specific

| What | Where |
|---|---|
| Map center, zoom, pitch, bearing | `src/Configs/{Client}.json` |
| Feature flags (`enableDrawingEntry`, `enableFloorplans`, `technicalAssessmentSaveMode`) | `src/Configs/{Client}.json` |
| Mapbox style (streets vs satellite) | `src/Configs/{Client}.json` |
| Client logo | `src/Configs/{Client}.json` → references file in `public/Data/` |
| Boundary and building footprint GeoJSON | `src/Configs/geojson/` |
| Floor plan room geometry and metadata | `public/floorplans/{Campus}/` |
| Tenant URL aliases and JS feature flags | `src/tenants/registry.js` |

### Adding a new client (no component code changes needed)

1. Add entry to `src/tenants/registry.js` — id, aliases, feature flags
2. Create `src/Configs/{Client}.json` — map settings, feature flags, logo
3. Add boundary/building GeoJSON to `src/Configs/geojson/`
4. Upload floor plans to `public/floorplans/{Campus}/` if applicable
5. Deploy — the shared app picks up the new tenant automatically via the URL slug

---

## Technical Assessment System (deep detail)

This is the most complex feature. Understanding it prevents bugs.

### Save modes

Controlled by `technicalAssessmentSaveMode` in the client's JSON config:

- `"building"` — one Firestore doc per building, shared across all assessors. Last write wins. Used by Hastings.
- `"per-assessor"` — one Firestore doc per (building + assessor), keyed as `{buildingId}__{assessorKey}`. Assessors never overwrite each other. Used by Cherokee Mental Health.

### Firestore path

```
universities/{universityId}/buildingAssessments/{docId}
```

- Building mode: `docId` = `{buildingId}` (slashes replaced with `__`)
- Per-assessor mode: `docId` = `{buildingId}__{assessorKey}`

### The 3 assessment sections

Every building is scored across exactly 3 sections:

| Section key | Display label | Fields |
|---|---|---|
| `architecture` | Codes | exterior, entrances, interiorFinishes, lifeSafety, codesAndAccessibility |
| `engineering` | Engineering | superstructure, conveyingSystems, fireProtection, plumbing, mechanical, power, lighting |
| `functionality` | Functionality | fireAlarm, spaceSize, technology |

A section is considered "started" if any of its fields has a value > 0.

### Building color on the map

Color is driven by how many of the 3 sections have been started:

| Sections started | Color | Hex |
|---|---|---|
| 0 | Gray | `#6b7280` |
| 1 | Red | `#dc2626` |
| 2 | Orange | `#d97706` |
| 3 | Green | `#15803d` |

Logic lives in `StakeholderMap.jsx` around `progressColors` and `computeTechnicalProgressFromScores()`.

### Real-time color sync

Assessment data uses `onSnapshot` (Firestore real-time listener). When any assessor saves a building, all other connected users see the map color update immediately — no page refresh needed.

**This was not always the case.** Before 2026-06-17, the data was fetched once with `getDocs` and never updated until page reload. The fix replaced that with `onSnapshot` in a dedicated `useEffect`.

### Draft autosave

`AssessmentPanel.jsx` autosaves form state to `localStorage` every 900ms while the assessor is typing. Draft key format:

```
mf:technical-assessment-draft:{universityId}:{buildingId}:{draftOwnerKey}
```

On cloud save success, the local draft is deleted. On cloud save failure, the draft is kept. On panel open, any stored draft is restored automatically.

---

## Recent Changes (2026-08-04) — FLOOR_DRAWING_LAYER root cause found and fixed; Hastings schedule feature and Sarpy walls left as open items

### Summary

Long investigation session, mostly triggered by "walls/doors/stairs missing" reports on the live Hastings site. The eventual root cause was a genuinely subtle Mapbox GL style-spec violation that had been silently breaking wall/door/stair rendering for **every tenant** since 2026-08-03 — not a Hastings-specific bug, and not caused by anything from this session's own work. Two other threads (a Hastings AI-query feature restore, and a Sarpy walls re-enable) were also touched today but both ended the day reverted — see "Open items" below before assuming either is live.

### The FLOOR_DRAWING_LAYER bug — the big find

**Symptom:** No walls/doors/stairs rendering on any building, any tenant, confirmed via live browser inspection (not a caching issue — verified the live-served GeoJSON and live JS bundle both matched source exactly).

**Root cause:** `d3286f5` ("Keep Cherokee overlays aligned with floor adjustments", 2026-08-03) added a Cherokee-specific `line-width` variant to `FLOOR_DRAWING_LAYER`'s paint properties via a `case`/`__mfOverlayKind` check, but wrapped **two full `interpolate(['zoom'], ...)` expressions** as sibling `case` branches instead of branching only the numeric values:

```js
// BROKEN (introduced 2026-08-03, live until 2026-08-04):
'line-width': [
  'case', ['has', '__mfOverlayKind'],
  ['interpolate', ['linear'], ['zoom'], 16, 0.55, 18, 1.0, 20, 1.5],
  ['interpolate', ['linear'], ['zoom'], 16, 0.15, 18, 0.25, 20, 0.45]
],
```

Mapbox's style spec only allows **one** zoom-based `step`/`interpolate` subexpression per property — it precompiles a single interpolation table per property for performance, and having two (even as mutually-exclusive `case` branches) violates this. Critically, **Mapbox validates this at style-apply time and fires a silent `error` event on the map instance** rather than throwing a catchable JS exception — so the app's own code, and even our own `window.onerror`/`unhandledrejection` instrumentation, never saw it. `addLayer` appeared to succeed with no visible error; the layer simply never existed in the style afterward.

**How this was actually found:** static code reading and git archaeology (checking `unloadFloorplan`, layer z-order via `ensureLayerOrder`, the "layer already exists" theory, etc.) all produced plausible-sounding theories that didn't survive contact with live evidence. What actually worked was iterative live-browser instrumentation: finding the Mapbox `Map` instance via a React-fiber walk from the DOM (`window.__debugMap`), then wrapping `addLayer`/`removeLayer`/`addSource`/`setStyle` to trace the real call sequence, and finally attaching `map.on('error', ...)` — which is what surfaced the actual Mapbox validation error message verbatim: `"layers.floor-drawing.paint.line-width: Only one zoom-based 'step' or 'interpolate' subexpression may be used in an expression."` **Lesson for next time:** Mapbox style errors are invisible to standard JS error handling; if a layer "adds successfully" but never renders, check `map.on('error', ...)` before anything else.

**Fix (`c1b883c`):** restructure to a single outer `interpolate`, with `case` only branching the numeric value at each zoom stop:
```js
'line-width': [
  'interpolate', ['linear'], ['zoom'],
  16, ['case', ['has', '__mfOverlayKind'], 0.55, 0.15],
  18, ['case', ['has', '__mfOverlayKind'], 1.0, 0.25],
  20, ['case', ['has', '__mfOverlayKind'], 1.5, 0.45]
],
```
`line-color` and `line-opacity` on the same layer used the identical `case`/`__mfOverlayKind` pattern but were **not** affected — neither branch of either property contains a zoom expression, so only `line-width` was ever invalid.

**Confirmed fixed for Hastings** (live-tested by user, hard refresh). **Cherokee's doors/stairs remain unresolved** as of end of session — see open items.

### Hastings AI schedule-query feature — restored, then reverted (currently NOT live)

Separately, discovered that `6e6dd3e` ("Hotfix feature branch StakeholderMap routing", 2026-07-29 — the same mass-rewrite commit responsible for most of today's other findings, see below) had deleted the entire `scheduledAvailabilityRequest` AI query handler (the "what classrooms are free Tuesday at 2pm" feature, including Block 1/Block 2 session filtering) as collateral damage, along with its full helper cluster (`extractScheduledClassroomAvailabilityRequest`, `parseScheduleQueryTimeToMinutes`, `buildScheduledAvailabilityRows`, `buildScheduleSnapshotForMoment`, `isScheduleEntryActiveForMoment`). This had been silently missing from every deploy since Jul 29.

Restored cleanly in `d5e7693` (202 lines, pure additions, verified byte-identical to the pre-`6e6dd3e` implementation, build-tested). **Then reverted in `0555df3`** after a live report that Hastings walls/doors/stairs were broken — which seemed plausible at the time given the timing, but was later conclusively proven unrelated (the real cause was the `FLOOR_DRAWING_LAYER` bug above, confirmed still broken on `ab0ea01`, a commit that predates `d5e7693` entirely). The revert was reasonable given the information available in the moment (a live regression report during active client concern), but the feature was never re-restored afterward.

**Open item:** `scheduledAvailabilityRequest` and its helper cluster are currently **absent from production** (confirmed 0 occurrences as of `a003114`). Restoring it again should be safe and low-risk — re-apply the change from `d5e7693` (or `git revert 0555df3`) once there's no active demo/deploy sensitivity. No further investigation needed, just re-application.

### Sarpy walls — enabled, then reverted for a client demo (currently rooms-only, matches pre-session state)

Separately from the `FLOOR_DRAWING_LAYER` bug: Sarpy walls render through a completely different, older mechanism (`tryLoadWallsOverlay` / `WALLS_LAYER`, not `FLOOR_DRAWING_LAYER`), which turned out to have its own, unrelated structural problem — also introduced by `6e6dd3e`:

- `ENABLE_WALLS_OVERLAY` has been hardcoded `false` since `9f15090` (2026-02-06).
- A workaround auto-detect call site (added `2fd0a39`, 2026-06-22) used to bypass that flag for tenants with a companion `Walls.geojson` file — this is what actually made Sarpy walls work historically.
- `6e6dd3e` (2026-07-29) deleted that auto-detect call site, leaving `tryLoadWallsOverlay` completely unreachable for Sarpy from that date forward, despite valid wall data existing on disk and `WALLS_LAYER`'s own paint block being clean (no interpolate bug — checked directly, confirmed fine).

Applied a scoped fix in `ce23993` (`isSarpyCountyInstance` gate, Hastings/Cherokee unaffected) that made `tryLoadWallsOverlay` reachable again for Sarpy. However, further investigation found that the **floor-adjust replay mechanism for walls is also gone**, entirely separate from the reachability issue:

1. **Live drag doesn't sync walls.** The rotate/move drag handler (`onMouseMove` in the Adjust Floorplan tool) only calls `.setData()` on `FLOOR_SOURCE` (rooms) — `WALLS_SOURCE` is never touched during a drag. Confirmed via direct code read: `WALLS_SOURCE` has exactly 4 references in the whole file (declaration + its own load/cleanup), none in any drag handler.
2. **The `georeferenced` flag mechanism no longer exists anywhere.** `grep -c "georeferenced"` across the entire file returns 0. This was the flag (see the 2026-07-02/07-06/07-07 sections above) that gated whether a saved floor adjustment was safe to replay on top of an already-correctly-positioned Sarpy floor — `6e6dd3e` deleted all 13 occurrences that existed in its parent commit.
3. **`tryLoadWallsOverlay` itself can no longer accept a floor adjustment even in principle.** Its signature dropped the `floorAdjust`/`overlayFloorAdjust` parameters entirely: pre-`6e6dd3e` it was `async function tryLoadWallsOverlay({ ..., wallsRawFCRef, floorAdjust, overlayFloorAdjust = null })`; today it's `async function tryLoadWallsOverlay({ basePath, floorId, map, roomsFC, affine, rotationOverride, fitTransform })` — no adjustment-related parameters, no references to either in the body.

Net effect: enabling Sarpy walls today would have looked fine for buildings nobody adjusts, but any live use of the Adjust Floorplan tool on a Sarpy building would visibly desync walls from rooms during the drag, and the correction would not persist for walls on reload (rooms would show the fix, walls would silently revert every time). Given a client demo the next day, **reverted `ce23993` via `a003114`** — Sarpy is back to rooms-only, matching what was reliably working before this session. `FLOOR_DRAWING_LAYER`'s fix (Hastings/Cherokee) was not touched by this revert.

**Open item for next session:** re-enabling Sarpy walls properly needs three things rebuilt, all removed by `6e6dd3e`:
- Wire the rotate/move drag handler to also update `WALLS_SOURCE` in real time (mirror whatever transform is applied to `FLOOR_SOURCE`).
- Restore a `georeferenced`-equivalent flag (or design a replacement) so a saved adjustment can be told apart from an already-correct georeferenced floor.
- Re-add `floorAdjust`/`overlayFloorAdjust` parameters to `tryLoadWallsOverlay` and apply them on load, mirroring the pattern `tryLoadDoorsOverlay`/`tryLoadStairsOverlay` already have via `overlayFloorAdjust`.

This is a real feature-restoration task, not a one-line fix — budget accordingly.

### The common thread: `6e6dd3e` did far more collateral damage than its commit message suggests

Every open/closed item in this session traces back to `6e6dd3e` ("Hotfix feature branch StakeholderMap routing", 2026-07-29, 2,914 deletions / 1,359 insertions in one commit): the deleted Hastings `scheduledAvailabilityRequest` feature, the deleted Sarpy walls auto-detect call site, the deleted `georeferenced` flag mechanism, and the deleted `floorAdjust` plumbing in `tryLoadWallsOverlay` were all removed in that single commit, apparently as unintentional side effects of a broader rewrite rather than deliberate changes. If something else "used to work" and mysteriously doesn't, checking whether `6e6dd3e` touched it is a good first move — `git log -S"<symbol name>" origin/feature/multi-university-refactor -- src/components/StakeholderMap.jsx` is the fastest way to check.

### Current status (end of session, `a003114`)

| Item | Status |
|---|---|
| `FLOOR_DRAWING_LAYER` double-interpolate bug | ✅ Fixed (`c1b883c`), confirmed live for Hastings |
| Cherokee doors/stairs via shared linework | ⚠️ Still not rendering post-fix; data/filter/render-level checks all passed, cause not yet found — see live-instrumentation scripts used this session if picking this back up |
| Hastings `scheduledAvailabilityRequest` AI feature | ❌ Currently absent from production (reverted, not re-applied) — safe to restore, no investigation needed |
| Sarpy walls overlay | ❌ Currently disabled (reverted for demo safety) — needs the 3-part floor-adjust-replay rebuild described above before re-enabling |

---

## Recent Changes (2026-07-15) - Hastings client role QA flow hardened

### Summary

Follow-up on the Hastings client rollout. The secure client workspace is now much closer to operator-ready: the route/role plumbing was tightened so Hastings aliases resolve to one canonical tenant workspace, room-edit save feedback is clearer for client users, and the repo now has repeatable automated and manual QA coverage for the new `viewer` / `editor` / `admin` model.

### What changed

- **Canonical tenant resolution for secure routes (`8ee6464`)**
  - Added `getTenantId(...)` in `src/tenants/registry.js`.
  - `src/App.jsx` now passes the canonical tenant id into the secure gate and page loaders instead of trusting the raw URL slug.
  - Practical effect: `/hastings/client` and `/hastings-demo/client` now read the same Firestore role docs and nested room data under `universities/hastings/...` instead of risking alias-split behavior.

- **Client room-edit save feedback hardened (`8ee6464`)**
  - The shared room-edit modal in `src/components/StakeholderMap.jsx` now distinguishes three cases correctly:
    - no-op edit (nothing changed)
    - full save failure
    - partial success where some selected rooms saved and others failed
  - This fixes the prior confusing fallback where failed saves could surface as the misleading `No changes detected` message.

- **Automated Hastings client smoke coverage expanded (`8ee6464`)**
  - `scripts/smoke-check.mjs` was extended from the older admin/engagement checks to cover:
    - `/:universityId/client` route presence
    - canonical tenant id wiring
    - Hastings tenant flags / config flags
    - secure gate copy for signed-out and unauthorized users
    - shared client header summaries for `viewer` and `editor`
    - room-edit permission gates
    - Firestore rule helper presence for `viewer` / `editor` / `admin`
  - Current result after the Hastings updates: **`62/62` checks passed** via `node scripts/smoke-check.mjs`.

- **Manual operator QA docs added (`8ee6464`)**
  - Added `docs/HASTINGS_CLIENT_ROLE_QA_RUNBOOK.md` with a live browser test script for:
    - signed-out access
    - Hastings `viewer`
    - Hastings `editor`
    - Hastings `admin`
    - alias consistency between `/hastings/client` and `/hastings-demo/client`
    - safe rollback of the temporary room-edit test
  - Refreshed `docs/HASTINGS_PRE_RELEASE_CHECKLIST.md` so it now matches the actual client rollout shape instead of the older admin-only pre-release matrix.

### Deployment / QA note

- GitHub Pages deploy workflow currently triggers on pushes to both:
  - `main`
  - `feature/multi-university-refactor`
- The workflow still deploys to the single GitHub Pages environment, so **pushes from the feature branch are effectively production-facing for the public Pages URL** unless the workflow strategy changes later.
- That means the remaining browser-only role-matrix QA in `docs/HASTINGS_CLIENT_ROLE_QA_RUNBOOK.md` should be treated as a live-environment check, not a harmless preview-only pass.

### Current status

- Code-side Hastings client guardrails are in place.
- Automated smoke coverage for the Hastings client route/role model is passing.
- The remaining blocker is **real browser QA with actual Hastings `viewer`, `editor`, and `admin` accounts** to confirm live Google sign-in, room-edit save behavior, alias consistency, and admin-route separation end to end.

---
## Recent Changes (2026-07-14) - Sarpy floorplan intake wrapped up for current export set

### Summary

Finished the current batch of Sarpy County floorplan imports and verified the safe intake pattern for already-georeferenced Revit exports. The key lesson from this run: when the raw export is already in real Nebraska lon/lat, run scripts/optimize-sarpy-export.cjs without --building.

Using --building on these corrected exports can create a coordinate-space mismatch: rooms stay in their raw georeferenced coordinates, while walls/drawing features get re-fit to the GIS footprint bbox. That is what caused the brief Sheriff's Garage rooms-vs-walls separation during troubleshooting. Re-running the optimizer without --building restored alignment immediately.

### Buildings added in this run

| Commit | Building | Notes |
|---|---|---|
| 4970c9b | Sheriff's Garage | Initial import. |
| c6d6423 | Sheriff's Garage | Replaced walls file after confirming the correct no---building flow. User later confirmed the remaining issue was only footprint placement, not rooms/walls drift. |
| fda5c8 | Springfield Shop | Added and verified. |
| 32d4ade | Public Works Fleet | Added and verified. |
| 29d018 | Bellevue Shop | Added and verified. |
| 763d71 | Gretna Shop | Added and verified; includes LEVEL_1 and LEVEL_2. |

### Safe Sarpy intake workflow (current best practice)

1. Confirm the raw top-level room GeoJSON is already real-world lon/lat in the Sarpy area (roughly -96.x, 41.1x), not small local Revit coordinates.
2. Confirm the raw export keeps rooms and drawings together internally:
   - inspect feature counts in LEVEL_*_Dept_Rooms.geojson
   - confirm room bbox and drawing bbox are in the same neighborhood
3. Run:

`powershell
node scripts/optimize-sarpy-export.cjs --src "C:\temp\Sarpy\{Building Name}" --dst "public/floorplans/SarpyCounty/{Building Name}"
`

Do not pass --building for these georeferenced exports.

4. Verify output alignment:
   - Rooms/LEVEL_*_Dept_Rooms.geojson bbox and LEVEL_*_Walls.geojson bbox should be nearly identical
   - if they are aligned with each other but offset from the GIS footprint, that is a placement issue, not an export corruption issue
5. Add the building to BUILDINGS_LIST in src/components/StakeholderMap.jsx
6. Add manifest.json with the exported floor list
7. Push to eature/multi-university-refactor, wait for GitHub Pages deploy, and test live
8. If the whole floorplan group is offset from the traced footprint, use Adjust Floorplan to place it; then hard refresh and confirm the saved adjust persists

### Current status

- All Sarpy buildings that currently have floorplans available from the user are now in the repo.
- Recent additions from this run:
  - Sheriff's Garage
  - Springfield Shop
  - Public Works Fleet
  - Bellevue Shop
  - Gretna Shop
- Gretna Shop is the only new multi-floor building in this batch (LEVEL_1, LEVEL_2).
- For Bellevue Shop and Gretna Shop, the raw exports sit somewhat northwest of the GIS footprints, but rooms/walls/doors stayed internally aligned after optimization. Treat those as floor-adjust placement steps, not export-pipeline failures.

---
## Recent Changes (2026-07-13) — Sarpy Airtable room-edit save 404 fixed

### Summary

Sarpy room edits were saving from the map UI but failing on the Airtable write-back fallback with `Airtable update by roomId failed 404 {"ok":false,"error":"Room not found"}`. Hastings did not reproduce it because its Airtable base/view exposes the broader set of candidate field names the shared lookup logic expected.

Root cause was in `ai-server/server.js`: the PATCH `/api/rooms` room-lookup fallback builds `filterByFormula` expressions across multiple possible room/building/floor field names. In Sarpy's Airtable base/view, some of those candidate fields do not exist. Airtable rejects the whole formula when even one referenced field name is unknown, so the lookup returned no records and the server surfaced a false 404 `Room not found`.

**Fix (`bf06833` on `feature/multi-university-refactor`, equivalent `6568fa2` on `main`):**
- Added in-memory fallback helpers in `ai-server/server.js`:
  - `getComparableFieldValues(...)`
  - `recordMatchesFieldCandidates(...)`
  - `filterAirtableRecordsByLookup(...)`
- When formula-based lookup fails because Airtable reports unknown field names, the server now fetches records from the active view and matches them in memory across `roomId`, `roomNumber`, and `roomGuid`, then optionally narrows by building/floor.
- This keeps the shared multi-candidate lookup behavior, but removes Sarpy's hard dependency on every Hastings-style field existing in the target Airtable base.

### Deployment / verification

- Sarpy's Render AI service is `https://mapfluence-sarpy-ai.onrender.com`.
- The live Sarpy AI service deploys from `feature/multi-university-refactor`, not `main`.
- The successful live Render deploy was commit `bf06833` (`Fix Sarpy Airtable room lookup fallback`).
- The equivalent `main` commit `6568fa2` exists, but it is not what Sarpy Render is serving today.
- User verification after the Render deploy: edited Sarpy rooms saved through to Airtable successfully.
- If this regresses, check `https://mapfluence-sarpy-ai.onrender.com/health` first and confirm the reported `commit` matches the expected backend revision.

---

## Recent Changes (2026-07-02) — Sarpy re-exports + Sheriff's Office corrupt-geometry fix

### Summary

Re-optimized five Sarpy County buildings against fresh Revit exports (Administration/Courthouse, 1246 Building, Juvenile Justice Center, Sheriff's Office — all real-world WGS84 lon/lat, no `affine.json`, same pattern as 1102 Building post-`732b643`). Room counts held steady across all of them, confirming the re-exports were geometry/attribute refreshes, not structural changes.

Sheriff's Office was then reported with visibly offset line work after the first re-export. Investigation found 2 drawing features — `A-GLAZ-CURT` and `A-GLAZ-CWMG`, both `GeometryCollection` curtain-wall/glazing geometry — exported with corrupt coordinates spanning tens of degrees of lon/lat (bbox stretched from Nebraska to British Columbia: `[-122.66, 41.09, -96.04, 58.53]`) instead of the building's real ~0.001-degree footprint. The other 2632 drawing features and all 170 rooms were correctly clustered. These 2 garbage features were dwarfing the real walls and blowing out the map's fit-to-bounds — this is what read as "offset."

**Fix (`6b8cf59`):** added `filterOutlierDrawingFeatures()` to `scripts/optimize-sarpy-export.cjs`. It compares each drawing feature's bbox (via a new `featureBbox()` helper that, unlike the pre-existing `bboxFromFeatures()`, also walks `GeometryCollection.geometries` — `bboxFromFeatures()` only reads `f.geometry.coordinates` and silently skips GeometryCollections, which is why the first filter attempt logged 0 drops) against the rooms bbox, with a margin of `20 × max(roomsWidth, roomsHeight)`. Anything farther out is dropped and logged. Margin scales with the rooms bbox itself, so it works whether rooms are in lon/lat degrees or Revit local feet, without hardcoding a unit-specific threshold. Re-ran all 5 current exports afterward to confirm it only caught the 2 Sheriff's Office features and didn't false-positive on the others (all had walls bbox spans of 0.0002–0.002°, comfortably inside the margin).

This filter is now a permanent step in every future `optimize-sarpy-export.cjs` run — no per-building opt-in needed.

---

## Recent Changes (2026-07-01) — 1102 Building georeferenced-rooms regression

### Summary

Commit `732b643` (same day, earlier) switched `script.py` to export 1102 Building rooms as real-world WGS84 lon/lat directly (via `SiteLocation`/`ProjectPosition`), removing the need for a per-building `affine.json`, and deleted the stale `affine.json` from the public floorplan folder. This broke floor alignment: `shouldFitFloorplanToBuilding` kept rescaling/repositioning the now-correctly-placed rooms onto the building footprint bbox, because the only place that sets `__mfGeoreferenced` (`applyAffineIfPresent`) requires an `affine` object — which no longer exists for this building by design. Fixing this took several passes; each is captured below because the root causes were layered, not a single bug.

| Commit | What changed and why |
|---|---|
| `2c898b3` | Added `'1102_building/level_1'` to `FLOORPLAN_NO_FIT` as an immediate unblock, and added `isFloorAlreadyGeoreferenced(roomsFC, basePath, floorId)` — a general fix that infers georeferencing (sets `fc.__mfGeoreferenced = true`) when rooms are already lon/lat **and** the paired `LEVEL_N_Walls.geojson` for the same floor is also lon/lat, corroborating a genuinely calibrated export rather than coincidentally small numbers. |
| `725e3b3` | Found the allowlist entry wasn't actually the problem — the key math (`canon('1102 Building')` + `fId('LEVEL_1')` = `1102_building/level_1`) was correct all along. The real gap: `__mfNoFit`/`__mfGeoreferenced` only guarded the `shouldFitFloorplanToBuilding` branch inside `loadFloorGeojson`'s fit block. The sibling `fitLocalFloorplanToBuilding` branch (taken when `!isLikelyLonLat(fc)`) had no flag check of its own. Wrapped both branches in a single `if (fc.__mfGeoreferenced \|\| fc.__mfNoFit) { /* skip */ } else if (...) {...} else {...}`. |
| `b429bb2` | Requested fix was `if (universityId && canon(universityId) === 'sarpy_county') return false;` at the top of `shouldFitFloorplanToBuilding` — but that's a module-level function with no `universityId` in scope; it would've thrown `ReferenceError` on every call, for every tenant, silently swallowed by the caller's `try/catch`, breaking building-fit everywhere. Used `floorBasePath` instead (in scope at the call site, literally contains `SarpyCounty` for this campus) threaded through as an `isSarpyCounty` option. |
| `fd8a1dd` | Added temporary `console.log('[fit] ...')` diagnostics (still in the code as of this writing — inside `shouldFitFloorplanToBuilding` and at its call site) after the guard appeared not to fire. **These logs never printing turned out to be expected**, not a bug: they sit inside the `else` branch of the guard added in `725e3b3`, and since `__mfNoFit` is `true` for this building/floor, execution takes the empty first branch and never reaches them. |
| `994a06f` | Real root cause of "works on first load in incognito, breaks on reload": `floorAdjust` (manual rotate/scale/nudge, saved via the floor-panel alignment tools) is persisted in `window.localStorage` — not the in-memory `floorCache`/`floorTransformCache`, which reset on reload — keyed per building+floor / URL / basePath+floor (`loadFloorAdjust`, `loadFloorAdjustByUrl`, `loadFloorAdjustByBasePath`). It was reapplied unconditionally at the end of `loadFloorGeojson`, regardless of georeferenced state. A stale adjustment saved before the WGS84 re-export got reapplied on top of already-correct coordinates on every normal reload. Incognito starts with empty `localStorage`, so the bug never showed there. Fixed: `if (floorAdjust && !fc.__mfGeoreferenced) {...}`. |
| `6886417` | `__mfNoFit` (set unconditionally via the allowlist) and `__mfGeoreferenced` (set only if the *async* `isFloorAlreadyGeoreferenced` walls-file fetch succeeds) are independent signals — the `994a06f` guard only checked the latter. Extended to `if (floorAdjust && !fc.__mfGeoreferenced && !fc.__mfNoFit) {...}` so a walls-file corroboration hiccup can't leave the door open. |
| `1b36d51` | Removed the temporary `[fit]` diagnostic `console.log` calls from `fd8a1dd` now that the root cause is confirmed fixed. |

**Confirmed working after `6886417`.**

### GitHub Actions deploy gotchas discovered this session

- `.github/workflows/deploy.yml`'s `push` trigger has a `paths` filter (`src/**`, `public/**`, `index.html`, `vite.config.js`, `package.json`, `package-lock.json`, `.github/workflows/deploy.yml`). **An empty commit (`git commit --allow-empty`) matches none of these paths and will not trigger a build at all.** Use the `workflow_dispatch` "Run workflow" button in the Actions tab instead, or touch a file under a matched path.
- The workflow's `concurrency` block is `{ group: "pages", cancel-in-progress: false }`. A stuck/hung run is **not** replaced by a new push — the new run queues behind it. Cancel the stuck run manually (Actions tab → the run → Cancel workflow) before expecting a fresh push or dispatch to actually execute promptly.
- No `gh` CLI or `GITHUB_TOKEN`/`GH_TOKEN` is available in the assistant's shell environment in this session — cancelling runs or dispatching workflows programmatically isn't possible from here; both require the GitHub web UI.

---

## Recent Changes (2026-06-30)

| Commit | What changed |
|---|---|
| `9cfd0e0` | **Park Sarpy walls overlay** — set `enableWallsOverlay: false` in `SarpyCounty.json`. Suppresses `tryLoadWallsOverlay` for all Sarpy buildings. Walls work is parked until Sarpy Revit models are georeferenced (see 2026-06-29 section below). |

### Export Adjusts vs affine.json — clarification

The **Export Adjusts Backup** button (in the floor panel, admin-only) exports a browser localStorage dump. It is **not** compatible with `affine.json`. They are two separate systems:

| | `affine.json` | Export Adjusts backup |
|---|---|---|
| **Purpose** | Base transform: Revit feet → geographic lon/lat | Post-hoc fine-tuning on top of an already-positioned floor plan |
| **Units** | `scale_deg_per_foot`, `anchor_feet` (Revit space) | `translateMeters`, `rotationDeg`, `scale` multiplier, `translateLngLat` |
| **Applied when** | At fetch time in `loadAffineJson()` | After the floor plan is positioned, as an interactive tweak |
| **Stored** | Static file on disk per-building in `public/floorplans/` | `localStorage` under `mfFloorAdjust:`, `mfFloorAdjustUrl:`, `mfFloorAdjustFloor:` prefixes |

The backup file (`exportFloorAdjustBackup`, line 18073 in `StakeholderMap.jsx`) wraps all matching localStorage entries in:
```json
{ "kind": "mapfluence-floor-adjustments", "version": 1, "universityId": "...", "entries": [...] }
```

You cannot derive an `affine.json` from an Export Adjusts backup — the backup encodes geographic delta adjustments, not the raw Revit coordinate transform.

---

## Recent Changes (2026-06-29) — Sarpy walls overlay overhaul

### Summary

Spent the session trying to get walls + drawing features (furniture, glazing, casework, fixtures) to render correctly on Sarpy floor plans. The root problem is that Sarpy Revit models are not georeferenced — PyRevit exports in Revit internal coordinates (local feet, e.g. `[121, -75]`), not real-world lon/lat. Every runtime transform attempt is an approximation. **Walls alignment is parked until the Revit models are georeferenced** (see long-term fix below).

### What was done

| Commit | What changed |
|---|---|
| `bf84d38` | Narrowed `WALL_LAYERS` in `optimize-sarpy-export.cjs` to only `A-WALL`/`I-WALL`. Previously all drawing layers (doors, glazing, furniture, stairs) were routed to the walls file, leaving rooms files with 0 drawing features. |
| `bff416d` | Moved ALL `type === 'drawing'` features to the companion `LEVEL_N_Walls.geojson` file (not just walls). Rooms files now contain room polygons only. All drawing features are pre-transformed to lon/lat using the offline localPlanarFit. |
| `8316a63` | Added early-exit to `tryLoadWallsOverlay`: if `isLikelyLonLat(fc)` is true immediately after fetch, skip all runtime transforms (affine, Path A/B/C, `applyFloorplanOverlayTransform`) and go straight to `addSource`/`addLayer`. |
| `d52d848` | Added `toLineGeometry`/`toLineFC` to `optimize-sarpy-export.cjs`. Drawing features export as MultiPolygon (furniture, casework, fixtures) but the Mapbox `walls-layer` is `type: "line"` — those features were silently skipped. Converts: MultiPolygon → exterior-ring MultiLineString, Polygon → LineString, GeometryCollection → flattened MultiLineString. |
| `f675a71` | Diagnostic log: `[walls] raw first coord after ensureFeatureCollection` to see exactly what coordinate `tryLoadWallsOverlay` receives before any transform. |
| `972cf05` | **Root cause fix**: `applyLocalPlanarFitToFC` checks `f.geometry.coordinates` to decide whether to transform a feature. `GeometryCollection` has `.geometries` not `.coordinates`, so those 10 features were returned untransformed in Revit space. After `toLineFC` extracted their coordinates, Revit X values like 282 ft were written to the walls file alongside lon/lat coordinates. `turf.bbox` then saw `maxX=282 > 180°`, `isLikelyLonLat` correctly returned false, the early-exit missed, and Path A applied a second runtime transform — causing a **51.9m shift** on all walls/drawings. Fix: run `toLineFC` before `applyLocalPlanarFitToFC` so all features are MultiLineString/LineString with `.coordinates` before the transform runs. |

### What failed and why

- **Drawing features in rooms file (Revit space)**: After the first WALL_LAYERS fix (`bf84d38`), non-wall drawings were left in the rooms GeoJSON in Revit local coordinates. The app applies no transform to features in the main rooms file — they rendered ~100 ft from Nebraska. Fixed by moving all drawings to the companion file (`bff416d`).

- **`isLikelyLonLat` returning false despite lon/lat content**: The walls file was confirmed in lon/lat by `node` inspection (`[-96.026583, 41.158152]`), but `turf.bbox` returned `maxX=282` because 10 `GeometryCollection` features bypassed the transform. `isLikelyLonLat` requires `maxX ≤ 180`, so it correctly rejected the file. The early-exit never fired, Path A ran, and walls were shifted 51.9m. Fixed in `972cf05`.

- **Path A diagnostic confusion**: `[walls] Path A: localCenterFrom=[121.33, -75.60]` was visible in console. `localCenterFrom` comes from `fitTransform` (the rooms fit in Revit space) — it does not reflect the walls file coordinates. This is normal when Path A runs; the 51.9m shift was Path A applying a Revit→lon/lat transform on top of already-lon/lat walls coordinates.

- **Diagnostic log obscured by build cache**: Several iterations appeared to "not take effect" because the deployed bundle hash changed but the walls GeoJSON was still browser-cached. Always hard-refresh (Ctrl+Shift+R) or test in incognito when debugging coordinate transforms.

### Current state of walls files

All six walls/drawings files are in lon/lat, all geometry normalized to MultiLineString/LineString:

| Building | File | Features | Size |
|---|---|---|---|
| 1102 Building | `LEVEL_1_Walls.geojson` | 2742 | 2.8 MB |
| Sheriff's Office | `LEVEL_1_Walls.geojson` | 2632 | 9.6 MB |
| Juvenile Justice Center | `LEVEL_1_Walls.geojson` | 2086 | 4.7 MB |
| 1246 Building | `LEVEL_1_Walls.geojson` | 760 | 1.7 MB |
| Admin/Courthouse | `BASEMENT_Walls.geojson` | 1871 | 1.9 MB |
| Admin/Courthouse | `LEVEL_1_Walls.geojson` | 7761 | 12.2 MB |

The `optimize-sarpy-export.cjs` script does the following for each building:
1. Splits features: rooms → `Rooms/LEVEL_N_Dept_Rooms.geojson`, drawings → walls companion
2. Runs `toLineFC` on drawings (normalize geometry)
3. Runs `computeLocalPlanarFit` using IQR-clipped room centroids → building footprint center
4. Applies `applyLocalPlanarFitToFC` (scale + translate, no rotation)
5. Writes walls companion in lon/lat

### Long-term fix: georeference the Sarpy Revit models

The offline fit is a best approximation. It maps the IQR-clipped rooms centroid to the building footprint center using a single scale factor. There is no rotation, and the building footprint polygons in `SarpyCounty_Buildings.json` are manually traced — not survey-accurate. The result is close (~5–50m depending on building) but not architecturally aligned.

**The correct fix**: georeference each Sarpy Revit model by setting the Survey Point to the building's real-world coordinates (Nebraska State Plane or WGS84). Then update the PyRevit export script to use `SharedCoordinates` instead of `InternalOrigin` when computing geometry. The exported GeoJSON would then contain actual lon/lat coordinates and the entire offline-transform pipeline in `optimize-sarpy-export.cjs` becomes unnecessary.

Until georeferencing is done, walls alignment will remain approximate. Do not spend more time tuning the runtime transform or offline fit — the fundamental input data (Revit internal coordinates with no real-world anchor) cannot be made more accurate without this change.

### Other 404s noted (not addressed)

- `public/icons/door-swing.png` and `public/icons/stairs-run.png` — PNG files missing from repo. Need the actual image assets committed to `public/icons/`.
- `affine.json` 404s for Sarpy buildings — expected. Sarpy uses `fitLocalFloorplanToBuilding` at runtime; no `affine.json` is generated or needed.

---

## Recent Changes (2026-06-25)

| Commit | What changed and why |
|---|---|
| `a7dbb02` | **Fix `tryLoadWallsOverlay` call site 1 fitTransform fallback** — call site 1 (the `enableWalls` branch) was passing a plain `fitTransform` shorthand with no fallback; changed to `fitTransform: fitTransform \|\| cachedTransform?.fitTransform \|\| null` to match call site 2. |
| `97756f6` | **Fix walls layer order** — `ensureLayerOrder` was calling `map.moveLayer(WALLS_LAYER, FLOOR_FILL_ID)` which placed walls *below* room fills, making them invisible. Changed to `map.moveLayer(WALLS_LAYER, FLOOR_LINE_ID)` so walls render above fills but below room outlines. |
| `34ceee6` | **Debug logging (temporary, now removed)** — added `[rooms transform]` / `[walls transform]` / raw-coord logs to diagnose walls offset. Confirmed affine is null for both; root cause was coordinate-space mismatch (see below). |
| `latest` | **Fix walls coordinate-space mismatch in `tryLoadWallsOverlay`** — buildings without an `affine.json` (e.g. Sarpy 1102 Building) have pre-optimized room GeoJSON already in lon/lat. The rooms pipeline takes the geographic fine-tune path (`fitFloorplanToBuilding`) and stores a `fitTransform` with turf geographic ops (rotate/translate/scale). When that same `fitTransform` was applied to the raw Revit walls file (local coordinate space, not lon/lat), it produced garbage output (bbox `[-223, -89, -72, 83]`). Fix: when `!isLikelyLonLat(fc) && !affine && roomsFC` is available, call `fitLocalFloorplanToBuilding(fc, turf.envelope(roomsFC))` to map walls directly into the rooms' already-positioned lon/lat bbox, then set `fitTransform = null` so the geographic fine-tune is not applied on top. Mirrors the rooms Path-1 pipeline (line 5379) but uses the positioned roomsFC extent as the target instead of a campus building polygon. |

### Walls transform pipeline — two paths

`tryLoadWallsOverlay` now handles three coordinate-space cases in order:

1. **Has affine + not lon/lat** → `applyAffineTransform` → `applyFloorplanOverlayTransform` (existing)
2. **No affine + not lon/lat + roomsFC available** → `fitLocalFloorplanToBuilding(fc, turf.envelope(roomsFC))` then `fitTransform = null` → `applyFloorplanOverlayTransform` with no-op (new)
3. **Already lon/lat** → affine skipped, local fit skipped → `applyFloorplanOverlayTransform` for fine-tuning (existing)

---

## Recent Changes (2026-06-23)

| Commit | What changed and why |
|---|---|
| `bfd6afe` | **Sheriff's Office floorplan added** — `public/floorplans/SarpyCounty/Sheriff's Office/Rooms/LEVEL_1_Dept_Rooms.geojson` + `manifest.json`. 41 MB Revit GeoJSON filtered to 170 room features (compact JSON, 6-decimal coordinates), output 100 KB. Registered in `BUILDINGS_LIST`. |
| `bfee11d` | **Sheriff's Office re-export: NCES_Seat Count fix confirmed** — PyRevit script now uses `get_param_by_name()` (see below). Room 1102 confirmed at Seat Count 42. GeoJSON re-optimized. Airtable: 170 records patched (12 Seat Count values written, 158 cleared to null). |
| `13eee58` | **Courthouse re-export + basement added** — Both floors re-exported with fixed PyRevit script. BASEMENT added for the first time: 117 rooms. Level 1: 454 rooms. Airtable: 441 patched, 130 created (117 basement new, 13 Level 1 re-keyed). Seat Count: 10 rooms. Workstations: 183. |
| `c146239` | **JJC re-export** — 137 rooms, 19 MB → 83 KB. Airtable: 137 patched. Seat Count: 12 rooms. Workstations: 24. |
| `f3d7c79` | **1102 Building re-export** — 192 rooms, 11 MB → 119 KB. First building with NCES_Occupancy Status data: 25 rooms Vacant. Airtable: 192 patched. Seat Count: 4 rooms. Workstations: 117. |

### PyRevit export script fixes (`scripts/script.py` + live copy)

Two bugs fixed where `LookupParameter(name)` returned `None` for NCES-prefixed parameters defined on a non-Room Revit category. Root cause: `LookupParameter` only finds parameters bound to the element's own category; `GetParameters` searches all bindings.

**New helpers added** (between `get_param_any` and `get_first_prop`):

```python
def get_param_value(p):
    try:
        if p.StorageType == StorageType.String:  return p.AsString() or ""
        if p.StorageType == StorageType.Integer: return str(p.AsInteger())
        if p.StorageType == StorageType.Double:  return str(p.AsDouble())
        if p.StorageType == StorageType.ElementId:
            ref = doc.GetElement(p.AsElementId())
            return ref.Name if ref else ""
    except: pass
    return ""

def get_param_by_name(elem, pname):
    params = elem.GetParameters(pname)
    if params:
        return get_param_value(params[0])
    return ""
```

**Props block — two lines changed:**

```python
# Occupancy Status: now uses get_param_by_name (was get_param_any → returned "" for all rooms)
_occ_raw = get_param_by_name(r, "NCES_Occupancy Status") or get_param_any(r, "Occupancy Status")

# Seat Count: now uses get_param_by_name (was get_param_any → returned "" for all rooms)
"Seat Count": get_param_by_name(r, "NCES_Seat Count") or get_param_any(r, "Seat Count"),
```

`Workstations` (`get_param_any(r, "NCES_Workstations")`) was already working — left unchanged.

Occupancy Status logic: null/blank → `occupancyStatus` defaults to `"Occupied"`. Only rooms explicitly tagged `"Vacant"` in Revit export non-default values. 1102 Building confirmed: 25 rooms Vacant, 167 Occupied.

### Airtable sync results — all 4 Sarpy buildings (2026-06-23)

All buildings re-exported from Revit and re-synced to Airtable after script fixes. CSV generation for multi-floor buildings (Courthouse) done via inline Node.js merging both GeoJSONs; single-floor buildings use `scripts/geojson_to_airtable_csv.cjs`.

| Building | Rooms | Seat Count rooms | Workstations rooms | Vacant rooms | Airtable result |
|---|---|---|---|---|---|
| Sheriff's Office | 170 | 12 | 79 | 0 | 170 patched |
| Administration Courthouse | 571 (BASEMENT + L1) | 10 | 183 | 0 | 441 patched + 130 created |
| Juvenile Justice Center | 137 | 12 | 24 | 0 | 137 patched |
| 1102 Building | 192 | 4 | 117 | 25 | 192 patched |

Excel exports used: Sheriff's Office `Sarpy_MP_NCES_20260623_101721.xlsx`, Courthouse `Sarpy_MP_NCES_20260623_111959.xlsx`, JJC `Sarpy_MP_NCES_20260623_113243.xlsx`, 1102 Building `Sarpy_MP_NCES_20260623_113752.xlsx`.

### Sheriff's Office initial sync notes (earlier in session)

`geojson_to_airtable_csv.cjs` / `.py` fixed: `Workstations` and `Seat Count` were collapsed into one column — now separate. `sync-airtable-rooms.cjs` updated to add `Workstations` field and use always-overwrite correction mode for numeric fields (Room Type stays fill-blank-only). `scripts/add-room-type-options.cjs` added — Meta API script to bulk-add Room Type dropdown options; persistent 422 errors blocked programmatic update, user added 5 missing options manually via Airtable UI.

### Hastings AI server "Refresh Airtable Data" — cold start issue (resolved/understood)

Error `"Airtable sync failed before scope validation."` was a Render free-tier cold start. The server spins down after 15 min of inactivity; the frontend `timeoutMs: 8000` aborts before the server warms up (~15–30s). Confirmed: refreshing a second time succeeded once the server was warm.

**No code fix needed** — this is expected Render free-tier behavior. If it becomes a recurring complaint, options are: (1) upgrade to Render paid tier (always-on), or (2) increase `timeoutMs` on the rooms fetch to 30s+.

---

## Recent Changes (2026-06-22, session 4)

| Commit | What changed and why |
|---|---|
| `9a1c1c4` | **Fix Edit button on public maps** — `roomEditCanWrite` had `\|\| isDemoPublicMode` in its condition, causing the Edit button to appear for signed-in admins on `/hastings` and `/sarpy-county`. Removed `isDemoPublicMode`; Edit is now gated on `isAdminUser && showFullMapfluenceControls` only, which requires `isAdminMode && !engagementMode && !technicalMode` — `/*/admin` URLs only. |
| `44a9482` | **Remove `_Public` GeoJSON substitution** — Public map was loading stale `_Dept_Rooms_Public.geojson` files (created Jun 18, pre rooms/walls split) with bad geometry/whitespace gaps. Removed both substitution points in `StakeholderMap.jsx` (`getFloorUrlForBuilding` and fallback URL path). Deleted `LEVEL_1_Dept_Rooms_Public.geojson` and `BASEMENT_Dept_Rooms_Public.geojson`. Public mode now uses the same files as admin. Airtable suppression for public mode is unchanged (`isSarpyPublicReadonlyMode` still gates all data-fetch paths). |
| `78e9cfc` | **Disable walls overlay for Sarpy County** — `LEVEL_1_Walls.geojson` was causing visual issues on the Admin/Courthouse floor plan. Added `"enableWallsOverlay": false` to `SarpyCounty.json`. `loadFloorGeojson` now accepts a `suppressAutoWalls` option (derived from `config?.enableWallsOverlay === false`) that skips the `tryLoadWallsOverlay` auto-detect call. Other tenants unaffected. |
| `2fd0a39` | **Split courthouse GeoJSON: rooms only** — Moved 7,761 wall/drawing features into `public/floorplans/SarpyCounty/AdministrationCourthouse/LEVEL_1_Walls.geojson`. `LEVEL_1_Dept_Rooms.geojson` now contains only the 454 room polygons (297 KB). Added auto-detect lazy-wall-loading to `loadFloorGeojson` (fires when drawing features absent from rooms file). |

### Airtable sync tooling added (scripts only — not committed)

**`scripts/sync-airtable-rooms.cjs`** — syncs a CSV (from `geojson_to_airtable_csv.cjs`) into the Sarpy Airtable base. Three-way match logic:
- Room GUID already in Airtable → skip
- Room ID found with blank GUID → PATCH just the GUID field
- No match → create with all fields

Run:
```
node scripts/sync-airtable-rooms.cjs --dry-run --env ai-server/.env.sarpy --csv "C:\temp\Sarpy\Admin_Courthouse\AdminCourthouse_Airtable_Import.csv"
# Remove --dry-run to apply
```

Credentials file `ai-server/.env.sarpy` (never commit):
```
AIRTABLE_TOKEN=patwl95Uy4003YY3u...
AIRTABLE_BASE_ID=appmlFbql4ktdsPxc
AIRTABLE_TABLE=Rooms
```

Admin/Courthouse sync result (2026-06-22): 68 skipped (already had GUID), 321 GUIDs patched, 60 new records created. All 454 courthouse rooms now in Airtable.

**`scripts/geojson_to_airtable_csv.cjs`** — joins a Revit-exported GeoJSON with an NCES Excel export on `Revit UniqueId`, outputs a CSV ready for Airtable import. Run with:
```
node scripts/geojson_to_airtable_csv.cjs
```
Paths are hardcoded at the top of the file. Update `EXCEL_PATH` and `GEOJSON_PATH` per project. Uses `xlsx` from `ai-server/node_modules/`.

---

## Recent Changes (2026-06-22, session 3)

| Commit | What changed and why |
|---|---|
| `3aad289` | **Revit export: multi-phase + expanded levels** — `TARGET_PHASE_NAME` → `TARGET_PHASE_NAMES` list (`["Existing", "New Construction"]`). Phase check now collects all matching phases and gates rooms/views against the union, so JJC (New Construction) and Admin Courthouse (Existing) both work from the same script. Added `LEVEL 1 - OVERALL`, `LEVEL 1 - AREA A`, `LEVEL 1 - AREA B` to `ALLOWED_LEVELS`. |
| `370c3f9` | **Revit export: new room properties** — Added `Workstations` (reads `NCES_Workstations` then `Workstations`), `Seat Count`, and `occupancyStatus` defaulting to `"Occupied"` when blank. Raw value preserved in `NCES_Occupancy Status`. |
| `56aef93` | **JJC floorplan added** — `public/floorplans/SarpyCounty/Juvenile Justice Center/Rooms/LEVEL_1_Dept_Rooms.geojson` + `manifest.json`. Registered in `BUILDINGS_LIST` in `StakeholderMap.jsx`. Building footprint was already present in `SarpyCounty_Buildings.json`. |
| `d357517` | **Per-tenant AI server URL** — `getAiBaseUrl()` now supports a runtime override via `setRuntimeAiBaseUrl()`. `StakeholderMap` reads `config.aiServerUrl` on mount and sets it. Fixes Sarpy admin showing Hastings departments and failing saves. Hastings is unaffected (no `aiServerUrl` → falls through to hardcoded default). |
| `c9ed4ef` | **Sarpy AI server wired** — `SarpyCounty.json` gets `"aiServerUrl": "https://mapfluence-sarpy-ai.onrender.com"`. |

---

## Recent Changes (2026-06-17)

| Commit | What changed and why |
|---|---|
| `f400ac1` | **Telecomm removal** — removed `telecomm` field from `AssessmentPanel` Functionality section. Now 3 fields: `fireAlarm`, `spaceSize`, `technology`. Updated both `assessmentTemplate` in `AssessmentPanel.jsx` and `TECHNICAL_SECTION_CONFIG` in `StakeholderMap.jsx`. |
| `00b2354` | **Cherokee photo upload** — added `enablePhotoUpload` prop to `AssessmentPanel`. When `universityId === 'cherokee-mental-health'`, assessors see an "Add Photo" button. Photos upload immediately to Firebase Storage at `cherokee-mental-health/buildings/{building}/photos/` and URLs are saved to the Firestore assessment record on next cloud save. Gated so Hastings and Sarpy are unaffected. Also added `storage` export to `firebaseConfig.js`. |
| `1898569` | **Assessment color real-time sync fix** — replaced `getDocs` with `onSnapshot` for `buildingAssessments` collection. Before this, building colors only reflected the state at page load; other users' saves were invisible until refresh. Now all connected clients update live. |
| `40db696` | Restored Hastings building resource links |
| `8f6a24e` | Synced Cherokee technical progress display across assessors |
| `dd23bab` | Improved technical mobile workflow and per-assessor saves |
| `644c92a` | Added Cherokee Mental Health as a new tenant |
| `eebe4be` | Added deploy env var checklist for AI usage logging |
| `ab3ff74` | Added lightweight AI usage logging to the AI server |
| `2f77c2b` | Added Sarpy NAIP basemap option |
| `eda2e4f` | Scoped Hastings dashboard defaults and room hydration |
| `01682dc` | Scoped Sarpy occupancy behavior |

---

## Known Issues / Open Items

### PyRevit script has two copies — keep them in sync manually

The GeoJSON export script lives in **two places** and must be kept identical:

| Copy | Purpose |
|---|---|
| `scripts/script.py` | Source of truth — version-controlled in the repo |
| `C:\Users\jdohrman\AppData\Roaming\pyRevit\extensions\Mapfluence.extension\Mapfluence.tab\Export.panel\GeoJSON Export.pushbutton\script.py` | Live copy Revit actually runs |

There is no auto-sync. After editing `scripts/script.py` and committing, manually overwrite the pyRevit copy:
```
copy scripts\script.py "C:\Users\jdohrman\AppData\Roaming\pyRevit\extensions\Mapfluence.extension\Mapfluence.tab\Export.panel\GeoJSON Export.pushbutton\script.py"
```
pyRevit picks up changes immediately — no Revit restart needed.

### BASEMENT_Dept_Rooms.geojson not yet split

`public/floorplans/SarpyCounty/AdministrationCourthouse/Rooms/BASEMENT_Dept_Rooms.geojson` is 7 MB and still contains mixed room + wall/drawing features (same problem LEVEL 1 had before the Jun 22 split). If the Basement floor is opened, it will load slowly. Fix: run the same rooms/walls split process used for LEVEL 1 against the basement file, then place the walls output at `AdministrationCourthouse/BASEMENT_Walls.geojson`.

### Sarpy admin bootstrap — first admin role must be set via Firebase Console

The Firestore `roles` collection requires an existing admin to write new entries (`allow write: if isUniversityAdmin(universityId)`). There is no admin for `sarpy-county` yet. To bootstrap:

1. Firebase Console → Authentication → Users → find `jack.g.dohrman@gmail.com` → copy UID
2. Firestore → `universities/sarpy-county/roles/{uid}` → add document with field `role: "admin"` (string)

Document structure mirrors `universities/hastings/roles/{uid}`.

### Firebase Storage rules missing — photo uploads blocked

There is no `storage.rules` file in the repo. Firebase Storage has its own security rules separate from Firestore, and the default when no rules are deployed is **deny all**. This is why Cherokee photo uploads hang without error.

**Fix needed:** create `storage.rules` at the repo root and add a `"storage"` entry to `firebase.json` pointing to it. Minimum rule to unblock Cherokee uploads:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /cherokee-mental-health/buildings/{building}/photos/{filename} {
      allow read: if true;
      allow write: if true;  // matches open-pilot pattern in Firestore rules
    }
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

The Firestore rules (`firestore.rules`) use `isOpenPilotCampus()` to allow unauthenticated writes for Cherokee assessments. The Storage rule above matches that posture. Tighten to `request.auth != null` if sign-in becomes required.

---

## Mode System (StakeholderMap internals)

`StakeholderMap` receives `mode` (`'admin'`|`'public'`), `engagementMode` (bool), and `technicalMode` (bool) and derives a set of boolean flags used throughout the component:

```js
isAdminMode              = mode === 'admin'
isAdminCombinedMode      = isAdminMode && engagementMode
isTechnicalOnlyMode      = Boolean(technicalMode)
isDemoPublicMode         = !isAdminMode && !engagementMode && !technicalMode
isSarpyPublicReadonlyMode = isSarpyCountyInstance && isDemoPublicMode
stakeholderWorkflowActive // engagement markers/paths are active
technicalWorkflowActive   // controls whether AssessmentPanel renders
showFullMapfluenceControls = isAdminMode && !engagementMode && !technicalMode
```

Before touching any conditional behavior inside `StakeholderMap`, determine which mode combination triggers it. These flags cascade through hundreds of conditionals.

---

## Component Inventory

| Component | Role | Notes |
|---|---|---|
| `StakeholderMap.jsx` | Core map + all logic | ~25k lines. All data fetching, Firestore, Airtable, panels, AI live here. |
| `AssessmentPanel.jsx` | Technical assessment form | Per-assessor save mode, 900ms draft autosave to localStorage, photo upload (Cherokee only) |
| `BuildingInteractionPanel.jsx` | Condition scoring panel | Minimal — a 1–5 dropdown, save button, and "Open Technical Assessment" trigger |
| `SpaceDashboardPanel.jsx` | Space data dashboard | SVG charts for enrollment trends, seat gap, office occupancy gauge. Props `showStrategicSection` and `showUtilizationSection` scope what's visible per tenant. |
| `panels/BuildingPanel.jsx` | Building summary popup | SF totals, department list, PDF/CSV export, deferred maintenance, remodel scenarios |
| `panels/FloorPanel.jsx` | Floor-level popup | Color modes, floor plan geometric alignment tools (rotate/scale/move/affine export) |
| `FloorsTab.jsx` | Floor selector + stats | Used inside building popups |
| `UtilizationBars.jsx` | Time + seat utilization bars | Pure display, no state |
| `ComboInput.jsx` | Searchable dropdown | Used for room type/dept assignment in room edit mode |
| `EmailEntryForm.jsx` | Email collection gate | **Has "Hastings.edu" text hardcoded in JSX.** It lives in shared components but is Hastings-only. |

### Two `popupUi.js` files — do not confuse them

| File | Exports | Imported by |
|---|---|---|
| `src/helpers/popupUi.js` | `fmtArea`, `fmtCount`, `renderKeyDeptLegendHtml` | `FloorsTab.jsx` |
| `src/components/popupUi.js` | `toKeyDeptList` | `StakeholderMap.jsx` |

Same filename, different folders, different exports. Do not merge or overwrite.

---

## Coding Patterns

### Gating features per tenant

Two patterns in use:

1. **Config flag (preferred)** — add a key to `src/Configs/{Client}.json` and read it in the component via `config?.yourFlag`. Clean, no component code knows about specific tenants.
2. **Direct `universityId` check (one-liners)** — `universityId === 'cherokee-mental-health'` or `isSarpyCountyInstance`. Used when adding a full config flag isn't worth it for a small change. `isSarpyCountyInstance` is computed by normalizing `universityId` through `canon()` and matching `sarpy_county`, `sarpy`, `sarpy_ne`, `sarpycounty`.

Sarpy County has the most hardcoded special-casing in the codebase. When touching anything that might behave differently for Sarpy, search for `isSarpyCountyInstance` first.

### localStorage key namespace

Always prefix with `mf:` or `mf-` and include `universityId` so tenants don't bleed into each other. Existing prefixes:

| Prefix | Used for |
|---|---|
| `mf:technical-assessment-draft:{uni}:{bld}:{owner}` | AssessmentPanel draft autosave |
| `mf-planning-scenarios` | Planner copilot scenario persistence |
| `mf-reno-scenarios` | Renovation scenario persistence |
| `mf-admin-engagement-prefs` | Admin combined mode user preferences |
| `mf-copilot-prefs` | Planner copilot preferences |

### Firestore writes use `merge: true`

All assessment saves use `setDoc(ref, data, { merge: true })`. This means a cloud save won't wipe fields that aren't present in the current write payload, as long as they were saved previously. Safe for incremental updates (e.g. adding `photoUrls` to an existing assessment record).

---

## Deploy Workflow

```
airtable-roomid-normalize-hotfix  ←  do all work here
         │
         └──merge──▶  feature/multi-university-refactor  ──push──▶  GitHub Actions  ──▶  GitHub Pages
```

Command to deploy (run at end of every session when changes should go live):

```bash
git checkout feature/multi-university-refactor
git merge airtable-roomid-normalize-hotfix --no-edit
git push origin feature/multi-university-refactor
git checkout airtable-roomid-normalize-hotfix
```

GitHub Actions also triggers on pushes to `main`, but **never push source code directly to `main`**. See incident below.

---

## Production Incident: Codex Pushed Directly to `main` (2026-06-17)

**What happened:** Codex made two commits directly to `main` (`24281fe`, `5fea647`) to "hide Hastings AI planning scenario" and "restore Cherokee tenant config." The second commit added Cherokee to `configLoader.js` (map data) but NOT to `registry.js` (tenant resolver). Without a `registry.js` entry, `resolveTenant('cherokee-mental-health')` returned null and the Cherokee map showed the Hastings fallback.

**Why it's dangerous to push source directly to `main`:** Both `main` and `feature/multi-university-refactor` trigger the same GitHub Actions build. The last completed build wins the GitHub Pages deploy slot. A bad push to `main` can overwrite a good `feature/multi-university-refactor` build.

**Recovery:** Push to `feature/multi-university-refactor` (which has the correct code) to trigger a new build that overwrites the bad `main` build. An empty commit works:

```bash
git checkout feature/multi-university-refactor
git commit --allow-empty -m "Trigger deploy: restore correct build"
git push origin feature/multi-university-refactor
git checkout airtable-roomid-normalize-hotfix
```

**Adding a new tenant: always update BOTH files**

When wiring a new tenant, `configLoader.js` and `registry.js` must both be updated. Missing either breaks the tenant:

| File | What to add |
|---|---|
| `src/tenants/registry.js` | Entry in `TENANT_DEFS` with id, aliases, and feature flags |
| `src/configLoader.js` | Import JSON + GeoJSON files, build config object, add aliases to `universityConfigs` |

---

## Active Branches

| Branch | Purpose |
|---|---|
| `main` | Production — GitHub Pages serves the last build from either `main` or `feature/multi-university-refactor`. **Do not push source code directly here.** |
| `airtable-roomid-normalize-hotfix` | Current working branch |
| `feature/multi-university-refactor` | Long-running refactor branch; deploy trigger |

---

## AI Server Deployments

Each tenant that uses Airtable room data needs its own AI server instance on Render, configured with that tenant's Airtable credentials. The frontend picks the right server from `config.aiServerUrl` in the tenant's JSON config.

| Tenant | AI Server URL | Airtable base |
|---|---|---|
| Hastings | `https://github-stakeholder-ai.onrender.com` | `appQbbKh2wTFogpN5` (Hastings) |
| Sarpy County | `https://mapfluence-sarpy-ai.onrender.com` | Sarpy base (set in Render env vars) |

As of 2026-07-13, the Sarpy Render AI service is configured to deploy from `feature/multi-university-refactor`, not `main`. Confirm the live backend revision via `/health` before assuming a `main` push is active.

`getAiBaseUrl()` priority order:
1. `config.aiServerUrl` (set at component mount via `setRuntimeAiBaseUrl()`)
2. `VITE_AI_BASE_URL` build-time env var
3. Hardcoded `https://github-stakeholder-ai.onrender.com` (GitHub Pages fallback)

**To add a new tenant AI server:** deploy `ai-server/` to Render, set its env vars (see full list below), then add `"aiServerUrl": "https://..."` to the tenant's JSON config.

## Environment Variables

The AI server (`ai-server/.env`) requires:

```
OPENAI_API_KEY=...
AIRTABLE_TOKEN=...
AIRTABLE_BASE_ID=...
AIRTABLE_TABLE=...
AIRTABLE_VIEW=...                        # default: "Mapfluence_Rooms"
AIRTABLE_BUILDING_FIELD=...              # default: "Building"
AIRTABLE_FLOOR_FIELD=...                 # default: "Floor"
AIRTABLE_ROOM_ID_FIELD=...              # default: "Room ID" (can be comma-list e.g. "Room GUID,Room ID")
AIRTABLE_ROOM_GUID_FIELD=...            # default: "Room GUID"
AIRTABLE_OCC_STATUS_FIELD=...           # default: "Occupancy Status"
AIRTABLE_OCCUPANT_FIELD=...             # default: "Occupant"
AIRTABLE_DEPT_FIELD=...                 # default: "Department"
AIRTABLE_TYPE_FIELD=...                 # default: "Type"
AIRTABLE_COMMENTS_FIELD=...             # default: "Comments"
AIRTABLE_SEAT_FIELD=...                 # default: "Seat Count"
AIRTABLE_AREA_FIELD=...                 # no default — set if area is a field
AIRTABLE_ROOM_TYPE_TABLE=...            # linked table for room type dropdown
AIRTABLE_ROOM_TYPE_PRIMARY_FIELD=...    # primary field in that table
AIRTABLE_DEPT_TABLE=...                 # linked table for department dropdown
AIRTABLE_DEPT_PRIMARY_FIELD=...         # primary field in that table
AI_MODEL=gpt-4.1
```

Firebase env vars live in `src/.env` and `functions/.env`. Do not commit `.env` files.

---

## STOPPED HERE (2026-07-02): Sarpy floorAdjust/georeferenced work reverted — Hastings offset still unexplained

**RESOLVED 2026-07-06** — see "Recent Changes (2026-07-06) — Root cause found and fixed" below. Root cause was `0268780`'s unconditional `fc.__mfGeoreferenced = true` after any successful affine transform, not anything in Firestore/localStorage — which confirms the "not a regression from this session's or the Sarpy work" conclusion reached below, but the actual mechanism is more precise than the "stale calibration" theory guessed at the time: the calibration *was* stale/wrong, but the real bug is that nothing ever re-checked it once `__mfGeoreferenced` was set.

**Current state:** `feature/multi-university-refactor` is at `cfecf43`. All floorAdjust/georeferenced-flag code from today has been reverted. `src/components/StakeholderMap.jsx` is byte-identical (same git blob hash) to `18c2f80`, the last commit from 2026-07-01. **Do not assume the code is "back to normal" fixes anything for Hastings — see below.**

### What this session was trying to do

Sarpy County buildings (pre-baked lon/lat floor plans, no `affine.json`, positioned via real-world georeferenced coordinates rather than the usual fit-to-building-footprint pipeline) had a bug where saved admin floor adjustments (rotate/move/scale) wouldn't reliably reapply on reload — sometimes silently no-op'd, sometimes only rooms moved and not walls. Root cause traced to a `georeferenced: true/false` flag stored per floorAdjust doc, which gates whether the saved adjustment is allowed to apply to a floor that's already correctly positioned in real-world space (`fc.__mfGeoreferenced` / `fc.__mfNoFit`). The flag was (a) missing on legacy Sarpy docs, (b) not sticky — recomputed from scratch on every save from an async, fallible detection check, so a single bad save could silently regress it back to `false` and "lose" a working adjustment.

### Commits made and reverted (all now undone via `cfecf43`)

| Commit | What it did |
|---|---|
| `de90ab2` | Let intentional post-georeference floor adjustments override `__mfNoFit` |
| `1dc5090` | Stamp `georeferenced` flag on drag-to-adjust auto-save path |
| `eed8fb1` | Fix georeferenced-flag clobber in cross-storage/DB sync paths |
| `7228be5` | Reapply saved floorAdjust to walls overlay on reload, not just rooms |
| `3b31a3d` | Skip Firestore floorAdjust hydration for no-fit/georeferenced floors |
| `a09e304` | Fix over-broad Firestore skip: gate on candidate's flag, not the fetch |
| `42c6abd` | Make floorAdjust `georeferenced` flag sticky across saves (OR with previous value) |
| `76b0f05` | Gate Sarpy `georeferenced` flag on `isSarpyCountyInstance` directly, not async detection |
| `1ac5032` | Add walls-to-rooms bbox-center snap for pre-baked floors — **caused visible offsets on previously-correct buildings, reverted same session** (`81ffbc3`) |
| `d225202` | Empty retrigger commit (a GH Actions Pages deploy step failed transiently; build always succeeded) |

Also stamped `georeferenced: true` directly on 4 pre-existing Sarpy Firestore docs (1246 Building, Administration/Courthouse, Juvenile Justice Center, Sheriff's Office) that predated the flag and had real, large saved corrections (rotations up to 216°, scales up to 2.5x) with no flag set. Sheriff's Office's doc was separately found zeroed out mid-session (real user `Clear Adjust` click, not a bug) and manually restored to its prior rotation/scale/translate/pivot values — `translateLngLat`/`anchorLngLat` could not be recovered and were left `null` (falls back to `translateMeters`, should be visually equivalent).

**None of this touched anything under `public/floorplans/Hastings/`, `src/Configs/`, or Hastings' Firestore collections** — verified explicitly (see below).

### The emergency revert

Mid-session, Hastings was reported "completely broken across multiple buildings" while `de90ab2..d225202` was live. Reverted the whole range in one squashed commit (`cfecf43`) via `git revert --no-commit de90ab2^..HEAD`, verified 0-diff against `f92066c` before committing, pushed (no force-push — normal forward commit), confirmed deployed and live.

**Hastings was still broken after the revert**, including in incognito (ruling out browser cache). This was re-verified two more ways, both coming back clean:

1. `git diff 18c2f80 cfecf43 -- src/` → **zero output**. Not just `StakeholderMap.jsx` — the entire `src/` tree is byte-identical between the last known-good commit and current `HEAD`.
2. Swept all 15 Firestore collections under `universities/hastings/` (`buildingAssessments`, `buildingConditions`, `buildings`, `drawingEntries`, `floorAdjustments`, `floors`, `maintenanceIssues`, `markers`, `moves`, `plannerCopilotFeedback`, `plannerCopilotPolicies`, `planningScenarios`, `renoScenarios`, `roles`, `rooms`) for any document with any timestamp field dated today. **Zero matches, in any collection.** (Seven of these require admin auth to read via the client SDK's security rules — pulled via the Firestore REST API using the already-authenticated `firebase-tools` CLI's stored OAuth refresh token, same technique used earlier in the session for direct Firestore writes; see `~/.config/configstore/firebase-tools.json` for the token, `563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com` is the Firebase CLI's public OAuth client ID.)

**Conclusion: the Hastings offset is not a regression from anything in this session, or from yesterday's `2026-07-01` Sarpy fit-guard work.** No code and no Firestore write in either day's work can explain it — the evidence rules both out completely, not just probabilistically.

Confirmed live and reproducing on: **Hazelrigg Student Union, LEVEL_1** — floor plan renders well up-and-left of the building's actual footprint on the basemap. Displayed `Rotation: 2.6° · Scale: 1.12` matches the stored Firestore/localStorage value exactly (saved 2026-03-16), so the stored adjustment itself isn't corrupted — it's just not landing in the right place relative to the current basemap/footprint.

**Leading theory, unconfirmed:** stale calibration, not a code bug. `public/floorplans/Hastings/Hazzelrig/affine.json` was last touched 2026-02-04 (`d47884a`). `public/Hastings_College_Buildings.geojson` (the footprint file) was last touched 2025-11-18 (`831608d`). The floorAdjust for Hazelrigg was saved 2026-03-16 — a month after the affine calibration, four months after the footprint. Both reference files have been stable ever since (no touches after March), so this isn't "the ground moved out from under a good save" either — more likely this building (and possibly others) has been silently offset since some point after March and nobody happened to check it until today.

**What wasn't finished:** an old-commit visual comparison (checked out `ab3ff74`, ~1 month before any of this session's or yesterday's work, via `git worktree`, ran a second dev server on port 5175) would have settled definitively whether this predates even that. Abandoned — that dev server instance defaulted to OpenStreetMap raster basemap tiles instead of Mapbox, and those got CORS-blocked in the sandboxed test environment, so the map never painted. The worktree was torn down; nothing left behind. If picking this back up, either fix the basemap/CORS issue for that isolated test, or just re-run `git worktree add ../stakeholder-map-oldcheck ab3ff74` again with a valid Mapbox token wired up for that instance.

**Next step for whoever picks this up:** treat the Hastings offset as its own, separate, pre-existing bug — not connected to the Sarpy georeferenced-flag work above. Likely fix is re-deriving Hazelrigg's (and any other affected Hastings buildings') floorAdjust from scratch against current calibration, using the same pattern as the admin "Clear Adjust" button (`clearFloorAdjustForFloor`), rather than continuing to hunt through today's or yesterday's commits — the evidence says it isn't there.

### Deploy notes

GitHub Actions Pages deploys failed at the "Deploy to GitHub Pages" step (not the build step) three separate times today (`a09e304` twice, `42c6abd`, `81ffbc3`), all with the build job succeeding and only the deploy job failing, no accessible logs (job log download requires repo-admin auth, returns 403 otherwise). One instance (`42c6abd`) self-resolved to `success` on a later status check with no action taken; another (`81ffbc3`) did not and required a follow-up empty commit (`d225202`) to retrigger. If this keeps happening, it's worth someone with repo-admin access checking Settings → Pages directly, since the logs aren't reachable from an assistant session.

---

## Recent Changes (2026-07-07) � Sarpy floorAdjust save/reload finally fixed

### Summary

Follow-up to the earlier Sarpy georeferenced-floor work. The remaining bug was: after an admin used rotate/move/scale on a Sarpy floor, clicked **Save Adjust**, then hard-reloaded, the rooms and linework could come back out of sync or the saved position could appear to revert. This is now confirmed fixed for the tested Sarpy buildings after `0f912bc`.

### What was actually wrong

There were **three separate reload/save-path issues**, not one:

| Commit | What it fixed |
|---|---|
| `59fce1a` | Earlier work that broadened reload to check label / URL / basePath / Firestore candidate docs instead of trusting one storage key. This improved persistence but did **not** fully fix reload. |
| **`7a2e489`** | Fixed stale-save branches that were still rebuilding the next adjust from the wrong source. `drag` mouse-up and explicit `Save Adjust` were updated to start from the freshest stored adjust across label/URL/basePath instead of sometimes pulling an older label-key copy; `onScaleChange` was later brought onto the same helper in this commit as well. Also added `buildOverlayFloorAdjust(...)`, which converts the rooms' saved `anchorLngLat` snap into an equivalent `translateLngLat` for overlays so walls/doors/stairs inherit the same final translation as rooms on reload. |
| **`0f912bc`** | Final root cause for the lingering walls mismatch: the fire-and-forget auto-walls path in `loadFloorGeojson` still called `tryLoadWallsOverlay(...)` **without** `overlayFloorAdjust`. On Sarpy floors this second async walls load could arrive after the adjusted pass and repaint unadjusted walls on top. The console symptom was duplicated `[walls] loaded features ... pre-baked lon/lat � skipping all transforms` logs for the same floor open. Passing `overlayFloorAdjust` through this second path fixed the last visible reload desync. |

### Key implementation details

- `getCurrentStoredFloorAdjust(...)` is now the single helper for "freshest saved adjust wins" across:
  - `loadFloorAdjust(buildingLabel, floorId)`
  - `loadFloorAdjustByUrl(url)`
  - `loadFloorAdjustByBasePath(basePath, floorId)`
- `buildOverlayFloorAdjust(...)` intentionally strips `anchorLngLat` from overlay replay, previews the adjusted rooms transform, measures the anchor delta, and adds that delta back as `translateLngLat`. This avoids double-applying the room anchor logic while still landing overlays where the rooms end up.
- `tryLoadWallsOverlay(...)`, `tryLoadDoorsOverlay(...)`, and `tryLoadStairsOverlay(...)` all accept `overlayFloorAdjust`; doors and stairs also rotate bearing-like properties with `applyBearingRotation(...)` when replaying a saved rotation.

### Guardrails for future work

- If Sarpy reload ever looks "half right" again, check whether **every** overlay load path is receiving the same replay adjust, not just the first/awaited one.
- Duplicate overlay console logs for the same floor open are a strong clue that one async path is repainting another.
- For georeferenced/no-`affine.json` floors, do not assume room-only replay is enough; overlays need an equivalent geographic replay path too.

---
## Recent Changes (2026-07-06) � Root cause found and fixed: `__mfGeoreferenced` set unconditionally on affine apply

### Summary

Direct continuation of the 2026-07-02 "STOPPED HERE" investigation above. **Root cause confirmed and fixed** this session — see "Root cause" below. Two earlier attempts this same session were dead ends and were reverted; both are documented here so nobody re-tries them.

### Session timeline

| Commit | What it did |
|---|---|
| `3710ae3`, `c174213` (earlier — superseded) | Added a "sanity guard" that scored saved floor adjustments against the current building fit (overlap/offset/scale) and silently ignored ones that scored worse, plus a hardcoded ignore-list for Hazelrigg specifically. Intended to protect against stale adjustments, but it ended up **blocking legitimate floor adjustments from loading across Hastings** — too aggressive. |
| `be6ff17` | Reverted the sanity guard entirely. Restored the simple `if (floorAdjust && hasFloorAdjust(floorAdjust))` reapply check in both `loadFloorGeojson` and `handleLoadFloorplan`. This unblocked floor adjustments from loading, but Hazelrigg still rendered in the wrong position afterward — a *different*, pre-existing bug (see below). |
| `381525f` | **Dead end, reverted same session (`253571a`).** Tried making `shouldFitFloorplanToBuilding` skip entirely whenever a non-Sarpy floor already had a saved adjustment, on the theory the fit heuristic was fighting the adjustment. Wrong direction — the fit heuristic needed to *run* to correct the underlying affine error, not be skipped; skipping it just left the floor sitting on the uncorrected (miscalibrated) affine position. |
| `f1bd213`, `2022aa5` | Temporary diagnostic logging (both removed in `8770e08` once the root cause was confirmed) added to `fitFloorplanToBuilding` and to `loadFloorGeojson`'s fit-decision point. The `fitBuilding`-resolution log was the one that mattered: it showed `mfGeoreferenced: true` for Hazelrigg despite it having a perfectly valid, fetchable `affine.json` — which should never by itself mark a floor as georeferenced. That's what led to the actual bug. |
| **`8770e08`** | **The fix.** See "Root cause" and "The fix" below. |

### Root cause

`applyAffineIfPresent` (called by `loadRoomsFC` for every floor that has an `affine.json`) set `fc.__mfGeoreferenced = true` unconditionally whenever the affine transform applied without throwing — regardless of whether that calibration was still *accurate*. This line was added in `0268780` ("Mark rooms georeferenced after affine.json applies to skip building-fit override", 2026-07-01) — **and was already present in `18c2f80`, the "last known good" commit referenced throughout the 2026-07-02 investigation above.** It was never touched by the `de90ab2..d225202` revert that day. This means the bug has been live in production since **2026-07-01**, silently affecting **every Hastings building with an `affine.json`**, not just Hazelrigg.

`fc.__mfGeoreferenced` gates `loadFloorGeojson`'s fit block:
```js
if (fc.__mfGeoreferenced || fc.__mfNoFit) {
  // skip both fitLocalFloorplanToBuilding and shouldFitFloorplanToBuilding
}
```
Once `__mfGeoreferenced` was (wrongly) `true`, the floor's position was never checked against the current building footprint — the app just trusted the affine transform's output as "already correct" and skipped the one mechanism (`shouldFitFloorplanToBuilding` → `fitFloorplanToBuilding`) that would have caught and corrected a bad calibration. For Hazelrigg specifically, the affine's `scale_deg_per_foot` measured out to ~7.3x too large (produces a ~630m × 486m floor plan against a real ~90m × 69m building footprint) — the fit heuristic's scale/distance/overlap checks all trip hard on the real numbers and would have corrected it, but never got the chance to run.

The saved `floorAdjust` (an admin's manual rotate/scale correction) was then applied on top of this uncorrected, oversized affine baseline, landing the floor in the wrong final position — even though the stored adjustment values themselves were completely correct and unchanged.

### The fix (`8770e08`)

Removed the `out.__mfGeoreferenced = true;` line (and its justifying comment) from `applyAffineIfPresent` — no replacement. `__mfGeoreferenced` is now set in exactly **one** place in the whole codebase: the `isFloorAlreadyGeoreferenced` check inside `loadFloorGeojson` (~line 5595), which corroborates via the paired walls file before trusting a floor as georeferenced — this path is for Sarpy-style pre-baked lon/lat exports that have **no** `affine.json` at all. Having an `affine.json`, and having it apply without throwing, is no longer treated as proof that a floor is correctly positioned.

### ⚠️ Guardrail — do not reintroduce this

**Never set `__mfGeoreferenced = true` just because a transform ran successfully.** "The code didn't error" is not the same as "the floor is in the right place." The only legitimate way to mark a floor georeferenced is independent corroboration (e.g. `isFloorAlreadyGeoreferenced`'s paired-walls-file check) — not the mere presence or successful application of an affine transform. If future work wants a fast-path that skips `shouldFitFloorplanToBuilding` for already-calibrated buildings, it needs an actual accuracy check (e.g. compare the post-transform bbox/overlap against the current building footprint) — not an assumption baked in at apply-time.

### False leads ruled out this session (for anyone re-reading git history later)

- `shouldFitFloorplanToBuilding`'s thresholds (`scale < 0.75 || > 1.35`, `distKm > 0.06`, `offsetRatio > 0.18`) — unchanged since `2026-01-12` / `2026-02-04`.
- `Hastings_College_Buildings.geojson`'s Hazelrigg footprint polygon — byte-identical since at least the `2025-11-18` path-rename commit (`831608d`), never touched since.
- `affine.json` for Hazzelrig — unchanged since `2026-02-04` (`d47884a`), and confirmed live/fetchable on the deployed site (not a 404 or stale-cache issue).
- `FLOORPLAN_NO_FIT` / `shouldSkipFloorplanFit` — a static per-building/floor allowlist unrelated to `floorAdjust`; Hazelrigg was never in it.
- `isFloorAlreadyGeoreferenced` — only runs when `!affine`; irrelevant for buildings (like Hazelrigg) that have a working `affine.json`, so it was never the mis-detection source for this bug.

### Deploy note

GitHub Pages returned "Deployment failed, try again later." again after pushing `8770e08` — the same transient deploy-step failure documented in the 2026-07-02 section above (build succeeds, the separate Pages-upload step fails independently). Still no `gh` CLI or `GITHUB_TOKEN` available in the assistant's shell environment to retry programmatically; use the Actions tab → the failed run → "Re-run failed jobs."

---
*Last updated: 2026-08-04 - update this file whenever the architecture, client list, or critical behavior changes.*


