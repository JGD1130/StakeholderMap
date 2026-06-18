# Mapfluence

Mapfluence is a multi-tenant geospatial intelligence platform built for higher education and public sector facility management. It combines interactive campus mapping, indoor floor plan visualization, AI-powered space planning, and real-time collaborative assessment tools in a single application — deployed to multiple clients from one shared codebase.

---

## Platform Overview

Mapfluence serves three distinct user types from the same deployment:

**Facilities administrators and planners** get an interactive campus map with building footprints, room-level floor plans, and a full suite of AI tools: natural-language space explanations at any zoom level, what-if relocation scenarios, and open Q&A against the live campus data. Real-time Firestore listeners mean annotations and assessment changes appear instantly for all collaborators.

**Public and stakeholder audiences** see a curated, read-only view of the campus — department occupancy, enrollment projections, and space summaries — with embedded survey flows for collecting facility feedback.

**Field assessors** complete structured building condition assessments from a mobile browser, upload photos to Firebase Storage organized by building, and export the full campus photo archive as a server-streamed ZIP.

---

## Tech Stack

### Frontend

| Layer | Technology |
|---|---|
| Framework | React 18, Vite 7 |
| Map engine | Mapbox GL JS 2.15 |
| Spatial analysis | Turf.js 7 |
| Real-time sync | Firebase Firestore (`onSnapshot` live listeners) |
| Auth | Firebase Auth — Google OAuth |
| File storage | Firebase Storage |
| PDF generation | jsPDF 3 |
| SVG parsing | svgson, svg-path-parser |
| Routing | React Router DOM 7 |

### AI Server

A separate Node.js/Express service on Render handles everything the browser can't: OpenAI proxying, Airtable reads and writes, server-side PDF/XLSX generation, and ZIP streaming. The browser never holds an API key.

| Layer | Technology |
|---|---|
| Runtime | Node.js ESM (`"type": "module"`) |
| Framework | Express 4 |
| AI | OpenAI SDK 4 (GPT-4o) |
| PDF | PDFKit |
| ZIP streaming | archiver |
| Spreadsheet parsing | SheetJS (xlsx) |
| Integrations | Airtable REST API |

**API surface:**

```
GET  /health                        liveness + AI usage stats
GET  /api/rooms                     proxy Airtable room data to the frontend
PATCH /api/rooms/:id                write room edits back to Airtable
PATCH /api/rooms                    batch room update
POST /explain-floor                 GPT-4o explanation of floor utilization
POST /explain-building              GPT-4o explanation of building utilization
POST /explain-campus                GPT-4o campus-wide utilization summary
POST /create-move-scenario          AI-generated department relocation plan
POST /compare-scenario              narrated diff: scenario vs baseline
POST /compare-scenario-vs-current   narrated diff: scenario vs current state
POST /ask                           open Q&A against campus data
POST /recommend                     AI space recommendations
POST /export-ai-pdf                 server-rendered PDF export
POST /api/photo-export              server-proxied ZIP of Firebase Storage photos
GET  /class-schedule                cached XLSX class schedule
GET  /enrollment-projections        enrollment projection data
GET  /ai/usage-summary              per-request token usage and cost tracking
```

### Infrastructure

| Concern | Solution |
|---|---|
| Frontend hosting | GitHub Pages — static Vite build |
| CI/CD | GitHub Actions — path-filtered, runs only on `src/` or `public/` changes |
| AI server hosting | Render — auto-deploys from `main` |
| Database | Firebase Firestore |
| File storage | Firebase Storage |
| Room data source | Airtable (per-deployment, configured via env vars) |

---

## Multi-Tenant Architecture

Every client runs from the same React codebase. Tenant identity resolves at runtime from the URL slug through a three-step lookup:

```
URL slug  →  registry.js  →  configId  →  src/Configs/{Tenant}.json
```

### Registry and Aliases

```js
// src/tenants/registry.js
resolveTenant('sarpy')          // → sarpy-county config
resolveTenant('hastings-demo')  // → hastings config (via alias)
getTenantFeatures('cherokee')   // → { enablePublicAiCreatePlanningScenario: false, ... }
```

Aliases allow a single config to surface under multiple slugs with different access modes — `hastings` loads the public map, `hastings/admin` loads the edit-mode map, both reading the same config file.

### Per-Tenant JSON Config

Each config drives map initialization, feature availability, and data sources:

```json
{
  "universityId": "sarpy-county",
  "universityName": "Sarpy County, NE",
  "enableDrawingEntry": true,
  "enableFloorplans": true,
  "floorplanCampus": "SarpyCounty",
  "style": "mapbox://styles/mapbox/streets-v12",
  "center": [-96.0804, 41.1367],
  "zoom": 11.2,
  "pitch": 39
}
```

### Per-Tenant Feature Flags

Feature flags in the registry gate capabilities without touching shared component code:

```js
features: {
  enableEngagementTechnicalAssessment: false,
  enablePublicAiCreatePlanningScenario: false
}
```

One tenant can expose "Create planning scenario" in the public AI panel while another hides it — same component tree, different flag.

### Access Modes

URL path and auth state resolve to one of four modes at runtime:

| Mode | Access |
|---|---|
| Admin | Full edit: markers, floor labels, room data, assessments |
| Technical-only | Field assessor: structured assessment form, photo upload |
| Public readonly | Lightweight view using `_Public` GeoJSON variants; no edits |
| Public | Survey engagement, read-only map, AI Q&A |

---

## Floor Plan System

