# Hastings Pre-Release Go/No-Go Checklist
Date: March 18, 2026
Project: StakeholderMap (`/StakeholderMap`)

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
| `/hastings/admin` | Signed-in admin | Full Mapfluence admin controls (planning/AI/edit flows) visible and usable. | PENDING MANUAL |
| `/hastings/admin` | Signed out / non-admin | Admin sign-in visible; write actions should not proceed without admin role. | PENDING MANUAL |
| `/hastings/admin/engagement` | Signed-in admin | Workflow switch between `Stakeholder` and `Technical`; marker + archive tools writable; technical saves to cloud enabled. | PENDING MANUAL |
| `/hastings/admin/engagement` | Signed out / non-admin | Read-only messaging visible; no marker placement; archive/delete actions blocked; building condition toggle disabled. | PENDING MANUAL |
| `/hastings/engagement` | Any user | Public stakeholder engagement map works (marker add + heatmap/floorplan flows per current Firestore rules). | PENDING MANUAL |
| `/hastings/technical` | Signed-in admin | Technical panel cloud save works; progress/checklist reflects saved values. | PENDING MANUAL |
| `/hastings/technical` | Signed out / non-admin | Technical panel allows local draft autosave; cloud save blocked with clear message. | PENDING MANUAL |

## Manual Release Smoke Steps (Quick)
1. Open each URL in a fresh tab (avoid stale state).
2. Verify route title/subtitle at top of controls matches intended mode.
3. For admin routes, test both signed-out and signed-in-admin states.
4. In `/admin/engagement`:
   - Stakeholder mode: marker controls visible.
   - Technical mode: technical progress + panel behavior visible.
   - Confirm floorplan unload behavior when switching to technical.
5. Validate one cloud-save path:
   - Technical save (`Save to Cloud`) as admin.
   - Marker archive/undo in admin engagement.
6. Validate one export path:
   - Technical missing-items CSV.
   - Marker filtered CSV (admin engagement).

## Go/No-Go Rule
- **GO** when all matrix rows are manually verified and no blocking regressions are found.
- **NO-GO** if any of the following fails:
  - role gating (non-admin can perform admin writes),
  - technical cloud save as admin,
  - route separation (wrong controls on wrong URL),
  - critical exports.
