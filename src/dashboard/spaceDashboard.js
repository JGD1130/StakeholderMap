function resolveAreaSf(p = {}) {
  const sfRaw =
    p.area ??
    p.Area ??
    p['Area (SF)'] ??
    p.SF ??
    p.NetArea ??
    p.Area_SF ??
    p['Area_SF'] ??
    0;

  const sf = Number(sfRaw);
  if (!Number.isFinite(sf) || sf <= 0) return null;
  return sf;
}

function resolveOccupancyStatus(p = {}) {
  const occupancyRaw =
    p.occupancyStatus ??
    p['Occupancy Status'] ??
    p.vacancy ??
    p.Vacancy ??
    p.Vacant ??
    p.Occupancy ??
    p.OccupancyStatus ??
    p.Status ??
    '';
  const occupancyStr = String(occupancyRaw).trim().toUpperCase();
  const hasExplicit =
    (typeof occupancyRaw === 'string' && occupancyStr.length > 0) ||
    typeof occupancyRaw === 'boolean' ||
    typeof occupancyRaw === 'number';

  const isVacantExplicit =
    occupancyRaw === true ||
    occupancyStr === 'VACANT' ||
    occupancyStr.includes('VACANT') ||
    occupancyStr.includes('UNOCCUPIED') ||
    occupancyStr.includes('AVAILABLE');

  const isOccupiedExplicit =
    occupancyRaw === false ||
    occupancyStr === 'OCCUPIED' ||
    occupancyStr.includes('OCCUPIED');

  if (hasExplicit) {
    if (isVacantExplicit && !isOccupiedExplicit) return 'Vacant';
    if (isOccupiedExplicit) return 'Occupied';
    return 'Unknown';
  }

  const occupant =
    (p.occupant ?? p.Occupant ?? p.AssignedTo ?? p.Assignee ?? '').toString().trim();
  if (occupant.length > 0) return 'Occupied';
  return 'Unknown';
}

const OFFICE_TYPE_LABELS = [
  'Office - Staff',
  'Office - Prof and Admin',
  'Office - Prof & Admin',
  'Office - Prof/Admin',
  'Office - Faculty',
  'Office - Adjunct Faculty',
  'Office - Emeritus Faculty'
];
const normalizeOfficeTypeLabel = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(and|&)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const OFFICE_TYPE_SET = new Set(OFFICE_TYPE_LABELS.map(normalizeOfficeTypeLabel).filter(Boolean));

function isOfficeRoom(p = {}) {
  const type =
    (p.NCES_Type ??
      p.NCES_Type_Desc ??
      p.__roomType ??
      p.RoomTypeName ??
      p.RoomType ??
      p.Type ??
      p.type ??
      '')
      .toString()
      .toLowerCase();
  return OFFICE_TYPE_SET.has(normalizeOfficeTypeLabel(type));
}

export function computeOfficeOccupancy(featureCollectionOrFeatures) {
  const feats = Array.isArray(featureCollectionOrFeatures)
    ? featureCollectionOrFeatures
    : Array.isArray(featureCollectionOrFeatures?.features)
      ? featureCollectionOrFeatures.features
      : [];

  let occupied = 0;
  let vacant = 0;
  let unknown = 0;

  for (const f of feats) {
    const p = f?.properties || {};
    if (!isOfficeRoom(p)) continue;
    const status = resolveOccupancyStatus(p);
    if (status === 'Occupied') {
      occupied += 1;
    } else if (status === 'Vacant') {
      vacant += 1;
    } else {
      unknown += 1;
    }
  }

  return {
    pct: (occupied + vacant) > 0 ? occupied / (occupied + vacant) : null,
    occupied,
    vacant,
    unknown,
    totalOffices: occupied + vacant + unknown
  };
}

export function normalizeRoomProps(p = {}) {
  const sf = resolveAreaSf(p);
  if (!sf) return null;

  const dept =
    (p.NCES_Department ?? p.department ?? p.Department ?? p.Dept ?? '').toString().trim() ||
    'Unspecified';

  const type =
    (p.NCES_Type ??
      p.NCES_Type_Desc ??
      p.RoomTypeName ??
      p.RoomType ??
      p.Type ??
      p.type ??
      '')
      .toString()
      .trim() || 'Unknown';

  const occupancy = resolveOccupancyStatus(p);

  return { sf, dept, type, occupancy };
}

export function computeOccupancySummary(featureCollectionOrFeatures) {
  const feats = Array.isArray(featureCollectionOrFeatures)
    ? featureCollectionOrFeatures
    : Array.isArray(featureCollectionOrFeatures?.features)
      ? featureCollectionOrFeatures.features
      : [];

  let occupiedSF = 0;
  let vacantSF = 0;
  let unknownSF = 0;

  let occupiedRooms = 0;
  let vacantRooms = 0;
  let unknownRooms = 0;

  for (const f of feats) {
    const p = f?.properties || {};
    const sf = resolveAreaSf(p);
    if (!sf) continue;

    const status = resolveOccupancyStatus(p);
    if (status === 'Vacant') {
      vacantSF += sf;
      vacantRooms += 1;
    } else if (status === 'Occupied') {
      occupiedSF += sf;
      occupiedRooms += 1;
    } else {
      unknownSF += sf;
      unknownRooms += 1;
    }
  }

  const totalSF = occupiedSF + vacantSF + unknownSF;
  const totalRooms = occupiedRooms + vacantRooms + unknownRooms;

  return {
    totalSF,
    totalRooms,
    occupiedSF,
    vacantSF,
    unknownSF,
    occupiedRooms,
    vacantRooms,
    unknownRooms,
    occupancyRate: totalSF > 0 ? occupiedSF / totalSF : null
  };
}