Floor plans are stored as GeoJSON and overlaid on the Mapbox canvas using affine coordinate transforms. Each building's `affine.json` encodes the pixel-to-lat/lng matrix that maps SVG-derived room polygons onto the satellite basemap.

### Asset Structure

```
public/floorplans/
  Hastings/
    Altman Hall/
      manifest.json     ← floor and room list metadata
      affine.json       ← pixel → lat/lng transform
      Rooms/            ← one GeoJSON file per room
      Doors/
      Stairs/
    ...                 ← 29 buildings
  SarpyCounty/
    AdministrationCourthouse/
    1102 Building/
```

### Room ID Canonicalization

A shared utility ensures identifiers are consistent across Airtable records, GeoJSON features, Firestore documents, and URL params:

```js
canon('Room 101B')           // → 'room_101b'
bId('Altman Hall')           // → 'altman_hall'
rId('LEVEL_1', 'Room 101B')  // → 'level_1__101b'
```

### Department Color System

68 named departments map to fixed hex colors for consistent visual identity across clients. Unmapped departments fall through to a 10-color hash palette. Colors feed directly into Mapbox `match` expressions on the room fill layer:

```js
getDeptColor('Biology')   // → '#17becf'
getDeptColor('Music')     // → '#9467bd'
DEPT_FILL_MATCH('dept')   // → Mapbox paint expression for the rooms layer
```

---

## AI Features

All AI calls route through the Express server. GPT-4o context is built server-side from structured room/floor/building data, so prompt construction and key management stay off the client.

### Space Explanations

At any level — floor, building, or campus — the platform generates a streaming GPT-4o summary of what's happening with the space. Input is a structured JSON snapshot (room counts, area breakdowns, top departments). The response streams live into the sidebar panel.

### Scenario Planning

An admin describes a relocation in plain language. The `create-move-scenario` endpoint generates a machine-readable move plan that the frontend applies to the live map. Scenarios compare against baseline or current state with narrated diffs of what changes and what the trade-offs are.

### Open Q&A

A context-aware endpoint answers free-form questions using the current campus data snapshot. Prompts are categorized (utilization, planning, history) and routed to purpose-built system prompts before reaching GPT-4o.

### Usage Tracking

Token consumption and cost are logged per request using Node.js `AsyncLocalStorage` for request-scoped context. Aggregated stats are available at `/ai/usage-summary`.

---

## Client Deployments

### Hastings College — Hastings, NE

Private liberal arts college using Mapfluence for strategic facilities planning. Full indoor floor plans for 29 campus buildings, room-level occupancy data sourced from Airtable, and enrollment projection modeling for 2026–2036. Admin and public-facing map modes deployed separately. AI planning scenario generation and open Q&A enabled for administrators.

### Sarpy County — Sarpy County, NE

County government deployment for public sector facility inventory. Multi-building county campus with indoor floor plans and department-level room assignments. The public-facing map loads lightweight `_Public` GeoJSON variants — metadata-stripped files that load significantly faster than the full admin dataset. Separate admin mode for internal facilities staff.

### Cherokee Mental Health Institute — Cherokee, IA

Mental health facility using Mapfluence for physical condition assessment. Field assessors complete structured building assessments from mobile browsers and upload photos to Firebase Storage, organized by building name. Administrators export all campus assessment photos as a server-streamed ZIP via the `/api/photo-export` endpoint, which proxies Firebase Storage downloads server-side to avoid browser CORS restrictions. Floor plan visualization is not deployed for this client.

---

## Repository Structure

```
├── src/
│   ├── components/
│   │   ├── StakeholderMap.jsx              ← core map component
│   │   ├── AssessmentPanel.jsx             ← technical assessment form
│   │   ├── BuildingInteractionPanel.jsx
│   │   ├── SpaceDashboardPanel.jsx
│   │   └── ...
│   ├── tenants/
│   │   └── registry.js                    ← tenant resolver and feature flags
│   ├── Configs/                            ← per-tenant JSON configs
│   ├── utils/
│   │   ├── idUtils.js                     ← canonical ID helpers
│   │   └── floorSummary.js                ← GeoJSON → AI context aggregation
│   ├── style/
│   │   └── roomColors.js                  ← 68-department color map + Mapbox expressions
│   ├── firebaseConfig.js
│   ├── surveyConfigs.js
│   └── App.jsx                            ← tenant resolution and route-to-mode mapping
├── ai-server/
│   ├── server.js                           ← Express API
│   └── package.json
├── public/
│   └── floorplans/                         ← GeoJSON assets by tenant and building
├── .github/
│   └── workflows/
│       └── deploy.yml                      ← path-filtered CI/CD
└── vite.config.js
```

---

## Local Development

```bash
npm install
cd ai-server && npm install && cd ..
npm run dev
```

Vite proxies `/api` → `localhost:5000` and `/ai` → `localhost:8787`. Add a `.env.local` with `VITE_MAPBOX_PUBLIC_TOKEN`.

The AI server reads `OPENAI_API_KEY` and optionally `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME` from its own `.env`. Without Airtable credentials it falls back to local `manifest.json` files.

---

## Deployment

GitHub Actions builds and deploys to GitHub Pages on pushes to `main` or `feature/multi-university-refactor` that touch `src/`, `public/`, `index.html`, `vite.config.js`, or `package.json`. The path filter prevents AI-server-only commits from triggering unnecessary frontend rebuilds.

The AI server auto-deploys to Render on every push to `main`.
