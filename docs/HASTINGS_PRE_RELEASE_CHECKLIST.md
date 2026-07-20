# Hastings Client Pre-Go-Live Checklist
Date: July 20, 2026
Project: StakeholderMap (`/StakeholderMap`)

## Goal
Use this checklist before live Hastings client handoff or wider campus rollout.

## Release Baseline
| Check | Status | Notes |
|---|---|---|
| GitHub Pages client/admin build | GO | Latest Hastings client fixes are pushed on `feature/multi-university-refactor`, including room edit audit history and history viewer. |
| `npm.cmd run build` | GO | Passed on July 20, 2026 after the edit history viewer change. |
| Firestore room-history rules | GO | Deployed to Firebase project `stakeholder-map-a4bdc` on July 20, 2026 at about 9:53 AM Central. |
| Building summary export room-type rollups | GO | Building summary CSV now populates room type rollups instead of returning all zeros. |
| Room edit audit trail | GO | Room edits now write actor metadata plus append-only history entries. |
| Final browser role + workflow QA | PENDING MANUAL | Run the manual checks below in the live Hastings environment. |

## Required Docs
- `docs/HASTINGS_CLIENT_ROLE_QA_RUNBOOK.md`
- `docs/HASTINGS_ROLE_ADMIN_SETUP.md`
- `docs/DEPLOY_ENV_VARS.md`
- `docs/DEPLOY_SAFETY_AND_ROLLBACK_PLAYBOOK.md`

## Route + Role Matrix
| URL | Auth State | Expected Behavior | Status |
|---|---|---|---|
| `/hastings` | Signed out | Public demo loads without auth prompt; no secure client controls; no room edit actions. | PENDING MANUAL |
| `/hastings/client` | Signed out | Secure gate blocks access and shows `Sign in to continue.` | PENDING MANUAL |
| `/hastings/client` | `viewer` | Client workspace loads; header shows `Read-only access`; no room edit action. | PENDING MANUAL |
| `/hastings/client` | `editor` | Client workspace loads; header shows `Room edits enabled`; room edit opens and save path works. | PENDING MANUAL |
| `/hastings/client` | `admin` | Client workspace loads in client mode; internal-only admin tooling stays on `/hastings/admin`. | PENDING MANUAL |
| `/hastings-demo/client` | Signed out | Same secure gate behavior as `/hastings/client`. | PENDING MANUAL |
| `/hastings-demo/client` | `viewer` | Same workspace/data/role behavior as `/hastings/client`. | PENDING MANUAL |
| `/hastings-demo/client` | `editor` | Same edit/save behavior as `/hastings/client`. | PENDING MANUAL |
| `/hastings/admin` | Signed out / non-admin | Internal admin gate blocks access. | PENDING MANUAL |
| `/hastings/admin` | `admin` | Full internal admin workspace loads with advanced controls and role manager. | PENDING MANUAL |
| `/hastings/admin/engagement` | Any | Redirects to `/hastings/admin`. | PENDING MANUAL |
| `/hastings/admin/technical` | Any | Redirects to `/hastings/admin`. | PENDING MANUAL |

## Data + Editing Checks
1. Open one low-risk room on `/hastings/client` as an `editor`.
2. Change one field such as `Comments` or `Department`, save, and confirm the room refreshes immediately.
3. Open the same room again as an `admin` and confirm `Edit History` loads.
4. Confirm the history panel shows:
   - the actor email
   - a timestamp
   - `Client room edit` or `Admin room edit`
   - field-level `Before` and `After` values
5. Open a room with no prior audit entries and confirm the panel shows `No recorded edits yet for this room.` instead of a permission error.
6. Run `Space Data Export -> Building summary` and confirm room-type rollup columns populate correctly for at least one known building.
7. If Airtable sync is part of the live workflow, confirm the edited field appears after the next refresh/sync path.

## Admin Readiness
- Confirm at least:
  - 1 Hastings admin user
  - 1 Hastings editor user
  - 1 Hastings viewer user
- Confirm role docs exist under `universities/hastings/roles/{uid}` for those users.
- Confirm the person performing support can reach `/hastings/admin`.
- Confirm someone on the team knows that GitHub Pages deploys do not deploy Firestore rules.

## Browser Smoke
1. Test `/hastings`, `/hastings/client`, and `/hastings/admin` in a normal signed-in browser.
2. Repeat the public/client gate checks in an incognito or private browser window.
3. Test at least one non-Chrome browser if Hastings users are likely to use Edge or Firefox.

## Go / No-Go
- GO when all route/role checks pass, one real edit succeeds, edit history loads for admin users, and the building summary export is correct.
- NO-GO if any of the following occurs:
  - signed-out users can reach `/client`
  - `viewer` can edit rooms
  - `editor` cannot save room edits
  - admin users see `Missing or insufficient permissions` in `Edit History`
  - a no-history room fails to show the empty-state message
  - building summary export rollups return zeros when known room types exist
  - `/hastings-demo/client` behaves differently from `/hastings/client`
  - `/hastings/admin` is reachable by non-admin users