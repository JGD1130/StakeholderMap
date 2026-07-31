# Tenant Runtime Split

Updated: 2026-07-31

## Purpose

Hastings College, Sarpy County, and Cherokee Mental Health share the Mapfluence frontend, but they do not share data policies. Tenant-specific changes must be made through the tenant adapter instead of relying on pathname checks, default AI-server behavior, or implicit Airtable assumptions.

## Current Boundary

`src/tenants/mapTenantAdapter.js` owns tenant policy for:

- Airtable enablement and API scope hints
- Department-option endpoint availability
- Airtable-versus-floorplan room precedence
- Sarpy public floor asset selection
- Floorplan building discovery and campus room filtering
- Tenant dashboard and overlay capabilities

`src/tenants/mapTenantRuntime.js` resolves those policies once for the active tenant. `StakeholderMap.jsx` consumes the runtime policy for Airtable initialization, refresh, room hydration, floor asset selection, and tenant-only technical features.

## Tenant Rules

- Hastings keeps Airtable sync enabled, uses its existing generic scope hints, and preserves floorplan room data precedence.
- Sarpy uses explicit Sarpy scope hints, Airtable room precedence, Sarpy public floor assets, and does not call the unavailable department-list endpoint.
- Cherokee does not initialize, refresh, or scope Airtable data and does not inherit another tenant's Airtable rows.

## Guardrails

Run both checks before publishing:

```text
npm run build
npm run smoke
npm run smoke:tenants
```

The tenant smoke check is intentionally static because this project uses Vite extensionless imports that cannot be imported directly by Node without changing the browser build's module-resolution assumptions.

## Deployment Limitation

This is a code-level tenant boundary inside the shared frontend. GitHub Pages still publishes one bundle, so tenant policy code remains in the same build artifact. Absolute release isolation would require separate frontend deployment targets and independent promotion workflows. Until that is done, tenant changes must pass the tenant smoke check and Hastings sanity checks before publishing.

## Do Not Reopen During Tenant Split

Floorplan geometry transforms, wall alignment, door/stair overlays, and Sarpy asset geometry are intentionally out of scope for this split. Those are tenant data/asset issues and should be repaired only after this boundary is stable.