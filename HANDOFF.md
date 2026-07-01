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

*Last updated: 2026-06-30 — update this file whenever the architecture, client list, or critical behavior changes.*
