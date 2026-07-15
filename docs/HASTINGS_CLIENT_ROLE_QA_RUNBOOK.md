# Hastings Client Role QA Runbook
Date: July 15, 2026
Audience: Operator running live browser QA against Hastings client access

## Purpose
Validate the live Hastings client role matrix end to end for:
- signed-out users
- `viewer`
- `editor`
- `admin`

This runbook is intended for manual browser verification on the deployed site.

## Test Accounts
Fill these in before starting.

| Role | Email | Expected Firestore role doc |
|---|---|---|
| `viewer` | `<viewer-email>` | `/universities/hastings/roles/{uid}` with `role: "viewer"` |
| `editor` | `<editor-email>` | `/universities/hastings/roles/{uid}` with `role: "editor"` |
| `admin` | `<admin-email>` | `/universities/hastings/roles/{uid}` with `role: "admin"` or global admin claim |

If any role doc is missing, fix that before browser QA.

## URLs To Test
Use the deployed GitHub Pages base:
- `https://jgd1130.github.io/StakeholderMap/hastings`
- `https://jgd1130.github.io/StakeholderMap/hastings/client`
- `https://jgd1130.github.io/StakeholderMap/hastings-demo/client`
- `https://jgd1130.github.io/StakeholderMap/hastings/admin`

## Recommended Test Room
Pick one room that meets all of these:
- It appears on a Hastings floorplan in both `/hastings/client` and `/hastings-demo/client`.
- It is low-risk to touch briefly.
- It already has stable data and is easy to relocate visually.

Preferred room characteristics:
- non-critical office, meeting room, or general classroom
- not a room whose real-time occupant/seat data is actively being used in a meeting
- not a room you expect another user to edit during QA

Record the chosen room before starting:
- Building: `<building-name>`
- Floor: `<floor-name>`
- Room label/number: `<room-label>`

## Safe Edit Pattern
Use the `Comments` field for the primary save check.

Temporary value to add:
- `QA role test 2026-07-15 <initials>`

Rollback value:
- restore the original `Comments` text exactly after verification

Reason:
- this exercises the real room-edit save path
- it avoids changing more sensitive operational fields like occupant or department unless needed

## Browser Setup
1. Open a private/incognito window for signed-out checks.
2. Open a separate normal window for signed-in checks.
3. Hard refresh each route during role changes.
4. Sign out fully before switching between viewer, editor, and admin tests.

## Signed-Out Checks
### Public route
1. Open `/hastings`.
2. Confirm the map loads.
3. Confirm no secure client gate appears.
4. Open the chosen room if possible and confirm there is no room edit action.

Pass criteria:
- public map works
- no forced sign-in
- no room edit access on public route

### Secure client routes
1. Open `/hastings/client`.
2. Open `/hastings-demo/client`.

Pass criteria:
- both routes stop at the secure gate
- both routes show `Sign in to continue.`
- neither route leaks client workspace content before sign-in

## Viewer Checks
1. Sign in as the `viewer` account.
2. Open `/hastings/client`.
3. Open `/hastings-demo/client`.

Confirm on both routes:
- header shows the signed-in email and `(viewer)`
- access summary says `Read-only access`
- route title says `Hastings College Client Workspace`
- only `Space Data` is present
- `Maintenance` is not visible
- the `Map View` selector is not shown
- opening the chosen room does not show an `Edit` button

Pass criteria:
- viewer can browse
- viewer cannot open room edit
- alias route matches primary route

## Editor Checks
1. Sign out.
2. Sign in as the `editor` account.
3. Open `/hastings/client`.
4. Navigate to the chosen room.

Confirm before saving:
- header shows `(editor)`
- access summary says `Room edits enabled`
- room popup shows the `Edit` action

Primary save test:
1. Open room edit.
2. Note the original `Comments` value.
3. Change `Comments` to `QA role test 2026-07-15 <initials>`.
4. Save.

Expected result:
- modal closes normally
- room popup refreshes
- no misleading `No changes detected` message appears
- no failure alert appears

Alias consistency test:
1. Open `/hastings-demo/client` while still signed in as `editor`.
2. Open the same room.
3. Confirm the updated `Comments` value is visible there too.

Rollback:
1. Reopen room edit on either client route.
2. Restore the original `Comments` value.
3. Save again.
4. Confirm the rollback appears on both `/hastings/client` and `/hastings-demo/client`.

Optional deeper check:
- If Airtable access is available, confirm the `Comments` field changed and then reverted there too.

Pass criteria:
- editor can open room edit
- editor can save and rollback successfully
- alias route shows the same data as the primary client route

## Admin Checks
1. Sign out.
2. Sign in as the `admin` account.
3. Open `/hastings/client`.
4. Open `/hastings/admin`.

Confirm on `/hastings/client`:
- it still looks like the client workspace
- it does not expose the full internal admin control surface
- room edit remains available

Confirm on `/hastings/admin`:
- internal admin workspace loads
- advanced admin controls are present
- role manager is visible

Redirect checks:
- `/hastings/admin/engagement` redirects to `/hastings/admin`
- `/hastings/admin/technical` redirects to `/hastings/admin`

Pass criteria:
- admin can use both routes in their intended shape
- client route stays client-shaped
- admin route stays internal-only

## Fail Conditions
Treat the run as failed if any of these happen:
- signed-out user reaches `/client` content
- `viewer` can edit a room
- `editor` cannot save a room comment change
- `/hastings-demo/client` differs from `/hastings/client`
- `/hastings/admin` is accessible to non-admin users
- save succeeds on one alias route but not the other

## Result Log
Fill this in at the end.

| Check | Result | Notes |
|---|---|---|
| Signed-out `/hastings` | `PASS / FAIL` | |
| Signed-out `/hastings/client` | `PASS / FAIL` | |
| Signed-out `/hastings-demo/client` | `PASS / FAIL` | |
| Viewer `/hastings/client` | `PASS / FAIL` | |
| Viewer `/hastings-demo/client` | `PASS / FAIL` | |
| Editor save `/hastings/client` | `PASS / FAIL` | |
| Editor alias consistency `/hastings-demo/client` | `PASS / FAIL` | |
| Editor rollback | `PASS / FAIL` | |
| Admin `/hastings/client` | `PASS / FAIL` | |
| Admin `/hastings/admin` | `PASS / FAIL` | |
| Admin redirects | `PASS / FAIL` | |