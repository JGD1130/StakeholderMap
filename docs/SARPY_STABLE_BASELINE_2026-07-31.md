# Sarpy Stable Baseline - 2026-07-31

## Locked Recovery Point

- Frontend source branch: `feature/multi-university-refactor`
- Known-good runtime commit: `b52fcb4a70d8e03aee22da82673dc91644ff9f4e`
- Recovery tag: `sarpy-stable-2026-07-31`

Sarpy-only work must branch from `feature/multi-university-refactor` and merge
back to that branch. Do not send Sarpy fixes through `main`, and do not change
Hastings or Cherokee runtime behavior while working on Sarpy.

## Confirmed Working

- The Sarpy admin map refreshes from the Sarpy Airtable base.
- Airtable is authoritative for room fields after **Refresh Airtable Data**.
- A blank Airtable Department is an explicit clear. The map must not retain an
  older department value from floorplan source data.
- The Facility Type legend, building markers, and building polygons use the
  same Sarpy category colors.
- Public Works is yellow. Administrative is blue, Law Enforcement is red,
  Recreation is green, and Infrastructure is gray.

## Deferred Until Next Session

Sarpy floorplan room geometry and companion drawing-line alignment remain open.
Do not alter room transforms, wall/door/stair overlays, or saved floorplan
adjustments as part of Airtable, summary, or legend changes. Begin the next
investigation with a Sarpy-only branch from this baseline and compare the
historic transform/overlay asset behavior before making a limited change.

## Verification Before Any Future Sarpy Merge

1. Hard-refresh `/sarpy-county/admin`.
2. Run **Refresh Airtable Data** and confirm the scoped-row count succeeds.
3. Confirm a room whose Airtable Department is blank does not show a stale
   department in the map.
4. Confirm the Facility Type legend is visible and markers and building
   footprints retain matching colors.
5. Smoke-test Hastings separately before merging, without modifying Hastings
   for a Sarpy-only fix.

## Recovery Procedure

If a later Sarpy-only change regresses this state, restore from
`sarpy-stable-2026-07-31` or revert that Sarpy pull request on
`feature/multi-university-refactor`. Do not revert or redeploy `main` as a
Sarpy recovery action.
