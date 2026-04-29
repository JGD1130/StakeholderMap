# Hastings Pre-Release Go/No-Go Checklist
Date: March 18, 2026
Project: StakeholderMap (`/StakeholderMap`)

## Env Baseline
- Verify deploy secrets/vars using `docs/DEPLOY_ENV_VARS.md` (especially `VITE_MAPBOX_PUBLIC_TOKEN`).

## Current Validation Snapshot
| Check | Status | Notes |
|---|---|---|
| `npm.cmd run smoke` | GO | Passed `24/24` checks (routes + role guardrails + critical map behaviors). |
| `npm.cmd run build` | GO | Build passes. |
| Firestore role gating in code | GO | Admin engagement write actions are admin-only. |
| Final browser smoke by operator | PENDING | Run the URL/auth checks below before stakeholder handoff. |

## URL + Auth Go/No-Go Matrix
| URL | Auth State | Expected Behavior | Status |
|---|---|---|---|
| `/hastings/admin` | Signed-in admin | Full Mapfluence admin controls visible; `Engagement` and `Technical` map views work from the main admin selector. | PENDING MANUAL |
| `/hastings/admin` | Signed out / non-admin | Admin sign-in visible; write actions should not proceed without admin role, including Engagement marker/archive tools. | PENDING MANUAL |
| `/hastings/admin/engagement` | Any | Legacy admin workflow URL redirects to `/hastings/admin`. | PENDING MANUAL |
| `/hastings/admin/technical` | Any | Legacy admin technical URL redirects to `/hastings/admin`. | PENDING MANUAL |
| `/hastings/engagement` | Any user | Public stakeholder engagement map works (marker add + heatmap/floorplan flows per current Firestore rules). | PENDING MANUAL |
| `/hastings/technical` | Signed-in admin | Technical panel cloud save works; progress/checklist reflects saved values. | PENDING MANUAL |
| `/hastings/technical` | Signed out / non-admin | Technical panel supports full assessment workflow, including cloud save for selected users. | PENDING MANUAL |

## Manual Release Smoke Steps (Quick)
1. Open each URL in a fresh tab (avoid stale state).
2. In a fresh incognito/private window, open `/hastings` and verify the map loads without any token prompt modal.
3. Verify route title/subtitle at top of controls matches intended mode.
4. For admin routes, test both signed-out and signed-in-admin states.
5. In `/admin`:
   - Map View `Engagement`: marker controls visible.
   - Map View `Technical`: technical progress + panel behavior visible.
   - Confirm floorplan unload behavior when switching to technical.
6. Validate one cloud-save path:
   - Technical save (`Save to Cloud`) as admin.
   - Marker archive/undo in admin Engagement view.
7. Validate one export path:
   - Technical missing-items CSV.
   - Marker filtered CSV (admin Engagement view).

## Go/No-Go Rule
- **GO** when all matrix rows are manually verified and no blocking regressions are found.
- **NO-GO** if any of the following fails:
  - role gating (non-admin can perform admin writes),
  - technical cloud save as admin,
  - route separation (wrong controls on wrong URL),
  - critical exports.
