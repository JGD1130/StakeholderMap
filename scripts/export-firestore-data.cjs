#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const turf = require('@turf/turf');

const args = process.argv.slice(2);
function getArg(name, fallbackNames = []) {
  const names = [name, ...fallbackNames];
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      return args[i + 1];
    }
    if (names.some(n => args[i].startsWith(`${n}=`))) {
      return args[i].split('=')[1];
    }
  }
  return undefined;
}

const serviceAccountPath = getArg('--serviceAccount', ['--sa']);
const universityId = (getArg('--university', ['-u']) || '').toLowerCase();
const projectId = getArg('--project', ['-p']);

if (!serviceAccountPath) {
  console.error('Missing --serviceAccount path to a Firebase service-account JSON file.');
  process.exit(1);
}
if (!universityId) {
  console.error('Missing --university (e.g., hastings or rockhurst).');
  process.exit(1);
}

const resolvedServiceAccount = path.resolve(serviceAccountPath);
if (!fs.existsSync(resolvedServiceAccount)) {
  console.error(`Service-account file not found: ${resolvedServiceAccount}`);
  process.exit(1);
}

const serviceAccount = require(resolvedServiceAccount);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: projectId || serviceAccount.project_id,
});

const db = admin.firestore();

db.settings({ ignoreUndefinedProperties: true });

const repoRoot = path.resolve(__dirname, '..');

const universityConfigMap = {
  hastings: {
    config: path.join(repoRoot, 'src', 'Configs', 'Hastings.json'),
    buildings: path.join(repoRoot, 'src', 'geojson', 'Hastings_College_Buildings.json'),
    outdoor: path.join(repoRoot, 'src', 'geojson', 'HC_Outdoor_map.json'),
  },
  rockhurst: {
    config: path.join(repoRoot, 'src', 'Configs', 'Rockhurst.json'),
    buildings: path.join(repoRoot, 'src', 'geojson', 'RockhurstU_Buildings.json'),
  },
};

function normalizeConfig(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.reduce((acc, entry) => {
      if (entry && typeof entry === 'object') {
        return { ...acc, ...entry };
      }
      return acc;
    }, {});
  }
  return raw;
}

function loadUniversityConfig(id) {
  const entry = universityConfigMap[id];
  if (!entry) {
    throw new Error(`No config mapping found for university "${id}".`);
  }

  const configRaw = JSON.parse(fs.readFileSync(entry.config, 'utf8'));
  const baseConfig = normalizeConfig(configRaw);
  const buildings = JSON.parse(fs.readFileSync(entry.buildings, 'utf8'));
  const outdoorSpaces = entry.outdoor ? JSON.parse(fs.readFileSync(entry.outdoor, 'utf8')) : undefined;

  return {
    ...baseConfig,
    buildings,
    outdoorSpaces,
  };
}

function getFeatureId(feature) {
  if (!feature || !feature.properties) return '';
  return (
    feature.properties.id ||
    feature.id ||
    feature.properties.ID ||
    feature.properties.name ||
    feature.properties.Name ||
    feature.properties.title ||
    feature.properties["Outdoor Space"] ||
    feature.properties.outdoorSpace ||
    ''
  );
}

