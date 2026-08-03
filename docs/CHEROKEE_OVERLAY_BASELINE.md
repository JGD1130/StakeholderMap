# Cherokee Architectural Overlay Baseline

## Protected tenant behavior

- Cherokee Mental Health uses repository GeoJSON. It is not connected to Airtable.
- Cherokee room data and summaries must remain scoped to the CherokeeMentalHealth asset directory.
- Hastings and Sarpy overlay, Airtable, authentication, and floorplan paths must not be changed for Cherokee fixes.

## Floor adjustment rule

Cherokee doors and stairs are generated from the floor's Doors and Stairs point files. The generated vector lines must be appended to the same FLOOR_SOURCE FeatureCollection as the rooms.

Do not restore separate Cherokee door or stair Mapbox sources. Separate sources do not receive the room floorplan's rotate, move, scale, saved-adjustment, or reload transforms, which leaves the architecture floating when rooms move.

Generated architectural features are noninteractive drawing features with unique IDs. They are appended after room summary calculation so they cannot affect room counts, square footage, exports, or selection.

## Available detail

The repository currently contains Cherokee room polygons plus door and stair point files. It does not contain Cherokee wall, fixture, furniture, or DXF architectural linework.

Hastings-quality graphics come from architectural/DXF linework merged into the room GeoJSON. Reaching that same detail for Cherokee requires the original Cherokee architectural export. Synthetic doors and stairs can provide useful context, but they cannot reconstruct missing walls or fixtures accurately.

## Verification

Run npm.cmd run build and node scripts/cherokee-overlay-all-check.mjs.

The Cherokee overlay check validates all available floors, generated geometry metadata and IDs, and the shared-source wiring in StakeholderMap.jsx.
