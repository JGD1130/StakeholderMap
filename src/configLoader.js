// src/configLoader.js --- CORRECTED VERSION ---

import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// Make sure all your geojson files are in a /src/geojson/ folder
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import hastingsOutdoorSpaces from './geojson/HC_Outdoor_map.json'; // <-- FIXED .geojson EXTENSION

import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';

const finalHastingsConfig = {
  ...hastingsConfigData,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
  outdoorSpaces: hastingsOutdoorSpaces,
};

const finalRockhurstConfig = {
  ...rockhurstConfigData,
  buildings: rockhurstBuildings,
  boundary: rockhurstBoundary,
};

const universityConfigs = {
  hastings: finalHastingsConfig,
  rockhurst: finalRockhurstConfig,
};

export function getConfig(universityId) {
  return universityConfigs[universityId];
}
