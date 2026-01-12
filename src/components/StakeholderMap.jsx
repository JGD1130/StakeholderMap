import * as React from 'react';
const { useRef, useEffect, useState, useCallback, useMemo, useLayoutEffect } = React;
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import jsPDF from 'jspdf';
import { db } from '../firebaseConfig';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, getDocs, addDoc, serverTimestamp, GeoPoint, writeBatch, setDoc, query, where, doc, getDoc, onSnapshot } from 'firebase/firestore';
import './StakeholderMap.css';
import AssessmentPanel from './AssessmentPanel.jsx';
import BuildingInteractionPanel from './BuildingInteractionPanel.jsx';
import { surveyConfigs } from '../surveyConfigs';
import * as turf from '@turf/turf';
import { bId, fId, rId, canon } from '../utils/idUtils';
import { computeFloorSummary } from '../utils/floorSummary';
import { DEPT_COLORS, getDeptColor } from '../style/roomColors';
import BuildingPanel from './panels/BuildingPanel';
import FloorPanel from './panels/FloorPanel';
import ComboInput from './ComboInput';
import { toKeyDeptList } from './popupUi';

function summarizeFloorFromFeatures(fc) {
  if (!fc || !Array.isArray(fc.features)) {
    return {
      totalSf: 0,
      rooms: 0,
      classroomSf: 0,
      classroomCount: 0,
      keyDepts: []
    };
  }

  let totalSf = 0;
  let rooms = 0;
  let classroomSf = 0;
  let classroomCount = 0;
  const deptMap = new Map();

  for (const feat of fc.features) {
    const props = feat.properties || {};

    const rawArea =
      props.area ??
      props.Area ??
      props['Area (SF)'] ??
      props.SF ??
      props.NetArea ??
      props['Area_sf'] ??
      0;

    const area = Number(rawArea);
    if (!Number.isFinite(area) || area <= 0) continue;

    rooms += 1;
    totalSf += area;

    const dept = norm(getDeptFromProps(props));

    if (dept) {
      const prev = deptMap.get(dept) || { name: dept, sf: 0, rooms: 0 };
      prev.sf += area;
      prev.rooms += 1;
      deptMap.set(dept, prev);
    }

    const type = String(getTypeFromProps(props) || '').toUpperCase();

    if (type.includes('CLASSROOM') || type.includes('LECTURE')) {
      classroomSf += area;
      classroomCount += 1;
    }
  }

  const keyDepts = Array.from(deptMap.values())
    .sort((a, b) => b.sf - a.sf)
    .slice(0, 10)
    .map((d) => ({
      name: d.name,
      sf: d.sf,
      rooms: d.rooms
    }));

  return {
    totalSf,
    rooms,
    classroomSf,
    classroomCount,
    keyDepts
  };
}

function deptFillExpression() {
  const pairs = [];
  for (const [dept, color] of Object.entries(DEPT_COLORS)) {
    pairs.push(dept, color);
  }
  return [
    'match',
    ['coalesce', ['feature-state', 'department'], ['get', 'department'], ['get', 'Department'], ['get', 'Dept']],
    ...pairs,
    '#e6e6e6'
  ];
}

// --- helpers for colored key-department legend in HTML popups ---
const _hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

const FALLBACKS = [
  '#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd',
  '#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'
];

const colorForDept = (name) => {
  if (!name) return '#AAAAAA';
  try {
    return getDeptColor(name) || '#AAAAAA';
  } catch {
    // fall back to hash palette
  }
  return FALLBACKS[_hash(String(name)) % FALLBACKS.length];
};

const colorForType = (name) => {
  if (!name) return '#CCCCCC';
  return FALLBACKS[_hash(String(name).toLowerCase()) % FALLBACKS.length];
};

const summarizeProgramCounts = (stats) => {
  const rt = stats?.roomTypes || {};
  let offices = 0, classrooms = 0, labs = 0;

  for (const [label, count] of Object.entries(rt)) {
    const k = String(label || '').toLowerCase();
    const n = Number(count || 0) || 0;

    // tune these keywords to match your room type naming conventions
    if (k.includes('office')) offices += n;
    else if (k.includes('classroom') || k.includes('seminar') || k.includes('lecture')) classrooms += n;
    else if (k.includes('lab') || k.includes('laboratory')) labs += n;
  }

  return { offices, classrooms, labs };
};