export function computeSpaceDashboard(features = []) {
  let totalSf = 0;
  let roomCount = 0;

  const sfByDept = new Map();
  const sfByType = new Map();
  const sfByOcc = new Map();
const isAssignableDept = (dept) => {
  const norm = String(dept || '').trim();
  if (!norm) return false;
  const upper = norm.toUpperCase();
  const isRecordId = /^rec[a-z0-9]{6,}$/i.test(norm);
  if (isRecordId) return false;
  return upper !== 'UNSPECIFIED' && upper !== 'UNKNOWN' && upper !== 'N/A' && upper !== 'NA';
};

  for (const f of features) {
    const norm = normalizeRoomProps(f?.properties || {});
    if (!norm) continue;

    roomCount += 1;
    totalSf += norm.sf;

    if (isAssignableDept(norm.dept)) {
      sfByDept.set(norm.dept, (sfByDept.get(norm.dept) || 0) + norm.sf);
    }
    sfByType.set(norm.type, (sfByType.get(norm.type) || 0) + norm.sf);
    sfByOcc.set(norm.occupancy, (sfByOcc.get(norm.occupancy) || 0) + norm.sf);
  }

  const toTopList = (m, limit = 10) =>
    Array.from(m.entries())
      .map(([name, sf]) => ({ name, sf }))
      .sort((a, b) => b.sf - a.sf)
      .slice(0, limit);

  const occupancySummary = computeOccupancySummary(features);
  const officeOccupancy = computeOfficeOccupancy(features);

  return {
    totalSf,
    roomCount,
    byDept: toTopList(sfByDept, 10),
    byType: toTopList(sfByType, 10),
    byOccupancy: toTopList(sfByOcc, 6),
    occupancySummary,
    officeOccupancy
  };
}

function resolveSeatCount(p = {}) {
  const raw =
    p.seatCount ??
    p.SeatCount ??
    p['Seat Count'] ??
    p.Seats ??
    p.Capacity ??
    p.rm_seats ??
    p.SeatingCapacity ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveCategoryCode(p = {}) {
  const raw =
    p.NCES_Category ??
    p['NCES Category'] ??
    p.NCES_Category_Code ??
    p['NCES Category Code'] ??
    p.categoryCode ??
    p.category ??
    '';
  return String(raw || '').trim();
}

function resolveCategoryPrefix(p = {}) {
  const code = resolveCategoryCode(p);
  if (!code) return '';
  return code.charAt(0);
}

export function computeStrategicCapacityMetrics(
  features = [],
  { seatSupplyCategoryPrefixes = ['1'] } = {}
) {
  const feats = Array.isArray(features) ? features : [];
  const allowed = new Set(
    (seatSupplyCategoryPrefixes || [])
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
  if (!allowed.size) allowed.add('1');

  let availableSeats = 0;
  let instructionalRooms = 0;
  const seatsByPrefix = {};

  for (const f of feats) {
    const p = f?.properties || {};
    const prefix = resolveCategoryPrefix(p);
    if (!prefix || !allowed.has(prefix)) continue;
    instructionalRooms += 1;
    const seats = resolveSeatCount(p);
    availableSeats += seats;
    seatsByPrefix[prefix] = (seatsByPrefix[prefix] || 0) + seats;
  }

  return {
    availableSeats: Math.round(availableSeats),
    instructionalRooms,
    seatsByPrefix
  };
}

function normalizeEnrollmentSeries(series = []) {
  const rows = Array.isArray(series) ? series : [];
  const byYear = new Map();
  rows.forEach((row) => {
    const yearRaw = row?.year;
    const enrollmentRaw = row?.enrollment;
    const year = Number(yearRaw);
    const enrollment = Number(enrollmentRaw);
    if (!Number.isFinite(year)) return;
    byYear.set(
      Math.round(year),
      Number.isFinite(enrollment) && enrollment >= 0 ? enrollment : 0
    );
  });
  return Array.from(byYear.entries())
    .map(([year, enrollment]) => ({ year, enrollment }))
    .sort((a, b) => a.year - b.year);
}

export function computeStrategicSeatGapByYear(
  enrollmentSeries = [],
  availableSeats = 0,
  seatRatio = 2.5
) {
  const rows = normalizeEnrollmentSeries(enrollmentSeries);
  if (!rows.length) return [];

  const seatSupply = Number.isFinite(Number(availableSeats))
    ? Number(availableSeats)
    : 0;
  const ratio = Number(seatRatio);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 2.5;

  return rows.map((row) => {
    const requiredSeats = row.enrollment / safeRatio;
    const seatGap = seatSupply - requiredSeats;
    return {
      year: row.year,
      enrollment: row.enrollment,
      availableSeats: seatSupply,
      requiredSeats,
      seatGap,
      gapStatus: seatGap >= 0 ? 'Surplus' : 'Deficit'
    };
  });
}