function escapeCsv(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function coordinatesFromGeoPoint(value) {
  if (!value) return null;
  if (typeof value.longitude === 'number' && typeof value.latitude === 'number') {
    return [value.longitude, value.latitude];
  }
  if (Array.isArray(value) && value.length === 2) {
    return [Number(value[0]), Number(value[1])];
  }
  return null;
}

async function exportUniversity(universityId) {
  const config = loadUniversityConfig(universityId);
  const markerSnap = await db.collection('universities').doc(universityId).collection('markers').get();
  const pathSnap = await db.collection('universities').doc(universityId).collection('paths').get();
  const conditionsSnap = await db.collection('universities').doc(universityId).collection('buildingConditions').get();
  const assessmentsSnap = await db.collection('universities').doc(universityId).collection('buildingAssessments').get();

  console.log(`Fetched ${markerSnap.size} markers, ${pathSnap.size} paths, ${conditionsSnap.size} conditions, ${assessmentsSnap.size} assessments.`);

  const buildingFeatures = config?.buildings?.features || [];
  const bufferedBuildings = buildingFeatures
    .map((feature) => {
      const id = getFeatureId(feature);
      if (!id || !feature.geometry) {
        return null;
      }
      const buffered = turf.buffer(feature, 5, { units: 'meters' });
      return { id, geometry: buffered.geometry };
    })
    .filter(Boolean);

  const outdoorFeatures = config?.outdoorSpaces?.features || [];

  const rows = [];

  // Technical Assessment rows
  rows.push(['DataType', 'LocationID', 'Category', 'SubCategory', 'Score', 'Notes'].join(','));
  assessmentsSnap.forEach((doc) => {
    const data = doc.data() || {};
    const buildingId = data.originalId || data.buildingId || doc.id.replace(/__/g, '/');
    const buildingName = data.buildingName || buildingId;
    const notes = data.notes || '';
    if (data.scores) {
      Object.entries(data.scores).forEach(([category, subScores]) => {
        Object.entries(subScores || {}).forEach(([subCategory, score]) => {
          rows.push([
            escapeCsv('TechnicalAssessment'),
            escapeCsv(buildingName),
            escapeCsv(category),
            escapeCsv(subCategory),
            escapeCsv(score),
            escapeCsv(notes),
          ].join(','));
        });
      });
    }
  });

  rows.push('');
  rows.push(['DataType', 'LocationID', 'ID', 'Type', 'Persona', 'Latitude', 'Longitude', 'Comment', 'PathCoordinatesJSON'].join(','));

  markerSnap.forEach((doc) => {
    const data = doc.data() || {};
    const lonLat = coordinatesFromGeoPoint(data.coordinates);
    if (!lonLat) {
      return;
    }
    const markerPoint = turf.point(lonLat);
    let locationId = '';

    for (const building of bufferedBuildings) {
      if (turf.booleanPointInPolygon(markerPoint, building.geometry)) {
        locationId = building.id;
        break;
      }
    }

    if (!locationId) {
      for (const space of outdoorFeatures) {
        if (!space?.geometry) continue;
        if (turf.booleanPointInPolygon(markerPoint, space.geometry)) {
          locationId = getFeatureId(space) || '';
          break;
        }
      }
    }

    rows.push([
      escapeCsv('Marker'),
      escapeCsv(locationId),
      escapeCsv(doc.id),
      escapeCsv(data.type || ''),
      escapeCsv(data.persona || ''),
      escapeCsv(lonLat[1]),
      escapeCsv(lonLat[0]),
      escapeCsv(data.comment || ''),
      ''
    ].join(','));
  });

  pathSnap.forEach((doc) => {
    const data = doc.data() || {};
    const coordinates = (data.coordinates || []).map((entry) => {
      const pair = coordinatesFromGeoPoint(entry);
      return pair ? [pair[0], pair[1]] : null;
    }).filter(Boolean);

    rows.push([
      escapeCsv('Path'),
      '',
      escapeCsv(doc.id),
      escapeCsv(data.type || ''),
      '',
      '',
      '',
      '',
      escapeCsv(JSON.stringify(coordinates))
    ].join(','));
  });

  conditionsSnap.forEach((doc) => {
    const data = doc.data() || {};
    const condition = data.condition;
    if (!condition) return;
    const location = data.originalId || doc.id.replace(/__/g, '/');
    rows.push([
      escapeCsv('StakeholderCondition'),
      escapeCsv(location),
      '',
      escapeCsv(condition),
      '',
      '',
      '',
      '',
      ''
    ].join(','));
  });

  const outputDir = path.join(repoRoot, 'exports');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
  const outputPath = path.join(outputDir, `${universityId}-map-data-export-${timestamp}.csv`);
  fs.writeFileSync(outputPath, rows.join('\n'), 'utf8');

  console.log(`Export written to ${outputPath}`);
}

exportUniversity(universityId)
  .then(() => {
    console.log('Export complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Export failed:', err);
    process.exit(1);
  });

