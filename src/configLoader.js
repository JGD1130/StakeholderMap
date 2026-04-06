import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';
import sarpyCountyConfigData from './Configs/SarpyCounty.json';

// Import raw GeoJSONs and parse them
import hastingsBuildingsRaw from './Configs/geojson/Hastings_College_Buildings.geojson?raw';
import hastingsBoundaryRaw from './Configs/geojson/Hastings_College_Boundary.geojson?raw';
import hastingsOutdoorRaw from './Configs/geojson/HC_Outdoor_map.geojson?raw';

import rockhurstBuildingsRaw from './Configs/geojson/RockhurstU_Buildings.geojson?raw';
import rockhurstBoundaryRaw from './Configs/geojson/RockhurstU_Boundary.geojson?raw';
import sarpyCountyBuildingsRaw from './Configs/geojson/SarpyCounty_Buildings.json?raw';
import sarpyCountyBoundaryRaw from './Configs/geojson/SarpyCounty_Boundary.json?raw';

function stripBom(text) {
  return (typeof text === 'string') ? text.replace(/^\uFEFF/, '') : text;
}

const hastingsBuildings = JSON.parse(stripBom(hastingsBuildingsRaw));
const hastingsBoundary = JSON.parse(stripBom(hastingsBoundaryRaw));
const hastingsOutdoorSpaces = JSON.parse(stripBom(hastingsOutdoorRaw));

const rockhurstBuildings = JSON.parse(stripBom(rockhurstBuildingsRaw));
const rockhurstBoundary = JSON.parse(stripBom(rockhurstBoundaryRaw));
const sarpyCountyBuildings = JSON.parse(stripBom(sarpyCountyBuildingsRaw));
const sarpyCountyBoundary = JSON.parse(stripBom(sarpyCountyBoundaryRaw));

function asConfig(objOrArray) {
  if (Array.isArray(objOrArray)) {
    return objOrArray[0] || {};
  }
  return objOrArray || {};
}

function normalizeBuildingFeatureCollection(input, fallbackPrefix = 'Building') {
  const source = (input && input.type === 'FeatureCollection' && Array.isArray(input.features))
    ? input
    : { type: 'FeatureCollection', features: [] };

  const seenIds = new Map();
  const features = source.features.map((feature, index) => {
    const safeFeature = (feature && typeof feature === 'object') ? feature : {};
    const props = (safeFeature.properties && typeof safeFeature.properties === 'object')
      ? { ...safeFeature.properties }
      : {};

    const rawName = String(props.name || props.Name || props.id || '').trim();
    const baseId = String(rawName || `${fallbackPrefix} ${index + 1}`).trim() || `${fallbackPrefix} ${index + 1}`;
    const seenCount = seenIds.get(baseId) || 0;
    seenIds.set(baseId, seenCount + 1);
    const id = seenCount ? `${baseId} (${seenCount + 1})` : baseId;

    props.id = id;
    if (!String(props.name || '').trim()) {
      props.name = rawName || id;
    }

    return {
      ...safeFeature,
      properties: props
    };
  });

  return {
    ...source,
    type: 'FeatureCollection',
    features
  };
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

const finalSarpyCountyConfig = {
  ...sarpyCountyBase,
  buildings: normalizeBuildingFeatureCollection(sarpyCountyBuildings, 'Sarpy Building'),
  boundary: sarpyCountyBoundary,
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
