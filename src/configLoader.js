// --- IMPORT ALL ASSETS DIRECTLY ---

// 1. Config data
import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// 2. GeoJSON data
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';

// 3. Image assets
import clarkEnersenLogo from './assets/Clark_Enersen_Logo.png';
import hastingsLogo from './assets/HC_image.png';
import rockhurstLogo from './assets/RockurstU_Logo.png';


// --- ASSEMBLE THE FINAL CONFIG OBJECTS ---

// We build the complete objects here, replacing the filename strings
// with the actual imported asset variables.
const finalHastingsConfig = {
  ...hastingsConfigData,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
  logos: {
    clarkEnersen: clarkEnersenLogo,
    university: hastingsLogo,
  }
};

const finalRockhurstConfig = {
  ...rockhurstConfigData,
  buildings: rockhurstBuildings,
  boundary: rockhurstBoundary,
  logos: {
    clarkEnersen: clarkEnersenLogo,
    university: rockhurstLogo,
  }
};

// --- EXPORT A SIMPLE FUNCTION TO GET THE CONFIG ---

const universityConfigs = {
  hastings: finalHastingsConfig,
  rockhurst: finalRockhurstConfig,
};

export function getConfig(universityId) {
  return universityConfigs[universityId];
}
