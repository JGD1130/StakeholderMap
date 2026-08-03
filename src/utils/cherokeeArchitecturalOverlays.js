import * as turf from '@turf/turf';

const featureCollection = (features = []) => ({
  type: 'FeatureCollection',
  features
});

const finitePoint = (feature) => {
  const coordinates = feature?.geometry?.coordinates;
  return feature?.geometry?.type === 'Point' &&
    Array.isArray(coordinates) &&
    Number.isFinite(coordinates[0]) &&
    Number.isFinite(coordinates[1]);
};

const roomBoundaryFeatures = (roomsFC) => {
  const boundaries = [];
  for (const feature of roomsFC?.features || []) {
    const type = feature?.geometry?.type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
    try {
      const converted = turf.polygonToLine(feature);
      if (converted?.type === 'FeatureCollection') {
        boundaries.push(...(converted.features || []));
      } else if (converted?.geometry) {
        boundaries.push(converted);
      }
    } catch {}
  }
  return boundaries;
};

const nearestBoundaryPoint = (coordinates, boundaries, maxDistanceMeters) => {
  const point = turf.point(coordinates);
  let nearest = null;
  let distanceMeters = Infinity;
  const [longitude, latitude] = coordinates;
  const latitudePadding = maxDistanceMeters / 111320;
  const longitudePadding = latitudePadding / Math.max(Math.cos(latitude * Math.PI / 180), 0.1);

  for (const { feature: boundary, bbox } of boundaries) {
    const [minX, minY, maxX, maxY] = bbox;
    if (longitude < minX - longitudePadding || longitude > maxX + longitudePadding ||
        latitude < minY - latitudePadding || latitude > maxY + latitudePadding) continue;
    try {
      const candidate = turf.nearestPointOnLine(boundary, point, { units: 'meters' });
      const candidateDistance = Number(candidate?.properties?.dist);
      if (!Number.isFinite(candidateDistance) || candidateDistance >= distanceMeters) continue;
      nearest = candidate;
      distanceMeters = candidateDistance;
    } catch {}
  }

  return nearest ? {
    coordinates: nearest.geometry.coordinates,
    distanceMeters
  } : null;
};

const destinationCoordinates = (origin, distanceMeters, bearing) => (
  turf.destination(turf.point(origin), distanceMeters, bearing, { units: 'meters' })
    .geometry.coordinates
);

export function buildCherokeeDoorLinework(doorsFC, roomsFC, options = {}) {
  const maxSnapMeters = Number.isFinite(options.maxSnapMeters) ? options.maxSnapMeters : 1.25;
  const leafLengthMeters = Number.isFinite(options.leafLengthMeters) ? options.leafLengthMeters : 0.9;
  const arcSegments = Number.isFinite(options.arcSegments) ? Math.max(4, options.arcSegments) : 8;
  const boundaries = roomBoundaryFeatures(roomsFC).map((feature) => ({
    feature,
    bbox: turf.bbox(feature)
  }));
  if (!boundaries.length) return featureCollection([]);

  const features = [];
  for (const [index, door] of (doorsFC?.features || []).entries()) {
    if (!finitePoint(door)) continue;
    const bearing = Number(door?.properties?.bearing_deg);
    if (!Number.isFinite(bearing)) continue;

    const nearest = nearestBoundaryPoint(door.geometry.coordinates, boundaries, maxSnapMeters);
    if (!nearest || nearest.distanceMeters > maxSnapMeters) continue;

    const hinge = nearest.coordinates;
    const leafEnd = destinationCoordinates(hinge, leafLengthMeters, bearing);
    const arc = [];
    for (let index = 0; index <= arcSegments; index += 1) {
      const arcBearing = bearing + ((90 * index) / arcSegments);
      arc.push(destinationCoordinates(hinge, leafLengthMeters, arcBearing));
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [hinge, leafEnd],
          arc
        ]
      },
      properties: {
        ...(door.properties || {}),
        RevitId: 'cherokee-door-' + index,
        Element: 'Drawing',
        Layer: 'A-DOOR',
        type: 'drawing',
        interactive: false,
        __mfOverlayKind: 'cherokee-door-linework',
        __mfSourceRevitId: door?.properties?.RevitId ?? door?.properties?.id ?? null,
        __mfSnapDistanceMeters: nearest.distanceMeters
      }
    });
  }

  return featureCollection(features);
}

const clusterPointFeatures = (features, clusterDistanceMeters) => {
  const clusters = [];

  for (const feature of features) {
    if (!finitePoint(feature)) continue;
    const coordinates = feature.geometry.coordinates;
    let target = null;
    let targetDistance = Infinity;

    for (const cluster of clusters) {
      const distance = turf.distance(
        turf.point(coordinates),
        turf.point(cluster.center),
        { units: 'meters' }
      );
      if (distance <= clusterDistanceMeters && distance < targetDistance) {
        target = cluster;
        targetDistance = distance;
      }
    }

    if (!target) {
      clusters.push({ center: [...coordinates], coordinates: [[...coordinates]], feature });
      continue;
    }

    target.coordinates.push([...coordinates]);
    target.center = [
      target.coordinates.reduce((sum, point) => sum + point[0], 0) / target.coordinates.length,
      target.coordinates.reduce((sum, point) => sum + point[1], 0) / target.coordinates.length
    ];
  }

  return clusters;
};

