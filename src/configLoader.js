import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';
import sarpyCountyConfigData from './Configs/SarpyCounty.json';

// Import raw GeoJSONs and parse them
import hastingsBuildingsRaw from './Configs/geojson/Hastings_College_Buildings.geojson?raw';
import hastingsBoundaryRaw from './Configs/geojson/Hastings_College_Boundary.geojson?raw';
import hastingsOutdoorRaw from './Configs/geojson/HC_Outdoor_map.geojson?raw';

import rockhurstBuildingsRaw from './Configs/geojson/RockhurstU_Buildings.geojson?raw';
import rockhurstBoundaryRaw from './Configs/geojson/RockhurstU_Boundary.geojson?raw';

function stripBom(text) {
  return (typeof text === 'string') ? text.replace(/^\uFEFF/, '') : text;
}

const hastingsBuildings = JSON.parse(stripBom(hastingsBuildingsRaw));
const hastingsBoundary = JSON.parse(stripBom(hastingsBoundaryRaw));
const hastingsOutdoorSpaces = JSON.parse(stripBom(hastingsOutdoorRaw));

const rockhurstBuildings = JSON.parse(stripBom(rockhurstBuildingsRaw));
const rockhurstBoundary = JSON.parse(stripBom(rockhurstBoundaryRaw));

function asConfig(objOrArray) {
  if (Array.isArray(objOrArray)) {
    return objOrArray[0] || {};
  }
  return objOrArray || {};
}

const hastingsBase = asConfig(hastingsConfigData);
const rockhurstBase = asConfig(rockhurstConfigData);
const sarpyCountyBase = asConfig(sarpyCountyConfigData);

const emptyFeatureCollection = { type: 'FeatureCollection', features: [] };

// Merge with JSON configs
const finalHastingsConfig = {
  ...hastingsBase,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
  outdoorSpaces: hastingsOutdoorSpaces,
};

const finalRockhurstConfig = {
  ...rockhurstBase,
  buildings: rockhurstBuildings,
  boundary: rockhurstBoundary,
};

// Sarpy shell config intentionally starts with empty feature collections.
// Building/boundary GeoJSON can be added later without impacting Hastings.
const finalSarpyCountyConfig = {
  ...sarpyCountyBase,
  buildings: emptyFeatureCollection,
  boundary: emptyFeatureCollection,
  outdoorSpaces: emptyFeatureCollection,
};

const universityConfigs = {
  hastings: finalHastingsConfig,
  'hastings-demo': finalHastingsConfig,
  rockhurst: finalRockhurstConfig,
  'sarpy-county': finalSarpyCountyConfig,
  sarpy: finalSarpyCountyConfig,
  'sarpy-ne': finalSarpyCountyConfig,
};

export function getConfig(universityId) {
  return universityConfigs[universityId];
}