function renderDeptListHTML(list) {
  if (!list?.length) return '';
  return list
    .map((item) => {
      const label = item.dept || item.name || item.Dept || item.Department;
      if (!label) return '';
      const color = getDeptColor(label);
      return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
        <span style="width:14px;height:14px;border-radius:3px;background:${color};border:1px solid #00000022"></span>
        <span>${label}</span>
      </div>`;
    })
    .filter(Boolean)
    .join('');
}

// ----- Controlled vocabularies (seed lists) -----
const ROOM_TYPES = [
  "Classroom - General (111)",
  "Classroom - Lecture Hall",
  "Classroom - Indoor Amphitheater / Auditorium",
  "Classroom - Multipurpose",
  "Classroom - Service",
  "Classroom - Seminar",
  "Classroom - Dist Ed / Interactive",
  "Classroom - Computer",
  "Classroom - Collaborative",
  "Laboratory - Class",
  "Laboratory - Computer (non-scheduled)",
  "Laboratory - Studio",
  "Laboratory - Service",
  "Laboratory - Open (non-scheduled)",
  "Laboratory - Music Practice (non-scheduled)",
  "Laboratory - Special Nonclass",
  "Special Nonclass Lab Svs",
  "Office - Prof and Admin (310)",
  "Office - Staff (311)",
  "Office - Faculty",
  "Office - Adjunct Faculty",
  "Office - Graduate / Post Doc Students",
  "Office - Service",
  "Office - Research / Non-Faculty",
  "Office - Emeritus Faculty",
  "Office - Other",
  "Office - Waiting / Reception",
  "Office - Student / Organization",
  "Office - Pantry / Kitchenette",
  "Office - Lounge / Lunch Room",
  "Office - File Room",
  "Office - Work Room",
  "Office - Mail Room",
  "Office - Vault",
  "Office - Department / Suite Circulation",
  "Office - Conference Room",
  "Office - Conference Room Service",
  "Office - Library / Reference Room",
  "Office - Collaborative Work Space",
  "Library - Study / Collaborative Area",
  "Library / Testing / Study Room Service",
  "Training / Tutorial Room",
  "Library - Resource Room",
  "Library Circulation or Reference",
  "Library - Stack",
  "Library / Testing / Study - Storage",
  "Library - Open Stack, Study Area",
  "Library - Processing Room",
  "Academic Assistance",
  "Academic Testing",
  "Interview Room",
  "Departmental Library",
  "Recreation - Health or Physical Education",
  "Athletics - Intercollegiate Sports",
  "Spectator Seating",
  "Fitness Area",
  "Recreation - Service",
  "Athletics - Intercollegiate Sports Service",
  "Ice Rink",
  "Swimming Pool",
  "Athletics - Locker Room or Shower Area",
  "Media - Multi Media Production",
  "Media - Television Studio",
  "Media - Radio Station",
  "Media - Newspaper or Publications",
  "Media - Service",
  "Clinic - (Non-Health care)",
  "Clinic - Observation Room (Non-Health care)",
  "Clinic - Service (Non-Health care)",
  "Clinic - Interview Room (Non-Health care)",
  "Demonstration",
  "Demonstration Service",
  "Special Use - Other (All Purpose)",
  "Public Performance / Assembly",
  "Auditorium",
  "Multi-Purpose Room",
  "Dressing Room",
  "Checkroom",
  "Assembly Room Service (All Types)",
  "Gallery",
  "Museum",
  "Exhibition / Display",
  "Museum / Display / Exhibit Service",
  "Dining / Food Facility",
  "Vending",
  "Dining / Food Service",
  "Kitchen",
  "Dry Food Storage",
  "Cold Food Storage",
  "Lounge - Public",
  "Lounge - Faculty",
  "Lounge - Staff",
  "Lounge - Student",
  "Lounge - Service",
  "Merchandising",
  "Bookstore",
  "Merchandising Service",
  "Recreation - General Use",
  "Recreation Service - General Use",
  "General - Locker Room",
  "General - Locker Room (All Gender)",
  "General - Locker Room Service",
  "Computing or Networking (Central)",
  "Telecom Room (Central)",
  "Telecom / Audio / Video Room",
  "Server Room",
  "IT / Telecom / Network Service",
  "Shop",
  "Shop Service",
  "Storage Room - Central",
  "Storage Room - General",
  "Vehicle / Equipment Storage",
  "Vehicle / Equipment Storage Service",
  "Central Services",
  "Laundry - Central",
  "Central Service Support",
  "Hazardous Materials",
  "Hazardous Materials Service",
  "Parking Garage",
  "Parking Garage Service",
  "Patient Bedroom",
  "Patient Bedroom Service",
  "Health Care - Nurse Station",
  "Utility Room",
  "Record Room",
  "Health Care - Recovery Room",
  "Health Care - Treatment / Examination",
  "Procedure Room",
  "Health Care - Examining Room",
  "Health Care - Therapy Room",
  "Recreation Room",
  "Health Care - Treatment / Examination Service",
  "Health Care - X-Ray Treatment Room",
  "Pharmacy",
  "Health Care - Miscellaneous Storage",
  "Health Care - Patient Reception",
  "Dorm - Sleep / Study NO Toilet & Bath",
  "Dorm - Bedroom Closet",
  "Dorm - Lounge / Study Room",
  "Dorm - Hallway",
  "Dorm - Living Room",
  "Dorm - Toilet or Bath",
  "Sleep / Study WITH Toilet & Bath",
  "Staff Quarters With Bath",
  "Sleep / Study Service",
  "Residence - Laundry",
  "Residence - Storage Room",
  "Apartment - Whole Building",
  "Apartment - Whole Unit",
  "Apartment - Bedroom",
  "Apartment - Closet",
  "Apartment - Living Room",
  "Apartment - Service",
  "Apartment - Kitchen",
  "Apartment - Hallway",
  "Apartment - Bathroom",
  "Apartment - Storage",
  "House",
  "Rental House",
  "Visiting/Special Residence",
  "Other University Residence",
  "Vacant - Assigned",
  "Inactive Area",
  "Available Unassigned",
  "Alteration or Conversion Area",
  "Unfinished Area",
  "Clear Story (open to below)",
  "Leased to Others",
  "Unknown / No Data",
  "Public Corridor",
  "Non-Public Corridor",
  "Lobby",
  "Stairway",
  "Escalator",
  "Elevators",
  "Vestibule",
  "Ramp",
  "Receiving / Loading Dock",
  "Exterior Space - Covered",
  "Commons Area",
  "Custodial Area",
  "Custodial Storage",
  "Custodial Locker Room",
  "Utility Room",
  "Building Storage",
  "Women's Restroom",
  "Men's Restroom",
  "Single Stall Restroom",
  "Private Restroom",
  "Trash / Recycle Room",
  "Nursing / Lactation Room",
  "Emergency Management Command Room",
  "Mechanical Area",
  "Mechanical Duct / Chase or Shaft Area",
  "Interior Incinerator",
  "Central Utility Plant Facility",
  "Electrical Equipment Area",
  "Structural Area",
  "Storage Room - General",
  "Testing"
];

const DEPARTMENTS = [
  'Teacher Education','Business Office','Registrar','VPAA - Academic Admin','Chaplain',
  'Financial Aid','Facilities','HR','Music','Open','Physical Education','Admissions','IT','Library','Student Accounts','Student Engagement','Health Center',
  'Biology','Chemistry','Physics','Psychology','History, Religion, Philosophy','Languages & Literatures','Math','Art','Digital Art','Communication','Academic Support','Athletics','Esports','Forensics','CIO','CFO','President Office','Alumni & Foundation','Business Economics','Classroom','Creighton Coll of Nursing','Admin-General','Bronco Blend'
];
const DEPARTMENT_NAMES = DEPARTMENTS;

const norm = (s) => (s ?? '').toString().trim();

function getDeptFromProps(props = {}) {
  return (
    props.Department ||
    props.department ||
    props.Dept ||
    props.NCES_Department ||
    props["NCES_Department"] ||
    props["Department Owner Text"] ||
    ""
  );
}

function getTypeFromProps(props = {}) {
  return (
    props["Room Type"] ||
    props.roomType ||
    props.RoomType ||
    props.type ||
    props.Type ||
    props.NCES_Type ||
    props["NCES_Type"] ||
    props["Room Type Text"] ||
    props.RoomTypeName ||
    ""
  );
}

function pickFirstDefined(props = {}, keys = []) {
  if (!props || !Array.isArray(keys)) return null;
  for (const key of keys) {
    const value = props[key];
    if (value != null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function formatTypeOptionLabel(baseLabel, categoryCode, typeCode) {
  const trimmedLabel = (baseLabel || '').toString().trim();
  const cat = norm(categoryCode);
  const type = norm(typeCode);
  if (cat && type) {
    return `${cat} - ${type} ${trimmedLabel}`.trim();
  }
  if (cat) {
    return `${cat} ${trimmedLabel}`.trim();
  }
  return trimmedLabel || '';
}

function buildTypeOption(value, meta = {}) {
  const normalizedValue = norm(value);
  if (!normalizedValue) return null;
  const typeDesc = norm(meta.typeDesc ?? meta.typeLabel ?? meta.typeName);
  const label = formatTypeOptionLabel(typeDesc || normalizedValue, meta.categoryCode, meta.typeCode) || normalizedValue;
  return { value: normalizedValue, label };
}

function buildTypeOptionList(list = []) {
  const map = new Map();
  (list || []).forEach((item) => {
    const opt = buildTypeOption(item);
    if (opt) map.set(opt.value, opt);
  });
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function mergeTypeOptions(prev = [], next = []) {
  const map = new Map();
  (prev || []).forEach((opt) => {
    if (opt?.value) map.set(opt.value, opt);
  });
  (next || []).forEach((opt) => {
    if (opt?.value) map.set(opt.value, opt);
  });
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function assertCanonicalIds(buildingName, floorLabel, docPath) {
  if (!buildingName || !floorLabel || !docPath) return;
  const nameFragment = String(buildingName).trim();
  const floorFragment = String(floorLabel).trim();
  if (
    docPath.includes(nameFragment) ||
    docPath.includes(floorFragment)
  ) {
    console.warn('Non-canonical pieces detected in path:', docPath);
  }
}

function convertHexWithAlpha(hex, alpha = 0.35) {
  if (!hex) return `rgba(255,165,0,${alpha})`;
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    return `rgba(255,165,0,${alpha})`;
  }
  const intVal = parseInt(normalized, 16);
  if (Number.isNaN(intVal)) {
    return `rgba(255,165,0,${alpha})`;
  }
  const r = (intVal >> 16) & 255;
  const g = (intVal >> 8) & 255;
  const b = intVal & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function getRoomCategoryCode(props = {}) {
  const raw = pickFirstDefined(props, [
    'RoomCategory',
    'Category',
    'CategoryCode',
    'rm_cat',
    'rm_cat_id',
    'NCES_Category',
    'NCES Category',
    'NCES_Category_Code',
    'NCES Category Code'
  ]);
  return raw ? String(raw).trim() : null;
}

function getSeatCount(props = {}) {
  const raw =
    props.SeatCount ??
    props.Seats ??
    props.Capacity ??
    props.rm_seats ??
    props.SeatingCapacity ??
    props['NCES_Seat Count'] ??
    props['NCES_Seat_Count'] ??
    props['NCES_Seat Count'] ??
    props['NCES_SeatCount'] ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isOfficeCategory(categoryCode) {
  if (!categoryCode) return false;
  const norm = String(categoryCode).trim();
  return norm.length > 0 && norm.startsWith('3');
}

function isTeachingCategory(categoryCode) {
  if (!categoryCode) return false;
  const norm = String(categoryCode).trim();
  const prefix = norm.charAt(0);
  return prefix === '1' || prefix === '2';
}

function detectRoomTypeFlags(props = {}) {
  const rawType = pickFirstDefined(props, [
    'RoomType',
    'roomType',
    'Name',
    'type',
    'RoomTypeName',
    'NCES_Type Description_Sh',
    'NCES_Type Description',
    'NCES Type Description',
    'NCES_Type Description_Short'
  ]) ?? '';
  const normed = String(rawType).toLowerCase();
  const isOfficeText = normed.includes('office');
  const isTeachingText = normed.includes('classroom') || normed.includes('lab') || normed.includes('studio');
  return { norm: normed, isOfficeText, isTeachingText };
}

function detectFeatureKind(props = {}) {
  const kindLabel = pickFirstDefined(props, [
    'FeatureClass',
    'featureClass',
    'Layer',
    'layer',
    'Type',
    'type',
    'Feature',
    'feature',
    'Name',
    'name'
  ]) ?? '';
  const normed = String(kindLabel).toLowerCase();
  if (normed.includes('door') || normed.includes('entrance')) return 'door';
  if (normed.includes('stair')) return 'stair';
  return 'room';
}

function collectFloorOptions(features) {
  const typeMap = new Map();
  const depts = new Set(DEPARTMENTS.map(norm));

  const getCategoryCode = (props) =>
    pickFirstDefined(props, [
      'NCES_Category',
      'NCES Category',
      'NCES_Category_Code',
      'NCES Category Code'
    ]);
  const getTypeCode = (props) =>
    pickFirstDefined(props, [
      'NCES_Type',
      'NCES Type',
      'NCES_Type_Code',
      'NCES Type Code'
    ]);
  const getTypeDesc = (props) =>
    pickFirstDefined(props, [
      'NCES_Type Description_Sh',
      'NCES_Type Description',
      'NCES Type Description',
      'NCES_Type Description_Short'
    ]);

  const addTypeOption = (value, meta = {}) => {
    const opt = buildTypeOption(value, meta);
    if (!opt) return;
    typeMap.set(opt.value, opt);
  };

  for (const f of features || []) {
    const p = f.properties || {};
    const typeName = norm(p.type ?? p.roomType ?? p.Name ?? p.RoomType ?? p.Type);
    const deptValue = norm(p.department ?? p.Department ?? p.Dept);
    const categoryCode = getCategoryCode(p);
    const typeCode = getTypeCode(p);
    const typeDesc = getTypeDesc(p);
    if (typeName) {
      addTypeOption(typeName, { categoryCode, typeCode, typeDesc });
    }
    if (deptValue) depts.add(deptValue);
  }

  return {
    typeOptions: Array.from(typeMap.values()).sort((a, b) => a.label.localeCompare(b.label)),
    deptOptions: Array.from(depts).filter(Boolean).sort(),
  };
}

function buildFloorplanCanvas(fc, options = {}) {
  if (!fc || !Array.isArray(fc.features) || !fc.features.length) return null;
  const bbox = turf.bbox(fc);
  if (!bbox || bbox.some((v) => !Number.isFinite(v))) return null;
  const width = 720;
  const spanX = bbox[2] - bbox[0];
  const spanY = bbox[3] - bbox[1];
  if (spanX <= 0 || spanY <= 0) return null;
  const aspect = spanY / spanX;
  const height = Math.max(260, Math.round(width * Math.max(0.33, Math.min(aspect, 2.5))));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const transform = (coord) => {
    const x = ((coord[0] - bbox[0]) / spanX) * width;
    const y = height - ((coord[1] - bbox[1]) / spanY) * height;
    return [x, y];
  };
  const drawPoly = (coords) => {
    if (!Array.isArray(coords)) return;
    ctx.beginPath();
    const first = transform(coords[0]);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < coords.length; i++) {
      const pt = transform(coords[i]);
      ctx.lineTo(pt[0], pt[1]);
    }
    ctx.closePath();
  };
  const drawLine = (coords) => {
    if (!Array.isArray(coords)) return;
    ctx.beginPath();
    const first = transform(coords[0]);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < coords.length; i++) {
      const pt = transform(coords[i]);
      ctx.lineTo(pt[0], pt[1]);
    }
  };
  const normalizeDept = (props) => {
    const dept = norm(props?.department ?? props?.Department ?? props?.Dept ?? '');
    return dept || '';
  };
  const normalizeId = (val) => {
    if (Number.isFinite(val)) return val;
    const asNum = Number(val);
    return Number.isFinite(asNum) ? asNum : (val != null ? String(val) : null);
  };
  const selectedIdsSet = new Set(
    (options?.selectedIds || []).map((v) => normalizeId(v)).filter((v) => v != null)
  );
  const solidFill = options?.solidFill === true;
  const labelOptions = options?.labelOptions || {};
  const labelsEnabled = labelOptions.enabled !== false;
  const labelSettings = {
    font: labelOptions.font || 'bold 10px "Open Sans", Arial, sans-serif',
    lineHeight: labelOptions.lineHeight || 12,
    maxLines: labelOptions.maxLines || 4,
    minWidth: labelOptions.minWidth || 32,
    minHeight: labelOptions.minHeight || 14
  };

  const buildLabelLines = (props, scenarioDept, fallbackDept, areaValue) => {
    const lines = [];
    const pushLine = (value) => {
      const text = norm(value);
      if (!text) return;
      if (lines.length >= labelSettings.maxLines) return;
      lines.push(text);
    };
    pushLine(props?.Number ?? props?.RoomNumber ?? props?.number);
    pushLine(props?.RoomType ?? props?.Type ?? props?.type ?? props?.Name);
    if (scenarioDept) pushLine(scenarioDept);
    else pushLine(fallbackDept);
    if (areaValue > 0) {
      pushLine(`${Math.round(areaValue).toLocaleString()} SF`);
    }
    return lines;
  };

  const drawLabelOnFeature = (feature, labelLines) => {
    if (!labelsEnabled || !labelLines.length) return;
    const centroidFeature = turf.centroid(feature);
    const centroidCoords = centroidFeature?.geometry?.coordinates;
    if (!centroidCoords) return;
    const featureBBox = turf.bbox(feature);
    if (!featureBBox) return;
    const polyWidth = ((featureBBox[2] - featureBBox[0]) / spanX) * width;
    const polyHeight = ((featureBBox[3] - featureBBox[1]) / spanY) * height;
    const requiredHeight = labelSettings.lineHeight * labelLines.length;
    if (polyWidth < labelSettings.minWidth || polyHeight < Math.max(requiredHeight, labelSettings.minHeight)) return;
    const [canvasX, canvasY] = transform(centroidCoords);
    const totalHeight = labelSettings.lineHeight * labelLines.length;
    const startY = canvasY - totalHeight / 2 + labelSettings.lineHeight / 2;
    ctx.save();
    ctx.font = labelSettings.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#101010';
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 3;
    for (let i = 0; i < labelLines.length; i += 1) {
      const y = startY + i * labelSettings.lineHeight;
      ctx.strokeText(labelLines[i], canvasX, y);
      ctx.fillText(labelLines[i], canvasX, y);
    }
    ctx.restore();
  };

  for (const feature of fc.features) {
    const props = feature?.properties || {};
    const kind = detectFeatureKind(props);
    const scenarioDept = norm(
      props?.scenarioDepartment ??
      props?.ScenarioDepartment ??
      props?.scenarioDept ??
      ''
    );
    const baseDept = normalizeDept(props);
    const deptName = scenarioDept || baseDept;
    const typeName = props?.RoomType ?? props?.Type ?? props?.type ?? props?.Name ?? '';
    const occupantVal = (props?.occupant ?? props?.Occupant ?? '').toString().trim();
    const colorMode = options?.colorMode || 'department';

    let baseColor = '#f7f7f7';
    if (colorMode === 'type') {
      baseColor = colorForType(typeName);
    } else if (colorMode === 'occupancy') {
      baseColor = occupantVal ? '#29b6f6' : '#e0e0e0';
    } else if (colorMode === 'vacancy') {
      baseColor = occupantVal ? '#29b6f6' : '#ff7043';
    } else {
      baseColor = deptName ? getDeptColor(deptName) : '#f7f7f7';
    }

    let fill = baseColor
      ? convertHexWithAlpha(baseColor, solidFill ? 1 : (scenarioDept ? 0.9 : 0.4))
      : '#f7f7f7';
    let outline = '#2b2b2b';
    let outlineWidth = kind === 'room' ? 2.2 : 1.5;
    const fidNorm = normalizeId(feature?.id ?? props?.RevitId ?? props?.id);
    const isSelected = fidNorm != null && selectedIdsSet.has(fidNorm);
    if (kind === 'door') {
      fill = '#1d1d1d';
      outline = '#0d0d0d';
      outlineWidth = 1.5;
    } else if (kind === 'stair') {
      fill = '#6b6b6b';
      outline = '#3a3a3a';
      outlineWidth = 1.5;
    } else if (baseColor) {
      outline = '#202020';
    }
    if (isSelected) {
      // Keep the original fill; emphasize selection with a cyan stroke only.
      outline = '#00ffff';
      outlineWidth = 4;
    }
    const geom = feature?.geometry;
    if (!geom || !geom.coordinates) continue;
    const drawGeom = (geomCoords, geomType) => {
      if (!Array.isArray(geomCoords)) return;
      if (geomType === 'Polygon') {
        ctx.fillStyle = fill;
        ctx.strokeStyle = outline;
        ctx.lineWidth = outlineWidth;
        geomCoords.forEach((ring) => {
          drawPoly(ring);
          ctx.fill();
          ctx.stroke();
        });
      } else if (geomType === 'MultiPolygon') {
        geomCoords.forEach((poly) => drawGeom(poly, 'Polygon'));
      } else if (geomType === 'LineString') {
        ctx.strokeStyle = outline;
        ctx.lineWidth = kind === 'door' ? 2 : 1.5;
        drawLine(geomCoords);
        ctx.stroke();
      } else if (geomType === 'MultiLineString') {
        geomCoords.forEach((line) => drawGeom(line, 'LineString'));
      }
    };
    drawGeom(geom.coordinates, geom.type);
    const areaValue = Number(
      props?.Area_SF ??
      props?.Area ??
      props?.['Area (SF)'] ??
      props?.Area_sf ??
      props?.NetArea ??
      props?.SF ??
      0
    );
    const normalizedArea = Number.isFinite(areaValue) && areaValue > 0 ? areaValue : 0;
    if (kind === 'room') {
      const labelLines = buildLabelLines(props, scenarioDept, baseDept, normalizedArea);
      drawLabelOnFeature(feature, labelLines);
    }
  }
  return {
    width: canvas.width,
    height: canvas.height,
    data: canvas.toDataURL('image/png')
  };
}

function generateFloorplanImageData(context = {}) {
  const fc = context?.fc ?? context;
  if (!fc) return null;
  return buildFloorplanCanvas(fc, context);
}

const getRoomTypeLabelFromProps = (props = {}) => {
  const typeValue = norm(
    props.type ??
    props.roomType ??
    props.Name ??
    props.RoomType ??
    props['Room Type'] ??
    props.Type ??
    props.RoomTypeName ??
    ''
  );
  return typeValue || 'Unknown';
};

// Robust base for static assets in Vite (dev vs prod)
const PUBLIC_BASE = (import.meta.env && import.meta.env.BASE_URL) ? import.meta.env.BASE_URL : '/';
const assetUrl = (path) => `${PUBLIC_BASE}${path}`.replace(/\/{2,}/g, '/');
const FLOORPLAN_MANIFEST_URL = assetUrl('floorplans/manifest.json');
const DEFAULT_FLOORPLAN_CAMPUS = 'Hastings';

function normalizeFloorId(floorId) {
  return String(floorId || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !ct.includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const text = await r.text();
    if (ct.includes("text/html")) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function ensureFeatureCollection(raw) {
  if (!raw) return null;

  if (raw.type === "FeatureCollection" && Array.isArray(raw.features)) return raw;
  if (Array.isArray(raw.features)) return { type: "FeatureCollection", features: raw.features };
  if (raw.type === "Feature") return { type: "FeatureCollection", features: [raw] };

  return null;
}

function applyAffineIfPresent(fc, affine) {
  if (!fc || !affine || fc.__mfAffineApplied) return fc;
  if (isLikelyLonLat(fc)) return fc;
  const out = applyAffineTransform(fc, affine);
  if (out && typeof out === "object") {
    out.__mfAffineApplied = true;
  }
  return out;
}

async function loadAffineForFloor(basePath, floorId) {
  if (!basePath || !floorId) return null;
  const candidates = [
    `${basePath}/${floorId}_Dept.affine.json`,
    `${basePath}/affine.json`,
  ];

  for (const url of candidates) {
    const data = await fetchJson(url);
    if (data) return data;
  }

  return null;
}

async function loadGeoJsonWithFallbacks(urls) {
  for (const u of (urls || []).filter(Boolean)) {
    const data = await fetchJson(u);
    if (data) return { url: u, data };
  }
  return { url: urls?.[0] || "", data: null };
}

async function loadRoomsFC({ basePath, floorId }) {
  const candidates = [
    `${basePath}/${floorId}_Dept.geojson`,
    `${basePath}/${floorId}_Dept_Rooms.geojson`,
  ];

  const [{ data: raw }, affine] = await Promise.all([
    loadGeoJsonWithFallbacks(candidates),
    loadAffineForFloor(basePath, floorId),
  ]);

  const rawFC = ensureFeatureCollection(raw);
  if (!rawFC) return { rawFC: null, patchedFC: null, affine: null };

  const patchedFC = applyAffineIfPresent(rawFC, affine);
  return { rawFC, patchedFC, affine };
}

async function loadWallsFC({ basePath, floorId, affine }) {
  const candidates = [
    `${basePath}/${floorId}_-_Map_Export_Walls.geojson`,
    `${basePath}/${floorId}_Walls.geojson`,
  ];

  const { data: raw } = await loadGeoJsonWithFallbacks(candidates);
  const rawFC = ensureFeatureCollection(raw);
  if (!rawFC) return null;

  return applyAffineIfPresent(rawFC, affine);
}

function applyAffine(fc, M) {
  function mapCoords(coords) {
    if (!coords) return coords;
    if (typeof coords[0] === "number") {
      const x = coords[0], y = coords[1];
      return [M.a * x + M.b * y + M.c, M.d * x + M.e * y + M.f];
    }
    return coords.map(mapCoords);
  }
  return {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      geometry: f.geometry ? { ...f.geometry, coordinates: mapCoords(f.geometry.coordinates) } : f.geometry
    }))
  };
}

function applyAffineTransform(fc, affine) {
  if (!fc || !affine) return fc;
  const anchor = affine.anchor_feet || affine.anchorFeet || affine.anchor;
  if (!Array.isArray(anchor) || anchor.length < 2) return fc;
  const targetLon = Number(affine.target_lon ?? affine.targetLon);
  const targetLat = Number(affine.target_lat ?? affine.targetLat);
  if (!Number.isFinite(targetLon) || !Number.isFinite(targetLat)) return fc;
  const rotDeg = Number(affine.rotation_deg_cw ?? affine.rotation_deg ?? 0);
  const hasEffectiveScale = affine.effective_scale_deg_per_foot != null;
  const baseScale = Number(
    hasEffectiveScale
      ? affine.effective_scale_deg_per_foot
      : (affine.scale_deg_per_foot ?? affine.scale_deg_per_ft ?? affine.scale)
  );
  if (!Number.isFinite(baseScale) || baseScale === 0) return fc;
  const scalePct = Number(affine.scale_percent ?? 100);
  const scaleLat = hasEffectiveScale
    ? baseScale
    : baseScale * (Number.isFinite(scalePct) ? scalePct / 100 : 1);
  const latRad = (targetLat * Math.PI) / 180;
  const cosLat = Math.max(1e-9, Math.cos(latRad));
  const scaleLon = scaleLat / cosLat;
  const theta = (rotDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const [ax, ay] = anchor;

  const a = scaleLon * cosT;
  const b = -scaleLon * sinT;
  const c = targetLon - (a * ax + b * ay);
  const d = scaleLat * sinT;
  const e = scaleLat * cosT;
  const f = targetLat - (d * ax + e * ay);

  return applyAffine(fc, { a, b, c, d, e, f });
}

async function fetchFirstOk(urls) {
  for (const u of (urls || []).filter(Boolean)) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const text = await r.text();

      // If the server returns HTML (SPA fallback), skip it and try next URL
      if (!r.ok) continue;
      if (ct.includes("text/html")) continue;

      // Try to parse JSON; if it fails, skip and try next URL
      try {
        const data = JSON.parse(text);
        return { ok: true, url: u, data };
      } catch {
        continue;
      }
    } catch (e) {
      // network error, try next
      continue;
    }
  }
  return { ok: false, url: urls?.[0] || "", error: "No valid JSON response from any candidate URL." };
}

async function tryLoadWallsOverlay({ basePath, floorId, map, roomsFC, affine }) {
  if (!basePath || !floorId || !map) return;

  const cleanFloor = String(floorId).trim();
  const candidates = [
    `${basePath}/${cleanFloor}_-_Map_Export_Walls_RAW.geojson`,
    `${basePath}/${cleanFloor}_Walls_RAW.geojson`,
    `${basePath}/${cleanFloor}_-_Map_Export_Walls.geojson`,
    `${basePath}/${cleanFloor}_Walls.geojson`,
  ];

  const raw = await fetchGeoJSON(candidates);
  let fc = ensureFeatureCollection(raw);
  if (!fc?.features?.length) return;

  console.log("[walls] loaded features", fc.features.length);

  function looksLikeLonLat(sampleFC, maxSamples = 20) {
    let checked = 0;

    const visit = (coords) => {
      if (!coords || checked >= maxSamples) return true;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        const x = coords[0];
        const y = coords[1];
        checked += 1;
        return Math.abs(x) <= 180 && Math.abs(y) <= 90;
      }
      for (const c of coords) {
        const ok = visit(c);
        if (!ok) return false;
      }
      return true;
    };

    for (const f of sampleFC?.features || []) {
      const ok = visit(f?.geometry?.coordinates);
      if (!ok) return false;
      if (checked >= maxSamples) break;
    }
    return checked > 0;
  }

  const shouldApplyAffine = affine && !looksLikeLonLat(fc);
  if (shouldApplyAffine) {
    fc = applyAffineTransform(fc, affine);
    console.log("[walls] applied affine");
  } else if (affine) {
    console.log("[walls] skipped affine (already lon/lat)");
  }

  const WALLS_SOURCE = "walls-source";
  const WALLS_LAYER = "walls-layer";

  if (map.getSource(WALLS_SOURCE)) map.getSource(WALLS_SOURCE).setData(fc);
  else map.addSource(WALLS_SOURCE, { type: "geojson", data: fc });
  try {
    const b = turf.bbox(fc);
    console.log("[walls] bbox", b);
  } catch {
    console.log("[walls] first coord", fc.features?.[0]?.geometry?.coordinates?.[0]?.[0]);
  }

  if (!map.getLayer(WALLS_LAYER)) {
    const beforeId = map.getLayer(FLOOR_FILL_ID) ? FLOOR_FILL_ID : undefined;
    map.addLayer({
      id: WALLS_LAYER,
      type: "line",
      source: WALLS_SOURCE,
      layout: {
        "line-join": "round",
        "line-cap": "round"
      },
      paint: {
        "line-color": "#000",
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          16, 0.15,
          18, 0.25,
          20, 0.45
        ],
        "line-opacity": 0.25
      }
    }, beforeId);
  }
}

async function tryLoadDoorsOverlay({ basePath, floorId, map, affine }) {
  if (!basePath || !floorId || !map) return;
  const cleanFloor = normalizeFloorId(floorId);
  const candidates = [
    `${basePath}/Doors/${cleanFloor}_Dept_Doors.geojson`,
    `${basePath}/Doors/${cleanFloor}_Doors.geojson`,
    `${basePath}/${cleanFloor}_Dept_Doors.geojson`,
    `${basePath}/${cleanFloor}_Doors.geojson`
  ];

  const raw = await fetchGeoJSON(candidates);
  if (!raw) {
    console.warn("Doors overlay not found. Tried:", candidates);
    return;
  }
  let fc = ensureFeatureCollection(raw);
  if (!fc?.features?.length) return;

  if (affine && !isLikelyLonLat(fc)) {
    fc = applyAffineTransform(fc, affine);
  }

  if (map.getSource(DOORS_SOURCE)) map.getSource(DOORS_SOURCE).setData(fc);
  else map.addSource(DOORS_SOURCE, { type: "geojson", data: fc });

  if (!map.getLayer(DOORS_LAYER)) {
    try {
      if (!map.hasImage('mf-door-swing')) {
        await loadIcon(map, 'mf-door-swing', 'icons/door-swing.png');
      }
    } catch (err) {
      console.warn('Door icon load failed:', err);
    }
    map.addLayer({
      id: DOORS_LAYER,
      type: "symbol",
      source: DOORS_SOURCE,
      layout: {
        "icon-image": "mf-door-swing",
        "icon-size": [
          "interpolate", ["linear"], ["zoom"],
          16, 0.28,
          18, 0.42,
          20, 0.65
        ],
        "icon-rotate": [
          "coalesce",
          ["to-number", ["get", "bearing_deg"]],
          0
        ],
        "icon-rotation-alignment": "map",
        "icon-keep-upright": false,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      },
      paint: {
        "icon-color": "#00a000",
        "icon-opacity": 0.95
      }
    });
  }
}

async function tryLoadStairsOverlay({ basePath, floorId, map, affine }) {
  if (!basePath || !floorId || !map) return;
  const cleanFloor = normalizeFloorId(floorId);
  const candidates = [
    `${basePath}/Stairs/${cleanFloor}_Dept_Stairs.geojson`,
    `${basePath}/Stairs/${cleanFloor}_DEPT_Stairs.geojson`,
    `${basePath}/Stairs/${cleanFloor}_Dept_StairsPoints.geojson`,
    `${basePath}/Stairs/${cleanFloor}_Stairs.geojson`,
    `${basePath}/Stairs/${cleanFloor}_StairRuns.geojson`,
    `${basePath}/Stairs/${cleanFloor}_StairsRuns.geojson`,
    `${basePath}/Stairs/${cleanFloor}_Dept_StairsRuns.geojson`,
    `${basePath}/${cleanFloor}_Dept_Stairs.geojson`,
    `${basePath}/${cleanFloor}_Stairs.geojson`
  ];

  const raw = await fetchGeoJSON(candidates);
  if (!raw) {
    console.warn("Stairs overlay not found. Tried:", candidates);
    return;
  }
  let fc = ensureFeatureCollection(raw);
  if (!fc?.features?.length) return;

  if (affine && !isLikelyLonLat(fc)) {
    fc = applyAffineTransform(fc, affine);
  }

  console.log("[stairs] loaded features", fc.features.length);

  if (map.getSource(STAIRS_SOURCE)) map.getSource(STAIRS_SOURCE).setData(fc);
  else map.addSource(STAIRS_SOURCE, { type: "geojson", data: fc });

  if (!map.getLayer(STAIRS_LAYER)) {
    try {
      if (!map.hasImage('mf-stairs-run')) {
        await loadIcon(map, 'mf-stairs-run', 'icons/stairs-run.png');
      }
    } catch (err) {
      console.warn('Stairs icon load failed:', err);
    }
    map.addLayer({
      id: STAIRS_LAYER,
      type: "symbol",
      source: STAIRS_SOURCE,
      layout: {
        "icon-image": "mf-stairs-run",
        "icon-size": [
          "interpolate", ["linear"], ["zoom"],
          16, 0.30,
          18, 0.50,
          20, 0.80
        ],
        "icon-rotate": [
          "coalesce",
          ["to-number", ["get", "bearing_deg"]],
          0
        ],
        "icon-rotation-alignment": "map",
        "icon-keep-upright": false,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      },
      paint: {
        "icon-color": "#0066ff",
        "icon-opacity": 0.95
      }
    });
  }
}
let aiLockUntil = 0;
async function guardedAiFetch(url, opts) {
  const now = Date.now();
  if (now < aiLockUntil) {
    throw new Error(`Rate limited. Try again in ${Math.ceil((aiLockUntil - now) / 1000)}s`);
  }
  const res = await fetch(url, opts);
  if (res.status === 429) {
    aiLockUntil = Date.now() + 60_000; // 60s cooldown
    throw new Error('Rate limited (429). AI paused for 60 seconds.');
  }
  return res;
}

async function loadFloorManifest(buildingKey, campus = DEFAULT_FLOORPLAN_CAMPUS) {
  if (!buildingKey) return [];
  const campusSeg = encodeURIComponent(campus);
  const buildingSeg = encodeURIComponent(buildingKey);
  const url = assetUrl(`floorplans/${campusSeg}/${buildingSeg}/manifest.json`);
  const manifest = await fetchJSON(url);
  return Array.isArray(manifest?.floors) ? manifest.floors : [];
}


// --- Mapbox token from Vite env (required for mapbox:// styles) ---
mapboxgl.accessToken = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();

// Optional sanity-check
console.log('Mapbox token length:', (mapboxgl.accessToken || '').length);


// --- Floor layer IDs (keep consistent) ---
const FLOOR_SOURCE = 'floor-source';
const FLOOR_FILL_ID = "floor-fill";
const FLOOR_LINE_ID = "floor-line";
const FLOOR_HL_ID = "floor-highlight";
const FLOOR_HL_BORDER_ID = "floor-highlight-border";
const FLOOR_ROOM_LABEL_LAYER = "floor-room-labels";
const FLOOR_DOOR_LAYER = "floor-doors";
const FLOOR_STAIR_LAYER = "floor-stairs";
const WALLS_SOURCE = 'walls-source';
const WALLS_LAYER = 'walls-layer';
const DOORS_SOURCE = "doors-source";
const STAIRS_SOURCE = "stairs-source";
const DOORS_LAYER = "doors-layer";
const STAIRS_LAYER = "stairs-layer";

// Cache to avoid double-loading sources
const floorCache = new Map();

function applyBuildingStyleForSpace(map) {
  if (!map) return;
  const layerId = 'buildings-fill';
  if (map.getLayer(layerId)) {
    try {
      map.setPaintProperty(layerId, 'fill-color', '#ffffff');
      map.setPaintProperty(layerId, 'fill-opacity', 1.0);
      map.setPaintProperty(layerId, 'fill-outline-color', '#cbd5e1');
    } catch {}
  }
}

const FLOOR_FILL_PAINT = {
  'fill-color': '#e6e6e6',
  'fill-opacity': 1.0
};

const WALL_PAINT = {
  "line-color": "#000",
  "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.15, 18, 0.25, 20, 0.45],
  "line-opacity": 0.25
};

const DOOR_PAINT = {
  "line-color": "#111",
  "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.6, 18, 1.0, 20, 1.6],
  "line-opacity": 0.95
};

const STAIR_PAINT = {
  "line-color": "#111",
  "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.6, 18, 1.0, 20, 1.6],
  "line-opacity": 0.95
};

function applyFloorFillExpression(map, mode = 'department', options = {}) {
  if (!map || !map.getLayer(FLOOR_FILL_ID)) return;
  const occupantExpr = [
    '>',
    ['length', ['coalesce', ['to-string', ['get', 'occupant']], ['to-string', ['get', 'Occupant']], '']],
    0
  ];
  const vacancyExpr = ['!', occupantExpr];
  const occupancyColorExpr = ['case', occupantExpr, '#29b6f6', '#e0e0e0'];
  const vacancyColorExpr = ['case', vacancyExpr, '#ff7043', '#cfd8dc'];
  try {
    if (mode === 'occupancy') {
      map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', occupancyColorExpr);
    } else if (mode === 'vacancy') {
      map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', vacancyColorExpr);
    } else {
      map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', deptFillExpression());
    }
    map.setPaintProperty(FLOOR_FILL_ID, 'fill-opacity', 1);
  } catch {}
}

function ensureFloorHighlightLayer(map) {
  if (!map || map.getLayer(FLOOR_HL_ID)) return;
  try {
    map.addLayer(
      {
        id: FLOOR_HL_ID,
        type: 'fill',
        source: FLOOR_SOURCE,
        paint: {
          'fill-color': 'rgba(0,255,255,0.4)',
          'fill-outline-color': '#00ffff'
        },
        filter: ['==', ['id'], -1]
      },
      FLOOR_FILL_ID
    );

    map.addLayer(
      {
        id: FLOOR_HL_BORDER_ID,
        type: 'line',
        source: FLOOR_SOURCE,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#00ffff',
          'line-width': 6,
          'line-opacity': 1,
          'line-gap-width': 0
        },
        filter: ['==', ['id'], -1]
      }
    );
  } catch {}
}

function ensureFloorDoorLayer(map) {
  if (!map || map.getLayer(FLOOR_DOOR_LAYER)) return;
  try {
    map.addLayer(
      {
        id: FLOOR_DOOR_LAYER,
        type: 'symbol',
        source: FLOOR_SOURCE,
        filter: ['==', ['get', 'Element'], 'Door'],
        layout: {
          'icon-image': 'door-16',
          'icon-size': 1,
          'icon-allow-overlap': true
        }
      },
      FLOOR_FILL_ID
    );
  } catch {}
}

function ensureFloorStairLayer(map) {
  if (!map || map.getLayer(FLOOR_STAIR_LAYER)) return;
  try {
    map.addLayer(
      {
        id: FLOOR_STAIR_LAYER,
        type: 'line',
        source: FLOOR_SOURCE,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#555',
          'line-width': 1.5,
          'line-opacity': 0.9,
          'line-dasharray': [2, 2]
        },
        filter: ['==', ['id'], '']
      },
      FLOOR_FILL_ID
    );
  } catch {}
}

function upsertGeoJsonSource(map, sourceId, fc) {
  if (!map || !sourceId || !fc) return;
  if (map.getSource(sourceId)) map.getSource(sourceId).setData(fc);
  else map.addSource(sourceId, { type: "geojson", data: fc });
}

function upsertLineLayer(map, layerId, sourceId, paint, filter, beforeId) {
  if (!map || !layerId || !sourceId) return;
  if (!map.getLayer(layerId)) {
    map.addLayer(
      { id: layerId, type: "line", source: sourceId, paint, ...(filter ? { filter } : {}) },
      beforeId || undefined
    );
  } else {
    if (paint) Object.entries(paint).forEach(([k, v]) => map.setPaintProperty(layerId, k, v));
    if (filter) map.setFilter(layerId, filter);
    if (beforeId) {
      try { map.moveLayer(layerId, beforeId); } catch {}
    }
  }
}

async function loadIcon(map, name, url) {
  if (!map || !name || !url) return;
  try {
    if (map.hasImage(name)) return;
  } catch {}
  const img = await new Promise((resolve, reject) => {
    map.loadImage(url, (err, image) => (err ? reject(err) : resolve(image)));
  });
  try {
    map.addImage(name, img, { sdf: true });
  } catch (err) {
    console.warn('addImage failed for', name, err);
  }
}

function ensureLayerOrder(map) {
  if (!map) return;
  try {
    // Make sure walls sit under room fills.
    if (map.getLayer(WALLS_LAYER) && map.getLayer(FLOOR_FILL_ID)) {
      map.moveLayer(WALLS_LAYER, FLOOR_FILL_ID);
    }

    // Keep room outlines above fills.
    if (map.getLayer(FLOOR_LINE_ID) && map.getLayer(FLOOR_FILL_ID)) {
      map.moveLayer(FLOOR_LINE_ID);
    }

    // Doors above room outlines.
    if (map.getLayer(DOORS_LAYER)) {
      map.moveLayer(DOORS_LAYER);
    }

    // Stairs above doors.
    if (map.getLayer(STAIRS_LAYER)) {
      map.moveLayer(STAIRS_LAYER);
    }
  } catch {}
}

function makeFeatureFilter(ids = [], revitIds = []) {
  const clauses = [];
  if (ids.length) {
    clauses.push(['in', ['id'], ['literal', ids]]);
  }
  if (revitIds.length) {
    clauses.push(['in', ['get', 'RevitId'], ['literal', revitIds]]);
  }
  if (!clauses.length) {
    return ['==', ['id'], ''];
  }
  if (clauses.length === 1) return clauses[0];
  return ['any', ...clauses];
}

// Fit-to-building (scale+translate) tuning
const FIT_MARGIN = 0.90;   // tighter/looser fit inside building bbox
const EXTRA_SHRINK = 0.85; // additional ?make smaller? factor

async function fetchGeoJSON(urlOrUrls) {
  const urls = Array.isArray(urlOrUrls)
    ? urlOrUrls.filter(Boolean)
    : [urlOrUrls].filter(Boolean);
  if (!urls.length) return null;

  const result = await fetchFirstOk(urls);
  if (!result.ok) {
    console.debug("GeoJSON fetch failed", {
      tried: urls,
      lastUrl: result.url,
      error: result.error
    });
    return null;
  }
  return result.data;
}

function extractFirstCoordinate(geojson) {
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  if (!coords) return null;
  const dive = (node) => {
    if (!Array.isArray(node)) return null;
    if (node.length >= 2 && node.every((v) => typeof v === 'number')) return node;
    for (const child of node) {
      const cand = dive(child);
      if (cand) return cand;
    }
    return null;
  };
  return dive(coords);
}

function isLikelyLonLat(gj) {
  try {
    if (!gj?.features?.length) return false;
    const bbox = turf.bbox(gj);
    if (!bbox || bbox.some((v) => !Number.isFinite(v))) return false;
    const [minX, minY, maxX, maxY] = bbox;
    if (minX < -180 || maxX > 180 || minY < -90 || maxY > 90) return false;
    const spanX = Math.abs(maxX - minX);
    const spanY = Math.abs(maxY - minY);
    return spanX <= 0.25 && spanY <= 0.25;
  } catch { return false; }
}

async function loadFloorGeojson(map, url, rehighlightId, affineParams, options = {}) {
  if (!map || !url) return;
  const { buildingId, floor, roomPatches, onOptionsCollected, currentFloorContextRef } = options;

  const floorBasePath = options?.roomsBasePath || options?.wallsBasePath;
  const floorId = options?.roomsFloorId || options?.wallsFloorId || floor || null;

  let data = floorCache.get(url);
  let affine = null;
  let fc = null;
  if (!data) {
    if (floorBasePath && floorId) {
      const roomsLoad = await loadRoomsFC({ basePath: floorBasePath, floorId });
      if (!roomsLoad.rawFC) {
        console.warn('Floor summary: no data returned', `${floorBasePath}/${floorId}_Dept.geojson`);
        return;
      }
      data = roomsLoad.rawFC;
      fc = roomsLoad.patchedFC;
      affine = roomsLoad.affine;
    } else {
      data = await fetchGeoJSON(url);
      if (!data) return;
    }
    floorCache.set(url, data);
  }

  if (!fc) {
    fc = ensureFeatureCollection(data) || toFeatureCollection(data);
    if (!fc?.features?.length) return;
    if (!affine && floorBasePath && floorId) {
      affine = await loadAffineForFloor(floorBasePath, floorId);
    }
    fc = applyAffineIfPresent(fc, affine);
  }

  if (fc && Array.isArray(fc.features) && currentFloorContextRef && typeof currentFloorContextRef === 'object') {
    currentFloorContextRef.current = { url, buildingId, floor, fc };
  }

  fc.features.forEach((feature, i) => {
    if (feature && feature.id == null) {
      feature.id = feature.properties?.RevitId ?? i;
    }
  });

  const doorFeatureIds = [];
  const doorRevitIds = [];
  const stairFeatureIds = [];
  const stairRevitIds = [];
  fc.features.forEach((feature) => {
    if (!feature) return;
    const id = feature.id ?? feature.properties?.RevitId ?? feature.properties?.id;
    if (id == null) return;
    const kind = detectFeatureKind(feature.properties);
    if (kind === 'door') {
      doorFeatureIds.push(id);
      if (feature.properties?.RevitId != null) doorRevitIds.push(feature.properties.RevitId);
    } else if (kind === 'stair') {
      stairFeatureIds.push(id);
      if (feature.properties?.RevitId != null) stairRevitIds.push(feature.properties.RevitId);
    }
  });

  const cacheFloorSummary = (stats, featureCollection) => {
    if (!stats) return;
    const features = featureCollection?.features;
    if (!Array.isArray(features) || features.length === 0) return;
    try {
    const bldg =
        (selectedBuildingIdRef.current) ||
        selectedBuilding ||
        affineParams?.fitBuilding?.properties?.id;
      const floorLabel =
        affineParams?.floorLabel ||
        features[0]?.properties?.Floor ||
        (url?.match(/(BASEMENT|LEVEL_\\d+|LEVEL|L\\d+)/)?.[0]) ||
        'LEVEL_1';

      if (bldg) {
        const existing = floorStatsByBuildingRef.current[bldg] || {};
        const updated = { ...existing, [floorLabel]: stats };
        floorStatsByBuildingRef.current[bldg] = updated;
        setFloorStatsByBuilding({ ...floorStatsByBuildingRef.current });
      }

      if (panelBuildingKeyRef.current && panelBuildingKeyRef.current === bldg) {
        setPanelStats((ps) => ({ ...(ps || {}), floor: stats }));
      }
    } catch {}
  };

  let summary = computeFloorSummary(fc);
  cacheFloorSummary(summary, fc);

  try {
    const fitBuilding = affineParams?.fitBuilding || null;
    if (fitBuilding && shouldFitFloorplanToBuilding(fc, fitBuilding)) {
      const fitted = fitFloorplanToBuilding(fc, fitBuilding);
      if (fitted?.features?.length) {
        fc = fitted;
        data.__mfTransformed = true;
        floorCache.set(url, fc);
      }
    }
  } catch {}

  let patchedFC = fc;
  let roomsEnriched = [];
  if (buildingId && floor && roomPatches instanceof Map) {
    const patchedFeatures = (fc.features || []).map((feature) => {
      const revitId = feature.id ?? feature.properties?.RevitId ?? feature.properties?.id;
      const rid = rId(buildingId, floor, revitId);
      const patch = roomPatches.get(rid);
      if (patch) {
        return {
          ...feature,
          properties: mergePatch(feature.properties || {}, patch)
        };
      }
      return feature;
    });
    patchedFC = { ...fc, features: patchedFeatures };
    if (typeof onOptionsCollected === 'function') {
      const { typeOptions, deptOptions } = collectFloorOptions(patchedFeatures);
      onOptionsCollected({ typeOptions, deptOptions });
    }
  }

  if (Array.isArray(patchedFC?.features)) {
    roomsEnriched = patchedFC.features.map((feature) => {
      const geoProps = feature?.properties ?? {};
      const revitId = feature?.id ?? geoProps.RevitId ?? geoProps.id;
      const rid = (buildingId && floor && revitId != null) ? rId(buildingId, floor, revitId) : null;
      const patch = roomPatches instanceof Map && rid ? roomPatches.get(rid) || null : null;
      return {
        geo: { ...geoProps },
        db: patch ? { ...patch } : null,
        roomId: rid || String(revitId ?? '')
      };
    });
  }
  const patchedSummary =
    Array.isArray(patchedFC?.features) && patchedFC.features.length
      ? computeFloorSummary(patchedFC)
      : null;
  if (patchedSummary) {
    summary = patchedSummary;
  }
  cacheFloorSummary(summary, patchedFC);

  // add / update source
  unloadFloorplan(map);
  if (map.getSource(FLOOR_SOURCE)) map.getSource(FLOOR_SOURCE).setData(patchedFC);
  else map.addSource(FLOOR_SOURCE, { type: 'geojson', data: patchedFC, promoteId: 'RevitId' });

  // fill colored by Department
  if (!map.getLayer(FLOOR_FILL_ID)) {
    map.addLayer({ id: FLOOR_FILL_ID, type: 'fill', source: FLOOR_SOURCE, paint: FLOOR_FILL_PAINT });
  }
  applyFloorFillExpression(map);
  ensureFloorHighlightLayer(map);

  // outline
  if (!map.getLayer(FLOOR_LINE_ID)) {
    map.addLayer({
      id: FLOOR_LINE_ID,
      type: 'line',
      source: FLOOR_SOURCE,
      paint: {
        'line-color': '#444',
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          16, 0.4,
          18, 0.8,
          20, 1.2
        ],
        'line-opacity': 0.7
      }
    });
  }

  ensureFloorRoomLabelLayer(map);
  // ---- WALLS OVERLAY (NEW) ----
  if (options?.wallsBasePath) {
    const floorId = options.wallsFloorId || floor || (url?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) || null;
    await tryLoadWallsOverlay({ basePath: options.wallsBasePath, floorId, map, roomsFC: patchedFC, affine });
    try { map.setPaintProperty(FLOOR_FILL_ID, "fill-opacity", 0.25); } catch {}
  }
  // ---- end walls overlay ----

  // ---- DOORS + STAIRS OVERLAY (optional) ----
  const overlayBasePath = options?.roomsBasePath || options?.wallsBasePath;
  if (overlayBasePath) {
    const overlayFloorId =
      options?.roomsFloorId ||
      options?.wallsFloorId ||
      floor ||
      (url?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) ||
      null;
    if (overlayFloorId) {
      await tryLoadDoorsOverlay({ basePath: overlayBasePath, floorId: overlayFloorId, map, affine });
      await tryLoadStairsOverlay({ basePath: overlayBasePath, floorId: overlayFloorId, map, affine });
    }
  }
  // ---- end doors + stairs overlay ----
  ensureLayerOrder(map);

  const doorFilter = makeFeatureFilter(doorFeatureIds, doorRevitIds);
  const stairFilter = makeFeatureFilter(stairFeatureIds, stairRevitIds);
  try {
    if (map.getLayer(FLOOR_DOOR_LAYER)) map.setFilter(FLOOR_DOOR_LAYER, doorFilter);
    if (map.getLayer(FLOOR_STAIR_LAYER)) map.setFilter(FLOOR_STAIR_LAYER, stairFilter);
  } catch {}

  // Ensure highlight layer draws above the fill (but under outline)
  try {
    if (map.getLayer(FLOOR_HL_ID) && map.getLayer(FLOOR_LINE_ID)) {
      map.moveLayer(FLOOR_HL_ID, FLOOR_LINE_ID);
    }

    
  } catch {}

  // re-apply selection if any (normalize to string id)
  if (rehighlightId != null && map.getLayer(FLOOR_HL_ID)) {
    const ids = Array.isArray(rehighlightId) ? rehighlightId.filter((v) => v != null) : [rehighlightId];
    const hlFilter = ids.length
      ? ['any',
          ['in', ['id'], ['literal', ids]],
          ['in', ['get', 'RevitId'], ['literal', ids]]
        ]
      : ['==', ['id'], ''];
    map.setFilter(FLOOR_HL_ID, hlFilter);
    if (map.getLayer(FLOOR_HL_BORDER_ID)) {
      map.setFilter(FLOOR_HL_BORDER_ID, hlFilter);
    }
  }

  // fit view to floor
  try {
    const b = turf.bbox(fc);
    if (b && isFinite(b[0])) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 400 });
  } catch {}

  return { summary, rooms: roomsEnriched };
}

// Normalize any GeoJSON-ish input into a FeatureCollection for safe bbox/centroid math
function toFeatureCollection(anyGeo) {
  if (!anyGeo) return null;
  if (anyGeo.type === 'FeatureCollection') return anyGeo;
  if (anyGeo.type === 'Feature') {
    return { type: 'FeatureCollection', features: [anyGeo] };
  }
  if (anyGeo.type === 'GeometryCollection') {
    return {
      type: 'FeatureCollection',
      features: (anyGeo.geometries || []).map((g) => ({ type: 'Feature', geometry: g, properties: {} }))
    };
  }
  if (anyGeo.type && anyGeo.coordinates) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: anyGeo, properties: {} }] };
  }
  return null;
}

function parseAreaValue(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function resolvePatchedArea(props = {}) {
  if (Number.isFinite(props.areaSF)) return Number(props.areaSF);
  const source = props.Area_SF ?? props.Area ?? props['Area SF'];
  if (source == null || source === '') return null;
  return parseAreaValue(source);
}

function createEmptySummaryAccumulator() {
  return {
    totalSf: 0,
    rooms: 0,
    classroomSf: 0,
    classroomCount: 0,
    labSf: 0,
    labCount: 0,
    officeSf: 0,
    officeCount: 0,
    deptCounts: new Map()
  };
}

function deriveRoomUsage(props = {}) {
  const categoryCode = getRoomCategoryCode(props) || '';
  const categoryPrefix = String(categoryCode).trim().charAt(0);
  const typeCode = pickFirstDefined(props, [
    'NCES_Type',
    'NCES Type',
    'NCES_Type_Code',
    'NCES Type Code'
  ]);
  const typeCodePrefix = String(typeCode || '').trim().charAt(0);
  const typeFlags = detectRoomTypeFlags(props);
  const typeText = (typeFlags?.norm || '').toLowerCase();

  const isClassroom =
    typeText.includes('classroom') ||
    typeText.includes('lecture') ||
    categoryPrefix === '1' ||
    typeCodePrefix === '1';

  const isLab =
    typeText.includes('lab') ||
    typeText.includes('laboratory') ||
    typeText.includes('studio') ||
    categoryPrefix === '2' ||
    typeCodePrefix === '2';

  const isOffice = typeFlags?.isOfficeText || isOfficeCategory(categoryCode);

  if (isClassroom) return 'classroom';
  if (isLab) return 'lab';
  if (isOffice) return 'office';
  return 'other';
}

function accumulateSummaryFromProps(accumulator, props = {}) {
  if (!accumulator) return;
  const area = resolvePatchedArea(props);
  const numericArea = Number.isFinite(area) ? area : 0;
  accumulator.totalSf += numericArea;
  accumulator.rooms += 1;

  const usage = deriveRoomUsage(props);
  if (usage === 'classroom') {
    accumulator.classroomSf += numericArea;
    accumulator.classroomCount += 1;
  } else if (usage === 'lab') {
    accumulator.labSf += numericArea;
    accumulator.labCount += 1;
  } else if (usage === 'office') {
    accumulator.officeSf += numericArea;
    accumulator.officeCount += 1;
  }

  const dept = norm(getDeptFromProps(props));
  if (dept) {
    accumulator.deptCounts.set(dept, (accumulator.deptCounts.get(dept) || 0) + numericArea);
  }
}

function summarizeFeatures(features = []) {
  const acc = createEmptySummaryAccumulator();
  features.forEach((feature) => accumulateSummaryFromProps(acc, feature?.properties));
  return finalizeCombinedSummary(acc);
}

function finalizeCombinedSummary(combined) {
  if (!combined) return null;
  const deptEntries = Array.from((combined.deptCounts || new Map()).entries());
  const sorted = deptEntries.sort((a, b) => b[1] - a[1]);
  const totalsByDept = Object.fromEntries(sorted);
  return {
    totalSf: combined.totalSf || 0,
    classroomSf: combined.classroomSf || 0,
    labSf: combined.labSf || 0,
    officeSf: combined.officeSf || 0,
    rooms: combined.rooms || 0,
    classroomCount: combined.classroomCount || 0,
    labCount: combined.labCount || 0,
    officeCount: combined.officeCount || 0,
    deptCounts: totalsByDept,
    totalsByDept,
    keyDepts: sorted.slice(0, 6).map(([name]) => name)
  };
}

function toScenarioShape(stats) {
  if (!stats) return null;

  if (stats.roomTypes && stats.sfByRoomType) {
    return {
      totalSF: Number(stats.totalSF ?? 0),
      rooms: Number(stats.rooms ?? 0),
      roomTypes: stats.roomTypes || {},
      sfByRoomType: stats.sfByRoomType || {}
    };
  }

  const totalSF = Number(stats.totalSF ?? stats.totalSqFt ?? stats.sf ?? stats.squareFeet ?? 0);
  const rooms = Number(stats.rooms ?? stats.roomCount ?? stats.totalRooms ?? 0);

  return {
    totalSF,
    rooms,
    roomTypes: stats.roomTypes || stats.countsByRoomType || {},
    sfByRoomType: stats.sfByRoomType || stats.sfByType || {}
  };
}

function computeDeptTotalsFromFeatures(features, deptName) {
  const dept = (deptName || '').trim().toLowerCase();
  if (!dept || !Array.isArray(features)) return null;

  let totalSF = 0;
  let rooms = 0;
  const roomTypes = {};
  const sfByRoomType = {};

  for (const f of features) {
    const p = f?.properties || {};
    const dep = String(getDeptFromProps(p) || '').trim().toLowerCase();
    if (dep !== dept) continue;

    const type = String(
      getTypeFromProps(p) ??
      p.Type ??
      p.RoomType ??
      p.Room_Type ??
      p.Name ??
      p.Room ??
      p.SpaceType ??
      p.Space_Type ??
      p.Use ??
      p.Usage ??
      p.Category ??
      'Unspecified'
    ).trim() || 'Unspecified';
    const resolvedArea = resolvePatchedArea(p);
    const sf = Number.isFinite(resolvedArea)
      ? resolvedArea
      : Number(p.sf ?? p.SF ?? p.AreaSF ?? p.Area ?? p.area ?? p.areaSF ?? p['Area SF'] ?? 0) || 0;

    rooms += 1;
    totalSF += sf;
    roomTypes[type] = (roomTypes[type] || 0) + 1;
    sfByRoomType[type] = (sfByRoomType[type] || 0) + sf;
  }

  return { totalSF, rooms, roomTypes, sfByRoomType };
}

function buildInventoryFromRoomRows(roomRows, limit = 1200) {
  if (!Array.isArray(roomRows)) return null;
  const trimmed = roomRows.slice(0, limit).map((r, idx) => {
    const buildingLabel = String(r.buildingName ?? r.buildingLabel ?? r.building ?? '').trim();
    const floorId = String(r.floor ?? r.floorId ?? '').trim();
    const roomLabel = String(r.roomNumber ?? r.roomLabel ?? r.name ?? '').trim();
    const idCandidate = String(r.roomId ?? r.revitId ?? r.id ?? '').trim();
    const fallbackId = [buildingLabel, floorId, roomLabel].filter(Boolean).join('|') || `room-${idx}`;
    const id = idCandidate || fallbackId;
    return {
      id,
      revitId: r.revitId ?? null,
      roomId: idCandidate || fallbackId,
      buildingLabel,
      floorId,
      roomLabel,
      type: String(r.type ?? r.roomType ?? '').trim(),
      sf: Number(r.sf ?? r.areaSF ?? r.area ?? 0) || 0,
      department: String(r.department ?? '').trim(),
      occupant: String(r.occupant ?? '').trim(),
      vacancy: String(r.vacancy ?? (r.occupant ? 'Occupied' : 'Unknown')).trim()
    };
  });
  return trimmed.filter((x) => x.id);
}

function buildInventoryFromFeatures(features, buildingLabel = '', floorId = '', limit = 1200) {
  if (!Array.isArray(features)) return null;
  return features.slice(0, limit).map((f, idx) => {
    const p = f?.properties || {};
    const idCandidate = f?.id ?? p.RevitId ?? p.id ?? p.roomId ?? p.RoomId;
    const roomLabel = String(
      p.roomNumber ?? p.RoomNumber ?? p.Number ?? p.Room ?? p.Name ?? ''
    ).trim();
    const type = String(
      p.RoomType ?? p.Type ?? p.type ?? p.Name ?? p.SpaceType ?? p.Use ?? ''
    ).trim();
    const dept = String(p.department ?? p.Department ?? p.Dept ?? '').trim();
    const occupant = String(p.occupant ?? p.Occupant ?? '').trim();
    const resolvedArea = resolvePatchedArea(p);
    const sf = Number.isFinite(resolvedArea)
      ? resolvedArea
      : Number(p.sf ?? p.SF ?? p.AreaSF ?? p.Area ?? p.area ?? 0) || 0;
    const fallbackId = [buildingLabel, floorId || p.Floor, roomLabel || idx].filter(Boolean).join('|') || `feat-${idx}`;
    const id = String(idCandidate ?? '').trim() || fallbackId;
    return {
      id,
      revitId: p.RevitId ?? idCandidate ?? null,
      roomId: id,
      buildingLabel: buildingLabel || String(p.buildingLabel ?? p.Building ?? p.building ?? '').trim(),
      floorId: floorId || String(p.floorId ?? p.floor ?? p.Floor ?? '').trim(),
      roomLabel,
      type,
      sf,
      department: dept,
      occupant,
      vacancy: occupant ? 'Occupied' : 'Unknown'
    };
  }).filter((x) => x.id);
}

const computeDeptTotalsAcrossCampus = async (deptName, opts) => {
  const { ensureFloorsForBuilding, buildFloorUrl, floorCache, fetchGeoJSON } = opts || {};
  const dept = (deptName || '').trim();
  if (!dept) return null;
  const deptLower = dept.toLowerCase();

  const totals = { totalSF: 0, rooms: 0, roomTypes: {}, sfByRoomType: {} };

  for (const b of BUILDINGS_LIST) {
    const buildingName = b?.name;
    if (!buildingName) continue;
    let floors = await ensureFloorsForBuilding(buildingName);
    if (!floors?.length) continue;

    for (const fl of floors) {
      const url = buildFloorUrl(buildingName, fl);
      if (!url) continue;

      let data = floorCache.get(url);
      if (!data) {
        try {
          data = await fetchGeoJSON(url);
          if (data) floorCache.set(url, data);
        } catch {
          continue;
        }
      }
      const fc = toFeatureCollection(data);
      const partial = computeDeptTotalsFromFeatures(fc?.features || [], deptLower);
      if (!partial) continue;

      totals.totalSF += partial.totalSF || 0;
      totals.rooms += partial.rooms || 0;
      Object.entries(partial.roomTypes || {}).forEach(([type, count]) => {
        totals.roomTypes[type] = (totals.roomTypes[type] || 0) + count;
      });
      Object.entries(partial.sfByRoomType || {}).forEach(([type, sf]) => {
        totals.sfByRoomType[type] = (totals.sfByRoomType[type] || 0) + sf;
      });
    }
  }

  if (!totals.rooms && !totals.totalSF) return null;
  return totals;
};

const computeDeptTotalsByBuildingAcrossCampus = async (deptName, opts) => {
  const { ensureFloorsForBuilding, buildFloorUrl, floorCache, fetchGeoJSON } = opts || {};
  const dept = (deptName || '').trim();
  if (!dept) return { perBuilding: {}, campusTotals: null };
  const deptLower = dept.toLowerCase();

  const perBuilding = {};
  const campusTotals = { totalSF: 0, rooms: 0, roomTypes: {}, sfByRoomType: {} };

  for (const b of BUILDINGS_LIST) {
    const buildingName = b?.name;
    if (!buildingName) continue;
    let floors = await ensureFloorsForBuilding(buildingName);
    if (!floors?.length) continue;

    const buildingTotals = { totalSF: 0, rooms: 0, roomTypes: {}, sfByRoomType: {} };

    for (const fl of floors) {
      const url = buildFloorUrl(buildingName, fl);
      if (!url) continue;

      let data = floorCache.get(url);
      if (!data) {
        try {
          data = await fetchGeoJSON(url);
          if (data) floorCache.set(url, data);
        } catch {
          continue;
        }
      }
      const fc = toFeatureCollection(data);
      const partial = computeDeptTotalsFromFeatures(fc?.features || [], deptLower);
      if (!partial) continue;

      buildingTotals.totalSF += partial.totalSF || 0;
      buildingTotals.rooms += partial.rooms || 0;
      Object.entries(partial.roomTypes || {}).forEach(([type, count]) => {
        buildingTotals.roomTypes[type] = (buildingTotals.roomTypes[type] || 0) + count;
      });
      Object.entries(partial.sfByRoomType || {}).forEach(([type, sf]) => {
        buildingTotals.sfByRoomType[type] = (buildingTotals.sfByRoomType[type] || 0) + sf;
      });
    }

    if (buildingTotals.rooms || buildingTotals.totalSF) {
      perBuilding[buildingName] = buildingTotals;
      campusTotals.totalSF += buildingTotals.totalSF;
      campusTotals.rooms += buildingTotals.rooms;
      Object.entries(buildingTotals.roomTypes || {}).forEach(([type, count]) => {
        campusTotals.roomTypes[type] = (campusTotals.roomTypes[type] || 0) + count;
      });
      Object.entries(buildingTotals.sfByRoomType || {}).forEach(([type, sf]) => {
        campusTotals.sfByRoomType[type] = (campusTotals.sfByRoomType[type] || 0) + sf;
      });
    }
  }

  if (!campusTotals.rooms && !campusTotals.totalSF) return { perBuilding: {}, campusTotals: null };
  return { perBuilding, campusTotals };
};

function formatSummaryForPanel(summary, mode) {
  if (!summary) {
    return {
      loading: false,
      mode,
      totalSf: '-',
      classroomSf: '-',
      rooms: '-',
      classroomCount: '-',
      labSf: '-',
      officeSf: '-',
      labCount: '-',
      officeCount: '-',
      deptCount: '-',
      keyDepts: []
    };
  }
  const fmt = (val) => (Number.isFinite(val) ? Math.round(val).toLocaleString() : '-');
  const fmtCount = (val) => (Number.isFinite(val) ? Number(val).toLocaleString() : '-');
  const deptCount = summary.deptCounts ? Object.keys(summary.deptCounts).length : 0;

  return {
    loading: false,
    mode,
    totalSf: fmt(summary.totalSf),
    classroomSf: fmt(summary.classroomSf),
    labSf: fmt(summary.labSf),
    officeSf: fmt(summary.officeSf),
    rooms: fmtCount(summary.rooms),
    classroomCount: fmtCount(summary.classroomCount),
    labCount: fmtCount(summary.labCount),
    officeCount: fmtCount(summary.officeCount),
    deptCount: deptCount ? deptCount.toString() : '-',
    keyDepts: summary.keyDepts || []
  };
}

// Normalize room property names across varying data sources
const normalizeRoomProps = (p = {}) => {
  const resolvedArea = resolvePatchedArea(p);
  const props = {
    number:     p.number ?? p.Number ?? p.RoomNumber ?? p['Room Number'] ?? '',
    name:       p.type ?? p.roomType ?? p.Name ?? p.RoomType ?? p['Room Type'] ?? '',
    department: p.department ?? p.Department ?? p.Dept ?? '',
    areaSF:     Number.isFinite(resolvedArea) ? resolvedArea : null,
    revitId:    p.revitId ?? p.RevitId ?? null,
    floor:      p.Floor ?? p.LevelName ?? p.Level ?? ''
  };
  return props;
};

// Slug helper to compare ids like "Hurley-McDonald Hall" vs "hurley_mcdonald"
function slugifyId(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Fit a rooms FeatureCollection to a building feature by scaling to bbox and aligning centroids
function fitFloorplanToBuilding(roomsFC, buildingGeomOrFeature) {
  try {
    if (!roomsFC || !Array.isArray(roomsFC.features) || roomsFC.features.length === 0) return roomsFC;

    const building = (buildingGeomOrFeature?.type === 'Feature')
      ? buildingGeomOrFeature
      : (buildingGeomOrFeature?.type ? { type: 'Feature', properties: {}, geometry: buildingGeomOrFeature } : null);

    if (!building) return roomsFC;

    let cRooms = turf.centroid(roomsFC);
    const cBldg = turf.centroid(building);

    const rotationDelta = getOrientationDeltaDeg(roomsFC, building);
    if (Number.isFinite(rotationDelta) && Math.abs(rotationDelta) > 1.5) {
      const rotated = turf.transformRotate(roomsFC, rotationDelta, { pivot: cRooms });
      if (rotated?.features?.length) {
        roomsFC = rotated;
        cRooms = turf.centroid(roomsFC);
      }
    }

    const [rxMin, ryMin, rxMax, ryMax] = turf.bbox(roomsFC);
    const [bxMin, byMin, bxMax, byMax] = turf.bbox(building);

    const rW = Math.max(1e-9, rxMax - rxMin);
    const rH = Math.max(1e-9, ryMax - ryMin);
    const bW = Math.max(1e-9, bxMax - bxMin);
    const bH = Math.max(1e-9, byMax - byMin);

    const FIT_MARGIN = 0.96; // 96% of building bbox
    const scale = Math.min(bW / rW, bH / rH) * FIT_MARGIN;

    let fitted = turf.transformScale(roomsFC, scale, { origin: cRooms });

    const fittedBBox = turf.bbox(fitted);
    const buildingCenter = [
      (bxMin + bxMax) / 2,
      (byMin + byMax) / 2
    ];
    const hasValidFittedBBox =
      Array.isArray(fittedBBox) &&
      fittedBBox.length === 4 &&
      fittedBBox.every((coord) => Number.isFinite(coord));
    const hasValidBuildingCenter =
      Number.isFinite(buildingCenter[0]) && Number.isFinite(buildingCenter[1]);

    let translated = false;
    if (hasValidFittedBBox && hasValidBuildingCenter) {
      const roomsCenter = [
        (fittedBBox[0] + fittedBBox[2]) / 2,
        (fittedBBox[1] + fittedBBox[3]) / 2
      ];
      const roomsCenterPt = turf.point(roomsCenter);
      const buildingCenterPt = turf.point(buildingCenter);
      const distKm = turf.distance(roomsCenterPt, buildingCenterPt, { units: 'kilometers' });
      const bearing = turf.bearing(roomsCenterPt, buildingCenterPt);
      if (Number.isFinite(distKm) && Number.isFinite(bearing)) {
        fitted = turf.transformTranslate(fitted, distKm, bearing, { units: 'kilometers' });
        translated = true;
      }
    }

    if (!translated) {
      // translate by centroid difference as a fallback
      const distKm = turf.distance(cRooms, cBldg, { units: 'kilometers' });
      const bearing = turf.bearing(cRooms, cBldg);
      if (Number.isFinite(distKm) && Number.isFinite(bearing)) {
        fitted = turf.transformTranslate(fitted, distKm, bearing, { units: 'kilometers' });
      }
    }

    const buildingPivot = cBldg?.geometry?.coordinates || buildingCenter;
    const refined = refineRotationToBuilding(fitted, building, buildingPivot, {
      maxDeg: 6,
      stepDeg: 0.4,
      fineStep: 0.1,
      fineWindow: 1.5,
      hullLimit: 1200
    });

    if (refined && typeof refined === 'object') {
      refined.__mfFitted = true;
      refined.__mfFittedBuilding = building?.properties?.id || building?.properties?.name || '';
    }
    return refined;
  } catch {
    return roomsFC;
  }
}

// Extract all [lng, lat] pairs from any geometry (handles deep nesting)
function extractLngLatPairs(geom, limit = Infinity) {
  const out = [];
  function collect(c) {
    if (!c || out.length >= limit) return;
    if (typeof c[0] === 'number') {
      out.push([c[0], c[1]]);
      return;
    }
    for (const child of c) {
      if (out.length >= limit) break;
      collect(child);
    }
  }
  if (geom?.type === 'GeometryCollection') (geom.geometries || []).forEach((g) => collect(g.coordinates));
  else collect(geom?.coordinates);
  return out;
}

function orientationFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let meanX = 0;
  let meanY = 0;
  points.forEach(([x, y]) => {
    meanX += x;
    meanY += y;
  });
  meanX /= points.length;
  meanY /= points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  points.forEach(([x, y]) => {
    const dx = x - meanX;
    const dy = y - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  });
  if (!Number.isFinite(xx) || !Number.isFinite(yy) || !Number.isFinite(xy)) return 0;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return (angle * 180) / Math.PI;
}

function isPositionArray(node) {
  return Array.isArray(node) && node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number';
}

function collectRings(node, rings) {
  if (!Array.isArray(node)) return;
  if (node.length && isPositionArray(node[0])) {
    rings.push(node);
    return;
  }
  node.forEach((child) => collectRings(child, rings));
}

function getDominantEdgeAngleDeg(geom) {
  if (!geom?.coordinates) return null;
  const rings = [];
  collectRings(geom.coordinates, rings);
  let bestLen = 0;
  let bestAngle = null;
  const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  rings.forEach((ring) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!isPositionArray(a) || !isPositionArray(b)) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len > bestLen) {
        bestLen = len;
        bestAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }
    const last = ring[ring.length - 1];
    const first = ring[0];
    if (isPositionArray(last) && isPositionArray(first) && !samePoint(last, first)) {
      const dx = first[0] - last[0];
      const dy = first[1] - last[1];
      const len = Math.hypot(dx, dy);
      if (len > bestLen) {
        bestLen = len;
        bestAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }
  });
  return bestAngle;
}

function getEdgeWeightedOrientationDeg(geom) {
  if (!geom?.coordinates) return null;
  const rings = [];
  collectRings(geom.coordinates, rings);
  let sumSin = 0;
  let sumCos = 0;
  let total = 0;
  rings.forEach((ring) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!isPositionArray(a) || !isPositionArray(b)) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len <= 0) continue;
      const angle = Math.atan2(dy, dx);
      sumCos += len * Math.cos(2 * angle);
      sumSin += len * Math.sin(2 * angle);
      total += len;
    }
  });
  if (total <= 0) return null;
  const angle = 0.5 * Math.atan2(sumSin, sumCos);
  return (angle * 180) / Math.PI;
}

function normalizeAngleDelta(deg) {
  let a = ((deg + 180) % 360) - 180;
  if (a > 90) a -= 180;
  if (a < -90) a += 180;
  return a;
}

function getFeatureOrientationDeg(feature, limit = 2000) {
  if (!feature?.geometry) return 0;
  const pts = extractLngLatPairs(feature.geometry, limit);
  return orientationFromPoints(pts);
}

function getFeatureCollectionOrientationDeg(fc, limit = 4000) {
  if (!fc?.features?.length) return 0;
  const pts = [];
  for (const f of fc.features) {
    if (pts.length >= limit) break;
    const next = extractLngLatPairs(f.geometry, limit - pts.length);
    if (next?.length) pts.push(...next);
  }
  return orientationFromPoints(pts);
}

function buildHullFeature(fc, limit = 3000) {
  if (!fc?.features?.length) return null;
  const pts = [];
  for (const f of fc.features) {
    if (pts.length >= limit) break;
    const next = extractLngLatPairs(f.geometry, limit - pts.length);
    if (next?.length) pts.push(...next);
  }
  if (pts.length < 3) return null;
  const ptFeatures = pts.map((c) => turf.point(c));
  const hull = turf.convex(turf.featureCollection(ptFeatures));
  return hull || null;
}

function getOrientationDeltaDeg(roomsFC, buildingFeature) {
  const hull = buildHullFeature(roomsFC);
  const roomsDominant = getDominantEdgeAngleDeg(hull?.geometry);
  const buildingDominant = getDominantEdgeAngleDeg(buildingFeature?.geometry);
  const roomsPca = getFeatureCollectionOrientationDeg(roomsFC);
  const buildingPca = getFeatureOrientationDeg(buildingFeature);
  const roomsWeighted = getEdgeWeightedOrientationDeg(hull?.geometry);
  const buildingWeighted = getEdgeWeightedOrientationDeg(buildingFeature?.geometry);

  const candidates = [];
  if (Number.isFinite(roomsDominant) && Number.isFinite(buildingDominant)) {
    candidates.push(normalizeAngleDelta(buildingDominant - roomsDominant));
  }
  if (Number.isFinite(roomsPca) && Number.isFinite(buildingPca)) {
    candidates.push(normalizeAngleDelta(buildingPca - roomsPca));
  }
  if (Number.isFinite(roomsWeighted) && Number.isFinite(buildingWeighted)) {
    candidates.push(normalizeAngleDelta(buildingWeighted - roomsWeighted));
  }

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)];
}

function overlapScore(hull, buildingFeature) {
  try {
    const inter = turf.intersect(turf.featureCollection([hull, buildingFeature]));
    if (!inter) return 0;
    const interArea = turf.area(inter);
    const hullArea = turf.area(hull);
    if (!Number.isFinite(interArea) || !Number.isFinite(hullArea) || hullArea <= 0) return 0;
    return interArea / hullArea;
  } catch {
    return 0;
  }
}

function refineRotationToBuilding(roomsFC, buildingFeature, pivot, options = {}) {
  if (!roomsFC || !buildingFeature || !pivot) return roomsFC;
  const maxDeg = Number.isFinite(options.maxDeg) ? options.maxDeg : 5;
  const stepDeg = Number.isFinite(options.stepDeg) ? options.stepDeg : 0.5;
  const fineStep = Number.isFinite(options.fineStep) ? options.fineStep : 0.1;
  const fineWindow = Number.isFinite(options.fineWindow) ? options.fineWindow : 1.2;
  const hull = buildHullFeature(roomsFC, options.hullLimit || 1200);
  if (!hull) return roomsFC;
  const baseScore = overlapScore(hull, buildingFeature);
  let bestAngle = 0;
  let bestScore = baseScore;

  for (let angle = -maxDeg; angle <= maxDeg; angle += stepDeg) {
    if (Math.abs(angle) < 1e-6) continue;
    const rotatedHull = turf.transformRotate(hull, angle, { pivot });
    const score = overlapScore(rotatedHull, buildingFeature);
    if (score > bestScore + 1e-4) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  if (fineStep > 0 && fineWindow > 0) {
    const start = bestAngle - fineWindow;
    const end = bestAngle + fineWindow;
    for (let angle = start; angle <= end; angle += fineStep) {
      if (Math.abs(angle) < 1e-6) continue;
      const rotatedHull = turf.transformRotate(hull, angle, { pivot });
      const score = overlapScore(rotatedHull, buildingFeature);
      if (score > bestScore + 1e-4) {
        bestScore = score;
        bestAngle = angle;
      }
    }
  }

  if (Math.abs(bestAngle) < 1e-3) return roomsFC;
  const rotated = turf.transformRotate(roomsFC, bestAngle, { pivot });
  return rotated?.features?.length ? rotated : roomsFC;
}

// Compute bbox [minX, minY, maxX, maxY] from a FeatureCollection using extractLngLatPairs
function bboxFromFC(fc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  (fc?.features || []).forEach((f) => {
    extractLngLatPairs(f.geometry).forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });
  });
  return [minX, minY, maxX, maxY];
}

function shouldFitFloorplanToBuilding(roomsFC, buildingFeature) {
  try {
    if (roomsFC?.__mfFitted) return false;
    if (!roomsFC || !roomsFC.features?.length || !buildingFeature) return false;
    const [rxMin, ryMin, rxMax, ryMax] = turf.bbox(roomsFC);
    const [bxMin, byMin, bxMax, byMax] = turf.bbox(buildingFeature);
    if (![rxMin, ryMin, rxMax, ryMax, bxMin, byMin, bxMax, byMax].every(Number.isFinite)) return false;

    const rW = Math.max(1e-9, rxMax - rxMin);
    const rH = Math.max(1e-9, ryMax - ryMin);
    const bW = Math.max(1e-9, bxMax - bxMin);
    const bH = Math.max(1e-9, byMax - byMin);
    const scale = Math.min(bW / rW, bH / rH);
    const scaleMismatch = scale < 0.75 || scale > 1.35;

    const roomsCenter = turf.centroid(roomsFC);
    const buildingCenter = turf.centroid(buildingFeature);
    const distKm = turf.distance(roomsCenter, buildingCenter, { units: 'kilometers' });
    const farApart = Number.isFinite(distKm) && distKm > 0.06;

    const noOverlap =
      rxMax < bxMin ||
      rxMin > bxMax ||
      ryMax < byMin ||
      ryMin > byMax;

    const rotationDelta = getOrientationDeltaDeg(roomsFC, buildingFeature);
    const needsRotation = Number.isFinite(rotationDelta) && Math.abs(rotationDelta) > 1.5;

    return scaleMismatch || farApart || noOverlap || needsRotation;
  } catch {
    return false;
  }
}

// --- Floorplan config (file-based, no manifest, no affine) ---
const BUILDINGS_LIST = [
  // name shown in dropdown            folder name under /floorplans/Hastings
  { name: 'Hurley-McDonald Hall',      folder: 'HurleyMcDonald' },
  { name: 'Gray Center',               folder: 'Gray Center' },
  { name: 'Morrison-Reeves Science Center', folder: 'Morrison Reeves' },
  { name: '1882', folder: '1882' },
  { name: 'Altman Hall', folder: 'Altman Hall' },
  { name: 'Babcock Hall', folder: 'Babcock Hall' },
  { name: 'Barrett Alumni', folder: 'Barrett Alumni' },
  { name: 'Batchelder Services Bldg', folder: 'Batchelder' },
  { name: 'Bronc Hall', folder: 'Bronc Hall' },
  { name: 'Calvin H. French Chapel', folder: 'Calvin French Chapel' },
  { name: 'Daugherty Student Engagement Center', folder: 'Daugherty' },
  { name: 'Farrell-Fleharty', folder: 'Fleharty' },
  { name: 'Hazzelrig Student Union', folder: 'Hazzelrig' },
  { name: 'Jackson Dinsdale Art Center', folder: 'Jackson Dinsdale' },
  { name: 'Kiewit Building', folder: 'Kiewit' },
  { name: 'Lloyd Wilson Stadium', folder: 'Lloyd Wilson Stadium' },
  { name: 'McCormick Hall', folder: 'McCormick' },
  { name: 'Perkins Library', folder: 'Perkins' },
  { name: 'Physical Fitness Facility', folder: 'Physical Fitness Facility' },
  { name: 'Scott Studio Theater', folder: 'Scott Theater' },
  { name: 'Taylor Hall ', folder: 'Taylor Hall' },
  { name: 'Wilson Center', folder: 'Wilson Center' },

  // add more as you add folders...
];

const BUILDING_FOLDER_MAP = Object.fromEntries(
  BUILDINGS_LIST.map((b) => [b.name, b.folder])
);
const BUILDING_FOLDER_SET = new Set(BUILDINGS_LIST.map((b) => b.folder));
const BUILDING_FOLDER_TO_NAME = Object.fromEntries(
  BUILDINGS_LIST.map((b) => [b.folder, b.name])
);

const BUILDING_ALIAS = {
  'Hurley-McDonald Hall': 'hurley_mcdonald',
  'Gray Center': 'gray_center',
  'Morrison-Reeves Science Center': 'morrison_reeves',
};
const BUILDING_ALIAS_REVERSE = Object.fromEntries(
  Object.entries(BUILDING_ALIAS).map(([name, alias]) => [alias, name])
);

// Floorplan view tuning
const FLOORPLAN_FIT_PADDING = 8;   // tighter frame around floor
const FLOORPLAN_SCALE = 1.0;       // auto-fit handles size; keep neutral here

const mergePatch = (props, patch) => ({ ...props, ...patch });

/**
 * Unload the active single-floor source/layers (FLOOR_*).
 * Safe to call even if nothing is loaded.
 */
function unloadFloorplan(map, currentFloorUrlRef) {
  if (!map) return;
  try {
    if (map.getLayer(FLOOR_HL_ID)) map.removeLayer(FLOOR_HL_ID);
    if (map.getLayer(FLOOR_HL_BORDER_ID)) map.removeLayer(FLOOR_HL_BORDER_ID);
    if (map.getLayer(FLOOR_ROOM_LABEL_LAYER)) map.removeLayer(FLOOR_ROOM_LABEL_LAYER);
    if (map.getLayer(FLOOR_LINE_ID)) map.removeLayer(FLOOR_LINE_ID);
    if (map.getLayer(FLOOR_DOOR_LAYER)) map.removeLayer(FLOOR_DOOR_LAYER);
    if (map.getLayer(FLOOR_STAIR_LAYER)) map.removeLayer(FLOOR_STAIR_LAYER);
    if (map.getLayer(FLOOR_FILL_ID)) map.removeLayer(FLOOR_FILL_ID);
    if (map.getSource(FLOOR_SOURCE)) map.removeSource(FLOOR_SOURCE);
  if (map.getLayer(WALLS_LAYER)) map.removeLayer(WALLS_LAYER);
  if (map.getSource(WALLS_SOURCE)) map.removeSource(WALLS_SOURCE);
  if (map.getLayer(DOORS_LAYER)) map.removeLayer(DOORS_LAYER);
  if (map.getSource(DOORS_SOURCE)) map.removeSource(DOORS_SOURCE);
  if (map.getLayer(STAIRS_LAYER)) map.removeLayer(STAIRS_LAYER);
  if (map.getSource(STAIRS_SOURCE)) map.removeSource(STAIRS_SOURCE);
  } catch {}
  if (currentFloorUrlRef) currentFloorUrlRef.current = null;
}

/**
 * Center on the current single-floor source if it exists.
 */
function centerOnCurrentFloor(map) {
  try {
    const src = map?.getSource(FLOOR_SOURCE);
    const data = src?._data || src?.serialize?.()?.data;
    const fc = toFeatureCollection(data);
    if (!fc) return;
    const b = turf.bbox(fc);
    if (b && isFinite(b[0])) {
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 500 });
    }
  } catch {}
}

function ensureFloorRoomLabelLayer(map) {
  if (!map) return;
  const scenarioDeptField = [
    'coalesce',
    ['get', 'scenarioDepartment'],
    ['get', 'department'],
    ['get', 'Department'],
    ['literal', '-']
  ];
  const typeField = [
    'coalesce',
    ['get', 'RoomType'],
    ['get', 'Type'],
    ['get', 'type'],
    ['get', 'Name'],
    ['literal', '-']
  ];
  const textField = [
    'concat',
    ['coalesce', ['get', 'Number'], ['get', 'RoomNumber'], ['get', 'name'], ['literal', '-']],
    '\n',
    typeField,
    '\n',
    scenarioDeptField,
    '\n',
    ['concat', ['to-string', ['round', ['coalesce', ['get', 'Area_SF'], ['get', 'Area'], 0]]], ' SF']
  ];
  const textSizeExpr = [
    'interpolate',
    ['linear'],
    ['zoom'],
    14, 0,
    15, 0,
    16, 3,
    17, 5,
    18, 7,
    19, 10
  ];
  if (map.getLayer(FLOOR_ROOM_LABEL_LAYER)) {
    try {
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'text-field', textField);
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'text-size', textSizeExpr);
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'symbol-placement', 'point');
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'text-allow-overlap', false);
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'text-ignore-placement', false);
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'text-max-width', 6);
      map.setLayoutProperty(FLOOR_ROOM_LABEL_LAYER, 'visibility', 'visible');
    } catch {}
    bringFloorRoomLabelsToFront(map);
    return;
  }
  try {
    map.addLayer(
      {
        id: FLOOR_ROOM_LABEL_LAYER,
        type: 'symbol',
        source: FLOOR_SOURCE,
        layout: {
          'text-field': textField,
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-size': textSizeExpr,
          'text-line-height': 1.0,
          'text-variable-anchor': ['center'],
          'text-radial-offset': 0,
          'text-anchor': 'center',
          'text-justify': 'center',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-max-width': 6,
          'visibility': 'visible'
      },
      paint: {
        'text-color': '#0b0b0b',
        'text-halo-color': 'rgba(255,255,255,0.95)',
        'text-halo-width': 1
      },
        filter: ['!=', ['id'], -1]
      },
      FLOOR_LINE_ID
    );
    bringFloorRoomLabelsToFront(map);
  } catch {}
}

function bringFloorRoomLabelsToFront(map) {
  if (!map) return;
  try {
    if (map.getLayer(FLOOR_ROOM_LABEL_LAYER)) {
      map.moveLayer(FLOOR_ROOM_LABEL_LAYER);
    }
  } catch {}
}

// Load Firestore rooms at path:
// universities/{campusId}/buildings/{buildingId}/floors/{floorId}/rooms
async function loadRooms(db, campusId, buildingId, floorId) {
  const colRef = collection(
    db,
    `universities/${campusId}/buildings/${buildingId}/floors/${floorId}/rooms`
  );
  const snap = await getDocs(colRef);
  const byId = {};
  snap.forEach((d) => {
    byId[String(d.id)] = d.data();
  });
  return byId;
}

const stakeholderConditionConfig = {
  '5': { label: '5 = Excellent condition', color: '#4CAF50' },
  '4': { label: '4 = Good condition', color: '#8BC34A' },
  '3': { label: '3 = Adequate condition', color: '#FFEB3B' },
  '2': { label: '2 = Poor condition', color: '#FF9800' },
  '1': { label: '1 = Very poor condition', color: '#F44336' }
};

const progressColors = {
  0: '#85474b',
  1: '#aed6f1',
  2: '#5dade2',
  3: '#2e86c1'
};

const defaultBuildingColor = '#85474b';

const StakeholderMap = ({ config, universityId, mode = 'public', persona }) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const previousSelectedBuildingId = useRef(null);
  const floorSelectionRef = useRef({}); // remember last selected room id per floor URL

  const [mapLoaded, setMapLoaded] = useState(false);
  const [interactionMode, setInteractionMode] = useState('select');
  const [showMarkers, setShowMarkers] = useState(mode === 'admin'); // Paths feature removed
  const [showHelp, setShowHelp] = useState(true);
  const [markers, setMarkers] = useState([]); // Paths feature removed
  const [buildingConditions, setBuildingConditions] = useState({});
  const [buildingAssessments, setBuildingAssessments] = useState({});
  const [selectedBuildingId, setSelectedBuildingId] = useState(null);
  const [selectedBuilding, setSelectedBuilding] = useState(BUILDINGS_LIST[0]?.name || '');
  const universityName = config?.universityName || config?.name || '';
  const activeUniversityName = universityName || universityId || 'Campus';
  // ---- Map view modes ----
  const MAP_VIEWS = {
    SPACE_DATA: 'space-data',
    ASSESSMENT: 'assessment',
    TECHNICAL: 'technical'
  };
  const [mapView, setMapView] = useState(MAP_VIEWS.SPACE_DATA);
  const MAP_VIEW_OPTIONS = [
    { value: MAP_VIEWS.SPACE_DATA, label: 'Space Data' },
    { value: MAP_VIEWS.ASSESSMENT, label: 'Assessment Progress' },
    { value: MAP_VIEWS.TECHNICAL, label: 'Technical' }
  ];
  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [isTechnicalPanelOpen, setIsTechnicalPanelOpen] = useState(false);
  useEffect(() => {
    const target = mapContainerRef.current;
    if (!target) return () => {};
    const scrub = () => {
      const buttons = target.querySelectorAll('.mapboxgl-popup-close-button[aria-hidden="true"]');
      buttons.forEach((btn) => btn.removeAttribute('aria-hidden'));
    };
    scrub();
    const observer = new MutationObserver(scrub);
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden'] });
    return () => observer.disconnect();
  }, []);
  const [isBuildingPanelCollapsed, setIsBuildingPanelCollapsed] = useState(true);

  const baseTypeOptions = useMemo(() => buildTypeOptionList(ROOM_TYPES), []);
  const baseDeptOptions = useMemo(() => Array.from(new Set([...Object.keys(DEPT_COLORS), ...DEPARTMENTS])).sort(), []);

  // ===== STATS STATE + REFS =====
  const [buildingStats, setBuildingStats] = useState(null); // { totalSf, rooms, classroomSf, classroomCount, totalsByDept }
  const [floorStats, setFloorStats] = useState(null);       // same shape for current floor
  const [campusStats, setCampusStats] = useState(null);
  const [campusPanelStats, setCampusPanelStats] = useState(null);
  const [popupMode, setPopupMode] = useState('building');
  const [panelStats, setPanelStats] = useState(null); // legacy stats for existing UI panels
  const [floorStatsByBuilding, setFloorStatsByBuilding] = useState({});
  const [floorLegendItems, setFloorLegendItems] = useState([]);
  const [floorLegendLookup, setFloorLegendLookup] = useState(new Map());
  const [floorLegendSelection, setFloorLegendSelection] = useState(null);
  const floorHighlightIdsRef = useRef([]);
  const [typeOptions, setTypeOptions] = useState(baseTypeOptions);
  const [deptOptions, setDeptOptions] = useState(baseDeptOptions);
  const [roomEditIncluded, setRoomEditIncluded] = useState(new Set());
  const [exportBuildingFilter, setExportBuildingFilter] = useState('__all__');
  const [exportDeptFilter, setExportDeptFilter] = useState('');
  const [exportSpaceMode, setExportSpaceMode] = useState('rooms');
  const [exportingSpaceData, setExportingSpaceData] = useState(false);
  const [exportSpaceMessage, setExportSpaceMessage] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [aiBuildingOpen, setAiBuildingOpen] = useState(false);
  const [aiBuildingLoading, setAiBuildingLoading] = useState(false);
  const [aiBuildingErr, setAiBuildingErr] = useState('');
  const [aiBuildingResult, setAiBuildingResult] = useState(null);
  const [aiCampusOpen, setAiCampusOpen] = useState(false);
  const [aiCampusLoading, setAiCampusLoading] = useState(false);
  const [aiCampusErr, setAiCampusErr] = useState('');
  const [aiCampusResult, setAiCampusResult] = useState(null);
  const [aiScenarioOpen, setAiScenarioOpen] = useState(false);
  const [aiScenarioLoading, setAiScenarioLoading] = useState(false);
  const [aiScenarioErr, setAiScenarioErr] = useState('');
  const [aiScenarioResult, setAiScenarioResult] = useState(null);
  const [aiCreateScenarioOpen, setAiCreateScenarioOpen] = useState(false);
  const [aiCreateScenarioText, setAiCreateScenarioText] = useState('');
  const [aiCreateScenarioLoading, setAiCreateScenarioLoading] = useState(false);
  const [aiCreateScenarioErr, setAiCreateScenarioErr] = useState('');
  const [aiCreateScenarioResult, setAiCreateScenarioResult] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [askErr, setAskErr] = useState('');
  const [askResult, setAskResult] = useState(null);
  const [scenarioBaselineTotals, setScenarioBaselineTotals] = useState(null);
  const [aiInfoOpen, setAiInfoOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState('unknown'); // "ok" | "down" | "unknown"
  const FLOOR_COLOR_MODES = useMemo(() => ({
    DEPARTMENT: 'department',
    TYPE: 'type',
    OCCUPANCY: 'occupancy',
    VACANCY: 'vacancy'
  }), []);
  const [floorColorMode, setFloorColorMode] = useState('department');
  const mergeOptionsList = (prev, next) => {
    const seen = new Set(prev);
    (next || []).forEach((item) => {
      if (item) seen.add(item);
    });
    return Array.from(seen).sort();
  };

  const setFloorHighlight = useCallback((idOrIds) => {
    const map = mapRef.current;
    if (!map || !map.getLayer(FLOOR_HL_ID)) return;
    const ids = Array.isArray(idOrIds)
      ? idOrIds.filter((v) => v != null)
      : (idOrIds != null ? [idOrIds] : []);
    floorHighlightIdsRef.current = ids;
    const filter = ids.length
      ? ['any',
          ['in', ['id'], ['literal', ids]],
          ['in', ['get', 'RevitId'], ['literal', ids]]
        ]
      : ['==', ['id'], ''];
    try {
      map.setFilter(FLOOR_HL_ID, filter);
      if (map.getLayer(FLOOR_HL_BORDER_ID)) {
        map.setFilter(FLOOR_HL_BORDER_ID, filter);
      }
    } catch {}
  }, []);

  const [roomPatches, setRoomPatches] = useState(new Map());
  const [roomEditOpen, setRoomEditOpen] = useState(false);
  const [roomEditData, setRoomEditData] = useState(null);
  const [roomEditSelection, setRoomEditSelection] = useState([]);
  const roomEditSelectionRef = useRef([]);
  const getHighlightIdsForSelection = useCallback((selection = []) => {
    return (selection || [])
      .map((t) => t?.highlightId ?? t?.revitId ?? t?.roomId ?? null)
      .filter((v) => v != null);
  }, []);
  const applySelectionHighlight = useCallback((selection = []) => {
    const ids = getHighlightIdsForSelection(selection);
    setFloorHighlight(ids.length ? ids : null);
  }, [getHighlightIdsForSelection, setFloorHighlight]);
  const clearRoomEditSelection = useCallback(() => {
    roomEditSelectionRef.current = [];
    setRoomEditSelection([]);
    applySelectionHighlight([]);
  }, [applySelectionHighlight]);

  const buildLegendForMode = useCallback((mode) => {
    const map = mapRef.current;
    const src = map?.getSource(FLOOR_SOURCE);
    if (!src) return;
    const data = src._data || src.serialize?.()?.data || null;
    const fc = toFeatureCollection(data);
    if (!fc?.features?.length) return;
    const sums = new Map();
    const idsByKey = new Map();

    const normalizeId = (val) => {
      if (Number.isFinite(val)) return val;
      const asNum = Number(val);
      return Number.isFinite(asNum) ? asNum : String(val);
    };

    fc.features.forEach((f) => {
      const p = f.properties || {};
      const areaVal = resolvePatchedArea(p);
      if (!Number.isFinite(areaVal) || areaVal <= 0) return;
      let key = '';
      let color = '#e6e6e6';
      if (mode === FLOOR_COLOR_MODES.TYPE) {
        key = p.RoomType || p.Type || p.type || p.Name || 'Unspecified';
        color = colorForType(key);
      } else if (mode === FLOOR_COLOR_MODES.OCCUPANCY) {
        const occ = (p.occupant ?? p.Occupant ?? '').toString().trim();
        key = occ ? 'Occupied' : 'Unoccupied';
        color = occ ? '#29b6f6' : '#cfd8dc';
      } else if (mode === FLOOR_COLOR_MODES.VACANCY) {
        const occ = (p.occupant ?? p.Occupant ?? '').toString().trim();
        key = occ ? 'Occupied' : 'Vacant';
        color = occ ? '#29b6f6' : '#ff7043';
      } else {
        key = getDeptFromProps(p) || 'Unspecified';
        color = getDeptColor(key) || '#e6e6e6';
      }
      const prev = sums.get(key) || { name: key, areaSf: 0, color };
      prev.areaSf += areaVal;
      prev.color = color;
      sums.set(key, prev);
      const fid = normalizeId(f.id ?? p.RevitId ?? p.id);
      if (fid != null) {
        const list = idsByKey.get(key) || [];
        list.push(fid);
        idsByKey.set(key, list);
      }
    });

    const items = Array.from(sums.values()).map((item) => ({
      ...item,
      ids: idsByKey.get(item.name) || []
    })).sort((a, b) => (b.areaSf || 0) - (a.areaSf || 0));
    setFloorLegendItems(items);
    setFloorLegendLookup(new Map(items.map((item) => [item.name, item.ids || []])));
  }, [FLOOR_COLOR_MODES.OCCUPANCY, FLOOR_COLOR_MODES.TYPE, FLOOR_COLOR_MODES.VACANCY]);

  const applyFloorColorMode = useCallback((mode) => {
    const map = mapRef.current;
    if (!map || !map.getLayer(FLOOR_FILL_ID)) return;
    const src = map.getSource(FLOOR_SOURCE);
    const data = src ? (src._data || src.serialize?.().data || null) : null;
    const fc = toFeatureCollection(data);

    if (mode === FLOOR_COLOR_MODES.TYPE && fc?.features?.length) {
      const typeColorMap = new Map();
      const areaSums = new Map();
      const idsByType = new Map();
      const normalizeId = (val) => {
        if (Number.isFinite(val)) return val;
        const asNum = Number(val);
        return Number.isFinite(asNum) ? asNum : (val != null ? String(val) : null);
      };
      fc.features.forEach((f) => {
        const p = f.properties || {};
        const typeVal = p.RoomType || p.Type || p.type || p.Name || 'Unspecified';
        const color = colorForType(typeVal);
        typeColorMap.set(typeVal, color);
        const areaVal = resolvePatchedArea(p);
        if (Number.isFinite(areaVal) && areaVal > 0) {
          const prev = areaSums.get(typeVal) || 0;
          areaSums.set(typeVal, prev + areaVal);
        }
        const fid = normalizeId(f.id ?? p.RevitId ?? p.id);
        if (fid != null) {
          const list = idsByType.get(typeVal) || [];
          list.push(fid);
          idsByType.set(typeVal, list);
        }
      });
      const pairs = [];
      typeColorMap.forEach((color, typeVal) => {
        pairs.push(typeVal, color);
      });
      const typeExpr = [
        'match',
        ['coalesce', ['get', 'RoomType'], ['get', 'Type'], ['get', 'type'], ['get', 'Name']],
        ...pairs,
        '#e6e6e6'
      ];
      try {
        map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', typeExpr);
        map.setPaintProperty(FLOOR_FILL_ID, 'fill-opacity', 1);
        const legend = Array.from(typeColorMap.entries()).map(([name, color]) => ({
          name,
          color,
          areaSf: areaSums.get(name) || 0,
          ids: idsByType.get(name) || []
        })).sort((a, b) => (b.areaSf || 0) - (a.areaSf || 0));
        setFloorLegendItems(legend);
        setFloorLegendLookup(new Map(legend.map((item) => [item.name, item.ids || []])));
        return;
      } catch {}
    }

    applyFloorFillExpression(map, mode);
    buildLegendForMode(mode);
    setFloorColorMode(mode);
  }, [FLOOR_COLOR_MODES.TYPE, applyFloorFillExpression, buildLegendForMode]);
  useEffect(() => {
    roomEditSelectionRef.current = roomEditSelection;
  }, [roomEditSelection]);
  const closeRoomEdit = useCallback(() => {
    setRoomEditOpen(false);
    setRoomEditData(null);
    clearRoomEditSelection();
    setFloorHighlight(null);
    setRoomEditIncluded(new Set());
  }, [clearRoomEditSelection, setFloorHighlight]);
  const roomEditTargets = roomEditData?.targets?.length
    ? roomEditData.targets
    : roomEditData
      ? [roomEditData]
      : [];
  const primaryRoomEditTarget = roomEditTargets[0] || null;
  const roomEditFeatureProps = primaryRoomEditTarget?.feature?.properties || {};
  const roomEditMergedProps = { ...roomEditFeatureProps, ...(roomEditData?.properties || {}) };
  const editHasOffice = roomEditTargets.some((t) => {
    const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}), ...(roomEditData?.properties || {}) };
    const cat = getRoomCategoryCode(merged);
    const flags = detectRoomTypeFlags(merged);
    return (isOfficeCategory(cat) || flags.isOfficeText || t?.flags?.isOffice);
  });
  const editHasTeaching = roomEditTargets.some((t) => {
    const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}), ...(roomEditData?.properties || {}) };
    const cat = getRoomCategoryCode(merged);
    const flags = detectRoomTypeFlags(merged);
    return (isTeachingCategory(cat) || flags.isTeachingText || t?.flags?.isTeaching);
  });
  const editSeatCounts = roomEditTargets
    .map((t) => getSeatCount({ ...(t?.feature?.properties || {}), ...(t?.properties || {}) }))
    .filter((n) => Number.isFinite(n));
  const editSeatCountDisplay = editSeatCounts.length
    ? (editSeatCounts.every((n) => n === editSeatCounts[0]) ? editSeatCounts[0].toLocaleString() : 'varies')
    : '-';
  const ncesCategoryCode = pickFirstDefined(roomEditMergedProps, [
    'NCES_Category',
    'NCES Category',
    'NCES_Category_Code',
    'NCES Category Code'
  ]);
  const ncesTypeCode = pickFirstDefined(roomEditMergedProps, [
    'NCES_Type',
    'NCES Type',
    'NCES_Type_Code',
    'NCES Type Code'
  ]);
  const ncesTypeDesc = pickFirstDefined(roomEditMergedProps, [
    'NCES_Type Description_Sh',
    'NCES_Type Description',
    'NCES Type Description',
    'NCES_Type Description_Short'
  ]);
  const ncesTypeDisplay = ncesTypeCode
    ? `${ncesTypeCode}${ncesTypeDesc ? ` - ${ncesTypeDesc}` : ''}`
    : ncesTypeDesc || '-';
  const selectedBuildingIdRef = useRef(null);
  const selectedBuildingFeatureRef = useRef(null);
  const currentFloorUrlRef = useRef(null);
  const lastFloorUrlRef = useRef(null);
  const currentFloorContextRef = useRef({ url: null, key: null, buildingId: null, floorId: null });
  const currentRoomFeatureRef = useRef(null);
  const buildingStatsCache = useRef({});
  const floorStatsCache = useRef({});
  const floorSummaryCacheRef = useRef(new Map());
  const floorRoomsRef = useRef(new Map());
  const floorStatsByBuildingRef = useRef({});
  const panelBuildingKeyRef = useRef(null);
  const roomSubRef = useRef(null);

  // Floorplans
  const roomAttrsRef = useRef({});
  const [selectedFloor, setSelectedFloor] = useState('LEVEL_1');
  const [availableFloors, setAvailableFloors] = useState([]);
  const availableFloorsByBuildingRef = useRef(new Map());
  const getAvailableFloors = useCallback((buildingKey) => {
    if (!buildingKey) return [];
    return availableFloorsByBuildingRef.current.get(buildingKey) ?? [];
  }, []);
  const getBuildingFolderKey = useCallback((idOrName) => {
    if (!idOrName) return null;
    if (BUILDING_FOLDER_MAP[idOrName]) return BUILDING_FOLDER_MAP[idOrName];
    if (BUILDING_FOLDER_SET.has(idOrName)) return idOrName;
    const aliasMatch = BUILDING_ALIAS_REVERSE[idOrName];
    if (aliasMatch && BUILDING_FOLDER_MAP[aliasMatch]) return BUILDING_FOLDER_MAP[aliasMatch];
    return null;
  }, []);
  const buildFloorUrl = useCallback((buildingKeyOrName, floorId) => {
    if (!buildingKeyOrName || !floorId) return null;
    const folderKey = getBuildingFolderKey(buildingKeyOrName);
    if (!folderKey) return null;
    const floors = getAvailableFloors(folderKey);
    if (!floors.includes(floorId)) return null;
    const campusSeg = encodeURIComponent(DEFAULT_FLOORPLAN_CAMPUS);
    const buildingSeg = encodeURIComponent(folderKey);
    const floorSeg = encodeURIComponent(floorId);
    return assetUrl(`floorplans/${campusSeg}/${buildingSeg}/${floorSeg}_Dept.geojson`);
  }, [getAvailableFloors, getBuildingFolderKey]);
  const ensureFloorsForBuilding = useCallback(async (buildingKeyOrName) => {
    const folderKey = getBuildingFolderKey(buildingKeyOrName);
    if (!folderKey) return [];
    const cached = getAvailableFloors(folderKey);
    if (cached.length) return cached;
    const floors = await loadFloorManifest(folderKey);
    availableFloorsByBuildingRef.current.set(folderKey, floors);
    return floors;
  }, [getBuildingFolderKey, getAvailableFloors]);
  const [loadedFloors, setLoadedFloors] = useState([]);
  const [loadedSingleFloor, setLoadedSingleFloor] = useState(false);
  const loadedFloorsRef = useRef([]);
  const floorUrlRef = useRef(null);

  const floorUrl = useMemo(() => {
    return buildFloorUrl(selectedBuilding, selectedFloor);
  }, [selectedBuilding, selectedFloor, buildFloorUrl]);
  useEffect(() => {
    floorUrlRef.current = floorUrl;
  }, [floorUrl]);
  useEffect(() => {
    if (!mapLoaded || !floorUrl) return;
    applyFloorColorMode(floorColorMode);
  }, [mapLoaded, floorUrl, floorColorMode, applyFloorColorMode]);
  useEffect(() => {
    if (!mapLoaded || !floorUrl) return;
    buildLegendForMode(floorColorMode);
  }, [mapLoaded, floorUrl, floorColorMode, buildLegendForMode]);
  useEffect(() => {
    // clear legend selection on mode change or floor change
    setFloorLegendSelection(null);
    setFloorHighlight(null);
  }, [floorColorMode, floorUrl, setFloorHighlight]);
  useEffect(() => {
    clearRoomEditSelection();
  }, [selectedBuildingId, floorUrl, clearRoomEditSelection]);

  useEffect(() => {
    setAiOpen(false);
    setAiLoading(false);
    setAiResult(null);
    setAiErr('');
    setAiBuildingOpen(false);
    setAiBuildingLoading(false);
    setAiBuildingResult(null);
    setAiBuildingErr('');
    setAiCreateScenarioOpen(false);
    setAiCreateScenarioLoading(false);
    setAiCreateScenarioResult(null);
    setAiCreateScenarioErr('');
  }, [selectedBuildingId, selectedBuilding, selectedFloor]);

  const [moveScenarioMode, setMoveScenarioMode] = useState(false);
  const [scenarioSelection, setScenarioSelection] = useState(new Set());
  const [scenarioAssignments, setScenarioAssignments] = useState({});
  const [scenarioAssignedDept, setScenarioAssignedDept] = useState('');
  const [scenarioLabel, setScenarioLabel] = useState('');
  const [scenarioTotals, setScenarioTotals] = useState({
    totalSF: 0,
    rooms: 0,
    roomTypes: {},
    sfByRoomType: {}
  });
  const baselineAvailable = Boolean(floorStats || buildingStats || campusStats);
  const scenarioAvailable = Boolean(scenarioTotals);
  const combinedScenarioRoomStats = useMemo(() => {
    const types = new Set([
      ...Object.keys(scenarioTotals.roomTypes || {}),
      ...Object.keys(scenarioTotals.sfByRoomType || {})
    ]);
    return Array.from(types).map((type) => ({
      type,
      count: scenarioTotals.roomTypes?.[type] ?? 0,
      sf: scenarioTotals.sfByRoomType?.[type] ?? 0
    }));
  }, [scenarioTotals]);
  const [scenarioPanelVisible, setScenarioPanelVisible] = useState(false);
  const scenarioRoomInfoRef = useRef(new Map());
  const previousScenarioSelectionRef = useRef(new Set());
  const [scenarioPanelTop, setScenarioPanelTop] = useState(320);

  const SCENARIO_LAYER_ID = 'scenario-highlight';
  const DEFAULT_SCENARIO_COLOR = 'rgba(255, 159, 64, 0.9)';
  const DEFAULT_SCENARIO_OUTLINE = '#ff9f40';

  const resetScenarioRecolor = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(SCENARIO_LAYER_ID)) {
      try {
        map.removeLayer(SCENARIO_LAYER_ID);
      } catch {}
    }
  }, []);

  const updateScenarioDepartmentOnFloor = useCallback((updates = []) => {
    if (!updates.length) return;
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource(FLOOR_SOURCE);
    if (!source) return;
    const data = source._data || source.serialize?.()?.data;
    const fc = toFeatureCollection(data);
    if (!fc?.features?.length) return;
    const entriesById = new Map();
    updates.forEach(({ revitId, dept }) => {
      if (revitId == null) return;
      entriesById.set(String(revitId), dept ?? null);
    });
    if (!entriesById.size) return;
    let changed = false;
    const newFeatures = fc.features.map((feature) => {
      const revitId = feature.id ?? feature.properties?.RevitId;
      if (revitId == null) return feature;
      const key = String(revitId);
      if (!entriesById.has(key)) return feature;
      const deptValue = entriesById.get(key);
      const nextProps = { ...(feature.properties || {}) };
      const prevDept = feature.properties?.scenarioDepartment ?? null;
      if (deptValue) nextProps.scenarioDepartment = deptValue;
      else delete nextProps.scenarioDepartment;
      const nextDept = nextProps.scenarioDepartment ?? null;
      if (prevDept === nextDept) return feature;
      changed = true;
      return { ...feature, properties: nextProps };
    });
    if (!changed) return;
    const updatedFC = { ...fc, features: newFeatures };
    try {
      source.setData(updatedFC);
    } catch {}
    if (currentFloorContextRef.current) {
      currentFloorContextRef.current = {
        ...(currentFloorContextRef.current || {}),
        fc: updatedFC
      };
    }
  }, []);

  const clearScenarioFeatureStates = useCallback((roomKeys = [], infoMap = scenarioRoomInfoRef.current) => {
    const map = mapRef.current;
    if (!map) return;
    roomKeys.forEach((roomKey) => {
      const info = infoMap.get(roomKey);
      if (!info?.revitId) return;
      try {
        map.removeFeatureState({ source: FLOOR_SOURCE, id: info.revitId }, 'scenarioColor');
        map.removeFeatureState({ source: FLOOR_SOURCE, id: info.revitId }, 'scenarioOutlineColor');
        map.removeFeatureState({ source: FLOOR_SOURCE, id: info.revitId }, 'scenarioDepartment');
      } catch {}
    });
  }, []);

  const resetScenarioModeState = useCallback(() => {
    const sourceInfos = Array.from(scenarioRoomInfoRef.current.values());
    const removalUpdates = sourceInfos
      .filter((info) => info?.revitId != null)
      .map((info) => ({ revitId: info.revitId, dept: null }));
    clearScenarioFeatureStates(Array.from(previousScenarioSelectionRef.current), scenarioRoomInfoRef.current);
    if (removalUpdates.length) {
      updateScenarioDepartmentOnFloor(removalUpdates);
    }
    scenarioRoomInfoRef.current = new Map();
    previousScenarioSelectionRef.current = new Set();
    setScenarioSelection(new Set());
    setScenarioAssignments({});
    setScenarioTotals({
      totalSF: 0,
      rooms: 0,
      roomTypes: {},
      sfByRoomType: {}
    });
    setScenarioAssignedDept('');
    setScenarioLabel('');
    setScenarioPanelVisible(false);
    resetScenarioRecolor();
  }, [clearScenarioFeatureStates, resetScenarioRecolor, updateScenarioDepartmentOnFloor]);

  const clearScenario = useCallback(() => {
    resetScenarioModeState();
  }, [resetScenarioModeState]);

  const ensureScenarioLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource(FLOOR_SOURCE)) return;
    if (map.getLayer(SCENARIO_LAYER_ID)) return;
    try {
      map.addLayer({
        id: SCENARIO_LAYER_ID,
        type: 'fill',
        source: FLOOR_SOURCE,
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'scenarioColor'], DEFAULT_SCENARIO_COLOR],
          'fill-outline-color': ['coalesce', ['feature-state', 'scenarioOutlineColor'], DEFAULT_SCENARIO_OUTLINE],
          'fill-opacity': 1
        },
        filter: ['==', ['get', 'id'], '']
      });
      if (map.getLayer(FLOOR_LINE_ID)) {
        map.moveLayer(SCENARIO_LAYER_ID, FLOOR_LINE_ID);
      }
      bringFloorRoomLabelsToFront(map);
    } catch {}
  }, []);

  const applyScenarioHighlight = useCallback((highlightIds) => {
    ensureScenarioLayer();
    const map = mapRef.current;
    if (!map || !map.getLayer(SCENARIO_LAYER_ID)) return;
    const filter =
      Array.isArray(highlightIds) && highlightIds.length
        ? ['any', ['in', ['id'], ['literal', highlightIds]], ['in', ['get', 'RevitId'], ['literal', highlightIds]]]
        : ['==', ['id'], ''];
    try {
      map.setFilter(SCENARIO_LAYER_ID, filter);
    } catch {}
  }, [ensureScenarioLayer]);

  const recomputeScenarioTotals = useCallback((selection) => {
    const totals = {
      totalSF: 0,
      rooms: 0,
      roomTypes: {},
      sfByRoomType: {}
    };
    const highlightIds = [];
    const roomInfo = scenarioRoomInfoRef.current;
    selection.forEach((roomId) => {
      const meta = roomInfo.get(roomId);
      if (!meta) return;
      const area = Number.isFinite(Number(meta.area)) ? Number(meta.area) : 0;
      const typeName = norm(meta.roomType ?? meta.type ?? 'Unknown') || 'Unknown';
      totals.rooms += 1;
      totals.totalSF += area;
      totals.roomTypes[typeName] = (totals.roomTypes[typeName] || 0) + 1;
      totals.sfByRoomType[typeName] = (totals.sfByRoomType[typeName] || 0) + area;
      if (meta.revitId != null) highlightIds.push(meta.revitId);
    });
    return { totals, highlightIds };
  }, []);

  const cleanScenarioAssignments = useCallback((selection) => {
    setScenarioAssignments((prev) => {
      const next = {};
      selection.forEach((roomKey) => {
        if (prev[roomKey]) next[roomKey] = prev[roomKey];
      });
      return next;
    });
  }, []);

  const handleScenarioSelectionChange = useCallback((nextSelection) => {
    const { totals, highlightIds } = recomputeScenarioTotals(nextSelection);
    const prevSelection = previousScenarioSelectionRef.current;
    const removed = Array.from(prevSelection).filter((key) => !nextSelection.has(key));
    if (removed.length) {
      clearScenarioFeatureStates(removed, scenarioRoomInfoRef.current);
    }
    previousScenarioSelectionRef.current = new Set(nextSelection);
    setScenarioTotals(totals);
    setScenarioPanelVisible(nextSelection.size > 0);
    applyScenarioHighlight(highlightIds);
    cleanScenarioAssignments(nextSelection);
  }, [recomputeScenarioTotals, applyScenarioHighlight, clearScenarioFeatureStates, cleanScenarioAssignments]);

  const toggleScenarioRoom = useCallback((roomMeta) => {
    if (!roomMeta?.roomId) return;
    setScenarioSelection((prev) => {
      const next = new Set(prev);
      if (next.has(roomMeta.roomId)) {
        next.delete(roomMeta.roomId);
      } else {
        next.add(roomMeta.roomId);
        scenarioRoomInfoRef.current.set(roomMeta.roomId, roomMeta);
      }
      handleScenarioSelectionChange(next);
      return next;
    });
  }, [handleScenarioSelectionChange]);

  const hexToRGBA = useCallback((hex, alpha = 0.35) => convertHexWithAlpha(hex, alpha), []);

  const setScenarioFeatureState = useCallback((roomKey, state = {}) => {
    const info = scenarioRoomInfoRef.current.get(roomKey);
    if (!info?.revitId) return;
    const map = mapRef.current;
    if (!map) return;
    const sanitizedState = { ...state };
    if (!Object.keys(sanitizedState).length) return;
    try {
      map.setFeatureState({ source: FLOOR_SOURCE, id: info.revitId }, sanitizedState);
    } catch {}
  }, []);

  const assignDepartmentToSelection = useCallback(() => {
    if (!scenarioAssignedDept || scenarioSelection.size === 0) return;
    const outlineColor = getDeptColor(scenarioAssignedDept) || DEFAULT_SCENARIO_OUTLINE;
    const fillColor = hexToRGBA(outlineColor, 0.9);
    setScenarioAssignments((prev) => {
      const next = { ...prev };
      scenarioSelection.forEach((roomId) => {
        next[roomId] = scenarioAssignedDept;
        setScenarioFeatureState(roomId, {
          scenarioColor: fillColor,
          scenarioOutlineColor: outlineColor,
          scenarioDepartment: scenarioAssignedDept
        });
      });
      return next;
    });

    const updates = [];
    scenarioSelection.forEach((roomId) => {
      const info = scenarioRoomInfoRef.current.get(roomId);
      if (info?.revitId != null) {
        updates.push({ revitId: info.revitId, dept: scenarioAssignedDept });
      }
    });
    if (updates.length) {
      updateScenarioDepartmentOnFloor(updates);
    }
  }, [scenarioAssignedDept, scenarioSelection, setScenarioFeatureState, hexToRGBA, updateScenarioDepartmentOnFloor]);

  const handleExportScenario = useCallback(() => {
    alert('Export Scenario to PDF is not implemented yet.');
  }, []);

  useEffect(() => {
    if (moveScenarioMode) {
      ensureScenarioLayer();
    }
  }, [moveScenarioMode, ensureScenarioLayer]);

  const [moveMode, setMoveMode] = useState(false);
  const [pendingMove, setPendingMove] = useState(null);
  const [moveConfirmData, setMoveConfirmData] = useState(null);

  useEffect(() => {
    if (moveMode || moveScenarioMode) return;
    applySelectionHighlight(roomEditSelection);
  }, [roomEditSelection, applySelectionHighlight, moveMode, moveScenarioMode]);

  const estimatePanelAnchor = (pt) => {
    const width = mapContainerRef.current?.clientWidth ?? 0;
    const height = mapContainerRef.current?.clientHeight ?? 0;
    const containerWidth = width || 1000;
    const containerHeight = height || 800;
    const x = pt.x + 110;
    const defaultY = pt.y - 160;
    const minY = Math.max(8, containerHeight * 0.15);
    const maxY = Math.max(minY, Math.min(containerHeight - 220, containerHeight * 0.65));
    return {
      x: Math.min(Math.max(x, 8), containerWidth - 260),
      y: Math.min(Math.max(defaultY, minY), maxY)
    };
  };

  const repositionScenarioPanelToClick = useCallback((pt) => {
    if (!pt) return;
    setScenarioPanelTop(() => {
      const height = mapContainerRef.current?.clientHeight ?? 0;
      const panelHeight = Math.max(360, (height || 0) * 0.7);
      const maxTop = Math.max(8, (height || 800) - panelHeight - 40);
      const target = pt.y - 120;
      return Math.max(8, Math.min(target, maxTop));
    });
  }, []);

  const nudgeScenarioPanelUp = useCallback(() => {
    setScenarioPanelTop((prev) => {
      const height = mapContainerRef.current?.clientHeight ?? 0;
      const panelHeight = Math.max(360, (height || 0) * 0.7);
      const maxTop = Math.max(8, (height || 800) - panelHeight - 40);
      return Math.max(8, Math.min(prev - 40, maxTop));
    });
  }, []);

  // Auth / role
  const [authUser, setAuthUser] = useState(null);
  const [isAdminUser, setIsAdminUser] = useState(false);

  // Marker filters (admin)
  const [showStudentMarkers, setShowStudentMarkers] = useState(false);
  const [showStaffMarkers, setShowStaffMarkers] = useState(false);

  // Session-only markers (for public users adding points this session)
  const [sessionMarkers, setSessionMarkers] = useState([]);


  const resolveBuildingPlanKey = useCallback((idOrName) => {
    if (!idOrName) return null;
    if (BUILDING_FOLDER_MAP[idOrName]) return idOrName;
    const aliasMatch = BUILDING_ALIAS_REVERSE[idOrName];
    if (aliasMatch && BUILDING_FOLDER_MAP[aliasMatch]) return aliasMatch;
    if (BUILDING_FOLDER_SET.has(idOrName)) {
      return BUILDING_FOLDER_TO_NAME[idOrName] || null;
    }
    return null;
  }, []);

  const fetchFloorSummaryByUrl = useCallback(async (url) => {
    if (!url) return null;

    // Try original URL first, then fall back to new py export naming
    const candidates = [url];
    if (typeof url === "string" && url.endsWith("_Dept.geojson")) {
      candidates.push(url.replace("_Dept.geojson", "_Dept_Rooms.geojson"));
    }

    // Return cached summary if we already computed it for any candidate
    for (const u of candidates) {
      if (floorStatsCache.current[u]) return floorStatsCache.current[u];
    }

    let data = null;
    let usedUrl = null;

    // Try cache + fetch for each candidate
    for (const u of candidates) {
      data = floorCache.get(u);
      if (!data) {
        data = await fetchGeoJSON(u);
        if (data) floorCache.set(u, data);
      }
      if (data) {
        usedUrl = u;
        break;
      }
    }

    if (!data) {
      console.warn("Floor summary: no data returned", url);
      return null;
    }

    const fc = toFeatureCollection(data);
    if (!Array.isArray(fc?.features)) {
      console.warn("Floor summary: no features, skipping", usedUrl || url);
      return null;
    }

    const sum = summarizeFeatures(fc.features);

    // Cache summary under BOTH URLs so future callers hit cache regardless of which name they request
    for (const u of candidates) floorStatsCache.current[u] = sum;

    return sum;
  }, []);

  const fetchFloorSummary = useCallback(async (buildingKeyOrName, floorId) => {
    const url = buildFloorUrl(buildingKeyOrName, floorId);
    if (!url) return null;
    return fetchFloorSummaryByUrl(url);
  }, [buildFloorUrl, fetchFloorSummaryByUrl]);

  const fetchBuildingSummary = useCallback(async (buildingId) => {
    if (!buildingId) return null;
    const resolvedKey = resolveBuildingPlanKey(buildingId) || buildingId;
    if (!resolvedKey) return null;
    if (buildingStatsCache.current[resolvedKey]) return buildingStatsCache.current[resolvedKey];

    const folderKey = getBuildingFolderKey(resolvedKey);
    let available = folderKey ? getAvailableFloors(folderKey) : [];
    if (!available.length) {
      available = await ensureFloorsForBuilding(resolvedKey);
    }
    if (!available.length) return null;
    const canonicalBuildingId = bId(buildingId);
    const combined = {
      totalSf: 0,
      classroomSf: 0,
      labSf: 0,
      officeSf: 0,
      rooms: 0,
      classroomCount: 0,
      labCount: 0,
      officeCount: 0,
      deptCounts: new Map()
    };

    for (const floorLabel of available) {
      const url = buildFloorUrl(resolvedKey, floorLabel);
      if (!url) continue;
      const canonicalFloorId = fId(floorLabel);
      const floorKey = `${canonicalBuildingId}/${canonicalFloorId}`;
      let stats = floorSummaryCacheRef.current.get(floorKey);
      if (!stats) {
        stats = floorStatsCache.current[url];
        if (!stats) stats = await fetchFloorSummary(resolvedKey, floorLabel);
        if (stats) floorSummaryCacheRef.current.set(floorKey, stats);
      }
      if (!stats) continue;
      combined.totalSf += stats.totalSf || 0;
      combined.classroomSf += stats.classroomSf || 0;
      combined.labSf += stats.labSf || 0;
      combined.officeSf += stats.officeSf || 0;
      combined.rooms += stats.rooms || 0;
      combined.classroomCount += stats.classroomCount || 0;
      combined.labCount += stats.labCount || 0;
      combined.officeCount += stats.officeCount || 0;
      Object.entries(stats.deptCounts || {}).forEach(([dept, area]) => {
        combined.deptCounts.set(dept, (combined.deptCounts.get(dept) || 0) + area);
      });
    }

    const summary = finalizeCombinedSummary(combined);
    buildingStatsCache.current[resolvedKey] = summary;
    return summary;
  }, [fetchFloorSummary, resolveBuildingPlanKey, getAvailableFloors, getBuildingFolderKey, buildFloorUrl, ensureFloorsForBuilding]);

  const computeBuildingTotals = useCallback(async (buildingId) => {
    if (!buildingId) {
      return {
        totalSf: undefined,
        rooms: undefined,
        classroomSf: undefined,
        classroomCount: undefined,
        labSf: undefined,
        labCount: undefined,
        officeSf: undefined,
        officeCount: undefined,
        totalsByDept: {}
      };
    }
    const sum = await fetchBuildingSummary(buildingId);
    return sum ?? {
      totalSf: undefined,
      rooms: undefined,
      classroomSf: undefined,
      classroomCount: undefined,
      labSf: undefined,
      labCount: undefined,
      officeSf: undefined,
      officeCount: undefined,
      totalsByDept: {}
    };
  }, [fetchBuildingSummary]);

  const computeCampusTotals = useCallback(async () => {
    const campusAcc = createEmptySummaryAccumulator();

    const summaries = await Promise.all(
      BUILDINGS_LIST.map(async (b) => {
        if (!b?.name) return null;
        try {
          return await computeBuildingTotals(b.name);
        } catch (err) {
          console.warn('Campus summary: failed to load building stats for', b.name, err);
          return null;
        }
      })
    );

    summaries.forEach((sum) => {
      if (!sum) return;
      campusAcc.totalSf += sum.totalSf || 0;
      campusAcc.classroomSf += sum.classroomSf || 0;
      campusAcc.labSf += sum.labSf || 0;
      campusAcc.officeSf += sum.officeSf || 0;
      campusAcc.rooms += sum.rooms || 0;
      campusAcc.classroomCount += sum.classroomCount || 0;
      campusAcc.labCount += sum.labCount || 0;
      campusAcc.officeCount += sum.officeCount || 0;
      const deptCounts = sum.deptCounts || sum.totalsByDept || {};
      Object.entries(deptCounts).forEach(([dept, area]) => {
        const val = Number(area) || 0;
        campusAcc.deptCounts.set(dept, (campusAcc.deptCounts.get(dept) || 0) + val);
      });
    });

    return finalizeCombinedSummary(campusAcc);
  }, [computeBuildingTotals]);

  useEffect(() => {
    let cancelled = false;
    const loadCampusStats = async () => {
      try {
        const summary = await computeCampusTotals();
        if (cancelled) return;
        setCampusStats(summary);
        setCampusPanelStats(formatSummaryForPanel(summary, 'campus'));
      } catch (err) {
        if (cancelled) return;
        console.warn('Campus summary load failed', err);
        setCampusStats(null);
        setCampusPanelStats(formatSummaryForPanel(null, 'campus'));
      }
    };
    loadCampusStats();
    return () => { cancelled = true; };
  }, [computeCampusTotals]);

  const prefetchFloorSummaries = useCallback(async (buildingKeyOrName) => {
    const folderKey = getBuildingFolderKey(buildingKeyOrName);
    if (!folderKey) return;
    let floors = getAvailableFloors(folderKey);
    if (!floors.length) {
      floors = await ensureFloorsForBuilding(buildingKeyOrName);
    }
    if (!floors.length) return;
    try {
      await Promise.all(floors.map((floorName) => fetchFloorSummary(buildingKeyOrName, floorName)));
    } catch (err) {
      console.warn('Floor summary prefetch failed:', err);
    }
  }, [getBuildingFolderKey, getAvailableFloors, fetchFloorSummary, ensureFloorsForBuilding]);

  const showBuildingStats = useCallback((buildingId) => {
    setPopupMode('building');
    setFloorStats(null);
    if (!buildingId) {
      setBuildingStats(null);
      setPanelStats(formatSummaryForPanel(null, 'building'));
      return;
    }
    const resolvedKey = resolveBuildingPlanKey(buildingId) || buildingId;
    panelBuildingKeyRef.current = resolvedKey;
    currentFloorUrlRef.current = null;
    currentFloorContextRef.current = { url: null, key: null, buildingId: null, floorId: null };
    setPanelStats({ loading: true, mode: 'building' });
    computeBuildingTotals(buildingId)
      .then((summary) => {
        if (panelBuildingKeyRef.current !== resolvedKey) return;
        if (currentFloorUrlRef.current) return;
        setBuildingStats(summary);
        setPanelStats(formatSummaryForPanel(summary, 'building'));
      })
      .catch(() => {
        if (panelBuildingKeyRef.current !== resolvedKey) return;
        if (currentFloorUrlRef.current) return;
        setBuildingStats(null);
        setPanelStats(formatSummaryForPanel(null, 'building'));
      });
  }, [computeBuildingTotals, resolveBuildingPlanKey]);

  const showFloorStats = useCallback((url) => {
    if (!url) return;
    setPopupMode('floor');
    currentFloorUrlRef.current = url;
    setPanelStats({ loading: true, mode: 'floor' });
    const ctx = currentFloorContextRef.current;
    const cachedUrlSummary = floorStatsCache.current[url];
    if (cachedUrlSummary) {
      const floorLabel = ctx?.floorLabel || selectedFloor || '';
      setFloorStats({ ...cachedUrlSummary, floorLabel });
      setPanelStats(formatSummaryForPanel(cachedUrlSummary, 'floor'));
      return;
    }
    if (ctx?.url === url && ctx?.key) {
      const cached = floorSummaryCacheRef.current.get(ctx.key);
      if (cached) {
        const floorLabel = ctx.floorLabel || selectedFloor || '';
        setFloorStats({ ...cached, floorLabel });
        setPanelStats(formatSummaryForPanel(cached, 'floor'));
        return;
      }
    }
    fetchFloorSummaryByUrl(url)
      .then((summary) => {
        if (currentFloorUrlRef.current !== url) return;
        const latestCtx = currentFloorContextRef.current;
        if (latestCtx?.url === url && latestCtx?.key && summary) {
          floorSummaryCacheRef.current.set(latestCtx.key, summary);
        }
        const floorLabel = latestCtx?.floorLabel || selectedFloor || '';
        setFloorStats(summary ? { ...summary, floorLabel } : null);
        setPanelStats(formatSummaryForPanel(summary, 'floor'));
      })
      .catch(() => {
        if (currentFloorUrlRef.current !== url) return;
        setFloorStats(null);
        setPanelStats(formatSummaryForPanel(null, 'floor'));
      });
  }, [fetchFloorSummaryByUrl, selectedFloor]);

  const saveRoomEdits = useCallback(
    async (edit) => {
      if (!edit || !universityId) return null;

      const { buildingId, floorName, revitId, roomId, properties = {} } = edit;
      if (!buildingId || !floorName || revitId == null) {
        console.warn('Missing ids for room edit', edit);
        return null;
      }

      const roomKey = rId(buildingId, floorName, revitId);

      try {
        const roomRef = doc(
          db,
          'universities',
          universityId,
          'buildings',
          buildingId,
          'floors',
          floorName,
          'rooms',
          roomKey
        );

        const payload = {
          type: properties.type || '',
          department: properties.department || '',
          occupant: properties.occupant || '',
          comments: properties.comments || '',
          updatedAt: serverTimestamp()
        };

        await setDoc(roomRef, payload, { merge: true });

        const patchPayload = {
          type: properties.type || '',
          department: properties.department || '',
          occupant: properties.occupant || '',
          comments: properties.comments || ''
        };

        setRoomPatches((prevMap) => {
          const next = new Map(prevMap || []);
          const patchKey = roomId || roomKey;
          const prevPatch = next.get(patchKey) || {};
          next.set(patchKey, { ...prevPatch, ...patchPayload });
          return next;
        });

        try {
          const ctx = currentFloorContextRef.current;
          if (ctx && ctx.url === currentFloorUrlRef.current) {
            const cached = floorSummaryCacheRef.current.get(ctx.key);
            if (cached) {
              floorSummaryCacheRef.current.delete(ctx.key);
            }
          }
        } catch (err) {
          console.warn('Failed to invalidate floor summary cache', err);
        }

        return payload;
      } catch (err) {
        console.error('Failed to save room edits', err);
        return null;
      }
    },
    [db, universityId]
  );

  // Initialize defaults on mount: first building + LEVEL_1 (or fallback)
useEffect(() => {
  if (selectedBuilding) return;
  if (!BUILDINGS_LIST.length) return;

  const first = BUILDINGS_LIST[0].name;
  setSelectedBuilding(first);
  setSelectedFloor('LEVEL_1');
}, []);

  const activeBuildingFeature = useMemo(() => {
    const feats = config?.buildings?.features || [];
    const byId = feats.find((f) => String(f?.properties?.id) === String(selectedBuildingId));
    if (byId) return byId;
    const byName = feats.find((f) => (f?.properties?.name || '') === (selectedBuilding || ''));
    return byName || null;
  }, [config, selectedBuildingId, selectedBuilding]);
  const activeBuildingName =
    activeBuildingFeature?.properties?.name ||
    selectedBuilding ||
    selectedBuildingId ||
    'Building';
  const activeBuildingId = selectedBuildingId || selectedBuilding || '';
  const panelSelectedFloor = selectedFloor ?? (availableFloors?.[0] || '');

  const computePanelAnchorFromFeature = useCallback((feature) => {
    const map = mapRef.current;
    const containerWidth = mapContainerRef.current?.clientWidth || 1000;
    const containerHeight = mapContainerRef.current?.clientHeight || 800;
    if (!map || !feature?.geometry) return null;
    const bbox = turf.bbox(feature);
    if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) return null;
    const centerLat = (bbox[1] + bbox[3]) / 2;
    const anchorPoint = map.project({ lng: bbox[2], lat: centerLat });
    const left = Math.min(Math.max(anchorPoint.x + 12, 8), containerWidth - 360);
    const top = Math.min(Math.max(anchorPoint.y - 120, 8), containerHeight - 260);
    return { x: left, y: top };
  }, []);

  const handlePanelLoadFloor = useCallback(async (floorId) => {
    await handleLoadFloorplan(floorId);
  }, [handleLoadFloorplan]);

  const loadSelectedFloor = useCallback(() => {
    if (!panelSelectedFloor) return;
    if (panelSelectedFloor !== selectedFloor) {
      setSelectedFloor(panelSelectedFloor);
    }
    handlePanelLoadFloor(panelSelectedFloor);
  }, [panelSelectedFloor, handlePanelLoadFloor, selectedFloor]);

  async function handleLoadFloorplan() {
    if (!mapLoaded || !mapRef.current) return false;
    if (!selectedFloor || !availableFloors.includes(selectedFloor)) {
      alert('This floor is not available for this building.');
      return false;
    }
    const url = buildFloorUrl(selectedBuilding, selectedFloor);
    if (!url) { alert('No file mapped for that floor.'); return false; }
    try {
      setPopupMode('floor');
      setFloorStats(null);
      setPanelStats({ loading: true, mode: 'floor' });
      const lastSel = floorSelectionRef.current?.[url];
      const buildingFolder = getBuildingFolderKey(selectedBuildingId || selectedBuilding);
      const basePath = buildingFolder
        ? `/stakeholder-map/floorplans/Hastings/${buildingFolder}`
        : null;
      let fitBuilding = selectedBuildingFeatureRef.current || null;
      if (!fitBuilding) {
        try {
          const feats = config?.buildings?.features || [];
          fitBuilding = feats.find(f => String(f.properties?.id) === String(selectedBuildingId || selectedBuilding)) || null;
        } catch {}
      }
      const loadResult = await loadFloorGeojson(mapRef.current, url, lastSel, { fitBuilding }, {
        buildingId: selectedBuildingId || selectedBuilding,
        floor: selectedFloor,
        roomPatches,
        currentFloorContextRef,
        roomsBasePath: basePath,
        roomsFloorId: selectedFloor,
        wallsBasePath: basePath,
        wallsFloorId: selectedFloor,
        onOptionsCollected: ({ typeOptions: types, deptOptions: depts }) => {
          if (types?.length) setTypeOptions((prev) => mergeTypeOptions(prev, types));
          if (depts) setDeptOptions((prev) => mergeOptionsList(prev, depts));
        }
      });
      if (!loadResult) {
        setPanelStats(formatSummaryForPanel(null, 'floor'));
        return false;
      }
      setLoadedSingleFloor(true);
      currentFloorUrlRef.current = url;
      lastFloorUrlRef.current = url;
      const canonicalBuildingId = bId(selectedBuildingId || selectedBuilding || '');
      const canonicalFloorId = fId(selectedFloor || '');
      const floorKey = canonicalBuildingId && canonicalFloorId ? `${canonicalBuildingId}/${canonicalFloorId}` : null;
      if (floorKey && loadResult.summary) {
        floorSummaryCacheRef.current.set(floorKey, loadResult.summary);
        floorRoomsRef.current.set(floorKey, loadResult.rooms);
      }
      currentFloorContextRef.current = {
        ...(currentFloorContextRef.current || {}),
        url,
        key: floorKey,
        buildingId: canonicalBuildingId,
        floorId: canonicalFloorId,
        floorLabel: selectedFloor
      };

      if (loadResult.summary) {
        floorStatsCache.current[url] = loadResult.summary;
        floorSummaryCacheRef.current.set(url, loadResult.summary);
        const summaryWithLabel = { ...loadResult.summary, floorLabel: selectedFloor };
        setFloorStats(summaryWithLabel);
        setFloorLegendItems(toKeyDeptList(loadResult.summary.totalsByDept));
        if (currentFloorUrlRef.current === url) {
          setPanelStats(formatSummaryForPanel(loadResult.summary, 'floor'));
        }
      } else {
        setFloorStats(null);
        setPanelStats(formatSummaryForPanel(null, 'floor'));
      }
      try {
        applyFloorColorMode(floorColorMode);
        buildLegendForMode(floorColorMode);
      } catch {}
      setIsBuildingPanelCollapsed(false);
      setPopupMode('floor');
      // Anchor floor panel to top-left to keep it fully visible when launched from controls
      setPanelAnchor({ x: 12, y: 12 });
      if (mapView === MAP_VIEWS.SPACE_DATA) {
        applyBuildingStyleForSpace(mapRef.current);
      }
      return true;
    } catch (e) {
      console.error(e);
      alert('Failed to load floor plan. See console for details.');
      setLoadedSingleFloor(false);
      return false;
    }
  }

  const drawSummaryAndLegend = (doc, stats, keyDepts, areaX, areaWidth, label, legendTitle = 'Key Departments') => {
    if (!stats && !label && !keyDepts?.length) return;
    const lineHeight = 14;
    const textX = areaX + 6;
    const textYStart = 24;
    const title = label || 'Totals';
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(title, textX, textYStart);
    let cursorY = textYStart + lineHeight;
    doc.setFont(undefined, 'normal');
    if (stats) {
      const lines = [
        stats.totalSF != null ? `Total SF: ${Math.round(stats.totalSF).toLocaleString()}` : null,
        stats.rooms != null ? `Rooms: ${stats.rooms}` : null,
        stats.classroomSf != null ? `Classroom SF: ${Math.round(stats.classroomSf).toLocaleString()}` : null,
        stats.classroomCount != null ? `Classrooms: ${stats.classroomCount}` : null,
        stats.levels != null ? `Levels: ${stats.levels}` : null
      ].filter(Boolean);
      lines.forEach((line) => {
        doc.text(line, textX, cursorY);
        cursorY += lineHeight;
      });
    }
    if (keyDepts?.length) {
      cursorY += lineHeight / 2;
      doc.setFont(undefined, 'bold');
      doc.text(legendTitle, textX, cursorY);
      cursorY += lineHeight;
      doc.setFont(undefined, 'normal');
      const boxSize = 10;
      keyDepts.slice(0, 8).forEach((dept) => {
        const color = dept.color || getDeptColor(dept.name);
        doc.setFillColor(color);
        doc.rect(areaX + 6, cursorY - 8, boxSize, boxSize, 'F');
        doc.setTextColor('#000');
        const labelText = dept.areaSf ? `${dept.name} (${Math.round(dept.areaSf).toLocaleString()} SF)` : dept.name;
        doc.text(labelText, areaX + 6 + boxSize + 4, cursorY);
        cursorY += lineHeight;
      });
    }
  };

  const exportFloorplanDocument = useCallback((pages, options = {}) => {
    if (!Array.isArray(pages) || !pages.length) {
      alert('No floorplan data to export.');
      return;
    }
    try {
      const doc = new jsPDF('p', 'pt', 'letter');
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 24;
      const stats = options.stats || null;
      const keyDepts = options.keyDepts || [];
      const summaryLabel = options.summaryLabel || '';
      const legendTitle = options.legendTitle || 'Key Departments';
      const filenameBase = options.filenameBase || 'floorplan';
      const hasSummary = Boolean(stats || (keyDepts && keyDepts.length));
      const summaryWidth = hasSummary ? 130 : 0;
      const summaryAreaWidth = hasSummary ? summaryWidth - 12 : 0;
      pages.forEach((page, idx) => {
        const img = page?.img;
        if (!img?.data) return;
        if (idx > 0) doc.addPage();
        const aspect = img.height && img.width ? img.height / img.width : 1;
        const imgAvailableWidth = hasSummary ? pageWidth - margin * 2 - summaryWidth - margin : pageWidth - margin * 2;
        let imgWidth = Math.min(imgAvailableWidth, img.width);
        let imgHeight = imgWidth * aspect;
        const maxHeight = pageHeight - margin * 2 - 40;
        if (imgHeight > maxHeight) {
          imgHeight = maxHeight;
          imgWidth = imgHeight / (aspect || 1);
        }
        const imgX = margin;
        doc.addImage(img.data, 'PNG', imgX, margin + 20, imgWidth, imgHeight);
        doc.setFontSize(12);
        const label = page.label || '';
        if (label) {
          doc.text(label, margin, margin);
        }
        if (hasSummary) {
          const summaryX = Math.min(pageWidth - summaryWidth - margin, imgX + imgWidth + margin * 0.75);
          drawSummaryAndLegend(doc, stats, keyDepts, summaryX, summaryAreaWidth, summaryLabel || label, legendTitle);
        }
      });
      const filename = `${filenameBase.replace(/\s+/g, '-').toLowerCase()}.pdf`;
      doc.save(filename);
    } catch (err) {
      console.error('Floor export failed', err);
      alert('Export failed - see console for details.');
    }
  }, []);

  const explainFloor = useCallback(async ({ context, floorStats, panelStats }) => {
    const res = await guardedAiFetch('http://localhost:8787/explain-floor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, floorStats, panelStats })
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!res.ok) throw new Error(data?.error || raw || `HTTP ${res.status}`);
    return data;
  }, []);

  const explainCampus = useCallback(async ({ context, campusStats, panelStats }) => {
    const res = await guardedAiFetch('http://localhost:8787/explain-campus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, campusStats, panelStats })
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!res.ok) throw new Error(data?.error || raw || `HTTP ${res.status}`);
    return data;
  }, []);

  const compareScenario = useCallback(async ({ context, baselineStats, scenarioStats, deltas }) => {
    const res = await guardedAiFetch('http://localhost:8787/compare-scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, baselineStats, scenarioStats, deltas })
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(data?.error || raw || `HTTP ${res.status}`);
    return data;
  }, []);

  const createMoveScenario = useCallback(async ({ request, context, inventory, constraints }) => {
    const res = await guardedAiFetch('http://localhost:8787/create-move-scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, context, inventory, constraints })
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(data?.error || raw || `HTTP ${res.status}`);
    return data;
  }, []);

  const askMapfluence = useCallback(async ({ question, context, data }) => {
    const res = await guardedAiFetch('http://localhost:8787/ask-mapfluence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context, data })
    });

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(json?.error || raw || `HTTP ${res.status}`);
    return json;
  }, []);

  const explainBuilding = useCallback(async ({ context, buildingStats, panelStats }) => {
    const res = await guardedAiFetch('http://localhost:8787/explain-building', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, buildingStats, panelStats })
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!res.ok) throw new Error(data?.error || raw || `HTTP ${res.status}`);
    return data;
  }, []);

  const onExplain = useCallback(async () => {
    setAiErr('');
    setAiLoading(true);
    setAiResult(null);

    try {
      const ctx = currentFloorContextRef.current;

      const context = {
        universityId,
        buildingId: ctx?.buildingId || selectedBuildingId || selectedBuilding || '',
        buildingLabel: ctx?.buildingLabel || '',
        floorId: ctx?.floorId || selectedFloor || '',
        floorLabel: ctx?.floorLabel || floorStats?.floorLabel || selectedFloor || '',
        url: ctx?.url || ''
      };

      const out = await explainFloor({ context, floorStats, panelStats });
      setAiResult(out);
      setAiOpen(true);
    } catch (e) {
      setAiErr(String(e?.message || e));
    } finally {
      setAiLoading(false);
    }
  }, [explainFloor, floorStats, panelStats, selectedBuildingId, selectedBuilding, selectedFloor, universityId]);

  const onExplainCampus = useCallback(async () => {
    setAiCampusErr('');
    setAiCampusLoading(true);
    setAiCampusResult(null);

    try {
      const context = {
        universityId,
        campusLabel: activeUniversityName || universityId || 'Campus',
        buildingId: '',
        buildingLabel: '',
        floorId: '',
        floorLabel: '',
        url: ''
      };

      const out = await explainCampus({
        context,
        campusStats,
        panelStats: campusPanelStats
      });

      setAiCampusResult(out);
      setAiCampusOpen(true);
    } catch (e) {
      setAiCampusErr(String(e?.message || e));
    } finally {
      setAiCampusLoading(false);
    }
  }, [activeUniversityName, campusPanelStats, campusStats, explainCampus, universityId]);

  const onCompareScenario = useCallback(async () => {
    setAiScenarioErr('');
    setAiScenarioLoading(true);
    setAiScenarioResult(null);

    try {
      if (!scenarioTotals) throw new Error('No scenario totals available. Turn on Move Scenario Mode and make changes.');
      if (!scenarioAssignedDept) throw new Error('Select a department for the scenario before comparing.');

      const { perBuilding, campusTotals } = await computeDeptTotalsByBuildingAcrossCampus(scenarioAssignedDept, {
        ensureFloorsForBuilding,
        buildFloorUrl,
        floorCache,
        fetchGeoJSON
      });
      if (!campusTotals) throw new Error('No baseline stats for the selected department on this campus.');

      const scenarioBuildingName = activeBuildingName || selectedBuilding || selectedBuildingId || '';
      const scenarioBuildingLower = scenarioBuildingName.trim().toLowerCase();

      const candidates = Object.entries(perBuilding || {}).sort(
        (a, b) => (b[1]?.totalSF || 0) - (a[1]?.totalSF || 0) || (b[1]?.rooms || 0) - (a[1]?.rooms || 0)
      );
      const baselineEntry =
        candidates.find(([name]) => name.trim().toLowerCase() !== scenarioBuildingLower) ||
        candidates[0] ||
        null;
      const baselineBuildingName = baselineEntry ? baselineEntry[0] : 'campus';
      const baselineDeptTotals = baselineEntry ? baselineEntry[1] : campusTotals;
      if (baselineDeptTotals) baselineDeptTotals.__label = baselineBuildingName || "campus";

      const baselineScope = 'campus';

      const buildingIdVal = selectedBuildingId || selectedBuilding || '';

      const context = {
        universityId,
        baselineScope,
        buildingId: buildingIdVal,
        buildingLabel: activeBuildingName || '',
        floorId: selectedFloor || '',
        scenarioDepartment: scenarioAssignedDept,
        baselineLabel: `Current allocation for ${scenarioAssignedDept} (${baselineBuildingName})`
      };

      console.log('Scenario compare baseline (dept campus-wide):', baselineDeptTotals);
      console.log('Scenario compare scenario (selection totals):', scenarioTotals);
      setScenarioBaselineTotals(baselineDeptTotals);

      const deltas = {
        totalSF: (scenarioTotals?.totalSF || 0) - (baselineDeptTotals?.totalSF || 0),
        rooms: (scenarioTotals?.rooms || 0) - (baselineDeptTotals?.rooms || 0)
      };

      const out = await compareScenario({
        context,
        baselineStats: baselineDeptTotals,
        scenarioStats: scenarioTotals,
        deltas,
        scenarioDept: scenarioAssignedDept || ''
        // deltas: optional if you compute them
      });

      setAiScenarioResult(out);
      setAiScenarioOpen(true);
    } catch (e) {
      setAiScenarioErr(String(e?.message || e));
    } finally {
      setAiScenarioLoading(false);
    }
  }, [
    activeBuildingName,
    compareScenario,
    scenarioAssignedDept,
    scenarioTotals,
    activeBuildingName,
    ensureFloorsForBuilding,
    buildFloorUrl,
    floorCache,
    fetchGeoJSON,
    selectedBuilding,
    selectedBuildingId,
    selectedFloor,
    universityId
  ]);

  const onExplainBuilding = useCallback(async () => {
    setAiBuildingErr('');
    setAiBuildingLoading(true);
    setAiBuildingResult(null);

    try {
      const buildingIdVal = selectedBuildingId || selectedBuilding || '';
      const context = {
        universityId,
        buildingId: buildingIdVal,
        buildingLabel: activeBuildingName || '',
        floorId: '',
        floorLabel: '',
        url: ''
      };
      const out = await explainBuilding({
        context,
        buildingStats,
        panelStats
      });
      setAiBuildingResult(out);
      setAiBuildingOpen(true);
    } catch (e) {
      setAiBuildingErr(String(e?.message || e));
    } finally {
      setAiBuildingLoading(false);
    }
  }, [activeBuildingName, buildingStats, explainBuilding, panelStats, selectedBuilding, selectedBuildingId, universityId]);

  useEffect(() => {
    const ping = async () => {
      try {
        const r = await fetch('http://localhost:8787/health', { cache: 'no-store' });
        setAiStatus(r.ok ? 'ok' : 'down');
      } catch {
        setAiStatus('down');
      }
    };
    ping();
    const t = setInterval(ping, 10000);
    return () => clearInterval(t);
  }, []);

  const handleExportFloor = useCallback(() => {
    const ctx = currentFloorContextRef?.current;
    if (!ctx?.fc) {
      alert('No floor loaded.');
      return;
    }
    const selectedIdsForExport = floorLegendSelection ? (floorLegendLookup.get(floorLegendSelection) || []) : [];
    const selectionIdsFromHighlight = getHighlightIdsForSelection(roomEditSelectionRef.current || []);
    const highlightIds = floorHighlightIdsRef.current || [];
    const combinedSelectedIds = Array.from(new Set([
      ...(selectedIdsForExport || []),
      ...(selectionIdsFromHighlight || []),
      ...(highlightIds || [])
    ]));
    const img = generateFloorplanImageData({
      ...ctx,
      colorMode: floorColorMode,
      selectedIds: combinedSelectedIds,
      solidFill: true
    });
    if (!img) {
      alert('Unable to render floorplan.');
      return;
    }
    const label = `${activeBuildingName} - ${ctx.floorLabel || selectedFloor || ''}`.trim() || 'Floor';
    const cachedStats = ctx?.url ? floorStatsCache.current[ctx.url] : null;
    const statsForExport = floorStats ?? (cachedStats ? { ...cachedStats, floorLabel: ctx.floorLabel || selectedFloor } : null);
    const floorLegend = floorLegendItems && floorLegendItems.length ? floorLegendItems : toKeyDeptList(statsForExport?.totalsByDept);
    const legendTitle =
      {
        department: 'Key Departments',
        type: 'Key Types',
        occupancy: 'Occupancy',
        vacancy: 'Vacancy'
      }[floorColorMode] || 'Legend';
    exportFloorplanDocument(
      [{ img, label }],
      {
        filenameBase: `${activeBuildingName || 'floor'}-${ctx.floorLabel || selectedFloor || 'floor'}`,
        stats: statsForExport,
        keyDepts: floorLegend,
        summaryLabel: `${activeBuildingName} - ${ctx.floorLabel || selectedFloor || ''} (${floorColorMode || 'department'})`,
        legendTitle
      }
    );
  }, [activeBuildingName, selectedFloor, exportFloorplanDocument, floorColorMode, floorLegendItems]);
  const handleUnloadFloorplan = useCallback(() => {
    unloadFloorplan(mapRef.current, currentFloorUrlRef);
    try {
      const map = mapRef.current;
      if (map?.getLayer(WALLS_LAYER)) map.removeLayer(WALLS_LAYER);
      if (map?.getSource(WALLS_SOURCE)) map.removeSource(WALLS_SOURCE);
    } catch {}
    setLoadedSingleFloor(false);
    currentFloorUrlRef.current = null;
    lastFloorUrlRef.current = null;
    currentFloorContextRef.current = { url: null, key: null, buildingId: null, floorId: null };
    setFloorStats(null);
    setPopupMode('building');
    const buildingKey = selectedBuildingIdRef.current || selectedBuilding;
    if (buildingKey) showBuildingStats(buildingKey);
  }, [selectedBuilding, showBuildingStats]);

  const handleCenterOnFloorplan = useCallback(() => {
    centerOnCurrentFloor(mapRef.current);
  }, []);

  const handleToggleMoveScenarioMode = useCallback(() => {
    const enabled = !moveScenarioMode;
    setMoveScenarioMode(enabled);
    if (!enabled) {
      clearScenario();
    } else {
      setScenarioPanelVisible(true);
    }
  }, [clearScenario, moveScenarioMode, setScenarioPanelVisible]);

  // ---------- Minimal admin actions to avoid runtime errors ----------
  const exportData = useCallback(() => {
    try {
      const payload = {
        markers,
        buildingConditions,
        buildingAssessments
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${universityId || 'campus'}-map-data.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.warn('Export failed', e);
      alert('Export failed. See console for details.');
    }
  }, [markers, buildingConditions, buildingAssessments, universityId]);

  const exportDrawingEntries = useCallback(() => {
    alert('Export Drawing Entries not implemented in this build.');
  }, []);

const collectSpaceRows = useCallback(async (buildingFilter = '__all__', deptFilterRaw = '') => {
  const targetBuildings = buildingFilter && buildingFilter !== '__all__'
    ? [buildingFilter]
    : BUILDINGS_LIST.map((b) => b.name).filter(Boolean);

    const deptFilter = deptFilterRaw.toLowerCase().trim();
    const rows = [];

    for (const buildingName of targetBuildings) {
      if (!buildingName) continue;
      const floors = await ensureFloorsForBuilding(buildingName);
      if (!floors?.length) continue;

      for (const fl of floors) {
        const url = buildFloorUrl(buildingName, fl);
        if (!url) continue;
        let fc;
        try {
          const data = await fetchGeoJSON(url);
          fc = toFeatureCollection(data);
        } catch (err) {
          console.warn('Space export: failed to load', url, err);
          continue;
        }
        if (!fc?.features?.length) continue;

        for (const feat of fc.features) {
          const props = feat?.properties || {};
          const revitId = feat?.id ?? props.RevitId ?? props.id;
        const roomIdKey = (buildingName && fl && revitId != null) ? rId(buildingName, fl, revitId) : null;
        const patch = roomIdKey && roomPatches instanceof Map ? roomPatches.get(roomIdKey) : null;
        const merged = patch ? { ...props, ...patch } : props;
        const roomNum = merged.Number ?? merged.RoomNumber ?? merged.number ?? merged.Room ?? '';
        const typeVal = merged.RoomType ?? merged.Type ?? merged.type ?? merged.Name ?? '';
        const deptVal = (merged.department ?? merged.Department ?? merged.Dept ?? '').toString().trim();
        if (deptFilter && !deptVal.toLowerCase().includes(deptFilter)) continue;
        const areaVal = resolvePatchedArea(merged);
        const seatCountVal = getSeatCount(merged);
        const occupantVal = merged.occupant ?? merged.Occupant ?? '';
        rows.push({
          building: buildingName,
          floor: fl,
          roomNumber: roomNum || '',
          type: typeVal || '',
          department: deptVal || '',
          area: Number.isFinite(areaVal) ? areaVal : '',
          seatCount: seatCountVal ?? '',
          occupant: occupantVal || '',
          roomId: roomIdKey || '',
          revitId: revitId ?? null
        });
      }
    }
  }
  return rows;
  }, [buildFloorUrl, ensureFloorsForBuilding, roomPatches]);

  const buildMoveScenarioInventory = useCallback(async () => {
    const rows = await collectSpaceRows('__all__', '');
    const inventory = buildInventoryFromRoomRows(rows, 250);
    return inventory || [];
  }, [collectSpaceRows]);

  const collectSpaceSummaryRows = useCallback(async (buildingFilter = '__all__', deptFilterRaw = '') => {
    const targetBuildings = buildingFilter && buildingFilter !== '__all__'
      ? [buildingFilter]
      : BUILDINGS_LIST.map((b) => b.name).filter(Boolean);

    const deptFilter = deptFilterRaw.toLowerCase().trim();
    const buildingRows = [];
    const campusAcc = createEmptySummaryAccumulator();

    const toSummaryRow = (summary, buildingName, buildingIdOverride) => {
      if (!summary) return null;
      const asNumber = (val) => (Number.isFinite(val) ? Math.round(val) : '');
      const asCount = (val) => (Number.isFinite(val) ? Number(val) : 0);
      return {
        buildingId: buildingIdOverride || bId(buildingName || ''),
        buildingName: buildingName || '',
        totalSf: asNumber(summary.totalSf),
        rooms: asCount(summary.rooms),
        classroomSf: asNumber(summary.classroomSf),
        classrooms: asCount(summary.classroomCount),
        labSf: asNumber(summary.labSf),
        labs: asCount(summary.labCount),
        officeSf: asNumber(summary.officeSf),
        offices: asCount(summary.officeCount),
        keyDepts: (summary.keyDepts || []).join('; ')
      };
    };

    for (const buildingName of targetBuildings) {
      if (!buildingName) continue;
      const floors = await ensureFloorsForBuilding(buildingName);
      if (!floors?.length) continue;

      const buildingAcc = createEmptySummaryAccumulator();

      for (const fl of floors) {
        const url = buildFloorUrl(buildingName, fl);
        if (!url) continue;

        let data = floorCache.get(url);
        if (!data) {
          data = await fetchGeoJSON(url);
          if (data) floorCache.set(url, data);
        }
        const fc = toFeatureCollection(data);
        if (!fc?.features?.length) continue;

        for (const feat of fc.features) {
          const props = feat?.properties || {};
          const revitId = feat?.id ?? props.RevitId ?? props.id;
          const roomIdKey = (buildingName && fl && revitId != null) ? rId(buildingName, fl, revitId) : null;
          const patch = roomIdKey && roomPatches instanceof Map ? roomPatches.get(roomIdKey) : null;
          const merged = patch ? { ...props, ...patch } : props;
          const deptVal = (merged.department ?? merged.Department ?? merged.Dept ?? '').toString().trim();
          if (deptFilter && !deptVal.toLowerCase().includes(deptFilter)) continue;
          accumulateSummaryFromProps(buildingAcc, merged);
          accumulateSummaryFromProps(campusAcc, merged);
        }
      }

      const buildingSummary = finalizeCombinedSummary(buildingAcc);
      const row = buildingSummary ? toSummaryRow(buildingSummary, buildingName) : null;
      if (row && (row.rooms || row.totalSf)) {
        buildingRows.push(row);
      }
    }

    const campusSummary = finalizeCombinedSummary(campusAcc);
    const includeCampusRow = !buildingFilter || buildingFilter === '__all__';
    const campusRow = includeCampusRow && campusSummary && (campusSummary.rooms || campusSummary.totalSf)
      ? toSummaryRow(campusSummary, 'Campus Total', 'campus')
      : null;

    return { campusRow, buildingRows };
  }, [buildFloorUrl, ensureFloorsForBuilding, roomPatches]);

  const onCreateMoveScenario = useCallback(async () => {
    setAiCreateScenarioErr('');
    setAiCreateScenarioLoading(true);
    setAiCreateScenarioResult(null);

    try {
      if (aiStatus !== 'ok') throw new Error('AI server is offline.');
      const request = (aiCreateScenarioText || '').trim();
      if (!request) throw new Error('Enter a short request for the move scenario.');

      const buildingLabel = activeBuildingName || selectedBuilding || '';
      const floorId = ''; // avoid biasing to a single floor; inventory is campus-wide

      let inventory = [];
      try {
        const rows = await collectSpaceRows('__all__', '');
        inventory = buildInventoryFromRoomRows(rows, 250) || [];
      } catch {}

      if (!inventory.length) {
        const featureList =
          currentFloorContextRef?.current?.fc?.features ||
          [];
        inventory = buildInventoryFromFeatures(featureList, buildingLabel, floorId, 250) || [];
      }

      if (!inventory.length) {
        throw new Error('No room inventory loaded yet. Load Space Data or a floorplan first.');
      }

      const context = {
        universityId,
        campusLabel: activeUniversityName || universityId || 'Campus',
        buildingLabel,
        floorId,
        moveScenarioMode: true,
        scenarioDepartment: scenarioAssignedDept || '',
        scenarioLabel: (scenarioLabel || '').trim(),
        scope: 'campus'
      };

      const out = await createMoveScenario({ request, context, inventory });
      setAiCreateScenarioResult(out);
      setAiCreateScenarioOpen(false);
    } catch (e) {
      setAiCreateScenarioErr(String(e?.message || e));
    } finally {
      setAiCreateScenarioLoading(false);
    }
  }, [
    activeBuildingName,
    activeUniversityName,
    aiCreateScenarioText,
    aiStatus,
    collectSpaceRows,
    createMoveScenario,
    scenarioAssignedDept,
    scenarioLabel,
    selectedBuilding,
    selectedFloor,
    universityId
  ]);

  const onAskRun = useCallback(async () => {
    setAskErr('');
    setAskLoading(true);
    setAskResult(null);

    try {
      const q = (askText || '').trim();
      if (!q) throw new Error('Type a question first.');

      const buildingIdVal = selectedBuildingId || selectedBuilding || '';
      let roomRowsPayload = null;
      try {
        const rows = await collectSpaceRows('__all__', '');
        roomRowsPayload = Array.isArray(rows) ? rows.slice(0, 250) : null;
      } catch {
        roomRowsPayload = null;
      }

      const context = {
        universityId,
        buildingId: buildingIdVal,
        buildingLabel: activeUniversityName || activeBuildingName || '',
        floorId: selectedFloor || ''
      };

      const data = {
        campusStats,
        buildingStats,
        floorStats,
        roomRows: roomRowsPayload || undefined
      };

      const out = await askMapfluence({ question: q, context, data });
      setAskResult(out);
    } catch (e) {
      setAskErr(String(e?.message || e));
    } finally {
      setAskLoading(false);
    }
  }, [
    activeBuildingName,
    activeUniversityName,
    askText,
    selectedBuildingId,
    selectedBuilding,
    selectedFloor,
    universityId,
    campusStats,
    buildingStats,
    floorStats,
    askMapfluence,
    collectSpaceRows
  ]);

  const applyAiMoveCandidatesToScenario = useCallback(() => {
    const candidates = aiCreateScenarioResult?.recommendedCandidates || [];
    if (!candidates.length) return;
    setMoveScenarioMode(true);
    candidates.forEach((c, idx) => {
      const roomId = c.roomId || c.id || [c.buildingLabel, c.floorId, c.roomLabel, idx].filter(Boolean).join('|') || `cand-${idx}`;
      toggleScenarioRoom({
        roomId,
        buildingId: c.buildingLabel || '',
        buildingName: c.buildingLabel || '',
        floorName: c.floorId || '',
        revitId: c.revitId ?? null,
        roomNumber: c.roomLabel || '',
        roomType: c.type || 'Unspecified',
        department: c.department || '',
        area: Number(c.sf || 0) || 0
      });
    });
  }, [aiCreateScenarioResult?.recommendedCandidates, setMoveScenarioMode, toggleScenarioRoom]);

  const exportSpaceCsv = useCallback(async (explicitBuilding, modeOverride) => {
    const buildingArg = (explicitBuilding && typeof explicitBuilding === 'object') ? null : explicitBuilding;
    const mode = modeOverride || exportSpaceMode || 'rooms';
    setExportingSpaceData(true);
    setExportSpaceMessage(mode === 'summary' ? 'Preparing summary export...' : 'Building export data...');
    try {
      const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      if (mode === 'summary') {
        const { campusRow, buildingRows } = await collectSpaceSummaryRows(buildingArg || exportBuildingFilter, exportDeptFilter);
        const summaryRows = [...(campusRow ? [campusRow] : []), ...buildingRows];
        if (!summaryRows.length) {
          setExportSpaceMessage('No matching rooms found.');
          setExportingSpaceData(false);
          return;
        }
        const headers = ['BuildingId', 'BuildingName', 'TotalSF', 'Rooms', 'ClassroomSF', 'Classrooms', 'LabSF', 'Labs', 'OfficeSF', 'Offices', 'KeyDepts'];
        const csvLines = [headers.join(',')];
        summaryRows.forEach((r) => {
          csvLines.push([
            esc(r.buildingId),
            esc(r.buildingName),
            esc(r.totalSf),
            esc(r.rooms),
            esc(r.classroomSf),
            esc(r.classrooms),
            esc(r.labSf),
            esc(r.labs),
            esc(r.officeSf),
            esc(r.offices),
            esc(r.keyDepts)
          ].join(','));
        });
        const csvBlob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(csvBlob);
        const buildingNameForFile = buildingArg || exportBuildingFilter;
        const namePart = buildingNameForFile && buildingNameForFile !== '__all__'
          ? buildingNameForFile.replace(/\s+/g, '-').toLowerCase()
          : 'campus';
        a.download = `${namePart}-space-summary.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setExportSpaceMessage(`Exported ${summaryRows.length} summary rows`);
        return;
      }

      const rows = await collectSpaceRows(buildingArg || exportBuildingFilter, exportDeptFilter);
      if (!rows.length) {
        setExportSpaceMessage('No matching rooms found.');
        setExportingSpaceData(false);
        return;
      }
      const headers = ['Building', 'Floor', 'Room', 'Type', 'Department', 'AreaSF', 'SeatCount', 'Occupant'];
      const csvLines = [headers.join(',')];
      rows.forEach((r) => {
        csvLines.push([
          esc(r.building),
          esc(r.floor),
          esc(r.roomNumber),
          esc(r.type),
          esc(r.department),
          esc(r.area),
          esc(r.seatCount),
          esc(r.occupant)
        ].join(','));
      });
      const csvBlob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(csvBlob);
      const buildingNameForFile = buildingArg || exportBuildingFilter;
      const namePart = buildingNameForFile && buildingNameForFile !== '__all__'
        ? buildingNameForFile.replace(/\s+/g, '-').toLowerCase()
        : 'campus';
      a.download = `${namePart}-space-data.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setExportSpaceMessage(`Exported ${rows.length} rows`);
    } catch (err) {
      console.warn('Space export failed', err);
      setExportSpaceMessage('Export failed. See console.');
    } finally {
      setExportingSpaceData(false);
    }
  }, [collectSpaceRows, collectSpaceSummaryRows, exportBuildingFilter, exportDeptFilter, exportSpaceMode]);

  const clearMarkers = useCallback(() => {
    try {
      setMarkers([]);
      setSessionMarkers([]);
    } catch {}
  }, []);

  const clearConditions = useCallback(() => {
    try {
      setBuildingConditions({});
      setBuildingAssessments({});
    } catch {}
  }, []);

  // Floating panel anchor
  const [panelAnchor, setPanelAnchor] = useState(null);

  // Outdoor polygons data (for export + point-in-polygon)
  const outdoorDataRef = useRef(null);
  // (Removed manifest loading state)

  // (Removed manifest fetching effect)

  if (!universityId) { return <div>Loading University...</div>; }

  // Collections
  const markersCollection = useMemo(() => collection(db, 'universities', universityId, 'markers'), [universityId]);
  // Paths collection removed
  const conditionsCollection = useMemo(() => collection(db, 'universities', universityId, 'buildingConditions'), [universityId]);
  const assessmentsCollection = useMemo(() => collection(db, 'universities', universityId, 'buildingAssessments'), [universityId]);
  const drawingEntriesCollection = useMemo(() => collection(db, 'universities', universityId, 'drawingEntries'), [universityId]);
  const movesCollection = useMemo(() => collection(db, 'moves'), [db]);

  const buildMoveDoc = ({ person, from, to, effectiveDate, comments, createdBy }) => ({
    person: person || '',
    fromRoomId: from?.roomId || '',
    toRoomId: to?.roomId || '',
    fromBuildingId: from?.buildingId || '',
    toBuildingId: to?.buildingId || '',
    fromFloorId: from?.floorId || '',
    toFloorId: to?.floorId || '',
    fromRoomLabel: from?.roomLabel || '',
    toRoomLabel: to?.roomLabel || '',
    effectiveDate: effectiveDate || '',
    comments: comments || '',
    createdAt: serverTimestamp(),
    createdBy: createdBy || 'unknown'
  });

  const logMove = useCallback(
    async (payload) => {
      if (!payload) return;
      try {
        await addDoc(movesCollection, payload);
      } catch (err) {
        console.warn('Failed to log move', err);
      }
    },
    [movesCollection]
  );

  const handleMoveCancel = () => {
    setPendingMove(null);
    setMoveConfirmData(null);
    setFloorHighlight(null);
  };

  const handleMoveConfirm = async () => {
    if (!moveConfirmData) return;
    const { from, to, effectiveDate, comments, person } = moveConfirmData;
    const occupantName = (person || from?.occupantName || '').trim();
    if (!from || !to || !occupantName) return;
    try {
      const fromSaved = await saveRoomEdits({
        roomId: from.roomId,
        buildingId: from.buildingId,
        floorName: from.floorId,
        revitId: from.revitId,
        properties: { occupant: '' }
      });
      const toSaved = await saveRoomEdits({
        roomId: to.roomId,
        buildingId: to.buildingId,
        floorName: to.floorId,
        revitId: to.revitId,
        properties: { occupant: occupantName }
      });
      if (fromSaved && toSaved) {
        await logMove(
          buildMoveDoc({
            person: occupantName,
            from,
            to,
            effectiveDate,
            comments,
            createdBy: authUser?.email || 'unknown'
          })
        );
      } else {
        console.warn('Move update incomplete, skipping move log.');
      }
    } catch (err) {
      console.warn('Move confirmation failed', err);
    } finally {
      handleMoveCancel();
    }
  };

  // Marker sets
const filteredMarkers = useMemo(() => {
  if (mode !== 'admin') return markers;
  return markers.filter((m) => {
    const p = (m.persona || '').toLowerCase(); // ? fixed: closed empty string
    if (p.includes('student')) return showStudentMarkers;
    if (p.includes('staff') || p.includes('faculty')) return showStaffMarkers;
    return true; // keep admin/legacy visible
  });
}, [markers, showStudentMarkers, showStaffMarkers, mode]);


  const markerTypes = useMemo(() => {
    if (mode === 'admin') return { ...surveyConfigs.student, ...surveyConfigs.staff };
    return surveyConfigs[persona] || surveyConfigs.default;
  }, [persona, mode]);

  // ---------- Auth ----------
  useEffect(() => {
    const auth = getAuth();
    getRedirectResult(auth).catch(() => {});
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthUser(user || null);
      if (!user) {
        setIsAdminUser(false);
        return;
      }
      try {
        const roleSnap = await getDoc(doc(db, 'universities', universityId, 'roles', user.uid));
        setIsAdminUser(!!roleSnap.exists() && roleSnap.data()?.role === 'admin');
      } catch {
        setIsAdminUser(false);
      }
    });
    return () => unsub();
  }, [universityId]);

  // Admin auth actions used by controls panel
  async function handleAdminSignIn() {
    try {
      const authInstance = getAuth();
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(authInstance, provider);
      } catch {
        await signInWithRedirect(authInstance, provider);
      }
    } catch {}
  }
  function handleAdminSignOut() {
    try { signOut(getAuth()); } catch {}
  }

  // ---------- Load building options ----------
  useEffect(() => {
    if (!universityId) return;
    (async () => {
      try {
        // Try Firestore first
        const bCol = collection(db, 'universities', universityId, 'buildings');
        const bSnap = await getDocs(bCol);
        if (!bSnap.empty) {
          const opts = bSnap.docs.map(d => ({ id: d.id, name: d.data()?.name || d.id }));
          // (removed setBuildingOptions)
          // If nothing is selected yet, default to the first
          if (!selectedBuilding && opts.length) setSelectedBuilding(opts[0].id);
          return;
        }
        // Fallback to local manifest if Firestore empty
        const res = await fetch(FLOORPLAN_MANIFEST_URL);
        if (res.ok) {
          const m = await res.json(); // { buildings: { [id]: { name, floors: [...] } } }
          const opts = Object.entries(m.buildings || {}).map(([id, v]) => ({ id, name: v?.name || id }));
          // (removed setBuildingOptions)
          if (!selectedBuilding && opts.length) setSelectedBuilding(opts[0].id);
        }
      } catch (e) {
        console.warn('Building options load failed:', e);
      }
    })();
  }, [universityId]);

  // ---------- Load floor manifest when building changes ----------
  useEffect(() => {
    let cancelled = false;
    const clearFloors = () => {
      setAvailableFloors([]);
      setSelectedFloor(undefined);
    };

    (async () => {
      const buildingKeyInput = selectedBuildingId || selectedBuilding;
      if (!buildingKeyInput) {
        clearFloors();
        return;
      }
      const folderKey = getBuildingFolderKey(buildingKeyInput);
      if (!folderKey) {
        clearFloors();
        return;
      }
      const floors = await loadFloorManifest(folderKey);
      if (cancelled) return;
      availableFloorsByBuildingRef.current.set(folderKey, floors);
      if (floors.length) {
        setAvailableFloors(floors);
        setSelectedFloor((prev) => (prev && floors.includes(prev) ? prev : floors[0]));
      } else {
        clearFloors();
      }
    })();

    return () => { cancelled = true; };
}, [selectedBuildingId, selectedBuilding, getBuildingFolderKey]);

  // ---------- Map init / teardown ----------
useEffect(() => {
  if (!config) return;

  let rafId = null;
  let ro = null;

  const el = mapContainerRef.current;
  if (!el) return;

  const hasSize = () => el.clientWidth > 0 && el.clientHeight > 0;

  const init = () => {
    if (mapRef.current) return; // avoid double init

    const styleUrl = (config && config.style) || 'mapbox://styles/mapbox/streets-v12';
    const initialCenter = config?.initialCenter || [-98.3739, 40.5939];
    const initialZoom = config?.initialZoom ?? 16;

    console.log('Mapbox token length:', (mapboxgl.accessToken || '').length);
    console.log('Using style:', styleUrl);

    let mapInstance = null;
    try {
      mapInstance = new mapboxgl.Map({
        container: el,
        style: styleUrl,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: false,
        preserveDrawingBuffer: true
      });
    } catch (e) {
      console.error('Map constructor failed:', e);
      return;
    }
    if (!mapInstance) {
      console.error('Map was not created (mapInstance is falsy).');
      return;
    }

    mapRef.current = mapInstance;
    if (typeof window !== "undefined") {
      window.__map = mapInstance;
    }

    try {
      mapInstance.addControl(new mapboxgl.NavigationControl(), 'top-right');
      // mapInstance.addControl(new mapboxgl.FullscreenControl());
    } catch (e) {
      console.warn('Adding controls failed:', e);
    }

    // 4) Load/resize safely
    mapInstance.once('load', () => {
      (async () => {
        try {
          await loadIcon(mapInstance, 'mf-door-swing', 'icons/door-swing.png');
        } catch (err) {
          console.warn('Door icon load failed:', err);
        }
        try {
          await loadIcon(mapInstance, 'mf-stairs-run', 'icons/stairs-run.png');
        } catch (err) {
          console.warn('Stairs icon load failed:', err);
        }

        setMapLoaded(true);

        try {
          mapInstance.resize();
        } catch (err) {
          console.warn('resize() failed:', err);
        }

        // Optional fitBounds from boundary
        try {
          const boundaryFC = toFeatureCollection(config?.boundary);
          if (boundaryFC?.features?.length) {
            const [minX, minY, maxX, maxY] = bboxFromFC(boundaryFC);
            if (
              Number.isFinite(minX) &&
              Number.isFinite(minY) &&
              Number.isFinite(maxX) &&
              Number.isFinite(maxY)
            ) {
              mapInstance.fitBounds([[minX, minY], [maxX, maxY]], {
                padding: 40,
                duration: 0
              });
            }
          }
        } catch (e) {
          console.warn('fitBounds from boundary failed:', e);
        }
      })();

    }); // closes once('load', ...)
  }; // closes init()

  if (hasSize()) {
    init();
  } else {
    // Wait for the element to get a size, then init once
    try {
      ro = new ResizeObserver(() => {
        if (hasSize()) {
          try { ro.disconnect(); } catch {}
          ro = undefined;
          init();
        }
      });
      ro.observe(el);
    } catch {}
    rafId = requestAnimationFrame(() => {
      if (hasSize()) {
        if (ro) { try { ro.disconnect(); } catch {} ro = undefined; }
        init();
      }
    });
  }

  const onResize = () => {
    if (mapRef.current) {
      try { mapRef.current.resize(); } catch {}
    }
  };
  try { window.addEventListener('resize', onResize); } catch {}

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    if (ro) { try { ro.disconnect(); } catch {} }
    try { window.removeEventListener('resize', onResize); } catch {}
    if (mapRef.current) { try { mapRef.current.remove(); } catch {} mapRef.current = null; }
  };
}, [config]);


  // ---------- Load data (markers/assessments/conditions) ----------
  useEffect(() => {
    (async () => {
      try {
        // Markers
        let markersQuery;
        if (mode === 'admin') {
          markersQuery = query(markersCollection);
        } else {
          markersQuery = query(markersCollection, where('persona', '==', persona));
        }
        const markerSnap = await getDocs(markersQuery);
        setMarkers(
          markerSnap.docs.map((d) => ({ id: d.id, ...d.data(), coordinates: [d.data().coordinates.longitude, d.data().coordinates.latitude] }))
        );

        if (mode !== 'admin') {
          setBuildingConditions({});
          setBuildingAssessments({});
          return;
        }

        // Admin loads conditions and assessments
        const [condSnap, assessmentSnap] = await Promise.all([
          getDocs(conditionsCollection),
          getDocs(assessmentsCollection)
        ]);

        const condData = {};
        condSnap.forEach((d) => {
          const id = d.data().originalId || d.id.replace(/__/g, '/');
          condData[id] = d.data().condition;
        });
        setBuildingConditions(condData);

        const assessmentData = {};
        assessmentSnap.forEach((docx) => {
          const key = docx.data().originalId || docx.id.replace(/__/g, '/');
          assessmentData[key] = docx.data();
        });
        setBuildingAssessments(assessmentData);
      } catch (err) {
        console.error('Failed to fetch data:', err);
        if (mode === 'admin') {
          setBuildingConditions({});
          setBuildingAssessments({});
        }
      }
    })();
  }, [mode, universityId, persona, markersCollection, conditionsCollection, assessmentsCollection]);

// Keep floorplan building input in sync with map selection (convenience)
useEffect(() => {
  if (!selectedBuildingId) return;
  const resolved = resolveBuildingPlanKey(selectedBuildingId) || selectedBuildingId;
  if (selectedBuilding !== resolved) {
    setSelectedBuilding(resolved);
  }
}, [selectedBuildingId, resolveBuildingPlanKey, selectedBuilding]);

useEffect(() => {
  if (roomSubRef.current) {
    try { roomSubRef.current(); } catch {}
    roomSubRef.current = null;
  }
  const resolvedBuilding = selectedBuildingId || selectedBuilding;
  if (!resolvedBuilding || !selectedFloor || !universityId) return;

  const canonicalUniversityId = canon(universityId);
  const canonicalBuildingId = bId(resolvedBuilding);
  const canonicalFloorId = fId(selectedFloor);

  const roomsCol = collection(
    db,
    'universities', canonicalUniversityId,
    'buildings', canonicalBuildingId,
    'floors', canonicalFloorId,
    'rooms'
  );

  roomSubRef.current = onSnapshot(roomsCol, (snap) => {
    const next = new Map();
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      next.set(docSnap.id, {
        ...data,
        buildingId: data.original?.buildingName ?? resolvedBuilding,
        floor: data.original?.floorLabel ?? selectedFloor,
        revitId: data.original?.featureId ?? data.revitId ?? docSnap.id
      });
    });
    setRoomPatches(next);
  });

  return () => {
    if (roomSubRef.current) {
      try { roomSubRef.current(); } catch {}
      roomSubRef.current = null;
    }
  };
}, [selectedBuildingId, selectedBuilding, selectedFloor, universityId]);

useEffect(() => {
  selectedBuildingIdRef.current = selectedBuildingId;
  if (!selectedBuildingId) {
    panelBuildingKeyRef.current = null;
    selectedBuildingFeatureRef.current = null;
    setBuildingStats(null);
    setFloorStats(null);
    setPopupMode('building');
    if (!currentFloorUrlRef.current) setPanelStats(null);
  }
}, [selectedBuildingId]);

// ---------- Base layers + Outdoor polygons ----------
useEffect(() => {
  if (!mapLoaded || !mapRef.current || !config) return;
  const map = mapRef.current;

  // Buildings (sources + base layers)
    if (!map.getSource('buildings')) {
      map.addSource('buildings', { type: 'geojson', data: config.buildings, promoteId: 'id' });

    // 1) visible extrusion
    map.addLayer({
      id: 'buildings-layer',
      type: 'fill-extrusion',
      source: 'buildings',
      paint: {
        'fill-extrusion-color': defaultBuildingColor,
        'fill-extrusion-height': 15,
        'fill-extrusion-opacity': 0.7
      }
    });

    // 2) outline (styled when selected)
    map.addLayer({
      id: 'buildings-outline-base',
      type: 'line',
      source: 'buildings',
      paint: {
        'line-color': '#000000',
        'line-width': 3,
        'line-opacity': 0.9
      }
    });

    map.addLayer({
      id: 'buildings-outline',
      type: 'line',
      source: 'buildings',
      paint: {
        'line-color': '#007bff',
        'line-width': 4,
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          1, 0
        ]
      }
    });

    // 3) transparent fill strictly for hit-testing (always clickable)
    if (!map.getLayer('buildings-fill')) {
      try {
        map.addLayer(
          { id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-opacity': 0.0 } },
          'buildings-outline'
        );
      } catch {
        map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-opacity': 0.0 } });
      }
    }

    // 4) building name labels
    map.addLayer({
      id: 'buildings-labels',
      type: 'symbol',
      source: 'buildings',
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ['get', 'id']],
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-size': 10,
        'text-anchor': 'center',
        'text-variable-anchor': ['center'],
        'text-offset': [0, 0],
        'text-line-height': 1,
        'text-allow-overlap': false,
        'text-max-width': 10,
        'symbol-placement': 'point'
      },
      paint: {
        'text-color': '#111111',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 2
      }
    });

    // highlight ring layer (kept separate)
    if (!map.getLayer('buildings-hit')) {
      map.addLayer({
        id: 'buildings-hit',
        type: 'line',
        source: 'buildings',
        paint: { 'line-color': '#007aff', 'line-width': 2 },
        filter: ['==', ['get', 'id'], selectedBuildingId || '']
      });
    }
  }

  // Boundary
  if (config.boundary && !map.getSource('boundary')) {
    const boundaryFC = toFeatureCollection(config.boundary);
    if (boundaryFC) {
      map.addSource('boundary', { type: 'geojson', data: boundaryFC });
      map.addLayer({
        id: 'boundary-layer',
        type: 'line',
        source: 'boundary',
        paint: { 'line-color': '#a9040e', 'line-width': 3, 'line-dasharray': [2, 2] }
      });
    } else {
      console.warn('Boundary provided but could not normalize to FeatureCollection.');
    }
  }
  // Outdoor polygons disabled
  }, [mapLoaded, config]);


// --- Ensure buildings source/layers and dedicated click are bound ---
useEffect(() => {
  if (!mapLoaded || !mapRef.current || !config) return;
  const map = mapRef.current;

  // Ensure sources/layers (defensive ? in case previous effect didn?t run yet)
  if (!map.getSource('buildings')) {
    map.addSource('buildings', { type: 'geojson', data: config.buildings, promoteId: 'id' });

    map.addLayer({
      id: 'buildings-layer',
      type: 'fill-extrusion',
      source: 'buildings',
      paint: {
        'fill-extrusion-color': defaultBuildingColor,
        'fill-extrusion-height': 15,
        'fill-extrusion-opacity': 0.7
      }
    });

    map.addLayer({
      id: 'buildings-outline',
      type: 'line',
      source: 'buildings',
      paint: {
        'line-color': '#007bff',
        'line-width': 2.5,
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          1, 0
        ]
      }
    });

    if (!map.getLayer('buildings-fill')) {
      map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-opacity': 0 } }, 'buildings-outline');
    }
  }

  // Dedicated building click (works even with no floorplan loaded)
  const onBuildingClick = async (e) => {
    if (!map) return;
    let clickedRoom = null;
    try {
      if (map.getLayer(FLOOR_FILL_ID)) {
        const floorHits = map.queryRenderedFeatures(e.point, { layers: [FLOOR_FILL_ID, DOORS_LAYER, STAIRS_LAYER] });
        clickedRoom = floorHits && floorHits[0];
      }
    } catch {}
    if (clickedRoom) return;

    const f = e.features && e.features[0];
    if (!f) return;
    selectedBuildingFeatureRef.current = f;

    const id = f.properties?.id;
    if (!id) return;

    // clear previous selection state
    try {
      if (previousSelectedBuildingId.current) {
        map.setFeatureState({ source: 'buildings', id: previousSelectedBuildingId.current }, { selected: false });
      }
      map.setFeatureState({ source: 'buildings', id }, { selected: true });
      previousSelectedBuildingId.current = id;
    } catch {}

    setSelectedBuildingId(id);
    selectedBuildingIdRef.current = id;

    // position the panel near the click
    const pt = map.project(e.lngLat);
    setPanelAnchor(estimatePanelAnchor(pt));
    setIsBuildingPanelCollapsed(false);
    setPopupMode('building');
    setFloorStats(null);
    setBuildingStats(null);
    setPanelStats({ loading: true, mode: 'building' });
    prefetchFloorSummaries(id);
    try {
      const sum = await computeBuildingTotals(id);
      if (selectedBuildingIdRef.current !== id) return;
      if (!currentFloorUrlRef.current) {
        setBuildingStats(sum);
        setPanelStats(formatSummaryForPanel(sum, 'building'));
      }
      if (mapView !== MAP_VIEWS.SPACE_DATA) {
        const statsRaw = (await fetchBuildingSummary?.(id)) || sum || {};
        const fmtArea = (val) => (Number.isFinite(val) ? Math.round(val).toLocaleString() : '-');
        const fmtCount = (val) => (Number.isFinite(val) ? Number(val).toLocaleString() : '-');
        const deptListHtml = renderDeptListHTML(statsRaw.keyDepts || []);
        const popupHtml = `
          <div class="mf-popup mf-popup--building" style="min-width:280px;padding:8px 10px;">
            <div style="display:flex;gap:18px;align-items:flex-start;">
              <div style="flex:1">
                <div style="font-weight:700;margin-bottom:6px;">${buildingName}</div>
                <div><b>Total SF:</b> ${fmtArea(statsRaw.totalSf)}</div>
                <div><b>Rooms:</b> ${fmtCount(statsRaw.rooms)}</div>
                <div><b>Classroom SF:</b> ${fmtArea(statsRaw.classroomSf)}</div>
                <div><b>Classrooms:</b> ${fmtCount(statsRaw.classroomCount)}</div>
              </div>
              <div style="min-width:180px;">
                <div style="font-weight:600;margin-bottom:4px;">Key Departments</div>
                ${deptListHtml || '<div class="mf-subtle">?</div>'}
              </div>
            </div>
          </div>`;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(popupHtml)
          .addTo(map);
      }
    } catch (err) {
      console.warn('Failed to load building totals for popup:', err);
    }
  };

  // Bind once
  if (!map.__mf_building_click_bound) {
    map.on('click', 'buildings-fill', onBuildingClick);
    map.__mf_building_click_bound = true;
  }

  // Cleanup (in case style reloads or component unmounts)
  return () => {
    try {
      if (map.__mf_building_click_bound) {
        map.off('click', 'buildings-fill', onBuildingClick);
        map.__mf_building_click_bound = false;
      }
    } catch {}
  };
}, [mapLoaded, config, mapView, prefetchFloorSummaries, computeBuildingTotals, fetchBuildingSummary]);

useEffect(() => {
  if (!mapLoaded || !mapRef.current) return;
  const map = mapRef.current;

  const applyExtrusion = (color, opacity) => {
    try {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', color);
      map.setPaintProperty('buildings-layer', 'fill-extrusion-opacity', opacity);
    } catch {}
  };
  const applyFill = (layerId, color, opacity) => {
    try {
      map.setPaintProperty(layerId, 'fill-color', color);
      map.setPaintProperty(layerId, 'fill-opacity', opacity);
    } catch {}
  };

  const buildingsLayer = map.getLayer('buildings-layer');
  const buildingsFill = map.getLayer('buildings-fill');

  if (mapView === MAP_VIEWS.SPACE_DATA) {
    if (buildingsLayer) {
      if (buildingsLayer.type === 'fill-extrusion') {
        applyExtrusion('#ffffff', 1.0);
      } else {
        applyFill('buildings-layer', '#ffffff', 1.0);
      }
    }
    applyBuildingStyleForSpace(map);
  } else {
    if (buildingsLayer) {
      if (buildingsLayer.type === 'fill-extrusion') {
        applyExtrusion(defaultBuildingColor, 0.7);
      } else {
        applyFill('buildings-layer', defaultBuildingColor, 0.7);
      }
    }
    if (buildingsFill) {
      applyFill('buildings-fill', defaultBuildingColor, 0.2);
      try {
        map.setPaintProperty('buildings-fill', 'fill-outline-color', '#00000000');
    } catch {}
    ensureFloorRoomLabelLayer(map);
  }
}

}, [mapLoaded, mapView]);


  
  // Update hit-layer filter on selection change
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    try {
      if (map.getLayer('buildings-hit')) {
        map.setFilter('buildings-hit', ['==', ['get', 'id'], selectedBuildingId || '']);
      }
    } catch {}
  }, [selectedBuildingId, mapLoaded]);
// ---------- UI: building selection state ----------
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    if (mode !== 'admin' && selectedBuildingId) setSelectedBuildingId(null);

    if (previousSelectedBuildingId.current) {
      map.setFeatureState({ source: 'buildings', id: previousSelectedBuildingId.current }, { selected: false });
    }
    if (selectedBuildingId && mode === 'admin') {
      map.setFeatureState({ source: 'buildings', id: selectedBuildingId }, { selected: true });
    }
    previousSelectedBuildingId.current = selectedBuildingId;
  }, [selectedBuildingId, mapLoaded, mode]);

  // ---------- Render markers ----------
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    // remove existing DOM markers
    map.getCanvas().parentElement
      .querySelectorAll('.custom-mapbox-marker')
      .forEach((el) => el.remove());

    const markersToDraw = mode === 'admin' ? (showMarkers ? filteredMarkers : []) : sessionMarkers;
    markersToDraw.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'custom-marker custom-mapbox-marker';
      el.style.backgroundColor = markerTypes[m.type] || '#9E9E9E';
      const mk = new mapboxgl.Marker(el).setLngLat(m.coordinates);
      if (mapView !== MAP_VIEWS.SPACE_DATA) {
        mk.setPopup(new mapboxgl.Popup({ offset: 25 }).setText(m.comment || m.type));
      }
      mk.addTo(map);
    });
  }, [filteredMarkers, sessionMarkers, markerTypes, mapLoaded, mode, showMarkers]);  // ---------- Recolor buildings based on theme ----------
useEffect(() => {
  if (!mapLoaded || !mapRef.current || !mapRef.current.getSource('buildings')) return;
  if (mapView === MAP_VIEWS.SPACE_DATA) {
    // in Space Data we keep buildings pure white; do not recolor
    try {
      mapRef.current.setPaintProperty('buildings-layer', 'fill-extrusion-color', '#ffffff');
    } catch {}
    return;
  }
  const map = mapRef.current;

    const matchExpr = ['match', ['get', 'id']];
    let hasEntries = false;

    if (mode === 'admin' && mapView === MAP_VIEWS.ASSESSMENT && Object.keys(buildingAssessments).length > 0) {
      Object.entries(buildingAssessments).forEach((tuple) => {
        const buildingId = tuple[0];
        const assessment = tuple[1];
        let completedSections = 0;
        const sc = assessment && assessment.scores ? assessment.scores : {};
        if (sc.architecture && Object.values(sc.architecture).some((s) => s > 0)) completedSections++;
        if (sc.engineering && Object.values(sc.engineering).some((s) => s > 0)) completedSections++;
        if (sc.functionality && Object.values(sc.functionality).some((s) => s > 0)) completedSections++;
        matchExpr.push((assessment && assessment.originalId) || buildingId, progressColors[completedSections]);
        hasEntries = true;
      });
    } else if (mode === 'admin' && mapView === MAP_VIEWS.SPACE_DATA && Object.keys(buildingConditions).length > 0) {
      Object.entries(buildingConditions).forEach((tuple) => {
        const id = tuple[0];
        const conditionValue = tuple[1];
        const conditionData = stakeholderConditionConfig[conditionValue];
        if (conditionData) {
          matchExpr.push(id, conditionData.color);
          hasEntries = true;
        }
      });
    }

    matchExpr.push(defaultBuildingColor);

    if (hasEntries) {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', matchExpr);
    } else {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', defaultBuildingColor);
    }
  }, [buildingConditions, buildingAssessments, mapLoaded, mode, mapView]);

  // ---------- Map click handlers ----------
  const showMarkerPopup = useCallback((lngLat) => {
    if (!mapRef.current) return;
    const popupNode = document.createElement('div');
    popupNode.className = 'marker-prompt-popup';
    popupNode.innerHTML = `
      <h4>Add a Marker</h4>
      <select id="marker-type">${Object.keys(markerTypes).map((type) => `<option value="${type}">${type}</option>`).join('')}</select>
      <textarea id="marker-comment" placeholder="Optional comment..."></textarea>
      <div class="button-group">
        <button id="confirm-marker">Add</button>
        <button id="cancel-marker">Cancel</button>
      </div>`;

    const popup = new mapboxgl.Popup({ closeOnClick: false, maxWidth: '280px' })
      .setDOMContent(popupNode)
      .setLngLat(lngLat)
      .addTo(mapRef.current);

    popupNode.querySelector('#confirm-marker').addEventListener('click', async () => {
      const type = popupNode.querySelector('#marker-type').value;
      const comment = popupNode.querySelector('#marker-comment').value.trim();
      const markerData = {
        coordinates: new GeoPoint(lngLat.lat, lngLat.lng),
        type,
        comment,
        persona: persona || 'admin',
        createdAt: serverTimestamp()
      };
      const docRef = await addDoc(markersCollection, markerData);
      const newMarker = { ...markerData, id: docRef.id, coordinates: [lngLat.lng, lngLat.lat] };
      setMarkers((prev) => [...prev, newMarker]);
      setSessionMarkers((prev) => [...prev, newMarker]);
      popup.remove();
    });
    popupNode.querySelector('#cancel-marker').addEventListener('click', () => popup.remove());
  }, [markerTypes, markersCollection, persona]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    const onFloorClick = (e) => {
      try {
        e.preventDefault?.();
        if (e.originalEvent) {
          e.originalEvent.preventDefault?.();
          e.originalEvent.stopPropagation?.();
          e.originalEvent.cancelBubble = true;
        }
      } catch {}

      currentRoomFeatureRef.current = null;
      const f = e.features?.[0];
      if (!f) return;

      if (moveScenarioMode) {
        try {
          const rawProps = f.properties || {};
          const buildingId = selectedBuildingId || selectedBuilding || rawProps.Building || rawProps.buildingId || '';
          const floorName =
            rawProps.Floor ||
            selectedFloor ||
            (floorUrl?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) ||
            'LEVEL_1';

          const revitId = f.id ?? rawProps.RevitId ?? rawProps.revitId ?? null;
          const roomNumber =
            rawProps.Number ??
            rawProps.RoomNumber ??
            rawProps.number ??
            rawProps.Room ??
            '';

          const roomTypeLabel = getRoomTypeLabelFromProps(rawProps);

          const department =
            rawProps.department ??
            rawProps.Department ??
            rawProps.Dept ??
            '';

          const resolvedArea = resolvePatchedArea(rawProps);
          const area = Number.isFinite(resolvedArea) ? resolvedArea : 0;

          const roomId = (buildingId && floorName && revitId != null)
            ? rId(buildingId, floorName, revitId)
            : null;

          if (!roomId) {
            console.warn('Scenario click: could not build roomId', {
              buildingId, floorName, revitId, props: rawProps
            });
            return;
          }

          const screenPoint = e.point || map.project(e.lngLat);
          toggleScenarioRoom({
            roomId,
            buildingId,
            buildingName: rawProps.BuildingName || rawProps.buildingName || buildingId,
            floorName,
            revitId,
            roomNumber,
            roomType: roomTypeLabel,
            department,
            area: Number(area) || 0
          });
          repositionScenarioPanelToClick(screenPoint);
          nudgeScenarioPanelUp();
        } catch (err) {
          console.warn('Scenario click failed', err);
        }

        return;
      }

      currentRoomFeatureRef.current = f;

      const selId = (f.id ?? f.properties?.RevitId ?? null);

      if (!moveMode) {
        setFloorHighlight(selId);
      }

      if (floorUrl) {
        if (!floorSelectionRef.current) floorSelectionRef.current = {};
        floorSelectionRef.current[floorUrl] = selId;
      }

      const rawProps = f.properties || {};
      const buildingId = selectedBuildingId || selectedBuilding;
      const revitId = f.id ?? rawProps.RevitId ?? null;
      const derivedFloorDefault =
        rawProps.Floor ||
        selectedFloor ||
        (floorUrl?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) ||
        'LEVEL_1';
      const roomMergeKey = (buildingId && revitId != null)
        ? rId(buildingId, derivedFloorDefault, revitId)
        : null;
      if (moveScenarioMode) {
        if (!roomMergeKey) return;
        setScenarioSelection((prev) => {
          const next = new Set(prev);
          if (next.has(roomMergeKey)) next.delete(roomMergeKey);
          else next.add(roomMergeKey);
          handleScenarioSelectionChange(next);
          return next;
        });
        return;
      }
      const overridePatch = roomMergeKey ? roomPatches.get(roomMergeKey) : null;
      const pp = overridePatch ? { ...rawProps, ...overridePatch } : rawProps;
      const roomNum2 = pp.Number ?? pp.RoomNumber ?? pp.number ?? pp.Room ?? '';
      const initialRoomType = pp.type ?? pp.roomType ?? pp.Name ?? pp.RoomType ?? pp.Type ?? '';
      const initialDept = pp.department ?? pp.Department ?? pp.Dept ?? '';
      const initialOccupant = pp.occupant ?? pp.Occupant ?? '';
      const initialComments = pp.comments ?? pp.Comments ?? '';
      const resolvedArea = resolvePatchedArea(pp);
      let displayRoomType = initialRoomType;
      let displayDept = initialDept;
      let displayAreaValue = Number.isFinite(resolvedArea) ? resolvedArea : null;
      let displayOccupant = initialOccupant;
      const categoryCode = getRoomCategoryCode(pp);
      const seatCount = getSeatCount(pp);
      const typeFlags = detectRoomTypeFlags(pp);
      const isOffice = isOfficeCategory(categoryCode) || typeFlags.isOfficeText;
      const isTeaching = isTeachingCategory(categoryCode) || typeFlags.isTeachingText;
      const canonicalRoomId = (buildingId && derivedFloorDefault && revitId != null)
        ? rId(buildingId, derivedFloorDefault, revitId)
        : null;
      const movingOccupant = (displayOccupant ?? '').toString().trim();
      const roomLabel = roomNum2 || '-';

      if (moveMode) {
        if (!pendingMove) {
          if (!movingOccupant || !canonicalRoomId || selId == null) {
            console.warn('Cannot start move: missing occupant or identifiers.');
            return;
          }
          setPendingMove({
            roomId: canonicalRoomId,
            roomLabel,
            buildingId,
            floorId: derivedFloorDefault,
            occupantName: movingOccupant,
            revitId,
            highlightId: selId
          });
          setMoveConfirmData(null);
          setFloorHighlight(selId);
          return;
        }

        if (selId === pendingMove.highlightId) {
          setPendingMove(null);
          setMoveConfirmData(null);
          setFloorHighlight(null);
          return;
        }

        if (buildingId !== pendingMove.buildingId || derivedFloorDefault !== pendingMove.floorId) {
          setPendingMove(null);
          setMoveConfirmData(null);
          setFloorHighlight(null);
          return;
        }

        setMoveConfirmData({
          person: pendingMove.occupantName,
          effectiveDate: '',
          comments: '',
          from: pendingMove,
          to: {
            roomId: canonicalRoomId,
            roomLabel,
            buildingId,
            floorId: derivedFloorDefault,
            revitId,
            highlightId: selId
          }
        });
        return;
      }

      const isAdmin = isAdminUser;
      const floorName = pp.Floor || derivedFloorDefault;

      const canEditRoom = Boolean(isAdmin && buildingId && floorName && revitId != null && universityId);
      const roomId = canEditRoom ? rId(buildingId, floorName, revitId) : null;
      const editTarget = canEditRoom
        ? {
            roomId,
            buildingId,
            floorName,
            revitId,
            roomLabel,
            feature: f,
            flags: { isOffice, isTeaching },
            highlightId: selId,
            properties: {
              type: displayRoomType || '',
              department: displayDept || '',
              area: Number.isFinite(displayAreaValue) ? displayAreaValue : '',
              occupant: displayOccupant || '',
              comments: initialComments || ''
            }
          }
        : null;
      let selectionAfterClick = roomEditSelectionRef.current || [];
      if (editTarget) {
        const current = roomEditSelectionRef.current || [];
        const idx = current.findIndex((t) => t.roomId === editTarget.roomId);
        if (idx >= 0) {
          selectionAfterClick = current.filter((t) => t.roomId !== editTarget.roomId);
        } else {
          selectionAfterClick = [...current, editTarget];
        }
        roomEditSelectionRef.current = selectionAfterClick;
        setRoomEditSelection(selectionAfterClick);
        applySelectionHighlight(selectionAfterClick);
      }

      const renderReadOnlyPopup = () => {
        const areaText =
          Number.isFinite(displayAreaValue) && displayAreaValue !== 0
            ? Math.round(displayAreaValue).toLocaleString()
            : '';

        const selectionFromState = roomEditSelectionRef.current || [];
        const selectionCount = selectionFromState.length;
        const showClearSelection = selectionCount > 0;
        const editLabel = selectionCount > 1 ? `Edit ${selectionCount} Rooms` : 'Edit';

        const editButtonHtml = canEditRoom
          ? `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
               <button id="mf-room-edit-btn" class="mf-btn tiny">${editLabel}</button>
               ${showClearSelection ? `<button id="mf-clear-edit-selection" class="mf-btn tiny" style="background:#f4f4f4;color:#333;">Clear Selection</button>` : ''}
             </div>`
          : '';

        // Decide what to show in the "occupancy" row
        const hasSeatCount = Number.isFinite(seatCount) && seatCount > 0;
        const occupantTrimmed = (displayOccupant ?? '').toString().trim();

        const seatCountValue = hasSeatCount ? seatCount.toLocaleString() : '-';
        const seatCountRowHtml = isTeaching
          ? `<div><b>Seat Count:</b> ${seatCountValue}</div>`
          : '';

        const occupancyValue = occupantTrimmed.length ? occupantTrimmed : '-';
        const occupancyRowHtml = isTeaching
          ? ''
          : `<div><b>Occupant:</b> ${occupancyValue}</div>`;

        const selectionCountHtml = canEditRoom && selectionCount
          ? `<div style="font-size:11px;color:#555;margin-top:6px;">Rooms selected: ${selectionCount}</div>`
          : '';

        return `
          <div class="mf-popup">
            <div class="mf-popup-body">
              <div class="mf-title">Room ${roomNum2 || '-'}</div>
              <div><b>Type:</b> ${displayRoomType || '-'}</div>
              <div><b>Department:</b> ${displayDept || '-'}</div>
              <div><b>Area (SF):</b> ${areaText || '-'}</div>
              <div><b>Floor:</b> ${floorName}</div>
              ${seatCountRowHtml}
              ${occupancyRowHtml}
              ${selectionCountHtml}
            </div>

            <div style="margin-top:8px">
              <button id="mf-show-floor" class="mf-btn tiny">Show Floor Data</button>
            </div>

            ${editButtonHtml}
          </div>`;
      };

      const clickPoint = map.project(e.lngLat);
      const containerWidth = mapContainerRef.current?.clientWidth || 1000;
      const anchorSide = clickPoint.x > containerWidth * 0.56 ? 'right' : 'left';
      const offsetX = anchorSide === 'left' ? 240 : -240;
      const popupOffsets = {
        top: [offsetX, 12],
        'top-left': [offsetX, 12],
        'top-right': [offsetX, 12],
        bottom: [offsetX, -12],
        'bottom-left': [offsetX, -12],
        'bottom-right': [offsetX, -12],
        left: [offsetX, 0],
        right: [offsetX, 0]
      };
      const popup = new mapboxgl.Popup({
        closeButton: true,
        offset: popupOffsets,
        anchor: anchorSide,
        maxWidth: '380px'
      })
        .setLngLat(e.lngLat)
        .setHTML(renderReadOnlyPopup())
        .addTo(map);

      popup.on('close', () => {
        if (!moveMode && !pendingMove) {
          const ids = getHighlightIdsForSelection(roomEditSelectionRef.current || []);
          setFloorHighlight(ids.length ? ids : null);
        }
      });

  const handleShowFloor = async () => {
        try { popup.remove(); } catch {}

        const floorUrlLatest =
          currentFloorUrlRef.current || lastFloorUrlRef.current;
        if (!floorUrlLatest) return;

        setMapView(MAP_VIEWS.SPACE_DATA);
        setIsTechnicalPanelOpen(false);
        setIsBuildingPanelCollapsed(false);

        try {
          const pt = map.project(e.lngLat);
          setPanelAnchor(estimatePanelAnchor(pt));
        } catch {}

        if (selectedBuildingIdRef.current) {
          setSelectedBuildingId(selectedBuildingIdRef.current);
        } else if (selectedBuilding) {
          setSelectedBuildingId(selectedBuilding);
        }

        showFloorStats(floorUrlLatest);

      };
      const handleEdit = () => {
        if (!canEditRoom) return;
        const ensureTargets = () => {
          if (roomEditSelection.length) {
            const hasCurrent = roomId && roomEditSelection.some((t) => t.roomId === roomId);
            if (hasCurrent || !editTarget) return roomEditSelection;
            return [...roomEditSelection, editTarget];
          }
          return editTarget ? [editTarget] : [];
        };
        const targets = ensureTargets();
        if (!targets.length) return;

        const deriveSharedValue = (field) => {
          const vals = targets.map((t) => (t?.properties?.[field] ?? ''));
          const first = vals[0];
          return vals.every((v) => v === first) ? first : '';
        };
        const sharedProperties = {
          type: deriveSharedValue('type'),
          department: deriveSharedValue('department'),
          occupant: deriveSharedValue('occupant'),
          comments: deriveSharedValue('comments'),
          area: deriveSharedValue('area')
        };

        setRoomEditData({
          ...targets[0],
          targets,
          roomLabel: targets.length === 1 ? (targets[0]?.roomLabel || '-') : `${targets.length} rooms`,
          properties: sharedProperties,
          includedKeys: new Set(targets.map((t) => t.roomId || String(t.revitId ?? ''))),
          refreshPopup: () => {
            popup.setHTML(renderReadOnlyPopup());
            attachReadOnlyEvents();
          },
          onApply: (payload) => {
            if ('type' in payload) displayRoomType = payload.type;
            if ('department' in payload) displayDept = payload.department;
            if ('occupant' in payload) displayOccupant = payload.occupant;
          }
        });
        setRoomEditIncluded(new Set(targets.map((t) => t.roomId || String(t.revitId ?? ''))));
        setRoomEditOpen(true);
      };
      const handleClearSelection = () => {
        roomEditSelectionRef.current = [];
        setRoomEditSelection([]);
        applySelectionHighlight([]);
        try {
          popup.remove();
        } catch {}
      };

      function attachReadOnlyEvents() {
        const el = popup.getElement();
        if (!el) return;
        el.querySelector('#mf-show-floor')?.addEventListener('click', handleShowFloor);
        if (canEditRoom) {
          el.querySelector('#mf-room-edit-btn')?.addEventListener('click', handleEdit);
          el.querySelector('#mf-clear-edit-selection')?.addEventListener('click', handleClearSelection);
        }
      }

      attachReadOnlyEvents();
    };

    const onStairsClick = (e) => {
      try {
        e.preventDefault?.();
        if (e.originalEvent) {
          e.originalEvent.preventDefault?.();
          e.originalEvent.stopPropagation?.();
          e.originalEvent.cancelBubble = true;
        }
      } catch {}

      const f = e.features?.[0];
      if (!f) return;

      const p = f.properties || {};
      new mapboxgl.Popup({ closeOnClick: false, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="mf-popup">
            <div style="font-weight:700;margin-bottom:4px;">Stairs</div>
            <div><b>Level:</b> ${p.Level || '-'}</div>
            <div><b>Type:</b> ${p.Type || '-'}</div>
            <div><b>RevitId:</b> ${p.RevitId || '-'}</div>
          </div>
        `)
        .addTo(map);
    };

    const onDoorsClick = (e) => {
      try {
        e.preventDefault?.();
        if (e.originalEvent) {
          e.originalEvent.preventDefault?.();
          e.originalEvent.stopPropagation?.();
          e.originalEvent.cancelBubble = true;
        }
      } catch {}

      const f = e.features?.[0];
      if (!f) return;

      const p = f.properties || {};
      new mapboxgl.Popup({ closeOnClick: false, maxWidth: '280px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="mf-popup">
            <div style="font-weight:700;margin-bottom:4px;">Door</div>
            <div><b>Level:</b> ${p.Level || '-'}</div>
            <div><b>Mark:</b> ${p.Mark || p.mark || '-'}</div>
            <div><b>Type:</b> ${p.Type || '-'}</div>
            <div><b>RevitId:</b> ${p.RevitId || '-'}</div>
          </div>
        `)
        .addTo(map);
    };

    const onEnter = () => { try { map.getCanvas().style.cursor = 'pointer'; } catch {} };
    const onLeave = () => { try { map.getCanvas().style.cursor = ''; } catch {} };

    map.on('click', FLOOR_FILL_ID, onFloorClick);
    map.on('mouseenter', FLOOR_FILL_ID, onEnter);
    map.on('mouseleave', FLOOR_FILL_ID, onLeave);
    map.on('click', DOORS_LAYER, onDoorsClick);
    map.on('mouseenter', DOORS_LAYER, onEnter);
    map.on('mouseleave', DOORS_LAYER, onLeave);
    map.on('click', STAIRS_LAYER, onStairsClick);
    map.on('mouseenter', STAIRS_LAYER, onEnter);
    map.on('mouseleave', STAIRS_LAYER, onLeave);

    return () => {
      try {
        map.off('click', FLOOR_FILL_ID, onFloorClick);
        map.off('mouseenter', FLOOR_FILL_ID, onEnter);
        map.off('mouseleave', FLOOR_FILL_ID, onLeave);
        map.off('click', DOORS_LAYER, onDoorsClick);
        map.off('mouseenter', DOORS_LAYER, onEnter);
        map.off('mouseleave', DOORS_LAYER, onLeave);
        map.off('click', STAIRS_LAYER, onStairsClick);
        map.off('mouseenter', STAIRS_LAYER, onEnter);
        map.off('mouseleave', STAIRS_LAYER, onLeave);
      } catch {}
      currentRoomFeatureRef.current = null;
    };
  }, [mapLoaded, floorUrl, selectedBuilding, selectedBuildingId, selectedFloor, showFloorStats, setMapView, setIsTechnicalPanelOpen, setIsBuildingPanelCollapsed, setPanelAnchor, panelStats, roomPatches, isAdminUser, authUser, universityId, resolveBuildingPlanKey, fetchBuildingSummary, fetchFloorSummaryByUrl, mapView, floorStatsByBuilding, moveScenarioMode, moveMode, pendingMove, setFloorHighlight, roomEditSelection, clearRoomEditSelection, applySelectionHighlight, getHighlightIdsForSelection]);

useEffect(() => {
  if (!mapLoaded || !mapRef.current) return;
  const map = mapRef.current;

  const onBackgroundClick = (e) => {
    const mapInstance = mapRef.current;
    if (!mapInstance) return;

    const selectedId = selectedBuildingIdRef.current;
    if (!selectedId) return;

    const hasFloorLayer = !!mapInstance.getLayer(FLOOR_FILL_ID);

    if (!hasFloorLayer) {
      showBuildingStats(selectedId);
      return;
    }

    const pt = e.point;
    const floorHits = mapInstance.queryRenderedFeatures(pt, { layers: [FLOOR_FILL_ID, DOORS_LAYER, STAIRS_LAYER] });
    if (floorHits && floorHits.length) return;

    const hasBuildingsLayer = !!mapInstance.getLayer('buildings-fill');
    if (!hasBuildingsLayer) return;

    const buildingHits = mapInstance.queryRenderedFeatures(pt, { layers: ['buildings-fill'] });
    const hitSelected = buildingHits?.some((f) => f.properties?.id === selectedId);
    if (hitSelected) {
      currentFloorUrlRef.current = null;
      showBuildingStats(selectedId);
    }
  };

  map.on('click', onBackgroundClick);
  return () => {
    try { map.off('click', onBackgroundClick); } catch {}
  };
}, [mapLoaded, showBuildingStats]);

  // TEMP: prevent crash until we wire real persistence
  const handleConditionSave = useCallback(() => {
    // no-op for now
  }, []);

  const handleExportBuilding = useCallback(async () => {
    const buildingKey = panelBuildingKeyRef.current || selectedBuildingId || selectedBuilding;
    if (!buildingKey) {
      alert('No building selected for export.');
      return;
    }
    if (!availableFloors.length) {
      alert('No floors available for export.');
      return;
    }
    const pages = [];
    for (const floorId of availableFloors) {
      const url = buildFloorUrl(buildingKey, floorId);
      if (!url) continue;
      const data = await fetchGeoJSON(url);
      const fc = toFeatureCollection(data);
      if (!fc?.features?.length) continue;
      const img = generateFloorplanImageData({ fc, colorMode: floorColorMode, solidFill: true });
      if (!img) continue;
      pages.push({ img, label: `${activeBuildingName} - ${floorId}` });
    }
    if (!pages.length) {
      alert('No floorplans could be rendered for export.');
      return;
    }
    const buildingKeyDepts = toKeyDeptList(buildingStats?.totalsByDept);
    const statsForExport = {
      totalSF: buildingStats?.totalSf,
      rooms: buildingStats?.rooms,
      classroomSf: buildingStats?.classroomSf,
      classroomCount: buildingStats?.classroomCount,
      levels: availableFloors.length
    };
    const filenameBase = `${(activeBuildingName || buildingKey).replace(/\s+/g, '-').toLowerCase()}-floors`;
    exportFloorplanDocument(pages, {
      filenameBase,
      stats: statsForExport,
      keyDepts: buildingKeyDepts,
      summaryLabel: `${activeBuildingName} Floors`
    });
  }, [availableFloors, activeBuildingName, buildFloorUrl, exportFloorplanDocument, selectedBuilding, selectedBuildingId]);

  return (
  <div className="map-page-container">
    {/* Height chain wrappers to ensure container gets height */}
    <div className="page">
      <div className="map-wrapper">
        {/* Ensure non-zero size to avoid Mapbox init crashes (see CSS .map-container) */}
        <div ref={mapContainerRef} className="map-container" />
      </div>
    </div>

    {mode === 'admin' && (
      <button className="controls-toggle-button" onClick={() => setIsControlsVisible(v => !v)}>
        {isControlsVisible ? 'Hide Controls' : 'Show Controls'}
      </button>
    )}
    {askOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10002,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(520px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.4
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Ask Mapfluence</div>
              <div style={{ fontSize: 12, color: '#555' }}>Ask questions about loaded campus data.</div>
            </div>
            <button className="btn" onClick={() => setAskOpen(false)}>Close</button>
          </div>


          <div style={{ marginTop: 10 }}>
            <label style={{ fontWeight: 600, fontSize: 12 }}>Question</label>
            <textarea
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              rows={3}
              placeholder="e.g. How many vacant offices are on campus?"
              style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 8, border: '1px solid #d0d0d0', marginTop: 4 }}
            />
          </div>

          {askErr ? (
            <div style={{ color: 'crimson', marginTop: 6, fontSize: 12 }}>
              {askErr}
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button
              className="btn"
              disabled={askLoading || !askText.trim() || aiStatus !== 'ok'}
              onClick={onAskRun}
            >
              {askLoading ? 'Asking...' : 'Ask'}
            </button>
          </div>
        </div>
      </div>
    )}
    {askResult && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(720px, 94vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.45
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Ask Mapfluence</div>
            <button className="btn" onClick={() => setAskResult(null)}>Close</button>
          </div>

          <p style={{ marginTop: 10 }}>{askResult.answer}</p>

          {askResult.bullets?.length ? (
            <ul style={{ margin: '6px 0 10px 18px', padding: 0 }}>
              {askResult.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          ) : null}

          {askResult.resultType === 'table' && askResult.columns?.length && askResult.rows?.length ? (
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: '#f8f9fb' }}>
                  <tr>
                    {askResult.columns.map((col) => (
                      <th key={col} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e0e0e0' }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {askResult.rows.map((row, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      {askResult.columns.map((col) => (
                        <td key={col} style={{ padding: '6px 8px' }}>
                          {row && row[col] != null ? String(row[col]) : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {askResult.missingData?.length ? (
            <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
              Missing data: {askResult.missingData.join(', ')}
            </div>
          ) : null}
        </div>
      </div>
    )}

    <div className="logo-panel-right">
      <div className="logo-box">
        <div className="mapfluence-title">MAPFLUENCE</div>
        <img src={assetUrl('Clark_Enersen_Logo.png')} alt="Clark & Enersen Logo" />
      </div>
      <div className="logo-box">
        <img className="corner-brand" src={assetUrl('HC_image.png')} alt="Hastings College" />
      </div>
    </div>

    {showHelp && (
      <div className="help-panel">
        <button className="close-button" onClick={() => setShowHelp(false)}>X</button>
        <h4>How to Use This Map</h4>
        <ul>
          <li>Click on the map to add a marker.</li>
          {mode === 'admin' && (
            <>
              <li>Click on a building to select and update its condition.</li>
              <li>Use the controls to toggle markers.</li>
            </>
          )}
        </ul>
        <button className="close-button-main" onClick={() => setShowHelp(false)}>Close</button>
      </div>
    )}

    {mode === 'admin' && (
      <>
        {mapView === MAP_VIEWS.ASSESSMENT && selectedBuildingId && !isTechnicalPanelOpen && panelAnchor && (
          <div
            className="floating-panel"
            style={{
              position: 'absolute', zIndex: 10,
              left: Math.max(8, Math.min(panelAnchor.x + 12, (mapContainerRef.current?.clientWidth || 1000) - 360)),
              top: Math.max(8, Math.min(panelAnchor.y + 12, (mapContainerRef.current?.clientHeight || 800) - 260)),
              width: 340
            }}
          >
            <BuildingInteractionPanel
              buildingId={selectedBuildingId}
              buildingName={config?.buildings?.features?.find(f => f.properties.id === selectedBuildingId)?.properties?.name}
              currentCondition={buildingConditions[selectedBuildingId]}
              onSave={handleConditionSave}
              onOpenTechnical={() => setIsTechnicalPanelOpen(true)}
              onClose={() => {
                setSelectedBuildingId(null);
                setIsTechnicalPanelOpen(false);
                setPanelAnchor(null);
              }}
              canWrite={isAdminUser}
            />
          </div>
        )}

        {mapView === MAP_VIEWS.TECHNICAL && selectedBuildingId && isTechnicalPanelOpen && (
          <AssessmentPanel
            buildingId={selectedBuildingId}
            assessments={buildingAssessments}
            universityId={universityId}
            panelPos={panelAnchor}
            isAdminRole={isAdminUser}
            onClose={() => setIsTechnicalPanelOpen(false)}
            onSave={handleAssessmentSave}
          />
        )}
      </>
    )}

    {mode === 'admin' && mapView === MAP_VIEWS.SPACE_DATA && (selectedBuildingId || selectedBuilding) && !isBuildingPanelCollapsed && (() => {
      const containerWidth = mapContainerRef.current?.clientWidth || 1000;
      const containerHeight = mapContainerRef.current?.clientHeight || 800;
      const PANEL_WIDTH = 360;
      const PANEL_HEIGHT = 420;
      const margin = 16;
      const clamp = (val, min, max) => Math.max(min, Math.min(val, max));
      const panelWidth = Math.max(300, Math.min(PANEL_WIDTH, containerWidth - margin * 2));
      const sideMargin = margin + 40;
      const leftAligned = clamp(containerWidth - panelWidth - sideMargin, 12, containerWidth - panelWidth - 12);
      const anchoredTop = 12; // park the panel at the top-right over the logo area
      const anchor = panelAnchor || { x: leftAligned, y: containerHeight * 0.65 };
      const defaultTop = clamp(anchor.y, 8, containerHeight - PANEL_HEIGHT - 8);
      const safeLeft = leftAligned;
      const safeTop = defaultTop;
      const buildingFeature = selectedBuildingFeatureRef.current;
      let floorAnchor = null;
      if (buildingFeature && buildingFeature.geometry) {
        try {
          const bbox = turf.bbox(buildingFeature);
          if (bbox && bbox.length === 4 && bbox.every((v) => Number.isFinite(v))) {
            const centerY = (bbox[1] + bbox[3]) / 2;
            const screenPoint = mapRef.current?.project ? mapRef.current.project({ lng: bbox[2], lat: centerY }) : null;
            if (screenPoint) {
              const left = leftAligned;
              const top = clamp(screenPoint.y - PANEL_HEIGHT * 0.35, 8, containerHeight - PANEL_HEIGHT - 8);
              floorAnchor = { left, top };
            }
          }
        } catch {}
      }
      const buildingPanelStyle = {
        position: 'absolute',
        zIndex: 10,
        left: safeLeft,
        top: safeTop,
        width: panelWidth,
        maxHeight: '75vh',
        overflow: 'auto'
      };
      const floorPanelStyle = floorAnchor
        ? {
          position: 'absolute',
          zIndex: 10,
          left: Math.max(12, Math.min(floorAnchor.left, containerWidth - panelWidth - margin)),
          top: anchoredTop,
          width: panelWidth,
          maxHeight: '80vh',
          overflow: 'auto'
        }
        : buildingPanelStyle;
      const panelStyle = popupMode === 'floor' ? floorPanelStyle : buildingPanelStyle;
      return (
        <div className="floating-panel" style={panelStyle}>
          {popupMode === 'building' && (
            <BuildingPanel
              buildingName={activeBuildingName}
              stats={buildingStats}
              keyDepts={toKeyDeptList(buildingStats?.totalsByDept)}
              floors={availableFloors}
              selectedFloor={panelSelectedFloor}
              onChangeFloor={(fl) => setSelectedFloor(fl)}
              onLoadFloorplan={loadSelectedFloor}
              onExportCSV={() => exportSpaceCsv(activeBuildingName || selectedBuildingId || selectedBuilding)}
              onClose={() => {
                setIsBuildingPanelCollapsed(true);
                setSelectedBuildingId(null);
                setPanelAnchor(null);
                currentFloorUrlRef.current = null;
                panelBuildingKeyRef.current = null;
                selectedBuildingFeatureRef.current = null;
                setBuildingStats(null);
                setFloorStats(null);
                setPanelStats(null);
                setPopupMode('building');
              }}
              onExportPDF={handleExportBuilding}
              onExplainBuilding={onExplainBuilding}
              explainBuildingLoading={aiBuildingLoading}
              explainBuildingDisabled={aiStatus !== 'ok' || !buildingStats}
              explainBuildingError={aiBuildingErr}
            />
          )}
          {popupMode === 'floor' && (
            <FloorPanel
              buildingName={activeBuildingName}
              floorLabel={floorStats?.floorLabel || panelSelectedFloor}
              stats={floorStats}
              legendItems={floorLegendItems}
              legendTitle={
                {
                  department: 'Key Departments',
                  type: 'Key Types',
                  occupancy: 'Occupancy',
                  vacancy: 'Vacancy'
                }[floorColorMode] || 'Legend'
              }
              floors={availableFloors}
              selectedFloor={panelSelectedFloor}
              onChangeFloor={(fl) => setSelectedFloor(fl)}
              onLoadFloorplan={loadSelectedFloor}
              onUnloadFloorplan={handleUnloadFloorplan}
              onExportCSV={() => exportSpaceCsv(activeBuildingName || selectedBuildingId || selectedBuilding)}
              colorMode={floorColorMode}
              onChangeColorMode={(mode) => {
                setFloorColorMode(mode);
                applyFloorColorMode(mode);
              }}
              legendSelection={floorLegendSelection}
              onLegendClick={(name) => {
                const ids = floorLegendLookup.get(name) || [];
                setFloorLegendSelection((prev) => {
                  const next = prev === name ? null : name;
                  setFloorHighlight(next ? ids : null);
                  return next;
                });
              }}
              onClose={() => {
                setIsBuildingPanelCollapsed(true);
                setSelectedBuildingId(null);
                setPanelAnchor(null);
                currentFloorUrlRef.current = null;
                panelBuildingKeyRef.current = null;
                selectedBuildingFeatureRef.current = null;
                setBuildingStats(null);
                setFloorStats(null);
                setPanelStats(null);
                setPopupMode('building');
              }}
              onExportPDF={handleExportFloor}
              onExplainFloor={onExplain}
              explainLoading={aiLoading}
              explainDisabled={aiStatus !== 'ok' || !floorStats}
              explainError={aiErr}
              moveScenarioMode={moveScenarioMode}
              onToggleMoveScenarioMode={handleToggleMoveScenarioMode}
            />
          )}
        </div>
      );
    })()}

    {/* Move Scenario Summary Panel */}
    {moveScenarioMode && scenarioPanelVisible && (
      <div
        className="floating-panel"
        style={{
          position: 'absolute',
          zIndex: 15,
          right: 12,
          top: scenarioPanelTop,
          width: 320,
          maxHeight: '70vh',
          overflow: 'auto',
          background: '#fff',
          borderRadius: 10,
          boxShadow: '0 12px 24px rgba(0,0,0,0.2)',
          padding: 12,
          fontSize: 13
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>Move Scenario</div>
          <button
            className="btn"
            style={{ fontSize: 11, padding: '2px 6px' }}
            onClick={clearScenario}
          >
            Clear
          </button>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 2 }}>Scenario label (optional)</label>
          <input
            className="mf-input"
            value={scenarioLabel}
            onChange={(e) => setScenarioLabel(e.target.value)}
            placeholder="e.g. Art Dept to Hurley - Option A"
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div><b>Total SF:</b> {Math.round(scenarioTotals.totalSF).toLocaleString()}</div>
          <div><b>Rooms:</b> {scenarioTotals.rooms}</div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Rooms by Type</div>
          {combinedScenarioRoomStats.length === 0 ? (
            <div style={{ fontSize: 12, fontStyle: 'italic', color: '#666' }}>No rooms selected.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>SF</th>
                </tr>
              </thead>
              <tbody>
                {combinedScenarioRoomStats.map(({ type, count, sf }) => (
                  <tr key={type}>
                    <td>{type}</td>
                    <td style={{ textAlign: 'right' }}>{count}</td>
                    <td style={{ textAlign: 'right' }}>{Math.round(sf).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

       <div style={{ marginTop: 4 }}>
          <label style={{ fontSize: 12 }}>Scenario Department</label>
          <select
            className="mf-input"
            value={scenarioAssignedDept}
            onChange={(e) => setScenarioAssignedDept(e.target.value)}
          >
            <option value="">Choose department...</option>
            {deptOptions.map((dept) => (
              <option key={dept} value={dept}>{dept}</option>
            ))}
          </select>
          <button className="btn" style={{ marginTop: 6 }} onClick={assignDepartmentToSelection} disabled={!scenarioAssignedDept || scenarioSelection.size === 0}>
            Commit
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn"
            onClick={onCompareScenario}
            disabled={aiStatus !== 'ok' || aiScenarioLoading || !scenarioAssignedDept || !scenarioTotals}
            title={
              !scenarioAssignedDept
                ? 'Select a department for the scenario before comparing.'
                : !scenarioTotals
                  ? 'Enable Move Scenario Mode and create a scenario to compare.'
                  : 'Compare scenario vs current allocation for this department.'
            }
          >
            {aiScenarioLoading ? 'Comparing...' : '\u2728 Compare scenario vs current'}
          </button>
          {aiScenarioErr ? <div style={{ color: 'crimson', fontSize: 12 }}>{aiScenarioErr}</div> : null}
        </div>

        <button
          className="btn"
          style={{ width: '100%', marginTop: 6 }}
          onClick={async () => {
            try {
              const doc = new jsPDF('p', 'pt', 'letter');
              const pageWidth = doc.internal.pageSize.getWidth();
              const pageHeight = doc.internal.pageSize.getHeight();
              const margin = 20;
              const imgData = generateFloorplanImageData(currentFloorContextRef.current);
              let imageAdded = false;
              let imgWidth = 0;
              let imgHeight = 0;
              if (imgData) {
                const aspect = imgData.height && imgData.width ? imgData.height / imgData.width : 1;
                const maxImageWidth = Math.min(pageWidth * 0.55, pageWidth - margin * 3);
                const maxImageHeight = pageHeight - margin * 2;
                imgWidth = maxImageWidth;
                imgHeight = imgWidth * aspect;
                if (imgHeight > maxImageHeight) {
                  imgHeight = maxImageHeight;
                  imgWidth = imgHeight / (aspect || 1);
                }
                doc.addImage(imgData.data, 'PNG', margin, margin, imgWidth, imgHeight);
                imageAdded = true;
              }

              const scenarioTitle = 'Move Scenario';
              const summaryLabel = scenarioLabel || 'Move Scenario';
              const labelText = scenarioLabel?.trim() ? scenarioLabel.trim() : '';
              const textX = imageAdded ? imgWidth + margin * 2 : margin;
              const textWidth = pageWidth - textX - margin;
              const lineHeight = 16;
              let y = margin;
              doc.setFontSize(14);
              doc.text(scenarioTitle, textX, y);
              if (labelText) {
                doc.text(labelText, textX + textWidth, y, { align: 'right' });
              }
              y += lineHeight;
              doc.setFontSize(12);
              const addLine = (txt) => {
                doc.text(txt, textX, y, { maxWidth: textWidth });
                y += lineHeight;
              };
              const deptName = scenarioAssignedDept || 'None selected';
              const deptColor = getDeptColor(scenarioAssignedDept) || '#AAAAAA';
              const badgeSize = 14;
              doc.setDrawColor(0);
              doc.setFillColor(deptColor);
              doc.rect(textX, y, badgeSize, badgeSize, 'FD');
              const deptText = `Scenario Dept: ${deptName}`;
              doc.setTextColor('#000000');
              doc.setFont(undefined, 'bold');
              doc.text(deptText, textX + badgeSize + 6, y + badgeSize - 4, { maxWidth: textWidth - badgeSize - 6 });
              doc.setFont(undefined, 'normal');
              y += badgeSize + lineHeight / 2;
              doc.setFontSize(12);
              addLine(`Total SF: ${Math.round(scenarioTotals.totalSF).toLocaleString()}`);
              addLine(`Rooms: ${scenarioTotals.rooms}`);
              y += lineHeight / 2;
              doc.setFont(undefined, 'bold');
              doc.text('Rooms by Type', textX, y);
              y += lineHeight;
              const colQtyX = textX + textWidth * 0.65;
              const colSfX = textX + textWidth;
              doc.setFontSize(11);
              doc.text('Type', textX, y);
              doc.text('Qty', colQtyX, y, { align: 'right' });
              doc.text('SF', colSfX, y, { align: 'right' });
              y += lineHeight;
              doc.setFont(undefined, 'normal');
              if (!combinedScenarioRoomStats.length) {
                doc.text('No rooms selected.', textX, y);
                y += lineHeight;
              } else {
              const typeColWidth = Math.max(textWidth - 120, 100);
              combinedScenarioRoomStats.forEach(({ type, count, sf }) => {
                const roundedSf = Math.round(sf).toLocaleString();
                const typeLines = doc.splitTextToSize(type, typeColWidth);
                typeLines.forEach((line, idx) => {
                  doc.text(line, textX, y + idx * (lineHeight * 0.9));
                });
                doc.text(String(count), colQtyX, y, { align: 'right' });
                doc.text(roundedSf, colSfX, y, { align: 'right' });
                y += lineHeight * Math.max(1, typeLines.length * 0.9);
              });
              }
              doc.setFont(undefined, 'normal');
              doc.setFontSize(12);
              y += lineHeight / 4;
              const filename = `${(summaryLabel || 'move-scenario').replace(/\s+/g, '-').toLowerCase()}.pdf`;
              doc.save(filename);
            } catch (err) {
              console.error('Scenario export failed', err);
              alert('Export failed - see console for details.');
            }
          }}
        >
          Export Scenario (PDF)
        </button>
      </div>
    )}

    {isControlsVisible && (
      <div className="map-controls-panel" style={{ width: 270, fontSize: 12.5, lineHeight: 1.25 }}>
        <div className="map-controls">

          {/* Admin access - compact header layout */}
          {mode === 'admin' && (
            <div className="control-section" style={{ background: '#fff', padding: 6, border: '1px solid #ddd', borderRadius: 6, marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <h5 style={{ margin: 0, fontSize: 13 }}>Admin access</h5>
                {!authUser ? (
                  <button onClick={handleAdminSignIn}>Sign in with Google</button>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {authUser.email} {isAdminUser ? '(admin)' : '(no admin)'}
                    </span>
                    <button onClick={handleAdminSignOut}>Sign out</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Map View */}
          {mode === 'admin' && (
            <div className="control-section theme-selector" style={{ marginTop: 6 }}>
              <label htmlFor="theme-select" style={{ marginRight: 8 }}>Map View:</label>
              <select id="theme-select" value={mapView} onChange={(e) => setMapView(e.target.value)}>
                {MAP_VIEW_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}

          {mode === 'admin' && (
            <>
              <div
                className="floorplans-section"
                style={{
                  marginTop: 8,
                  padding: 6,
                  borderRadius: 8,
                  border: '1px solid rgba(0,0,0,0.25)',
                  background: 'linear-gradient(180deg, rgba(235,250,240,0.9), rgba(220,242,230,0.9))'
                }}
              >
                <h4 style={{ margin: '0 0 6px 0', fontSize: 12.5 }}>Floorplans</h4>

                <div className="floorplans" style={{ display: 'grid', gap: 6 }}>
                  <select
                    id="fp-building"
                    style={{ width: '100%' }}
                    value={selectedBuilding}
                    onChange={(e) => {
                      const newBldg = e.target.value;
                      setSelectedBuilding(newBldg);
                      setSelectedFloor(undefined);
                    }}
                  >
                    {BUILDINGS_LIST.map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>

                  <select
                    id="fp-floor"
                    style={{ width: '100%' }}
                    value={selectedFloor ?? ''}
                    onChange={(e) => setSelectedFloor(e.target.value)}
                    disabled={!availableFloors.length}
                  >
                    {availableFloors.map((fl) => (
                      <option key={fl} value={fl}>{fl}</option>
                    ))}
                  </select>

                  <button className="btn" style={{ width: '100%' }} onClick={handleLoadFloorplan} disabled={!availableFloors.length}>Load</button>
                  <button className="btn" style={{ width: '100%' }} onClick={handleUnloadFloorplan}>Unload</button>
                  <button className="btn" style={{ width: '100%' }} onClick={() => centerOnCurrentFloor(mapRef.current)}>Center</button>
                </div>

                <div style={{ marginTop: 8 }}>
                  <button
                    className="mf-btn"
                    style={{ width: '100%', fontWeight: 600 }}
                    onClick={handleToggleMoveScenarioMode}
                  >
                    Move Scenario Mode {moveScenarioMode ? 'ON' : 'OFF'}
                  </button>
                  {moveScenarioMode && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#555', textAlign: 'center' }}>
                      Click rooms to add/remove them from a what-if scenario. Real data is not changed.
                    </div>
                  )}
                </div>
              </div>

              <div
                className="floorplans-section"
                style={{
                  marginTop: 8,
                  padding: 6,
                  borderRadius: 8,
                  border: '1px solid rgba(0,0,0,0.25)',
                  background: 'linear-gradient(180deg, rgba(255,247,235,0.9), rgba(255,239,219,0.9))'
                }}
              >
                <h4 style={{ margin: '2px 0 4px 0', fontSize: 12.5 }}>Space Data Export (beta)</h4>
                <div style={{ display: 'grid', gap: 6 }}>
                  <select
                    style={{ width: '100%' }}
                    value={exportBuildingFilter}
                    onChange={(e) => setExportBuildingFilter(e.target.value)}
                  >
                    <option value="__all__">All buildings</option>
                    {BUILDINGS_LIST.map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                  <input
                    className="mf-input"
                    style={{ width: '100%' }}
                    placeholder="Filter department (optional)"
                    value={exportDeptFilter}
                    onChange={(e) => setExportDeptFilter(e.target.value)}
                  />
                  <select
                    style={{ width: '100%' }}
                    value={exportSpaceMode}
                    onChange={(e) => setExportSpaceMode(e.target.value)}
                  >
                    <option value="rooms">Room rows</option>
                    <option value="summary">Building summary</option>
                  </select>
                  <button
                    className="btn"
                    style={{ width: '100%' }}
                    onClick={() => exportSpaceCsv()}
                    disabled={exportingSpaceData}
                  >
                    {exportingSpaceData
                      ? 'Exporting...'
                      : exportSpaceMode === 'summary'
                        ? 'Export Summary CSV'
                        : 'Export Space CSV'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2, minHeight: 0 }}>
                  {exportSpaceMessage || (exportSpaceMode === 'summary'
                    ? 'Summary export adds a campus total (when exporting all buildings) plus one row per building.'
                    : '')}
                </div>
              </div>
            </>
          )}
          {/* Mode */}
          {/*
          <div className="mode-selector" style={{ marginTop: 8 }}>
            <button
              className={interactionMode === 'select' ? 'active' : ''}
              onClick={() => setInteractionMode('select')}
            >
              Select/Marker
            </button>
          </div>
          */}


            <div
              style={{
                marginTop: 4,
                padding: 6,
                borderRadius: 8,
                border: '1px solid rgba(0,0,0,0.25)',
                background: 'linear-gradient(180deg, rgba(240,246,255,0.94), rgba(228,238,255,0.94))',
                boxShadow: '0 2px 6px rgba(0,0,0,0.05)'
              }}
            >
            <style>{`@keyframes aiSparklePulse { 0% { transform: translateY(0); } 50% { transform: translateY(-1px); } 100% { transform: translateY(0); } }`}</style>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 800, letterSpacing: 0.2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
                  <span style={{ color: '#c62828', fontFamily: '\'Trebuchet MS\', \'Gill Sans\', \'Helvetica Neue\', Arial, sans-serif', fontWeight: 700 }}>
                    MAPFLUENCE
                  </span>
                  <span>AI</span>
                  <span
                    title="AI-generated summaries based on currently loaded space data."
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      marginLeft: 'auto',
                      padding: '2px 6px',
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                      border: '1px solid rgba(0,0,0,0.15)',
                      background: 'rgba(255,255,255,0.9)',
                      animation: aiStatus === 'ok' ? 'aiSparklePulse 2.8s ease-in-out infinite' : 'none'
                    }}
                  >
                    {"\u2728 AI Summary"}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span>Summaries from loaded space data</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 999,
                        border: '1px solid rgba(0,0,0,0.15)',
                        background: aiStatus === 'ok' ? 'rgba(0,255,0,0.10)' : 'rgba(255,0,0,0.08)'
                      }}
                      title={aiStatus === 'ok' ? 'AI server available' : 'AI server not reachable'}
                    >
                      {aiStatus === 'ok' ? 'Online' : 'Unavailable'}
                    </span>
                    <button
                      onClick={() => setAiInfoOpen(true)}
                      title="What Mapfluence AI is doing"
                      style={{
                        border: '1px solid rgba(0,0,0,0.15)',
                        borderRadius: 999,
                        background: 'white',
                        width: 18,
                        height: 18,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 10
                      }}
                      aria-label="What Mapfluence AI is doing"
                    >
                      ?
                    </button>
                  </span>
                </div>
              </div>

              <div style={{ display: 'none', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 999,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: aiStatus === 'ok' ? 'rgba(0,255,0,0.10)' : 'rgba(255,0,0,0.08)'
                  }}
                  title={aiStatus === 'ok' ? 'AI server available' : 'AI server not reachable'}
                >
                  {aiStatus === 'ok' ? 'Online' : 'Unavailable'}
                </span>
                <button
                  onClick={() => setAiInfoOpen(true)}
                  title="What Mapfluence AI is doing"
                  style={{
                    border: '1px solid rgba(0,0,0,0.15)',
                    borderRadius: 999,
                    background: 'white',
                    width: 20,
                    height: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: 11,
                    marginTop: 2
                  }}
                  aria-label="What Mapfluence AI is doing"
                >
                  i
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
              <button
                style={{ padding: '5px 7px', fontSize: 11 }}
                disabled={aiStatus !== 'ok' || !floorStats || aiLoading}
                onClick={onExplain}
              >
                {aiLoading ? 'Explaining...' : '\u2728 Explain this floor'}
              </button>

              <button
                style={{ padding: '5px 7px', fontSize: 11 }}
                disabled={aiStatus !== 'ok' || !buildingStats || aiBuildingLoading}
                onClick={onExplainBuilding}
              >
                {aiBuildingLoading ? 'Explaining...' : '\u2728 Explain this building'}
              </button>

              <button
                style={{ padding: '5px 7px', fontSize: 11 }}
                disabled={aiStatus !== 'ok' || !campusStats || aiCampusLoading}
                onClick={onExplainCampus}
              >
                {aiCampusLoading ? 'Explaining...' : '\u2728 Explain campus'}
              </button>
            </div>

            <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              <button style={{ padding: '5px 7px', fontSize: 11 }} onClick={() => setAskOpen(true)}>
                {"\u2728 Ask Mapfluence"}
              </button>
            </div>

            <div style={{ marginTop: 6 }}>
              <button
                disabled={aiStatus !== 'ok'}
                onClick={() => setAiCreateScenarioOpen(true)}
                style={{ width: '100%', padding: '5px 7px', fontSize: 11 }}
              >
                {"\u2728 Create move scenario"}
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 11, opacity: 0.75, lineHeight: 1.35 }}>
              Results are descriptive and do not modify project data.
            </div>

            {(aiErr || aiBuildingErr || aiCampusErr) ? (
              <div style={{ marginTop: 8, color: 'crimson', fontSize: 12 }}>
                {aiErr || aiBuildingErr || aiCampusErr}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )}

    {mode === 'admin' && isControlsVisible && (
      <div
        style={{
          position: 'absolute',
          left: 20,
          bottom: 20,
          width: 270,
          borderRadius: 8,
          border: '1px solid rgba(0,0,0,0.25)',
          background: 'linear-gradient(180deg, rgba(245,245,245,0.96), rgba(230,230,230,0.96))',
          padding: 8,
          boxShadow: '0 2px 6px rgba(0,0,0,0.05)'
        }}
      >
        <h4 style={{ margin: '0 0 6px 0', fontSize: 12.5 }}>Data Filters</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          <button className="btn" onClick={exportData}>Export Map Data</button>
          <button className="btn" onClick={clearConditions}>Clear Conditions</button>
        </div>
      </div>
    )}

    {roomEditOpen && roomEditData && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10000,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.35)'
        }}
      >
        <div
          style={{
            width: 520,
            maxWidth: '90vw',
            background: '#fff',
            borderRadius: 14,
            padding: 16,
            boxShadow: '0 18px 36px rgba(0,0,0,0.2)'
          }}
        >
                <h4 style={{ margin: '0 0 12px 0' }}>
                  {roomEditTargets.length > 1
                    ? `Edit ${roomEditTargets.length} Rooms`
                    : `Edit Room ${roomEditData.feature?.properties?.name || roomEditData.roomLabel || ''}`}
                </h4>

          {roomEditTargets.length > 1 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Selected Rooms</div>
              <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #e5e5e5', borderRadius: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#f9f9f9', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={{ padding: '6px 8px', width: 40, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={roomEditIncluded.size === roomEditTargets.length}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? new Set(roomEditTargets.map((t) => t.roomId || String(t.revitId ?? '')))
                              : new Set();
                            setRoomEditIncluded(next);
                          }}
                        />
                      </th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Room</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Area (SF)</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Department</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roomEditTargets.map((t) => {
                      const key = t.roomId || String(t.revitId ?? '');
                      const checked = roomEditIncluded.has(key);
                      const areaVal = Number.isFinite(t.properties?.area) ? Math.round(t.properties.area) : '';
                      return (
                        <tr key={key} style={{ borderTop: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setRoomEditIncluded((prev) => {
                                  const next = new Set(prev || []);
                                  if (e.target.checked) next.add(key);
                                  else next.delete(key);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td style={{ padding: '6px 8px', fontWeight: 600 }}>{t.roomLabel || t.feature?.properties?.name || key}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {areaVal ? areaVal.toLocaleString() : ''}
                          </td>
                          <td style={{ padding: '6px 8px' }}>{t.properties?.department || t.feature?.properties?.department || ''}</td>
                          <td style={{ padding: '6px 8px' }}>{t.properties?.type || t.feature?.properties?.type || ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <ComboInput
            label="Type"
            value={roomEditData.properties?.type ?? roomEditData.feature?.properties?.type ?? ''}
            onChange={(val) =>
              setRoomEditData((prev) => (prev ? ({ ...prev, properties: { ...prev.properties, type: val } }) : prev))
            }
            options={typeOptions}
            placeholder="Search or choose a type..."
          />

          <ComboInput
            label="Department"
            value={roomEditData.properties?.department ?? roomEditData.feature?.properties?.department ?? ''}
            onChange={(val) =>
              setRoomEditData((prev) => (prev ? ({ ...prev, properties: { ...prev.properties, department: val } }) : prev))
            }
            options={deptOptions}
            placeholder="Search or choose a department..."
          />

          <div className="mf-form-row">
            <label>Area (SF)</label>
            <input
              className="mf-input"
              value={roomEditData.properties?.area ?? ''}
              disabled
              readOnly
            />
          </div>

          {editHasTeaching && (
            <div className="mf-form-row">
              <label>Seat Count</label>
              <input
                className="mf-input"
                value={editSeatCountDisplay}
                readOnly
                disabled
              />
            </div>
          )}

          {editHasOffice && (
            <div className="mf-form-row">
              <label>Occupant</label>
              <input
                className="mf-input"
                value={roomEditData.properties?.occupant ?? ''}
                onChange={(e) =>
                  setRoomEditData((prev) => (prev ? ({ ...prev, properties: { ...prev.properties, occupant: e.target.value } }) : prev))
                }
              />
            </div>
          )}

          <div className="mf-form-row">
            <label>Comments</label>
            <textarea
              className="mf-input"
              rows={3}
              value={roomEditData.properties?.comments ?? ''}
              onChange={(e) =>
                setRoomEditData((prev) => (prev ? ({ ...prev, properties: { ...prev.properties, comments: e.target.value } }) : prev))
              }
            />
          </div>

        <div className="mf-actions">
          <button className="btn" onClick={closeRoomEdit}>Cancel</button>
          <button
            className="btn"
            onClick={async () => {
                const includedKeys = roomEditIncluded;
                const targets = roomEditTargets.length
                  ? roomEditTargets.filter((t) => includedKeys.has(t.roomId || String(t.revitId ?? '')))
                  : [];
                if (!targets.length) return;
                let savedCount = 0;
                const sharedProps = roomEditData.properties || {};
                const mapRefCurrent = mapRef.current;
                const src = mapRefCurrent?.getSource(FLOOR_SOURCE);
                const sourceData = src ? (src._data || src.serialize?.().data || null) : null;
                const patchedFeatures = sourceData ? (toFeatureCollection(sourceData)?.features || []) : [];
                for (const tgt of targets) {
                  const fallbackProps = {
                    type: tgt.properties?.type ?? tgt.feature?.properties?.type ?? '',
                    department: tgt.properties?.department ?? tgt.feature?.properties?.department ?? '',
                    occupant: tgt.properties?.occupant ?? tgt.feature?.properties?.occupant ?? '',
                    comments: tgt.properties?.comments ?? tgt.feature?.properties?.comments ?? ''
                  };
                  const propsForTarget = {
                    ...tgt.properties,
                    ...sharedProps,
                    type:
                      sharedProps.type != null && String(sharedProps.type).trim() !== ''
                        ? sharedProps.type
                        : fallbackProps.type,
                    department:
                      sharedProps.department != null && String(sharedProps.department).trim() !== ''
                        ? sharedProps.department
                        : fallbackProps.department
                  };
                  const saved = await saveRoomEdits({
                    roomId: tgt.roomId,
                    buildingId: tgt.buildingId,
                    floorName: tgt.floorName,
                    revitId: tgt.revitId,
                    properties: propsForTarget
                  });
                  if (saved) {
                    savedCount += 1;
                    if (patchedFeatures.length) {
                      const fid = tgt.revitId ?? tgt.feature?.id ?? tgt.feature?.properties?.RevitId ?? null;
                      if (fid != null) {
                        const feat = patchedFeatures.find((f) => (f.id ?? f.properties?.RevitId) === fid);
                        if (feat && feat.properties) {
                          feat.properties.department = propsForTarget.department ?? feat.properties.department;
                          feat.properties.department = feat.properties.department || propsForTarget.department || '';
                          feat.properties.Department = feat.properties.department;
                          feat.properties.type = propsForTarget.type ?? feat.properties.type;
                          feat.properties.Type = feat.properties.type;
                          feat.properties.RoomType = feat.properties.type;
                          feat.properties.Occupant = propsForTarget.occupant ?? feat.properties.Occupant;
                          feat.properties.occupant = feat.properties.Occupant;
                        }
                      }
                    }
                  }
                }
                if (savedCount > 0) {
                  try {
                    if (src && patchedFeatures.length) {
                      const updatedFc = toFeatureCollection(sourceData) || { type: 'FeatureCollection', features: [] };
                      updatedFc.features = patchedFeatures;
                      src.setData(updatedFc);
                    }
                  } catch {}
                  roomEditData.refreshPopup?.();
                  clearRoomEditSelection();
                  closeRoomEdit();
                }
            }}
          >
            {roomEditTargets.length > 1 ? `Save ${roomEditTargets.length} Rooms` : 'Save'}
          </button>
        </div>
        </div>
      </div>
    )}
    {aiOpen && aiResult && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
          <div
            style={{
            width: 'min(760px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)'
          }}
          >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {aiResult.title && aiResult.title.includes('Summary')
                    ? aiResult.title
                    : `${aiResult.title || 'Level'} - Summary`}
                </div>
                <span
                  title="AI-generated summary based on currently loaded space data."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: '#f7f7ff'
                  }}
                >
                  {"\u2728 AI Summary"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>AI-assisted overview</div>
            </div>
            <button className="btn" onClick={() => setAiOpen(false)}>Close</button>
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.45 }}>
            {aiResult.summary ? <p style={{ margin: '6px 0 10px 0' }}>{aiResult.summary}</p> : null}
            <div>
              <h4 style={{ margin: '8px 0 4px 0' }}>Insights</h4>
              <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                {(aiResult.insights || []).map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
            {Array.isArray(aiResult.watchouts) && aiResult.watchouts.length ? (
              <div>
                <h4 style={{ margin: '8px 0 4px 0' }}>Watchouts</h4>
                <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                  {aiResult.watchouts.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            ) : null}
            {Array.isArray(aiResult.data_used) && aiResult.data_used.length ? (
              <small style={{ color: '#555' }}>Data used: {aiResult.data_used.join(', ')}</small>
            ) : null}
            <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
              AI summaries reflect available data at the time of generation.
            </div>
          </div>
        </div>
      </div>
    )}
    {aiBuildingOpen && aiBuildingResult && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(760px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {aiBuildingResult.title && aiBuildingResult.title.includes('Summary')
                    ? aiBuildingResult.title
                    : `${aiBuildingResult.title || 'Building'} - Summary`}
                </div>
                <span
                  title="AI-generated summary based on currently loaded space data."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: '#f7f7ff'
                  }}
                >
                  {"\u2728 AI Summary"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>AI-assisted overview</div>
            </div>
            <button className="btn" onClick={() => setAiBuildingOpen(false)}>Close</button>
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.45 }}>
            {aiBuildingResult.summary ? <p style={{ margin: '6px 0 10px 0' }}>{aiBuildingResult.summary}</p> : null}
            <div>
              <h4 style={{ margin: '8px 0 4px 0' }}>Insights</h4>
              <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                {(aiBuildingResult.insights || []).map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
            {Array.isArray(aiBuildingResult.watchouts) && aiBuildingResult.watchouts.length ? (
              <div>
                <h4 style={{ margin: '8px 0 4px 0' }}>Watchouts</h4>
                <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                  {aiBuildingResult.watchouts.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            ) : null}
            {Array.isArray(aiBuildingResult.data_used) && aiBuildingResult.data_used.length ? (
              <small style={{ color: '#555' }}>Data used: {aiBuildingResult.data_used.join(', ')}</small>
            ) : null}
            <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
              AI summaries reflect available data at the time of generation.
            </div>
          </div>
        </div>
      </div>
    )}
    {aiCampusOpen && aiCampusResult && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(760px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {aiCampusResult.title && aiCampusResult.title.includes('Summary')
                    ? aiCampusResult.title
                    : `${aiCampusResult.title || activeUniversityName || 'Campus'} - Summary`}
                </div>
                <span
                  title="AI-generated summary based on currently loaded space data."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: '#f7f7ff'
                  }}
                >
                  {"\u2728 AI Summary"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>AI-assisted overview</div>
            </div>
            <button className="btn" onClick={() => setAiCampusOpen(false)}>Close</button>
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.45 }}>
            {aiCampusResult.summary ? <p style={{ margin: '6px 0 10px 0' }}>{aiCampusResult.summary}</p> : null}
            <div>
              <h4 style={{ margin: '8px 0 4px 0' }}>Insights</h4>
              <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                {(aiCampusResult.insights || []).map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
            {Array.isArray(aiCampusResult.watchouts) && aiCampusResult.watchouts.length ? (
              <div>
                <h4 style={{ margin: '8px 0 4px 0' }}>Watchouts</h4>
                <ul style={{ margin: '0 0 10px 18px', padding: 0 }}>
                  {aiCampusResult.watchouts.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            ) : null}
            {Array.isArray(aiCampusResult.data_used) && aiCampusResult.data_used.length ? (
              <small style={{ color: '#555' }}>Data used: {aiCampusResult.data_used.join(', ')}</small>
            ) : null}
            <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
              AI summaries reflect available data at the time of generation.
            </div>
          </div>
        </div>
      </div>
    )}
    {aiScenarioOpen && aiScenarioResult && (() => {
      const rollupRoomTypeCounts = (roomTypes = {}) => {
        let offices = 0, classrooms = 0, labs = 0;

        for (const [label, qty] of Object.entries(roomTypes || {})) {
          const s = String(label || "").toLowerCase();
          const n = Number(qty || 0) || 0;

          if (s.includes("office")) offices += n;
          else if (s.includes("class")) classrooms += n;
          else if (s.includes("lab")) labs += n;
        }

        return { offices, classrooms, labs };
      };

      const b = scenarioBaselineTotals || {};
      const s = scenarioTotals || {};

      const bCounts = rollupRoomTypeCounts(b.roomTypes);
      const sCounts = rollupRoomTypeCounts(s.roomTypes);

      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.45)'
          }}
        >
          <div
            style={{
              width: 'min(760px, 92vw)',
              background: '#fff',
              borderRadius: 12,
              padding: 16,
              boxShadow: '0 22px 44px rgba(0,0,0,0.25)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <b>
                {`${scenarioAssignedDept || 'Scenario'} - ${scenarioBaselineTotals?.__label || 'baseline'} to ${activeBuildingName || 'scenario'}${selectedFloor ? ` (${selectedFloor})` : ''}`}
              </b>
              <button onClick={() => setAiScenarioOpen(false)}>Close</button>
            </div>

            <p style={{ marginTop: 10 }}>{aiScenarioResult.summary}</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
              <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Baseline (Current)
                </div>
                <div style={{ fontSize: 13 }}>SF: {Math.round(scenarioBaselineTotals?.totalSF || 0).toLocaleString()}</div>
                <div style={{ fontSize: 13 }}>Rooms: {Math.round(scenarioBaselineTotals?.rooms || 0).toLocaleString()}</div>
                {(bCounts.offices || bCounts.classrooms || bCounts.labs) ? (
                  <>
                    <div style={{ fontSize: 13 }}>Offices: {bCounts.offices}</div>
                    <div style={{ fontSize: 13 }}>Classrooms: {bCounts.classrooms}</div>
                    <div style={{ fontSize: 13 }}>Labs: {bCounts.labs}</div>
                  </>
                ) : null}
              </div>
              <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Scenario ({aiScenarioResult?.scenarioDept || scenarioAssignedDept || 'Selected Dept'})
                </div>
                <div style={{ fontSize: 13 }}>SF: {Math.round(scenarioTotals?.totalSF || 0).toLocaleString()}</div>
                <div style={{ fontSize: 13 }}>Rooms: {Math.round(scenarioTotals?.rooms || 0).toLocaleString()}</div>
                {(sCounts.offices || sCounts.classrooms || sCounts.labs) ? (
                  <>
                    <div style={{ fontSize: 13 }}>Offices: {sCounts.offices}</div>
                    <div style={{ fontSize: 13 }}>Classrooms: {sCounts.classrooms}</div>
                    <div style={{ fontSize: 13 }}>Labs: {sCounts.labs}</div>
                  </>
                ) : null}
              </div>
            </div>

            <b>{`Scenario - ${aiScenarioResult?.scenarioDept || scenarioAssignedDept || 'Selected Dept'}`}</b>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
              <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Pluses</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(aiScenarioResult?.scenarioPros || []).map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>

              <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Minuses</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(aiScenarioResult?.scenarioCons || []).map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            </div>

            {(aiScenarioResult.risks?.length) ? (
              <>
                <b>Risks / watchouts</b>
                <ul>
                  {aiScenarioResult.risks.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </>
            ) : null}

            {(aiScenarioResult.notes?.length) ? (
              <>
                <b>Notes</b>
                <ul>
                  {aiScenarioResult.notes.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      );
    })()}
    {aiCreateScenarioOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10002,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(560px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.4
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Create move scenario (AI)</div>
              <div style={{ fontSize: 12, color: '#555' }}>Uses campus-wide room inventory to suggest candidates.</div>
            </div>
            <button className="btn" onClick={() => setAiCreateScenarioOpen(false)}>Close</button>
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={{ fontWeight: 600, fontSize: 12 }}>Request</label>
              <textarea
                value={aiCreateScenarioText}
                onChange={(e) => setAiCreateScenarioText(e.target.value)}
                rows={3}
                placeholder="e.g. Find a new home for Physics; move the Art department to the Gray Center."
                style={{ width: '100%', resize: 'vertical', padding: 8, borderRadius: 8, border: '1px solid #d0d0d0', marginTop: 4 }}
              />
          </div>

          {aiCreateScenarioErr ? (
            <div style={{ color: 'crimson', marginTop: 6, fontSize: 12 }}>
              {aiCreateScenarioErr}
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button
              className="btn"
              disabled={aiCreateScenarioLoading || !aiCreateScenarioText.trim() || aiStatus !== 'ok'}
              onClick={onCreateMoveScenario}
            >
              {aiCreateScenarioLoading ? 'Planning...' : 'Create move scenario'}
            </button>
          </div>
        </div>
      </div>
    )}
    {aiCreateScenarioResult && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(820px, 94vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.45
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{aiCreateScenarioResult.title || 'Move scenario plan'}</div>
              {aiCreateScenarioResult.interpretedIntent ? (
                <div style={{ fontSize: 12, color: '#555' }}>{aiCreateScenarioResult.interpretedIntent}</div>
              ) : null}
            </div>
            <button className="btn" onClick={() => setAiCreateScenarioResult(null)}>Close</button>
          </div>

          {aiCreateScenarioResult.selectionCriteria?.length ? (
            <div style={{ marginTop: 10 }}>
              <b>Selection criteria</b>
              <ul style={{ margin: '6px 0 10px 18px', padding: 0 }}>
                {aiCreateScenarioResult.selectionCriteria.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ) : null}

          <div style={{ marginTop: 10 }}>
            <b>Recommended candidates</b>
            {aiCreateScenarioResult.recommendedCandidates?.length ? (
              <div style={{ marginTop: 6, border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 8px', background: '#f8f9fb' }}>
                  <button className="btn" onClick={applyAiMoveCandidatesToScenario}>
                    Select these rooms in Move Scenario
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 3fr', background: '#f8f9fb', padding: '6px 8px', fontWeight: 600, fontSize: 12 }}>
                  <div>Location</div>
                  <div>Room</div>
                  <div style={{ textAlign: 'right' }}>SF</div>
                  <div style={{ textAlign: 'right' }}>Vacancy</div>
                  <div>Rationale</div>
                </div>
                <div>
                  {aiCreateScenarioResult.recommendedCandidates.map((c, i) => (
                    <div
                      key={c.id || i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr 1fr 1fr 3fr',
                        padding: '6px 8px',
                        borderTop: '1px solid #f0f0f0',
                        fontSize: 12
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{c.buildingLabel || 'Building'}</div>
                        <div style={{ opacity: 0.75 }}>{c.floorId || ''}</div>
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{c.roomLabel || 'Room'}</div>
                        <div style={{ opacity: 0.75 }}>{c.type || 'Unspecified'}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>{Math.round(Number(c.sf || 0)).toLocaleString()}</div>
                      <div style={{ textAlign: 'right' }}>{c.vacancy || (c.occupant ? 'Occupied' : 'Vacant')}</div>
                      <div>{c.rationale || ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>No candidates returned.</div>
            )}
          </div>

          {aiCreateScenarioResult.assumptions?.length ? (
            <div style={{ marginTop: 10 }}>
              <b>Assumptions</b>
              <ul style={{ margin: '6px 0 10px 18px', padding: 0 }}>
                {aiCreateScenarioResult.assumptions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ) : null}

          {aiCreateScenarioResult.nextSteps?.length ? (
            <div style={{ marginTop: 10 }}>
              <b>Next steps</b>
              <ul style={{ margin: '6px 0 10px 18px', padding: 0 }}>
                {aiCreateScenarioResult.nextSteps.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    )}
    {aiInfoOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10002,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 'min(520px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.5,
            fontSize: 13
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>What Mapfluence AI is doing</div>
            <button className="btn" onClick={() => setAiInfoOpen(false)}>Close</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>What Mapfluence AI is doing</div>
            <ul style={{ paddingLeft: 18, margin: '0 0 10px 0' }}>
              <li>Generates summaries and comparisons from the statistics currently loaded in this session.</li>
              <li>Uses your selected scope (campus / building / floor) and scenario totals when available.</li>
              <li>Produces descriptive output and does not modify project data.</li>
            </ul>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>What Mapfluence AI is not doing</div>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              <li>Not writing to the database automatically.</li>
              <li>Not making final planning decisions.</li>
              <li>Not inventing missing data; it will note what's unavailable.</li>
            </ul>
          </div>
        </div>
      </div>
    )}
    {moveConfirmData && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10001,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          style={{
            width: 480,
            maxWidth: '90vw',
            background: '#fff',
            borderRadius: 14,
            padding: 18,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)'
          }}
        >
          <h4 style={{ margin: '0 0 10px 0' }}>Confirm Move</h4>
          <div style={{ fontSize: 13, color: '#333', marginBottom: 10 }}>
            {`Move ${moveConfirmData.person || moveConfirmData.from?.occupantName || '-'} from ${moveConfirmData.from?.buildingId || ''} ${moveConfirmData.from?.roomLabel || '-'} to ${moveConfirmData.to?.buildingId || ''} ${moveConfirmData.to?.roomLabel || '-'}.`}
          </div>

          <div className="mf-form-row">
            <label>Person</label>
            <input
              className="mf-input"
              value={moveConfirmData.person || ''}
              onChange={(e) =>
                setMoveConfirmData((prev) => (prev ? ({ ...prev, person: e.target.value }) : prev))
              }
            />
          </div>

          <div className="mf-form-row">
            <label>Effective Date</label>
            <input
              className="mf-input"
              type="date"
              value={moveConfirmData.effectiveDate || ''}
              onChange={(e) =>
                setMoveConfirmData((prev) => (prev ? ({ ...prev, effectiveDate: e.target.value }) : prev))
              }
            />
          </div>

          <div className="mf-form-row">
            <label>Comments</label>
            <textarea
              className="mf-input"
              rows={3}
              value={moveConfirmData.comments || ''}
              onChange={(e) =>
                setMoveConfirmData((prev) => (prev ? ({ ...prev, comments: e.target.value }) : prev))
              }
            />
          </div>

          <div className="mf-actions" style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={handleMoveCancel}>Cancel</button>
            <button className="btn" onClick={handleMoveConfirm}>Confirm move</button>
          </div>
        </div>
      </div>
    )}
  </div>
);

}

export default StakeholderMap;













