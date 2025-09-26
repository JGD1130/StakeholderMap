// src/configLoader.js --- CORRECTED VERSION ---

import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// Make sure all your geojson files are in a /src/geojson/ folder
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import hastingsOutdoorSpaces from './geojson/HC_Outdoor_map.json';

import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';

const normalizeConfig = (rawConfig) => {
  if (!rawConfig) {
    return {};
  }
  if (Array.isArray(rawConfig)) {
    return rawConfig.reduce((acc, entry) => {
      if (entry && typeof entry === 'object') {
        return { ...acc, ...entry };
      }
      return acc;
    }, {});
  }
  return rawConfig;
};

const baseHastingsConfig = normalizeConfig(hastingsConfigData);
const baseRockhurstConfig = normalizeConfig(rockhurstConfigData);

const finalHastingsConfig = {
  ...baseHastingsConfig,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
  outdoorSpaces: hastingsOutdoorSpaces,
};

const finalRockhurstConfig = {
  ...baseRockhurstConfig,
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
