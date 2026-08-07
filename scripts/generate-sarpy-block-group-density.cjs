'use strict';
/**
 * generate-sarpy-block-group-density.cjs
 *
 * Builds a static GeoJSON of Sarpy County, NE (FIPS 31153) Census block
 * group boundaries with population and population density, joining:
 *   - TIGERweb (boundaries + land area, no API key required)
 *   - Census ACS 5-year estimates, table B01003 (total population,
 *     requires CENSUS_API_KEY)
 *
 * Re-run this annually when the new ACS 5-year vintage is released
 * (usually each December/January) — bump ACS_YEAR below to match.
 *
 * Usage:
 *   node scripts/generate-sarpy-block-group-density.cjs [--env path/to/.env] [--out path/to/file.geojson]
 *
 * Credentials (create this file — never commit it):
 *   ai-server/.env.sarpy
 *     CENSUS_API_KEY=...   (free, instant signup: api.census.gov/data/key_signup.html)
 */

const fs = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

// ── Load env file ────────────────────────────────────────────────────────────
const ENV_FILE = flagVal('--env')
  ? path.resolve(flagVal('--env'))
  : path.join(__dirname, '..', 'ai-server', '.env.sarpy');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const cfg = { ...loadDotEnv(ENV_FILE), ...process.env };
const CENSUS_API_KEY = cfg.CENSUS_API_KEY;

if (!CENSUS_API_KEY) {
  console.error(
    `\nMissing CENSUS_API_KEY.\n` +
    `Create ${ENV_FILE} with:\n\n  CENSUS_API_KEY=your-key-here\n\n` +
    `Free instant signup: https://api.census.gov/data/key_signup.html\n`
  );
  process.exit(1);
}

// ── Geography / vintage ──────────────────────────────────────────────────────
const STATE_FIPS = '31';   // Nebraska
const COUNTY_FIPS = '153'; // Sarpy County
const ACS_YEAR = '2024';   // 2020-2024 ACS 5-year — bump annually

const SQM_PER_SQMI = 2589988.110336;

const TIGERWEB_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/10/query' +
  `?where=${encodeURIComponent(`STATE='${STATE_FIPS}' AND COUNTY='${COUNTY_FIPS}'`)}` +
  '&outFields=STATE,COUNTY,TRACT,BLKGRP,GEOID,NAME,AREALAND,AREAWATER' +
  '&outSR=4326' +
  '&f=geojson';

const ACS_URL =
  `https://api.census.gov/data/${ACS_YEAR}/acs/acs5` +
  '?get=NAME,B01003_001E' +
  '&for=block%20group:*' +
  `&in=state:${STATE_FIPS}%20county:${COUNTY_FIPS}%20tract:*` +
  `&key=${CENSUS_API_KEY}`;

const OUT_PATH = flagVal('--out')
  ? path.resolve(flagVal('--out'))
  : path.join(__dirname, '..', 'public', 'Data', 'SarpyCounty_BlockGroup_Density.geojson');

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  console.log('Fetching block group boundaries from TIGERweb...');
  const boundaries = await fetchJson(TIGERWEB_URL, 'TIGERweb');
  if (!Array.isArray(boundaries?.features) || !boundaries.features.length) {
    throw new Error('TIGERweb returned no block group features for Sarpy County (31153). Check the query/service.');
  }
  console.log(`  ${boundaries.features.length} block groups.`);

  console.log(`Fetching ACS ${ACS_YEAR} 5-year population (table B01003) from the Census API...`);
  const acsRows = await fetchJson(ACS_URL, 'Census ACS');
  const [header, ...rows] = acsRows;
  const idx = {
    pop: header.indexOf('B01003_001E'),
    state: header.indexOf('state'),
    county: header.indexOf('county'),
    tract: header.indexOf('tract'),
    blkgrp: header.indexOf('block group')
  };
  if (Object.values(idx).some((i) => i === -1)) {
    throw new Error(`Unexpected ACS response header: ${JSON.stringify(header)}`);
  }

  const populationByGeoid = new Map();
  rows.forEach((row) => {
    const geoid = `${row[idx.state]}${row[idx.county]}${row[idx.tract]}${row[idx.blkgrp]}`;
    const population = Number(row[idx.pop]);
    populationByGeoid.set(geoid, Number.isFinite(population) ? population : null);
  });
  console.log(`  ${populationByGeoid.size} block group population rows.`);

  let unmatched = 0;
  const features = boundaries.features.map((feature) => {
    const props = feature.properties || {};
    const geoid = String(props.GEOID || '');
    const population = populationByGeoid.has(geoid) ? populationByGeoid.get(geoid) : null;
    if (population == null) unmatched += 1;

    const areaLandSqMeters = Number(props.AREALAND) || 0;
    const areaLandSqMi = areaLandSqMeters / SQM_PER_SQMI;
    const densitySqMi =
      Number.isFinite(population) && areaLandSqMi > 0 ? population / areaLandSqMi : null;

    return {
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        GEOID: geoid,
        NAME: props.NAME || '',
        population,
        areaLandSqMi: Number.isFinite(areaLandSqMi) ? Number(areaLandSqMi.toFixed(4)) : null,
        densitySqMi: Number.isFinite(densitySqMi) ? Number(densitySqMi.toFixed(1)) : null
      }
    };
  });

  if (unmatched > 0) {
    console.warn(`  Warning: ${unmatched} block group(s) had no matching ACS population row (left as null).`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        type: 'FeatureCollection',
        metadata: {
          county: 'Sarpy County, NE (FIPS 31153)',
          boundarySource: 'US Census Bureau TIGERweb, tigerWMS_Current, layer 10 (Census Block Groups)',
          populationSource: `US Census Bureau ACS 5-year ${ACS_YEAR} estimates, table B01003 (Total Population)`,
          densityUnits: 'people per square mile of land area (water area excluded)',
          generatedAt: new Date().toISOString(),
          regenerate: 'Re-run scripts/generate-sarpy-block-group-density.cjs annually when the new ACS 5-year vintage is released.'
        },
        features
      },
      null,
      2
    )
  );
  console.log(`Wrote ${features.length} features to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
