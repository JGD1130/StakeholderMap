// src/utils/researchSpaceStatus.js
//
// F&A Compass (Hastings-only): the ONE place a room's classification status
// is derived, shared by ResearchSpaceClassificationPanel (room list, rollup)
// and the floorplan color mode in StakeholderMap.jsx, so the two can't drift.
//
// Status is never stored. It is derived from what Firestore holds:
//   - a researchSpaceRoomStatus doc for the room  -> 'excluded'
//       (vacant_unassigned / ineligible_non_assignable; mutually exclusive
//        with occupants, see researchSpaceClassification.js)
//   - else >= 1 researchSpaceOccupants doc        -> 'classified'
//   - else                                        -> 'not_started'
// (researchSpaceRoomStatus only ever holds the two exclusion states, so an
// empty collection is expected until a room is marked vacant/ineligible.)
import { buildRoomUtilizationMetaKey } from './roomUtilizationMeta';

export const RS_STATUS = {
  NOT_STARTED: 'not_started',
  CLASSIFIED: 'classified',
  EXCLUDED: 'excluded'
};

export const RS_STATUS_LABELS = {
  [RS_STATUS.NOT_STARTED]: 'Not started',
  [RS_STATUS.CLASSIFIED]: 'Classified',
  [RS_STATUS.EXCLUDED]: 'Excluded (vacant / ineligible)'
};

// Floorplan fills. Out-of-scope rooms use RS_OUT_OF_SCOPE_COLOR.
export const RS_STATUS_COLORS = {
  [RS_STATUS.NOT_STARTED]: '#f59e0b',
  [RS_STATUS.CLASSIFIED]: '#22c55e',
  [RS_STATUS.EXCLUDED]: '#94a3b8'
};
export const RS_OUT_OF_SCOPE_COLOR = '#e6e6e6';

export function deriveRoomStatus({ occupantCount = 0, exclusionStatus = '' } = {}) {
  if (exclusionStatus) return RS_STATUS.EXCLUDED;
  if (Number(occupantCount) > 0) return RS_STATUS.CLASSIFIED;
  return RS_STATUS.NOT_STARTED;
}

// roomKey -> status for every scope room.
export function buildStatusByRoomKey(scopeRooms, occupantCountByRoomKey, exclusionByRoomKey) {
  const out = new Map();
  (Array.isArray(scopeRooms) ? scopeRooms : []).forEach((room) => {
    out.set(room.roomKey, deriveRoomStatus({
      occupantCount: occupantCountByRoomKey?.get?.(room.roomKey) || 0,
      exclusionStatus: exclusionByRoomKey?.[room.roomKey] || ''
    }));
  });
  return out;
}

// Floorplan join. A floor feature belongs to the scope when
// buildRoomUtilizationMetaKey(<scope building name for that floorplan
// folder>, feature Number) is a scope roomKey. The scope's building name (the
// Airtable spelling) is used -- not the floorplan's -- so the key is exactly
// the one Firestore docs are saved under.
export function buildScopeFloorIndex(scopeRooms) {
  const buildingByFolder = new Map();
  const scopeKeys = new Set();
  (Array.isArray(scopeRooms) ? scopeRooms : []).forEach((room) => {
    scopeKeys.add(room.roomKey);
    if (room.folder && !buildingByFolder.has(room.folder)) {
      buildingByFolder.set(room.folder, room.building);
    }
  });
  return { buildingByFolder, scopeKeys };
}

// -> roomKey when this floorplan room is in the scope, else null.
export function resolveFloorFeatureRoomKey(index, folder, roomNumber) {
  if (!index || !folder) return null;
  const building = index.buildingByFolder.get(folder);
  if (!building) return null;
  const roomKey = buildRoomUtilizationMetaKey(building, String(roomNumber ?? '').trim());
  return roomKey && index.scopeKeys.has(roomKey) ? roomKey : null;
}

// Group a floor's features by status for the fill expression + legend.
// Duplicate polygons sharing one roomKey (e.g. Farrell-Fleharty FC-130 is
// drawn twice) each get the same status because every feature is resolved
// independently to the same roomKey. Returns
// { idsByStatus: {status: [id,...]}, scopedCount, totalRooms }.
export function groupFloorFeaturesByStatus(features, folder, index, statusByRoomKey) {
  const idsByStatus = {
    [RS_STATUS.NOT_STARTED]: [],
    [RS_STATUS.CLASSIFIED]: [],
    [RS_STATUS.EXCLUDED]: []
  };
  let totalRooms = 0;
  let scopedCount = 0;
  (Array.isArray(features) ? features : []).forEach((feature) => {
    const props = feature?.properties || {};
    if (props.Element !== 'Room') return;
    totalRooms += 1;
    const roomKey = resolveFloorFeatureRoomKey(index, folder, props.Number ?? props.RoomNumber ?? props.number);
    if (!roomKey) return;
    const id = feature.id ?? props.RevitId ?? props.id;
    if (id == null) return;
    scopedCount += 1;
    const status = statusByRoomKey?.get?.(roomKey) || RS_STATUS.NOT_STARTED;
    idsByStatus[status].push(String(id));
  });
  return { idsByStatus, scopedCount, totalRooms };
}

// Mapbox fill-color expression: in-scope rooms by status, everything else
// neutral. Ids are compared as strings so numeric RevitIds and string ids
// both work; empty groups are omitted (Mapbox `match` rejects empty label
// arrays).
export function buildStatusFillExpression(idsByStatus) {
  const idExpr = ['to-string', ['coalesce', ['get', 'RevitId'], ['id'], '']];
  const branches = [];
  Object.values(RS_STATUS).forEach((status) => {
    const ids = idsByStatus?.[status] || [];
    if (ids.length) branches.push(ids, RS_STATUS_COLORS[status]);
  });
  if (!branches.length) return RS_OUT_OF_SCOPE_COLOR;
  return ['match', idExpr, ...branches, RS_OUT_OF_SCOPE_COLOR];
}

// Floor file id for an Airtable numeric floor (0 = basement).
export function floorIdFromAirtableFloor(floor) {
  const n = Number(floor);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 'BASEMENT' : `LEVEL_${n}`;
}
