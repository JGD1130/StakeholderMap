# Hastings Role Admin Setup
Date: July 14, 2026
Project: Hastings client workspace

## What This Adds
The Hastings client rollout now has an admin-only role provisioning path built into the app.

Pieces:
- Secure client route: `/hastings/client`
- Internal admin route: `/hastings/admin`
- Admin-only `Client Access` panel in the Hastings admin controls
- Firebase callable functions:
  - `setUniversityUserRole`
  - `removeUniversityUserRole`

Supported client roles:
- `viewer`
- `editor`

Internal role:
- `admin`

## Important Deployment Note
This is not fully live until all three are deployed together:
1. Frontend app
2. Firebase Functions
3. Firestore rules

If only the frontend is deployed, the new Hastings admin panel may appear, but role changes will fail.

## Intended Provisioning Flow
1. Hastings user opens `/hastings/client`
2. User signs in with Google once
3. Jack opens `/hastings/admin`
4. In the `Client Access` panel:
   - enter the user's email
   - choose `Viewer` or `Editor`
   - click `Grant / Update Access`
5. Refresh the role list to confirm the user appears
6. User reloads `/hastings/client`

## Role Behavior
- `viewer`
  - can access the secure Hastings client workspace
  - can browse campus, buildings, floors, and rooms
  - cannot edit rooms
- `editor`
  - can do everything a viewer can do
  - can use room edit and save changes
- `admin`
  - internal/operator use only
  - retains full admin workspace access

## Current Guardrails
- Hastings is no longer treated as an open-pilot campus for write access
- Room edit in the client workspace depends on university role
- Admin route panel is feature-flagged for Hastings only
- Non-global admins cannot assign or remove the `admin` role through the new callable helpers

## If Role Assignment Fails
Expected common cause:
- The user has never signed in before

Expected message:
- Have them open the Hastings client workspace once, then try again

Other likely causes:
- Functions not deployed
- Firestore rules not deployed
- Admin account signed in without internal admin access

## Suggested Manual Smoke Test
1. Signed out: open `/hastings/client` and confirm sign-in is required
2. Sign in as Hastings `viewer`
   - route loads
   - read-only access is shown
   - room edit is not available
3. Sign in as Hastings `editor`
   - route loads
   - `Room edits enabled` is shown
   - one room edit saves successfully
4. Sign in as Jack on `/hastings/admin`
   - `Client Access` panel is visible
   - grant a test `viewer` role
   - refresh and confirm it appears in the list
   - remove the test role and confirm it disappears

## Next Good Follow-Up
If we want a fuller customer-admin experience later, the next logical step is a dedicated admin users page with search, audit timestamps, and bulk role actions. For now, the compact Hastings admin panel should be enough for controlled rollout.
