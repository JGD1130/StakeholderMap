# Hastings Client Go/No-Go Checklist
Date: July 15, 2026
Project: StakeholderMap (`/StakeholderMap`)

## Env Baseline
- Verify deploy secrets/vars using `docs/DEPLOY_ENV_VARS.md`.
- Confirm the current branch/build includes the Hastings client route and role-gating changes.
- Detailed live operator steps: docs/HASTINGS_CLIENT_ROLE_QA_RUNBOOK.md.

## Current Validation Snapshot
| Check | Status | Notes |
|---|---|---|
| `node scripts/smoke-check.mjs` | GO | Passed `62/62` checks covering Hastings client routes, canonical tenant IDs, role gates, tenant flags, Firestore rule wiring, and shared admin guardrails. |
| `npm.cmd run build` | GO | Build passes after the Hastings client QA fixes. |
| Static room-edit failure handling | GO | Client room edit now distinguishes no-op, full failure, and partial failure outcomes. |
| Final browser role-matrix smoke | PENDING | Run the URL/auth checks below before stakeholder handoff. |

## URL + Role Matrix
| URL | Auth State | Expected Behavior | Status |
|---|---|---|---|
| `/hastings` | Signed out | Public demo loads without auth prompt; no secure client controls; no room edit actions. | PENDING MANUAL |
| `/hastings/client` | Signed out | Secure gate blocks access and shows `Sign in to continue.` | PENDING MANUAL |
| `/hastings/client` | `viewer` | Client workspace loads; header shows `Read-only access`; `Space Data` only; no room edit button/action. | PENDING MANUAL |
| `/hastings/client` | `editor` | Client workspace loads; header shows `Room edits enabled`; room edit opens and save path works. | PENDING MANUAL |
| `/hastings/client` | `admin` | Client workspace loads; room edit works; internal-only admin tooling should still stay on `/hastings/admin`. | PENDING MANUAL |
| `/hastings-demo/client` | Signed out | Same secure gate behavior as `/hastings/client`. | PENDING MANUAL |
| `/hastings-demo/client` | `viewer` | Same workspace/data/role behavior as `/hastings/client`; alias should not split role docs or room data. | PENDING MANUAL |
| `/hastings-demo/client` | `editor` | Same edit behavior as `/hastings/client`; room save should target the canonical Hastings workspace. | PENDING MANUAL |
| `/hastings/admin` | Signed out / non-admin | Internal admin gate blocks access; no admin workspace should load. | PENDING MANUAL |
| `/hastings/admin` | `admin` | Full internal admin workspace loads with advanced controls and role manager. | PENDING MANUAL |
| `/hastings/admin/engagement` | Any | Redirects to `/hastings/admin`. | PENDING MANUAL |
| `/hastings/admin/technical` | Any | Redirects to `/hastings/admin`. | PENDING MANUAL |

## Manual Smoke Steps
1. Open `/hastings`, `/hastings/client`, `/hastings-demo/client`, and `/hastings/admin` in fresh tabs.
2. In an incognito/private window, verify `/hastings` stays public and both `/client` routes require sign-in.
3. Sign in as a Hastings `viewer` on both `/client` routes.
   - Confirm the header shows the signed-in email plus `(viewer)`.
   - Confirm the access summary reads `Read-only access`.
   - Open a floorplan room popup and confirm no `Edit` button appears.
4. Sign in as a Hastings `editor` on both `/client` routes.
   - Confirm the header shows `(editor)`.
   - Confirm the access summary reads `Room edits enabled`.
   - Open a room popup, launch room edit, change one low-risk field, save, and confirm the room refreshes without the old misleading `No changes detected` message.
5. If possible, verify the edited room changed in Airtable or in the next Airtable refresh path.
6. Sign in as Hastings `admin`.
   - Confirm `/hastings/client` still looks like the client workspace, not the full internal admin route.
   - Confirm `/hastings/admin` exposes the internal admin workspace and role manager.
7. Test alias consistency.
   - Repeat one viewer check and one editor save check on `/hastings-demo/client`.
   - Confirm behavior matches `/hastings/client` exactly.

## Go/No-Go Rule
- GO when all matrix rows are manually verified and no role/route regressions are found.
- NO-GO if any of the following fails:
  - signed-out users can reach `/client`,
  - `viewer` can edit rooms,
  - `editor` cannot save room edits,
  - `/hastings-demo/client` behaves differently from `/hastings/client`,
  - `/hastings/admin` is reachable by non-admin users.