// src/configLoader.js --- SIMPLER CORRECT VERSION ---

// 1. Import the raw config data from src/Configs
import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// 2. Import the GeoJSON data
// We assume these files are moved to a folder like src/geojson
// If they are in /public, this static import method is tricky.
// Let's assume you move them to src/geojson for simplicity.
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import hastingsOutdoorSpaces from './geojson/HC_Outdoor_map.json'; // <-- Import new file

import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';


// ASSEMBLE THE FINAL CONFIG OBJECTS
const finalHastingsConfig = {
  ...hastingsConfigData,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
  outdoorSpaces: hastingsOutdoorSpaces, // <-- ADD THIS LINE
};

const finalRockhurstConfig = {
  ...rockhurstConfigData,
  buildings: rockhurstBuildings,
  boundary: rockhurstBoundary,
  // No outdoor spaces for Rockhurst, so we don't add the property
};

const universityConfigs = {
  hastings: finalHastingsConfig,
  rockhurst: finalRockhurstConfig,
};

export function getConfig(universityId) {
  return universityConfigs[universityId];
}