const clusterBearing = (cluster) => {
  if (cluster.coordinates.length < 2) return 0;
  let endpoints = null;
  let maxDistance = -1;
  for (let left = 0; left < cluster.coordinates.length; left += 1) {
    for (let right = left + 1; right < cluster.coordinates.length; right += 1) {
      const distance = turf.distance(
        turf.point(cluster.coordinates[left]),
        turf.point(cluster.coordinates[right]),
        { units: 'meters' }
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        endpoints = [cluster.coordinates[left], cluster.coordinates[right]];
      }
    }
  }
  return endpoints ? turf.bearing(turf.point(endpoints[0]), turf.point(endpoints[1])) : 0;
};

const stairRoomFeatures = (roomsFC) => (roomsFC?.features || []).filter((feature) => {
  const type = feature?.geometry?.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return false;
  const properties = feature.properties || {};
  return [properties.NCES_Type, properties.Name, properties['Room Type']]
    .some((value) => /stair/i.test(String(value || '')));
});

const stairLines = (center, bearing, widthMeters, runMeters, treadCount) => {
  const lines = [];
  for (let index = 0; index < treadCount; index += 1) {
    const offset = -runMeters / 2 + ((runMeters * index) / (treadCount - 1));
    const treadCenter = destinationCoordinates(center, Math.abs(offset), offset < 0 ? bearing + 180 : bearing);
    const left = destinationCoordinates(treadCenter, widthMeters / 2, bearing - 90);
    const right = destinationCoordinates(treadCenter, widthMeters / 2, bearing + 90);
    lines.push([left, right]);
  }
  lines.push([
    destinationCoordinates(center, runMeters / 2, bearing + 180),
    destinationCoordinates(center, runMeters / 2, bearing)
  ]);
  return lines;
};

export function buildCherokeeStairLinework(stairsFC, roomsFC, options = {}) {
  const clusterDistanceMeters = Number.isFinite(options.clusterDistanceMeters)
    ? options.clusterDistanceMeters
    : 2.2;
  const widthMeters = Number.isFinite(options.widthMeters) ? options.widthMeters : 1.5;
  const runMeters = Number.isFinite(options.runMeters) ? options.runMeters : 2.0;
  const treadCount = Number.isFinite(options.treadCount) ? Math.max(4, options.treadCount) : 6;
  const stairRooms = stairRoomFeatures(roomsFC);

  if (stairRooms.length) {
    return featureCollection(stairRooms.map((room, index) => {
      const center = turf.pointOnFeature(room).geometry.coordinates;
      const [minX, minY, maxX, maxY] = turf.bbox(room);
      const horizontalMeters = turf.distance([minX, center[1]], [maxX, center[1]], { units: 'meters' });
      const verticalMeters = turf.distance([center[0], minY], [center[0], maxY], { units: 'meters' });
      const horizontal = horizontalMeters >= verticalMeters;
      const roomRun = Math.min(4.5, Math.max(1.2, Math.max(horizontalMeters, verticalMeters) * 0.62));
      const roomWidth = Math.min(3.0, Math.max(1.0, Math.min(horizontalMeters, verticalMeters) * 0.62));

      return {
        type: 'Feature',
        geometry: {
          type: 'MultiLineString',
          coordinates: stairLines(center, horizontal ? 90 : 0, roomWidth, roomRun, treadCount)
        },
        properties: {
          ...(room.properties || {}),
          RevitId: 'cherokee-stair-room-' + index,
          Element: 'Drawing',
          Layer: 'S-STRS',
          type: 'drawing',
          interactive: false,
          __mfOverlayKind: 'cherokee-stair-room-linework'
        }
      };
    }));
  }

  const clusters = clusterPointFeatures(stairsFC?.features || [], clusterDistanceMeters);
  return featureCollection(clusters.map((cluster, index) => {
    const bearing = clusterBearing(cluster);
    return {
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: stairLines(cluster.center, bearing, widthMeters, runMeters, treadCount)
      },
      properties: {
        ...(cluster.feature?.properties || {}),
        RevitId: 'cherokee-stair-' + index,
        Element: 'Drawing',
        Layer: 'S-STRS',
        type: 'drawing',
        interactive: false,
        bearing_deg: bearing,
        __mfOverlayKind: 'cherokee-stair-linework',
        __mfSourcePointCount: cluster.coordinates.length
      }
    };
  }));
}
