# Hastings Stable Baseline - 2026-07-29

This document records the Hastings College stable baseline after the Airtable/floorplan/class-schedule interruption fixes completed on July 29, 2026.

## Stable commits

- `main`: `62f13290912a7be2dde03900563e34330706085e`
- `feature/multi-university-refactor`: `cdf79a360126c82ac7ee3aea14f4e55419338d4f`

## Hastings behaviors that are considered stable and should be protected

1. Airtable refresh control is visible on Hastings and reports sync status normally.
2. Hastings client floorplans load without crashing the map.
3. Hastings room popups for classrooms show the weekly class schedule for the current block.
4. The classroom schedule popup uses the wider two-column layout so the right half of the panel is used.
5. The popup does not truncate the weekly day lists into a narrow single-column view.

## Do not change for Sarpy or Cherokee work without re-testing Hastings

- Shared popup layout logic in `src/components/StakeholderMap.jsx`
- Hastings Airtable refresh/status UI in `src/components/StakeholderMap.jsx`
- Hastings class schedule fetch and room-schedule rendering in `src/components/StakeholderMap.jsx`
- Hastings class schedule parsing/loading in `ai-server/server.js`
- Shared floorplan load / popup / panel logic used by Hastings

## Minimum re-test checklist before merging shared map changes

1. Open `hastings/client`
2. Confirm Airtable refresh button and sync status are visible
3. Load a Hastings floorplan such as Hurley-McDonald Hall
4. Click a classroom such as room 220
5. Confirm the popup shows `Weekly Class Schedule`
6. Confirm the popup shows the current block label
7. Confirm the schedule uses the wide two-column layout and fills the right side of the popup

## Recovery reference

If a future shared change breaks Hastings, start by comparing against these commits and restore the Hastings behavior before continuing with Sarpy or Cherokee work.