# Sarpy County Rollout Checklist (Hastings-safe)

Use this runbook to onboard Sarpy data in stages without changing Hastings behavior.

## Current baseline

- Tenant scaffold branch/tag are pinned at commit `5e0e6af`.
- Sarpy tenant aliases resolve:
  - `/sarpy/admin`
  - `/sarpy/engagement`
  - `/sarpy/<persona>`
- Sarpy config shell exists in `src/Configs/SarpyCounty.json` with empty GeoJSON placeholders.

## Guardrails (do not skip)

- Keep Hastings files and IDs unchanged.
- Keep Sarpy data under separate namespaces only:
  - `universities/sarpy-county/...` (Firestore)
  - Sarpy-only Airtable base or strictly filtered Sarpy views
  - `public/floorplans/SarpyCounty/...` (assets)
- Validate locally first (`npm start`) before any publish step.

## Stage 1: Building outlines

1. Prepare Sarpy building polygons as GeoJSON (`FeatureCollection`).
2. Required building feature properties:
   - `id` (stable unique key, no duplicates)
   - `name` (display label)
3. Prepare Sarpy campus boundary GeoJSON (`FeatureCollection`).
4. Optional: outdoor spaces GeoJSON if needed.

Deliverables:

- `src/Configs/geojson/SarpyCounty_Buildings.geojson`
- `src/Configs/geojson/SarpyCounty_Boundary.geojson`
- (optional) `src/Configs/geojson/SarpyCounty_Outdoor.geojson`

Code updates:

- Import and parse these in `src/configLoader.js`.
- Replace Sarpy empty placeholder collections with parsed Sarpy collections.

Acceptance check:

- `/StakeholderMap/sarpy/admin` loads map and selectable Sarpy buildings.
- No console errors from missing `id`/`name`.

## Stage 2: Floorplan asset structure

Create floorplan folders under:

- `public/floorplans/SarpyCounty/<BuildingFolder>/manifest.json`
- `public/floorplans/SarpyCounty/<BuildingFolder>/Rooms/<FLOOR>_Dept_Rooms.geojson`

Required points:

- Building folder key must match the map lookup key.
- Floor IDs should stay normalized (`LEVEL_1`, `LEVEL_2`, etc.).
- Room feature properties should include stable room identifiers and room number/label fields for Airtable matching.

Acceptance check:

- In Sarpy floor panel, building + floor dropdowns populate.
- `Load` shows room polygons and labels for each mapped floor.

## Stage 3: Building/floor mapping sheet (fill this first)

Use `docs/templates/SARPY_BUILDING_INVENTORY_TEMPLATE.csv` to define:

- `building_id` (stable key used in GeoJSON `properties.id`)
- `building_name` (label shown to users)
- `building_folder` (folder under `public/floorplans/SarpyCounty/`)
- `floors_expected` (semicolon-separated)
- `status` (`planned`, `ready`, `loaded`)

This sheet should be treated as source-of-truth during ingest.

## Stage 4: Airtable integration (Sarpy-safe)

1. Ensure Sarpy records are identifiable by building/floor/room keys.
2. Confirm room ID/guid fields used by the API update path exist in Sarpy view.
3. Verify occupancy/type/department fields align to the same field names used by current API layer.

Acceptance check:

- Editing a Sarpy room in admin map saves without 404/422.
- Refresh reflects updates from Airtable.
- Occupancy and Type legends match selected radio mode.

## Stage 5: Engagement instance setup

1. Open `/StakeholderMap/sarpy/engagement`.
2. Validate:
   - campus vs floor mode toggle
   - marker add/save
   - heatmap + room sentiment overlays
   - room sentiment solid/gradient controls
3. Keep demo marker taxonomy aligned with the trimmed Hastings set unless Sarpy requests changes.

## Stage 6: Optional technical assessments in engagement

If you want Architectural/Engineering/Space assessment controls enabled for Sarpy engagement:

1. Update `src/tenants/registry.js`:
   - set `features.enableEngagementTechnicalAssessment` to `true` for `sarpy-county`
2. Validate in `/sarpy/engagement` only.
3. Confirm Hastings remains unchanged.

## Stage 7: AI (Mapfluence) for Sarpy

1. Add Sarpy-specific docs to AI server.
2. Use Sarpy-specific `AI_DOC_FILE_IDS` and names in the Sarpy deployment env.
3. Keep model/token settings tuned to avoid TPM overages for large context questions.

Acceptance check:

- Narrative doc questions answer from Sarpy docs.
- Data questions still return accurate map/room stats.

## Final pre-share QA

- Route checks:
  - `/StakeholderMap/sarpy/admin`
  - `/StakeholderMap/sarpy/engagement`
  - `/StakeholderMap/sarpy/student` (or target persona)
- Data checks:
  - Building totals, room counts, occupancy/type legends
  - Marker colors/legend categories
  - No legacy Hastings artifacts in Sarpy views
- Performance checks:
  - Floor load time acceptable
  - No blocking console errors

## Rollback safety

If needed, inspect baseline without changing your working branch:

`git switch --detach sarpy-baseline-2026-03-02`

If you need to restore code on a branch, create a recovery branch first, then merge/cherry-pick selectively.
