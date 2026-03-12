# Tenant Onboarding (Hastings-safe)

This repo now supports tenant scaffolding via `src/tenants/registry.js`.

## Current state

- `hastings` is active.
- `sarpy-county` has a scaffolded tenant + config shell (`src/Configs/SarpyCounty.json`).
- Sarpy currently uses empty buildings/boundary GeoJSON placeholders until data is loaded.
- Engagement technical assessment controls are feature-flagged per tenant:
  - `features.enableEngagementTechnicalAssessment`

## Add a new tenant without impacting Hastings

1. Add tenant metadata in `src/tenants/registry.js`
   - `id`, `configId`, `aliases`, `status`, `features`

2. Add a tenant config
   - Create `src/Configs/<Tenant>.json`
   - Add `floorplanCampus` (folder name under `public/floorplans/`)
   - Add building/boundary geojson imports in `src/configLoader.js`
   - Register config key in `universityConfigs`

3. Data isolation checklist
   - Firestore path namespace: `universities/<tenant-id>/...`
   - Marker/assessment/condition collections per tenant id
   - Floorplans under separate campus folder:
     - `public/floorplans/<floorplanCampus>/...`
   - Airtable:
     - separate base, or separate views with strict filter to tenant
   - AI docs:
     - separate `AI_DOC_FILE_IDS` and doc names per tenant deployment

4. Deploy safely
   - Use separate deployment target for tenant staging first.
   - Validate all routes:
     - `/<tenant>/admin`
     - `/<tenant>/engagement`
     - `/<tenant>/<persona>`
   - Promote to production after data + floorplan checks pass.

## Notes

- `StakeholderMap` now resolves floorplan paths from `config.floorplanCampus` (fallback remains `Hastings`).
- Engagement map view selector remains unchanged for Hastings.
- Technical assessment in engagement can be turned on later by setting:
  - `enableEngagementTechnicalAssessment: true` for that tenant.
- Sarpy implementation checklist:
  - `docs/SARPY_ROLLOUT_CHECKLIST.md`
  - `docs/templates/SARPY_BUILDING_INVENTORY_TEMPLATE.csv`
