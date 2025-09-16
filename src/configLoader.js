// src/configLoader.js --- FINAL CORRECT VERSION ---

// 1. Import the raw config data from src/Configs
import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// 2. Import the GeoJSON data from src/geojson
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';

// ASSEMBLE THE FINAL CONFIG OBJECTS
const finalHastingsConfig = {
  ...hastingsConfigData,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
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
