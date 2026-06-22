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

## Recent Changes (2026-06-22)

| Commit | What changed and why |
|---|---|
| `3aad289` | **Revit export: multi-phase + expanded levels** — `TARGET_PHASE_NAME` → `TARGET_PHASE_NAMES` list (`["Existing", "New Construction"]`). Phase check now collects all matching phases and gates rooms/views against the union, so JJC (New Construction) and Admin Courthouse (Existing) both work from the same script. Added `LEVEL 1 - OVERALL`, `LEVEL 1 - AREA A`, `LEVEL 1 - AREA B` to `ALLOWED_LEVELS`. |
| `370c3f9` | **Revit export: new room properties** — Added `Workstations` (reads `NCES_Workstations` then `Workstations`), `Seat Count`, and `occupancyStatus` defaulting to `"Occupied"` when blank. Raw value preserved in `NCES_Occupancy Status`. |
| `56aef93` | **JJC floorplan added** — `public/floorplans/SarpyCounty/Juvenile Justice Center/Rooms/LEVEL_1_Dept_Rooms.geojson` + `manifest.json`. Registered in `BUILDINGS_LIST` in `StakeholderMap.jsx`. Building footprint was already present in `SarpyCounty_Buildings.json`. |
| `d357517` | **Per-tenant AI server URL** — `getAiBaseUrl()` now supports a runtime override via `setRuntimeAiBaseUrl()`. `StakeholderMap` reads `config.aiServerUrl` on mount and sets it. Fixes Sarpy admin showing Hastings departments and failing saves. Hastings is unaffected (no `aiServerUrl` → falls through to hardcoded default). |
| `c9ed4ef` | **Sarpy AI server wired** — `SarpyCounty.json` gets `"aiServerUrl": "https://mapfluence-sarpy-ai.onrender.com"`. |

### Airtable import tooling added (not committed — one-off scripts)

`scripts/geojson_to_airtable_csv.cjs` — joins a Revit-exported GeoJSON with an NCES Excel export on `Revit UniqueId`, outputs a CSV ready for Airtable import. Run with:
```
node scripts/geojson_to_airtable_csv.cjs
```
Paths are hardcoded at the top of the file. Update `EXCEL_PATH` and `GEOJSON_PATH` per project. Uses `xlsx` from `ai-server/node_modules/`.

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

### Sarpy AI server not yet seeded with room data

`mapfluence-sarpy-ai.onrender.com` is deployed and wired into `SarpyCounty.json`, but the Sarpy Airtable base needs the JJC room records imported before the admin panel room edit flow will work end-to-end. The import CSV is at `C:\temp\Sarpy\Juvenile Justice Center\JJC_Airtable_Import.csv` (137 rooms, all GUIDs attached). Import it into the Sarpy Airtable base before testing admin room saves.

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

*Last updated: 2026-06-22 (session 3) — update this file whenever the architecture, client list, or critical behavior changes.*
