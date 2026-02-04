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
import SpaceDashboardPanel from './SpaceDashboardPanel.jsx';
import { computeSpaceDashboard } from '../dashboard/spaceDashboard';

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
    [
      'coalesce',
      ['feature-state', 'department'],
      ['get', 'department'],
      ['get', 'Department'],
      ['get', 'Dept'],
      ['get', 'NCES_Department'],
      ['get', 'NCES_Dept']
    ],
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
  if (String(name).trim().toLowerCase() === 'public corridor') return '#D9D9D9';
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

const clampValue = (value, min, max) => Math.max(min, Math.min(value, max));

const isInteractiveTarget = (target) => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));
};

const beginPanelDrag = (event, panelRef, setPos, boundsProvider) => {
  if (event.button !== 0) return;
  if (isInteractiveTarget(event.target)) return;
  const panelEl = panelRef.current;
  if (!panelEl || !boundsProvider) return;

  const bounds = boundsProvider();
  if (!bounds) return;

  event.preventDefault();
  event.stopPropagation();

  const panelRect = panelEl.getBoundingClientRect();
  const offsetX = event.clientX - panelRect.left;
  const offsetY = event.clientY - panelRect.top;
  const margin = 8;
  const prevUserSelect = document.body.style.userSelect;

  const updatePosition = (clientX, clientY) => {
    const rawLeft = clientX - bounds.left - offsetX;
    const rawTop = clientY - bounds.top - offsetY;
    const maxLeft = Math.max(margin, bounds.width - panelRect.width - margin);
    const maxTop = Math.max(margin, bounds.height - panelRect.height - margin);
    setPos({
      x: clampValue(rawLeft, margin, maxLeft),
      y: clampValue(rawTop, margin, maxTop)
    });
  };

  const handleMove = (moveEvent) => {
    updatePosition(moveEvent.clientX, moveEvent.clientY);
  };

  const handleUp = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleUp);
    document.body.style.userSelect = prevUserSelect;
  };

  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleUp);
};

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
    props["Room Type Description"] ||
    props.RoomTypeDescription ||
    props.roomTypeDescription ||
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
    props.seatCount ??
    props.SeatCount ??
    props['Seat Count'] ??
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
    const typeName = norm(getRoomTypeLabelFromProps(p));
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
  const hideDrawingLabel = labelOptions.hideDrawing === true;
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
      if (hideDrawingLabel && text.toLowerCase() === 'drawing') return;
      if (lines.length >= labelSettings.maxLines) return;
      lines.push(text);
    };
    pushLine(props?.Number ?? props?.RoomNumber ?? props?.number);
    pushLine(getRoomTypeLabelFromProps(props) || props?.Name);
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
    const typeName =
      props?.__roomType ||
      getRoomTypeLabelFromProps(props) ||
      props?.Name ||
      '';
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
    const fidNorm = normalizeId(
      feature?.id ??
      props?.RevitId ??
      props?.Revit_UniqueId ??
      props?.RevitUniqueId ??
      props?.Revit_UniqueID ??
      props?.['Revit Unique Id'] ??
      props?.['Room GUID'] ??
      props?.roomGuid ??
      props?.id
    );
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
  const roomTypeDesc =
    props['Room Type Description'] ??
    props.RoomTypeDescription ??
    props.roomTypeDescription;
  if (roomTypeDesc && String(roomTypeDesc).trim()) return String(roomTypeDesc).trim();
  const nces =
    props.NCES_Type ??
    props['NCES Type'] ??
    props['NCES Types'] ??
    props.NCES_Types ??
    props.nces_type ??
    props.ncesType;
  if (nces && String(nces).trim()) return String(nces).trim();
  const ncesDesc =
    props['NCES_Type Description_Sh'] ??
    props['NCES_Type Description'] ??
    props['NCES Type Description'] ??
    props['NCES_Type Description_Short'] ??
    props['NCES Type Description Short'];
  if (ncesDesc && String(ncesDesc).trim()) return String(ncesDesc).trim();
  return (
    props['Room Type'] ||
    props.RoomType ||
    props.RoomTypeName ||
    props.Type ||
    props.type ||
    props.Category ||
    props.category ||
    props.Name ||
    props['Room Name'] ||
    ''
  ).toString().trim();
};

function resolveNcesType(p = {}) {
  return (
    p.NCES_Type ??
    p['NCES Types'] ??
    p.NCES_Types ??
    p.nces_type ??
    p.ncesType ??
    ''
  ).toString().trim();
}

function resolveNcesDept(p = {}) {
  return (
    p.NCES_Department ??
    p['NCES_Department'] ??
    p.NCES_Dept ??
    p['NCES Dept'] ??
    p.department ??
    p.Department ??
    p.Dept ??
    ''
  ).toString().trim();
}

function resolveAreaSf(p = {}) {
  const v =
    p.Area_SF ??
    p['Area_SF'] ??
    p.area ??
    p.Area ??
    p.SF ??
    p['Area (SF)'] ??
    p.NetArea ??
    0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function applyRoomTypeLabel(fc) {
  if (!fc?.features?.length) return fc;
  const nextFeatures = fc.features.map((f) => {
    const props = f?.properties || {};
    if ('__roomType' in props) return f;
    const ncesType = resolveNcesType(props);
    const normalized = ncesType && String(ncesType).trim();
    if (!normalized) return f;
    return {
      ...f,
      properties: {
        ...props,
        __roomType: normalized
      }
    };
  });
  return { ...fc, features: nextFeatures };
}

function getAffineSignature(affine) {
  if (!affine) return null;
  const anchor = affine.anchor_feet || affine.anchorFeet || affine.anchor;
  const parts = [
    affine.target_lon ?? affine.targetLon,
    affine.target_lat ?? affine.targetLat,
    affine.rotation_deg_cw ?? affine.rotation_deg,
    affine.scale_deg_per_foot ?? affine.scale_deg_per_ft ?? affine.scale,
    Array.isArray(anchor) ? anchor.join(',') : ''
  ];
  return parts.map((v) => (v == null ? '' : String(v))).join('|');
}

const DRAWING_ALIGN_STORAGE_PREFIX = 'mfDrawingAlign:';
const drawingAlignCache = new Map();
const FLOORPLAN_ADJUST_STORAGE_PREFIX = 'mfFloorAdjust:';
const FLOORPLAN_ADJUST_URL_PREFIX = 'mfFloorAdjustUrl:';
const FLOORPLAN_ADJUST_FLOOR_PREFIX = 'mfFloorAdjustFloor:';
const floorAdjustCache = new Map();
const floorAdjustUrlCache = new Map();
const floorAdjustFloorCache = new Map();

function buildDrawingAlignKey(buildingLabel, floorId) {
  const key = canon(buildingLabel || '');
  const floorKey = fId(floorId || '');
  if (!key || !floorKey) return null;
  return `${DRAWING_ALIGN_STORAGE_PREFIX}${key}/${floorKey}`;
}

function buildFloorAdjustKey(buildingLabel, floorId) {
  const key = canon(buildingLabel || '');
  const floorKey = fId(floorId || '');
  if (!key || !floorKey) return null;
  return `${FLOORPLAN_ADJUST_STORAGE_PREFIX}${key}/${floorKey}`;
}

function buildFloorAdjustUrlKey(url) {
  const key = canon(url || '');
  if (!key) return null;
  return `${FLOORPLAN_ADJUST_URL_PREFIX}${key}`;
}

function buildFloorAdjustFloorKey(basePath, floorId) {
  const folder = basePath ? getBuildingFolderFromBasePath(basePath) : '';
  const key = canon(folder || basePath || '');
  const floorKey = fId(floorId || '');
  if (!key || !floorKey) return null;
  return `${FLOORPLAN_ADJUST_FLOOR_PREFIX}${key}/${floorKey}`;
}

function getDrawingAlignSignature(align) {
  if (!align) return null;
  const parts = [
    align.rotationDeg,
    align.scale,
    Array.isArray(align.pivot) ? align.pivot.join(',') : '',
    Array.isArray(align.target) ? align.target.join(',') : ''
  ];
  return parts.map((v) => (v == null ? '' : String(v))).join('|');
}

function loadDrawingAlign(buildingLabel, floorId) {
  const key = buildDrawingAlignKey(buildingLabel, floorId);
  if (!key) return null;
  if (drawingAlignCache.has(key)) return drawingAlignCache.get(key);
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.pivot) || !Array.isArray(parsed.target)) return null;
    drawingAlignCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function loadFloorAdjust(buildingLabel, floorId) {
  const key = buildFloorAdjustKey(buildingLabel, floorId);
  if (!key) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  if (floorAdjustCache.has(key)) return floorAdjustCache.get(key);
  if (typeof window === 'undefined' || !window.localStorage) {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
    const parsed = JSON.parse(raw);
    const rotationDeg = Number(parsed?.rotationDeg);
    const scale = Number(parsed?.scale);
    const translateMeters = Array.isArray(parsed?.translateMeters) ? parsed.translateMeters : [0, 0];
    const translateLngLat = Array.isArray(parsed?.translateLngLat) ? parsed.translateLngLat : null;
    const savedAt = Number(parsed?.savedAt);
    const pivot = Array.isArray(parsed?.pivot) ? parsed.pivot : null;
    const anchorLngLat = Array.isArray(parsed?.anchorLngLat) ? parsed.anchorLngLat : null;
    const safe = {
      rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : 0,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      translateMeters: [
        Number.isFinite(translateMeters[0]) ? translateMeters[0] : 0,
        Number.isFinite(translateMeters[1]) ? translateMeters[1] : 0
      ],
      translateLngLat: Array.isArray(translateLngLat)
        ? [
            Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
            Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
          ]
        : null,
      anchorLngLat: Array.isArray(anchorLngLat)
        ? [
            Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
            Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
          ]
        : null,
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
    };
    floorAdjustCache.set(key, safe);
    return safe;
  } catch {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
}

function loadFloorAdjustByUrl(url) {
  const key = buildFloorAdjustUrlKey(url);
  if (!key) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  if (floorAdjustUrlCache.has(key)) return floorAdjustUrlCache.get(key);
  if (typeof window === 'undefined' || !window.localStorage) {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
    const parsed = JSON.parse(raw);
    const rotationDeg = Number(parsed?.rotationDeg);
    const scale = Number(parsed?.scale);
    const translateMeters = Array.isArray(parsed?.translateMeters) ? parsed.translateMeters : [0, 0];
    const translateLngLat = Array.isArray(parsed?.translateLngLat) ? parsed.translateLngLat : null;
    const savedAt = Number(parsed?.savedAt);
    const pivot = Array.isArray(parsed?.pivot) ? parsed.pivot : null;
    const anchorLngLat = Array.isArray(parsed?.anchorLngLat) ? parsed.anchorLngLat : null;
    const safe = {
      rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : 0,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      translateMeters: [
        Number.isFinite(translateMeters[0]) ? translateMeters[0] : 0,
        Number.isFinite(translateMeters[1]) ? translateMeters[1] : 0
      ],
      translateLngLat: Array.isArray(translateLngLat)
        ? [
            Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
            Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
          ]
        : null,
      anchorLngLat: Array.isArray(anchorLngLat)
        ? [
            Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
            Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
          ]
        : null,
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
    };
    floorAdjustUrlCache.set(key, safe);
    return safe;
  } catch {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
}

function loadFloorAdjustByBasePath(basePath, floorId) {
  const key = buildFloorAdjustFloorKey(basePath, floorId);
  if (!key) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  if (floorAdjustFloorCache.has(key)) return floorAdjustFloorCache.get(key);
  if (typeof window === 'undefined' || !window.localStorage) {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
    const parsed = JSON.parse(raw);
    const rotationDeg = Number(parsed?.rotationDeg);
    const scale = Number(parsed?.scale);
    const translateMeters = Array.isArray(parsed?.translateMeters) ? parsed.translateMeters : [0, 0];
    const translateLngLat = Array.isArray(parsed?.translateLngLat) ? parsed.translateLngLat : null;
    const savedAt = Number(parsed?.savedAt);
    const pivot = Array.isArray(parsed?.pivot) ? parsed.pivot : null;
    const anchorLngLat = Array.isArray(parsed?.anchorLngLat) ? parsed.anchorLngLat : null;
    const safe = {
      rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : 0,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      translateMeters: [
        Number.isFinite(translateMeters[0]) ? translateMeters[0] : 0,
        Number.isFinite(translateMeters[1]) ? translateMeters[1] : 0
      ],
      translateLngLat: Array.isArray(translateLngLat)
        ? [
            Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
            Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
          ]
        : null,
      anchorLngLat: Array.isArray(anchorLngLat)
        ? [
            Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
            Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
          ]
        : null,
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
    };
    floorAdjustFloorCache.set(key, safe);
    return safe;
  } catch {
    return { rotationDeg: 0, scale: 1, translateMeters: [0, 0], savedAt: 0 };
  }
}

function saveDrawingAlign(buildingLabel, floorId, align) {
  const key = buildDrawingAlignKey(buildingLabel, floorId);
  if (!key || !align) return false;
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(align));
    drawingAlignCache.set(key, align);
    return true;
  } catch {
    return false;
  }
}

function saveFloorAdjust(buildingLabel, floorId, adjust) {
  const key = buildFloorAdjustKey(buildingLabel, floorId);
  if (!key || !adjust) return false;
  if (typeof window === 'undefined' || !window.localStorage) return false;
  const pivot = Array.isArray(adjust.pivot) ? adjust.pivot : null;
  const translateLngLat = Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : null;
  const anchorLngLat = Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat : null;
  const safe = {
    rotationDeg: Number.isFinite(adjust.rotationDeg) ? adjust.rotationDeg : 0,
    scale: Number.isFinite(adjust.scale) && adjust.scale > 0 ? adjust.scale : 1,
    translateMeters: Array.isArray(adjust.translateMeters)
      ? [
          Number.isFinite(adjust.translateMeters[0]) ? adjust.translateMeters[0] : 0,
          Number.isFinite(adjust.translateMeters[1]) ? adjust.translateMeters[1] : 0
        ]
      : [0, 0],
    translateLngLat: Array.isArray(translateLngLat)
      ? [
          Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
          Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
        ]
      : null,
    anchorLngLat: Array.isArray(anchorLngLat)
      ? [
          Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
          Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
        ]
      : null,
    savedAt: Date.now(),
    pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(safe));
    floorAdjustCache.set(key, safe);
    return true;
  } catch {
    return false;
  }
}

function saveFloorAdjustByUrl(url, adjust) {
  const key = buildFloorAdjustUrlKey(url);
  if (!key || !adjust) return false;
  if (typeof window === 'undefined' || !window.localStorage) return false;
  const pivot = Array.isArray(adjust.pivot) ? adjust.pivot : null;
  const translateLngLat = Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : null;
  const anchorLngLat = Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat : null;
  const safe = {
    rotationDeg: Number.isFinite(adjust.rotationDeg) ? adjust.rotationDeg : 0,
    scale: Number.isFinite(adjust.scale) && adjust.scale > 0 ? adjust.scale : 1,
    translateMeters: Array.isArray(adjust.translateMeters)
      ? [
          Number.isFinite(adjust.translateMeters[0]) ? adjust.translateMeters[0] : 0,
          Number.isFinite(adjust.translateMeters[1]) ? adjust.translateMeters[1] : 0
        ]
      : [0, 0],
    translateLngLat: Array.isArray(translateLngLat)
      ? [
          Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
          Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
        ]
      : null,
    anchorLngLat: Array.isArray(anchorLngLat)
      ? [
          Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
          Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
        ]
      : null,
    savedAt: Date.now(),
    pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(safe));
    floorAdjustUrlCache.set(key, safe);
    return true;
  } catch {
    return false;
  }
}

function saveFloorAdjustByBasePath(basePath, floorId, adjust) {
  const key = buildFloorAdjustFloorKey(basePath, floorId);
  if (!key || !adjust) return false;
  if (typeof window === 'undefined' || !window.localStorage) return false;
  const pivot = Array.isArray(adjust.pivot) ? adjust.pivot : null;
  const translateLngLat = Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : null;
  const anchorLngLat = Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat : null;
  const safe = {
    rotationDeg: Number.isFinite(adjust.rotationDeg) ? adjust.rotationDeg : 0,
    scale: Number.isFinite(adjust.scale) && adjust.scale > 0 ? adjust.scale : 1,
    translateMeters: Array.isArray(adjust.translateMeters)
      ? [
          Number.isFinite(adjust.translateMeters[0]) ? adjust.translateMeters[0] : 0,
          Number.isFinite(adjust.translateMeters[1]) ? adjust.translateMeters[1] : 0
        ]
      : [0, 0],
    translateLngLat: Array.isArray(translateLngLat)
      ? [
          Number.isFinite(translateLngLat[0]) ? translateLngLat[0] : 0,
          Number.isFinite(translateLngLat[1]) ? translateLngLat[1] : 0
        ]
      : null,
    anchorLngLat: Array.isArray(anchorLngLat)
      ? [
          Number.isFinite(anchorLngLat[0]) ? anchorLngLat[0] : 0,
          Number.isFinite(anchorLngLat[1]) ? anchorLngLat[1] : 0
        ]
      : null,
    savedAt: Date.now(),
    pivot: (Array.isArray(pivot) && pivot.length >= 2) ? pivot : null
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(safe));
    floorAdjustFloorCache.set(key, safe);
    return true;
  } catch {
    return false;
  }
}

function clearDrawingAlign(buildingLabel, floorId) {
  const key = buildDrawingAlignKey(buildingLabel, floorId);
  if (!key) return;
  drawingAlignCache.delete(key);
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.removeItem(key); } catch {}
}

function clearFloorAdjust(buildingLabel, floorId) {
  const key = buildFloorAdjustKey(buildingLabel, floorId);
  if (!key) return;
  floorAdjustCache.delete(key);
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.removeItem(key); } catch {}
}

function clearFloorAdjustByUrl(url) {
  const key = buildFloorAdjustUrlKey(url);
  if (!key) return;
  floorAdjustUrlCache.delete(key);
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.removeItem(key); } catch {}
}

function clearFloorAdjustByBasePath(basePath, floorId) {
  const key = buildFloorAdjustFloorKey(basePath, floorId);
  if (!key) return;
  floorAdjustFloorCache.delete(key);
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.removeItem(key); } catch {}
}

function applyDrawingAlignment(fc, align) {
  if (!fc?.features?.length || !align) return fc;
  const sig = getDrawingAlignSignature(align);
  if (sig && fc.__mfDrawingAlignSignature === sig) return fc;
  const pivot = Array.isArray(align.pivot) ? align.pivot : null;
  const target = Array.isArray(align.target) ? align.target : null;
  if (!pivot || !target) return fc;
  const scale = Number.isFinite(align.scale) ? align.scale : 1;
  const rotationDeg = Number.isFinite(align.rotationDeg) ? align.rotationDeg : 0;
  const theta = (rotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const [px, py] = pivot;
  const [tx, ty] = target;
  const transformPoint = (coords) => {
    const dx = coords[0] - px;
    const dy = coords[1] - py;
    const rx = (dx * cosT - dy * sinT) * scale;
    const ry = (dx * sinT + dy * cosT) * scale;
    return [tx + rx, ty + ry];
  };
  const nextFeatures = fc.features.map((f) => {
    if (!isDrawingFeature(f?.properties || {})) return f;
    if (!f?.geometry) return f;
    return {
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: mapCoords(f.geometry.coordinates, transformPoint)
      }
    };
  });
  const next = { ...fc, features: nextFeatures };
  if (sig) next.__mfDrawingAlignSignature = sig;
  return next;
}

function resolveDrawingAlignLabel({ buildingLabel, buildingId, floorBasePath, fitBuilding } = {}) {
  const raw =
    buildingLabel ||
    buildingId ||
    fitBuilding?.properties?.id ||
    fitBuilding?.properties?.name ||
    '';
  const resolved = resolveBuildingNameFromInput(raw) || raw;
  if (resolved) return resolved;
  if (floorBasePath) {
    const folder = getBuildingFolderFromBasePath(floorBasePath);
    if (folder) return BUILDING_FOLDER_TO_NAME?.[folder] || folder;
  }
  return '';
}

function resolveFloorAdjustLabel({ buildingLabel, buildingId, floorBasePath, fitBuilding } = {}) {
  const folder = floorBasePath ? getBuildingFolderFromBasePath(floorBasePath) : null;
  if (folder) return folder;
  return resolveDrawingAlignLabel({ buildingLabel, buildingId, floorBasePath, fitBuilding });
}

function getFloorAdjustSignature(adjust) {
  if (!adjust) return null;
  const parts = [
    adjust.rotationDeg,
    adjust.scale,
    Array.isArray(adjust.translateMeters) ? adjust.translateMeters.join(',') : '',
    Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat.join(',') : '',
    Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat.join(',') : ''
  ];
  return parts.map((v) => (v == null ? '' : String(v))).join('|');
}

function hasFloorAdjust(adjust) {
  if (!adjust) return false;
  return (
    Math.abs(adjust.rotationDeg || 0) > 1e-6 ||
    Math.abs((adjust.scale || 1) - 1) > 1e-6 ||
    Math.abs((adjust.translateMeters?.[0] || 0)) > 1e-6 ||
    Math.abs((adjust.translateMeters?.[1] || 0)) > 1e-6 ||
    Math.abs((adjust.translateLngLat?.[0] || 0)) > 1e-12 ||
    Math.abs((adjust.translateLngLat?.[1] || 0)) > 1e-12 ||
    Math.abs((adjust.anchorLngLat?.[0] || 0)) > 1e-12 ||
    Math.abs((adjust.anchorLngLat?.[1] || 0)) > 1e-12
  );
}

function pickLatestFloorAdjust({ base, url, label }) {
  const candidates = [
    { source: 'basePath', adjust: base },
    { source: 'url', adjust: url },
    { source: 'label', adjust: label }
  ].filter((c) => c.adjust);
  const withAdjust = candidates.filter((c) => hasFloorAdjust(c.adjust));
  if (withAdjust.length) {
    let best = null;
    for (const c of withAdjust) {
      const savedAt = Number(c.adjust?.savedAt) || 0;
      if (!best || savedAt > best.savedAt) {
        best = { ...c, savedAt };
      }
    }
    if (best) return best;
  }
  const labelCandidate = candidates.find((c) => c.source === 'label');
  return labelCandidate || candidates[0] || { source: 'label', adjust: null, savedAt: 0 };
}

function getFloorAdjustAnchorLngLat(fc) {
  if (!fc?.features?.length) return null;
  try {
    const coords = turf.centroid(fc)?.geometry?.coordinates || null;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
    return coords;
  } catch {
    return null;
  }
}

function applyFloorAdjustWithTransform(fc, adjust, fitTransform) {
  if (!fc?.features?.length || !adjust) return { fc, fitTransform };
  const sig = getFloorAdjustSignature(adjust);
  if (sig && fc.__mfUserAdjustSignature === sig) return { fc, fitTransform };
  const rotationDeg = Number.isFinite(adjust.rotationDeg) ? adjust.rotationDeg : 0;
  const scale = Number.isFinite(adjust.scale) ? adjust.scale : 1;
  const translateMeters = Array.isArray(adjust.translateMeters) ? adjust.translateMeters : [0, 0];
  const translateLngLat = Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : null;
  const anchorLngLat = Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat : null;
  let out = fc;
  const pivot =
    (Array.isArray(adjust.pivot) ? adjust.pivot : null) ||
    fitTransform?.scaleOrigin ||
    fitTransform?.rotationPivot ||
    turf.centroid(out)?.geometry?.coordinates ||
    null;
  if (Number.isFinite(scale) && Math.abs(scale - 1) > 1e-6 && pivot) {
    out = turf.transformScale(out, scale, { origin: pivot });
  }
  if (Number.isFinite(rotationDeg) && Math.abs(rotationDeg) > 1e-6 && pivot) {
    out = turf.transformRotate(out, rotationDeg, { pivot });
  }
  if (translateLngLat && (Math.abs(translateLngLat[0] || 0) > 1e-12 || Math.abs(translateLngLat[1] || 0) > 1e-12)) {
    out = applyNudgeLngLat(out, translateLngLat);
  } else if (translateMeters && (Math.abs(translateMeters[0] || 0) > 1e-6 || Math.abs(translateMeters[1] || 0) > 1e-6)) {
    out = applyNudgeMeters(out, translateMeters);
  }
  if (anchorLngLat && Number.isFinite(anchorLngLat[0]) && Number.isFinite(anchorLngLat[1])) {
    const currentAnchor = getFloorAdjustAnchorLngLat(out);
    if (currentAnchor) {
      const deltaLng = anchorLngLat[0] - currentAnchor[0];
      const deltaLat = anchorLngLat[1] - currentAnchor[1];
      if (Math.abs(deltaLng) > 1e-12 || Math.abs(deltaLat) > 1e-12) {
        out = applyNudgeLngLat(out, [deltaLng, deltaLat]);
      }
    }
  }
  if (out && typeof out === 'object') {
    out.__mfUserAdjustSignature = sig;
  }

  let nextTransform = fitTransform;
  if (Number.isFinite(scale) || Number.isFinite(rotationDeg) || Array.isArray(translateMeters)) {
    nextTransform = nextTransform || {
      rotationDeg: 0,
      rotationPivot: pivot,
      scale: 1,
      scaleOrigin: pivot,
      translateKm: 0,
      translateBearing: 0,
      nudgeMeters: [0, 0],
      refineRotationDeg: 0,
      refineRotationPivot: pivot
    };
    if (pivot) {
      if (!Array.isArray(nextTransform.rotationPivot)) nextTransform.rotationPivot = pivot;
      if (!Array.isArray(nextTransform.scaleOrigin)) nextTransform.scaleOrigin = pivot;
      if (!Array.isArray(nextTransform.refineRotationPivot)) nextTransform.refineRotationPivot = pivot;
    }
    if (Number.isFinite(scale) && Math.abs(scale - 1) > 1e-6) {
      nextTransform.scale = (Number.isFinite(nextTransform.scale) ? nextTransform.scale : 1) * scale;
    }
    if (Number.isFinite(rotationDeg) && Math.abs(rotationDeg) > 1e-6) {
      nextTransform.rotationDeg = (Number.isFinite(nextTransform.rotationDeg) ? nextTransform.rotationDeg : 0) + rotationDeg;
    }
    if (Array.isArray(translateMeters)) {
      const base = Array.isArray(nextTransform.nudgeMeters) ? nextTransform.nudgeMeters : [0, 0];
      nextTransform.nudgeMeters = [
        (Number(base[0]) || 0) + (Number(translateMeters[0]) || 0),
        (Number(base[1]) || 0) + (Number(translateMeters[1]) || 0)
      ];
    }
  }
  return { fc: out, fitTransform: nextTransform };
}

function isDrawingFeature(props = {}) {
  if (!props) return false;
  const type = String(props.type ?? props.Type ?? '').toLowerCase();
  if (type === 'drawing') return true;
  return props.interactive === false;
}

function snapToNearestVertex(feature, fallback) {
  if (!feature?.geometry || !Array.isArray(fallback)) return fallback;
  const pts = extractLngLatPairs(feature.geometry, 4000);
  if (!pts.length) return fallback;
  let best = fallback;
  let bestDist = Infinity;
  for (const [x, y] of pts) {
    const dx = x - fallback[0];
    const dy = y - fallback[1];
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = [x, y];
    }
  }
  return best;
}

function bboxFromCoords(coords, limit = 4000) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  const visit = (node) => {
    if (!Array.isArray(node) || count >= limit) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const x = node[0];
      const y = node[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      count += 1;
      return;
    }
    node.forEach(visit);
  };
  visit(coords);
  if (!count) return null;
  return { minX, minY, maxX, maxY };
}

function pruneDrawingOutsideRooms(fc, marginRatio = 0.12) {
  if (!fc?.features?.length) return fc;
  const rooms = fc.features.filter((f) => !isDrawingFeature(f?.properties || {}));
  if (!rooms.length) return fc;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const f of rooms) {
    const pts = extractLngLatPairs(f?.geometry, 4000);
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      count += 1;
    }
    if (count > 20000) break;
  }
  if (!count) return fc;
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const padX = spanX * marginRatio;
  const padY = spanY * marginRatio;
  const clipMinX = minX - padX;
  const clipMinY = minY - padY;
  const clipMaxX = maxX + padX;
  const clipMaxY = maxY + padY;
  const keep = [];
  for (const f of fc.features) {
    if (!isDrawingFeature(f?.properties || {})) {
      keep.push(f);
      continue;
    }
    const bbox = bboxFromCoords(f?.geometry?.coordinates, 4000);
    if (!bbox) continue;
    const intersects = !(bbox.maxX < clipMinX || bbox.minX > clipMaxX || bbox.maxY < clipMinY || bbox.minY > clipMaxY);
    if (intersects) keep.push(f);
  }
  return keep.length === fc.features.length ? fc : { ...fc, features: keep };
}

function findNearestVertexInFloor({ map, fc, isDrawing, screenPoint, maxPixels, maxPoints }) {
  if (!map || !fc?.features?.length || !screenPoint) return null;
  const radius = Number.isFinite(maxPixels) ? maxPixels : null;
  const limit = Number.isFinite(maxPoints) ? maxPoints : 8000;
  let best = null;
  let bestDist = Infinity;
  let count = 0;
  for (const f of fc.features) {
    const props = f?.properties || {};
    const drawing = isDrawingFeature(props);
    const geomType = f?.geometry?.type || '';
    const isLineGeom = geomType === 'LineString' || geomType === 'MultiLineString';
    const isDrawingCandidate = drawing || isLineGeom;
    if (isDrawing ? !isDrawingCandidate : isDrawingCandidate) continue;
    if (!f?.geometry) continue;
    const pts = extractLngLatPairs(f.geometry, Math.max(0, limit - count));
    count += pts.length;
    for (const [lng, lat] of pts) {
      const projected = map.project({ lng, lat });
      const dx = projected.x - screenPoint.x;
      const dy = projected.y - screenPoint.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = [lng, lat];
      }
    }
    if (count >= limit) break;
  }
  if (!best) return null;
  if (radius == null) return best;
  return bestDist <= radius * radius ? best : null;
}

function buildFitCandidate(fc) {
  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) return fc;
  const filtered = fc.features.filter((f) => !isDrawingFeature(f?.properties || {}));
  if (filtered.length === 0 || filtered.length === fc.features.length) return fc;
  return { ...fc, features: filtered, __mfFitCandidate: true };
}

const DRAWING_ALIGN_STEPS = [
  { key: 'roomA', label: 'Click room point A (rooms layer)' },
  { key: 'roomB', label: 'Click room point B (rooms layer)' },
  { key: 'drawingA', label: 'Click drawing point A (linework)' },
  { key: 'drawingB', label: 'Click drawing point B (linework)' }
];
const DRAWING_ALIGN_ROOM_RADIUS_PX = 40;
const DRAWING_ALIGN_DRAWING_RADIUS_PX = 140;
const DRAWING_ALIGN_POINT_LIMIT = 12000;

// Robust base for static assets in Vite (dev vs prod)
const PUBLIC_BASE = (import.meta.env && import.meta.env.BASE_URL) ? import.meta.env.BASE_URL : '/';
const assetUrl = (path) => `${PUBLIC_BASE}${path}`.replace(/\/{2,}/g, '/');
const FLOORPLAN_MANIFEST_URL = assetUrl('floorplans/manifest.json');
const DEFAULT_FLOORPLAN_CAMPUS = 'Hastings';
const DEBUG_OVERLAY_LOGS = false;
const ENABLE_DOOR_STAIR_OVERLAY = false;
const ROOMS_ONLY_FILTER = ['==', ['get', 'Element'], 'Room'];

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    if (ct.includes('text/html')) return null;
    const cleaned = text.replace(/^\uFEFF/, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
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
      const cleaned = text.replace(/^\uFEFF/, '');
      return JSON.parse(cleaned);
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
    out.__mfAffineSignature = getAffineSignature(affine);
  }
  return out;
}

function applyRotationOverride(fc, rotationDeg, pivot) {
  if (!fc || !Number.isFinite(rotationDeg) || Math.abs(rotationDeg) < 1e-6) return fc;
  if (fc.__mfRotationOverride === rotationDeg) return fc;
  try {
    const pivotCoords =
      (Array.isArray(pivot) && pivot.length >= 2)
        ? pivot
        : (pivot?.geometry?.coordinates || turf.centroid(fc)?.geometry?.coordinates || null);
    const rotated = turf.transformRotate(fc, rotationDeg, pivotCoords ? { pivot: pivotCoords } : undefined);
    if (rotated && typeof rotated === 'object') {
      rotated.__mfRotationOverride = rotationDeg;
      if (pivotCoords) rotated.__mfRotationPivot = pivotCoords;
      if (fc.__mfFitTransform) rotated.__mfFitTransform = fc.__mfFitTransform;
      if (fc.__mfFitted) rotated.__mfFitted = fc.__mfFitted;
      if (fc.__mfFittedBuilding) rotated.__mfFittedBuilding = fc.__mfFittedBuilding;
      if (fc.__mfAffineApplied) rotated.__mfAffineApplied = fc.__mfAffineApplied;
      return rotated;
    }
  } catch {}
  return fc;
}

function applyNudgeMeters(fc, nudgeMeters) {
  if (!fc || !Array.isArray(nudgeMeters) || nudgeMeters.length < 2) return fc;
  const eastMeters = Number(nudgeMeters[0]);
  const northMeters = Number(nudgeMeters[1]);
  let out = fc;
  if (Number.isFinite(eastMeters) && Math.abs(eastMeters) > 1e-6) {
    const distKm = Math.abs(eastMeters) / 1000;
    const bearing = eastMeters >= 0 ? 90 : 270;
    out = turf.transformTranslate(out, distKm, bearing, { units: 'kilometers' });
  }
  if (Number.isFinite(northMeters) && Math.abs(northMeters) > 1e-6) {
    const distKm = Math.abs(northMeters) / 1000;
    const bearing = northMeters >= 0 ? 0 : 180;
    out = turf.transformTranslate(out, distKm, bearing, { units: 'kilometers' });
  }
  return out;
}

function applyNudgeLngLat(fc, nudgeLngLat) {
  if (!fc || !Array.isArray(nudgeLngLat) || nudgeLngLat.length < 2) return fc;
  const deltaLng = Number(nudgeLngLat[0]);
  const deltaLat = Number(nudgeLngLat[1]);
  if (!Number.isFinite(deltaLng) && !Number.isFinite(deltaLat)) return fc;
  const translate = (coords) => [
    coords[0] + (Number.isFinite(deltaLng) ? deltaLng : 0),
    coords[1] + (Number.isFinite(deltaLat) ? deltaLat : 0)
  ];
  return {
    ...fc,
    features: (fc.features || []).map((f) => ({
      ...f,
      geometry: f.geometry ? { ...f.geometry, coordinates: mapCoords(f.geometry.coordinates, translate) } : f.geometry
    }))
  };
}

function applyFloorplanFitTransform(fc, transform) {
  if (!fc || !transform) return fc;
  if (fc.__mfFitTransformApplied) return fc;
  let out = fc;
  try {
    const {
      rotationDeg,
      rotationPivot,
      scale,
      scaleOrigin,
      translateKm,
      translateBearing,
      nudgeMeters,
      refineRotationDeg,
      refineRotationPivot
    } = transform;

    if (Number.isFinite(rotationDeg) && Math.abs(rotationDeg) > 1e-6 && Array.isArray(rotationPivot)) {
      out = turf.transformRotate(out, rotationDeg, { pivot: rotationPivot });
    }
    if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 1e-6 && Array.isArray(scaleOrigin)) {
      out = turf.transformScale(out, scale, { origin: scaleOrigin });
    }
    if (Number.isFinite(translateKm) && Number.isFinite(translateBearing) && Math.abs(translateKm) > 1e-9) {
      out = turf.transformTranslate(out, translateKm, translateBearing, { units: 'kilometers' });
    }
    if (Array.isArray(nudgeMeters)) {
      out = applyNudgeMeters(out, nudgeMeters);
    }
    if (Number.isFinite(refineRotationDeg) && Math.abs(refineRotationDeg) > 1e-6 && Array.isArray(refineRotationPivot)) {
      out = turf.transformRotate(out, refineRotationDeg, { pivot: refineRotationPivot });
    }
  } catch {}

  if (out && typeof out === 'object') {
    out.__mfFitTransformApplied = true;
  }
  return out;
}

function findBuildingFeatureInMap(map, buildingId) {
  if (!map || !buildingId) return null;
  try {
    const src = map.getSource('buildings');
    const data = src?._data || src?.serialize?.().data || null;
    let features = data?.features || [];
    if (!features.length && typeof map.querySourceFeatures === 'function') {
      try {
        features = map.querySourceFeatures('buildings') || [];
      } catch {}
    }
    return matchBuildingFeature(features, buildingId);
  } catch {
    return null;
  }
}

function applyBearingRotation(fc, deltaDeg) {
  if (!fc || !Number.isFinite(deltaDeg) || Math.abs(deltaDeg) < 1e-6) return fc;
  if (!Array.isArray(fc.features) || !fc.features.length) return fc;
  const degToRad = Math.PI / 180;
  // Align with turf.transformRotate (positive is clockwise)
  const theta = -deltaDeg * degToRad;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rotateBearing = (bearing) => {
    const bRad = bearing * degToRad;
    const x = Math.sin(bRad);
    const y = Math.cos(bRad);
    const xr = x * cosT - y * sinT;
    const yr = x * sinT + y * cosT;
    const ang = Math.atan2(xr, yr) / degToRad;
    return (ang + 360) % 360;
  };
  const next = {
    ...fc,
    features: fc.features.map((f) => {
      const props = f?.properties || {};
      const bearing = Number(props.bearing_deg);
      if (!Number.isFinite(bearing)) return f;
      const rotated = rotateBearing(bearing);
      return {
        ...f,
        properties: {
          ...props,
          bearing_deg: rotated
        }
      };
    })
  };
  return next;
}

function getAffineRotationDeg(affine) {
  const rot = Number(affine?.rotation_deg_cw ?? affine?.rotation_deg ?? 0);
  return Number.isFinite(rot) ? rot : 0;
}

function applyFloorplanOverlayTransform(fc, rotationOverride, fitTransform, options = {}) {
  if (!fc) return fc;
  const needsBearingRotation =
    options.adjustBearings &&
    Number.isFinite(options.bearingRotationDeg) &&
    Math.abs(options.bearingRotationDeg) > 1e-6;
  if (!rotationOverride && !fitTransform && !needsBearingRotation) return fc;
  if (fc.__mfOverlayTransformApplied) return fc;

  let out = fc;
  if (rotationOverride?.deg != null) {
    out = applyRotationOverride(out, rotationOverride.deg, rotationOverride.pivot);
  }
  if (fitTransform) {
    out = applyFloorplanFitTransform(out, fitTransform);
  }

  if (options.adjustBearings) {
    const bearingDelta =
      (Number.isFinite(options.bearingRotationDeg) ? options.bearingRotationDeg : 0) +
      (Number.isFinite(rotationOverride?.deg) ? rotationOverride.deg : 0) +
      (Number.isFinite(fitTransform?.rotationDeg) ? fitTransform.rotationDeg : 0) +
      (Number.isFinite(fitTransform?.refineRotationDeg) ? fitTransform.refineRotationDeg : 0);
    out = applyBearingRotation(out, bearingDelta);
  }

  if (out && typeof out === 'object') {
    out.__mfOverlayTransformApplied = true;
  }
  return out;
}

function applyDoorSwingDirection(doorsFC, roomsFC, options = {}) {
  if (!doorsFC?.features?.length || !roomsFC?.features?.length) return doorsFC;
  const hull = buildHullFeature(roomsFC, options.hullLimit || 2000);
  if (!hull) return doorsFC;
  const offsetMeters = Number.isFinite(options.offsetMeters) ? options.offsetMeters : 0.7;
  const invertBearing = Boolean(options.invertBearing);

  const nextFeatures = doorsFC.features.map((f) => {
    if (!f?.geometry?.coordinates) return f;
    const props = f.properties || {};
    const rawBearing = Number(props.bearing_deg);
    if (!Number.isFinite(rawBearing)) return f;
    const bearing = invertBearing ? ((rawBearing + 180) % 360) : rawBearing;

    const pt = turf.point(f.geometry.coordinates);
    const forward = turf.destination(pt, offsetMeters, bearing, { units: 'meters' });
    const reverseBearing = (bearing + 180) % 360;
    const reverse = turf.destination(pt, offsetMeters, reverseBearing, { units: 'meters' });

    const insideForward = turf.booleanPointInPolygon(forward, hull);
    const insideReverse = turf.booleanPointInPolygon(reverse, hull);

    if (!insideForward && !insideReverse) return f;

    const isExterior = insideForward !== insideReverse;
    let desired = bearing;
    if (isExterior) {
      desired = insideForward ? reverseBearing : bearing;
    }

    return {
      ...f,
      properties: {
        ...props,
        bearing_deg: desired
      }
    };
  });

  return { ...doorsFC, features: nextFeatures };
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
    `${basePath}/Rooms/${floorId}_Dept_Rooms.geojson`,
    `${basePath}/Rooms/${floorId}_Dept.geojson`,
    `${basePath}/${floorId}_Dept_Rooms.geojson`,
    `${basePath}/${floorId}_Dept.geojson`,
  ];

  const [{ data: raw }, affine] = await Promise.all([
    loadGeoJsonWithFallbacks(candidates),
    loadAffineForFloor(basePath, floorId),
  ]);

  const rawFC = ensureFeatureCollection(raw);
  if (!rawFC) return { rawFC: null, patchedFC: null, affine: null };

  rawFC.features = (rawFC.features || []).map((f) => {
    const p = f?.properties || {};
    const ncesType = resolveNcesType(p);
    const ncesDept = resolveNcesDept(p);
    return {
      ...f,
      properties: {
        ...p,
        __roomType: ncesType || '',
        __dept: ncesDept || '',
        __areaSf: resolveAreaSf(p),
      }
    };
  });

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
        const cleaned = text.replace(/^\uFEFF/, '');
        const data = JSON.parse(cleaned);
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

async function tryLoadWallsOverlay({ basePath, floorId, map, roomsFC, affine, rotationOverride, fitTransform }) {
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
  fc = applyFloorplanOverlayTransform(fc, rotationOverride, fitTransform, { adjustBearings: false });

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

async function tryLoadDoorsOverlay({ basePath, floorId, map, affine, rotationOverride, fitTransform, roomsFC, buildingLabel }) {
  if (!ENABLE_DOOR_STAIR_OVERLAY) return;
  if (!basePath || !floorId || !map) return;
  const normalizedFloor = String(floorId || '').trim().toUpperCase();
  const affineRotationDeg = getAffineRotationDeg(affine);
  const candidates = [
    `${basePath}/Doors/${floorId}_Dept_Doors.geojson`,
    `${basePath}/Doors/${floorId}_Doors.geojson`,
    `${basePath}/${floorId}_Dept_Doors.geojson`,
    `${basePath}/${floorId}_Doors.geojson`
  ];
  if (normalizedFloor && normalizedFloor !== 'BASEMENT') {
    candidates.push(`${basePath}/Doors/BASEMENT_Doors.geojson`);
    candidates.push(`${basePath}/BASEMENT_Doors.geojson`);
  }

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
  fc = applyFloorplanOverlayTransform(fc, rotationOverride, fitTransform, {
    adjustBearings: true,
    bearingRotationDeg: affineRotationDeg
  });
  fc = applyDoorSwingDirection(fc, roomsFC, {
    invertBearing: shouldFlipDoorSwing(buildingLabel, floorId)
  });

  if (map.getSource(DOORS_SOURCE)) map.getSource(DOORS_SOURCE).setData(fc);
  else map.addSource(DOORS_SOURCE, { type: "geojson", data: fc });

  if (!map.getLayer(DOORS_LAYER)) {
    try {
      if (!map.hasImage('mf-door-swing')) {
        await loadIcon(map, 'mf-door-swing', assetUrl('icons/door-swing.png'));
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
          16, 0.18,
          18, 0.26,
          20, 0.34
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
        "icon-color": "#888888",
        "icon-opacity": 0.95
      }
    });
  }
}

function invertAffinePoint(lonLat, affine) {
  if (!affine || !Array.isArray(lonLat) || lonLat.length < 2) return lonLat;
  const targetLon = Number(affine.target_lon ?? affine.targetLon);
  const targetLat = Number(affine.target_lat ?? affine.targetLat);
  const rotDeg = Number(affine.rotation_deg_cw ?? affine.rotation_deg ?? 0);
  const baseScale = Number(
    affine.effective_scale_deg_per_foot ??
    affine.scale_deg_per_foot ??
    affine.scale_deg_per_ft ??
    affine.scale
  );
  const anchor = affine.anchor_feet || affine.anchorFeet || affine.anchor;
  if (!Number.isFinite(targetLon) || !Number.isFinite(targetLat) || !Number.isFinite(baseScale) || !Array.isArray(anchor)) {
    return lonLat;
  }
  const scaleLat = baseScale;
  const scaleLon = scaleLat / Math.max(1e-9, Math.cos((targetLat * Math.PI) / 180));
  const [lon, lat] = lonLat;
  const dx = (lon - targetLon) / scaleLon;
  const dy = (lat - targetLat) / scaleLat;
  const theta = (rotDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const [ax, ay] = anchor;
  return [
    cosT * dx + sinT * dy + ax,
    -sinT * dx + cosT * dy + ay
  ];
}

function rotatePoint(point, origin, deg) {
  if (!Array.isArray(point) || point.length < 2) return point;
  const [x, y] = point;
  const [ox, oy] = origin || [0, 0];
  const theta = (deg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dx = x - ox;
  const dy = y - oy;
  return [
    ox + cosT * dx - sinT * dy,
    oy + sinT * dx + cosT * dy
  ];
}

function mapCoords(coords, fn) {
  if (!coords) return coords;
  if (typeof coords[0] === 'number') return fn(coords);
  return coords.map((c) => mapCoords(c, fn));
}

function bboxFromPoints(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return {
    minx: minX,
    miny: minY,
    maxx: maxX,
    maxy: maxY,
    spanX: maxX - minX,
    spanY: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

function isFrenchChapelBasement({ buildingLabel, floorId, floorBasePath } = {}) {
  const floorKey = fId(floorId || '');
  if (floorKey !== 'basement') return false;
  if (floorBasePath && String(floorBasePath).includes('/Calvin French Chapel/')) return true;
  const key = normalizeSnapKey(buildingLabel);
  return key && [
    normalizeSnapKey('Calvin French Chapel'),
    normalizeSnapKey('Calvin H. French Chapel'),
    normalizeSnapKey('Calvin H. French Memorial Chapel')
  ].includes(key);
}

function isBabcockHallLevel3({ buildingLabel, floorId, floorBasePath } = {}) {
  const floorKey = fId(floorId || '');
  if (floorKey !== 'level_3') return false;
  if (floorBasePath) {
    const decoded = (() => {
      try { return decodeURIComponent(String(floorBasePath)); } catch { return String(floorBasePath); }
    })();
    if (decoded.includes('/Babcock Hall/')) return true;
  }
  const key = normalizeSnapKey(buildingLabel);
  return key && [
    normalizeSnapKey('Babcock Hall'),
    normalizeSnapKey('Babcock Hall Residence')
  ].includes(key);
}

function computeFeatureCentroid(features) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumX += node[0];
      sumY += node[1];
      count += 1;
      return;
    }
    node.forEach(visit);
  };
  (features || []).forEach((f) => {
    if (f?.geometry?.coordinates) visit(f.geometry.coordinates);
  });
  if (!count) return null;
  return [sumX / count, sumY / count];
}

function collectFeaturePoints(features, limit = 8000) {
  const pts = [];
  const visit = (node) => {
    if (!Array.isArray(node) || pts.length >= limit) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      pts.push([node[0], node[1]]);
      return;
    }
    node.forEach(visit);
  };
  (features || []).forEach((f) => {
    if (pts.length >= limit) return;
    if (f?.geometry?.coordinates) visit(f.geometry.coordinates);
  });
  return pts;
}

function translateGeometry(geom, dx, dy) {
  if (!geom?.coordinates || (!dx && !dy)) return geom;
  const translatePoint = (coords) => [coords[0] + dx, coords[1] + dy];
  return {
    ...geom,
    coordinates: mapCoords(geom.coordinates, translatePoint)
  };
}

function applyBabcockHallLevel3Fix(roomsFC, buildingLabel, floorId) {
  if (!roomsFC?.features?.length) return roomsFC;
  if (roomsFC.__mfBabcockL3AutoRotated) return roomsFC;
  const theta = (90 * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rotatePoint = (coords) => {
    const x = coords[0];
    const y = coords[1];
    return [x * cosT - y * sinT, x * sinT + y * cosT];
  };
  const nextFeatures = roomsFC.features.map((f) => {
    if (!isDrawingFeature(f?.properties || {})) return f;
    if (!f?.geometry) return f;
    return {
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: mapCoords(f.geometry.coordinates, rotatePoint)
      }
    };
  });
  return { ...roomsFC, features: nextFeatures, __mfBabcockL3AutoRotated: true };
}

function applyFrenchChapelBasementFix(roomsFC, affine, buildingFeature) {
  if (!roomsFC?.features?.length) return roomsFC;
  if (roomsFC.__mfBasementFixed) return roomsFC;

  const drawingFeatures = roomsFC.features.filter((f) => isDrawingFeature(f?.properties || {}));
  const roomFeatures = roomsFC.features.filter((f) => !isDrawingFeature(f?.properties || {}));
  if (drawingFeatures.length && roomFeatures.length) {
    const drawingFC = { type: 'FeatureCollection', features: drawingFeatures };
    const roomsOnlyFC = { type: 'FeatureCollection', features: roomFeatures };
    const drawHull = buildHullFeature(drawingFC, 1200) || drawingFC;
    const roomHull = buildHullFeature(roomsOnlyFC, 1200) || roomsOnlyFC;
    const drawPts = collectLngLatPairsFromGeoJSON(drawHull, 2000);
    const roomPts = collectLngLatPairsFromGeoJSON(roomHull, 2000);
    const drawBox = bboxFromPoints(drawPts);
    const roomBox = bboxFromPoints(roomPts);
    const drawCentroid = computeFeatureCentroid(drawingFeatures) || (drawBox ? [drawBox.cx, drawBox.cy] : null);
    const roomCentroid = computeFeatureCentroid(roomFeatures) || (roomBox ? [roomBox.cx, roomBox.cy] : null);
    if (drawBox && roomBox && drawCentroid && roomCentroid) {
      const span = Math.max(roomBox.spanX || 0, roomBox.spanY || 0, 1e-9);
      const dist = Math.hypot(drawCentroid[0] - roomCentroid[0], drawCentroid[1] - roomCentroid[1]);
      const farApart = dist > span * 0.18;
      if (farApart) {
        const drawAngle = getDominantEdgeAngleDeg(drawHull?.geometry) ?? 0;
        const roomAngle = getDominantEdgeAngleDeg(roomHull?.geometry) ?? 0;
        const rotDelta = normalizeAngleDelta(roomAngle - drawAngle);
        const ratioX = drawBox.spanX ? roomBox.spanX / drawBox.spanX : 1;
        const ratioY = drawBox.spanY ? roomBox.spanY / drawBox.spanY : 1;
        let scale = 1;
        if (Number.isFinite(ratioX) && Number.isFinite(ratioY) && ratioX > 0 && ratioY > 0) {
          scale = Math.min(ratioX, ratioY);
        }
        scale = Math.max(0.2, Math.min(5, scale || 1));
        const theta = (rotDelta * Math.PI) / 180;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const [px, py] = drawCentroid;
        const [tx, ty] = roomCentroid;
        const transformPoint = (coords) => {
          const dx = coords[0] - px;
          const dy = coords[1] - py;
          const rx = (dx * cosT - dy * sinT) * scale;
          const ry = (dx * sinT + dy * cosT) * scale;
          return [tx + rx, ty + ry];
        };
        const nextFeatures = roomsFC.features.map((f) => {
          if (!isDrawingFeature(f?.properties || {})) return f;
          if (!f?.geometry) return f;
          return {
            ...f,
            geometry: {
              ...f.geometry,
              coordinates: mapCoords(f.geometry.coordinates, transformPoint)
            }
          };
        });
        const next = { ...roomsFC, features: nextFeatures };
        next.__mfBasementFixed = true;
        return next;
      }
    }
  }

  if (!affine || !buildingFeature) return roomsFC;

  const featureCentroids = roomsFC.features
    .map((f, i) => {
      const coords = f?.geometry?.coordinates;
      if (!coords) return null;
      const pts = extractLngLatPairs({ coordinates: coords }, 1000);
      if (!pts.length) return null;
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return { i, c: [cx, cy] };
    })
    .filter(Boolean);
  if (featureCentroids.length < 6) return roomsFC;

  const xs = featureCentroids.map((o) => o.c[0]).sort((a, b) => a - b);
  const mid = xs[Math.floor(xs.length / 2)];
  const leftIdx = new Set(featureCentroids.filter((o) => o.c[0] <= mid).map((o) => o.i));
  if (!leftIdx.size || leftIdx.size === roomsFC.features.length) return roomsFC;

  const leftFC = {
    type: 'FeatureCollection',
    features: roomsFC.features.filter((_, i) => leftIdx.has(i))
  };
  const leftHull = buildHullFeature(leftFC, 1200);
  const buildingAngle = getDominantEdgeAngleDeg(buildingFeature?.geometry) ?? 0;
  const leftAngle = getDominantEdgeAngleDeg(leftHull?.geometry) ?? 0;
  const rotDelta = Number.isFinite(buildingAngle) && Number.isFinite(leftAngle)
    ? (buildingAngle - leftAngle)
    : 0;

  const buildingCentroid = turf.centroid(buildingFeature)?.geometry?.coordinates || null;
  if (!buildingCentroid) return roomsFC;
  const rotateToAxis = (pt) => rotatePoint(pt, buildingCentroid, -buildingAngle);
  const rotateFromAxis = (pt) => rotatePoint(pt, buildingCentroid, buildingAngle);

  const buildingRot = {
    type: 'Feature',
    properties: {},
    geometry: {
      ...buildingFeature.geometry,
      coordinates: mapCoords(buildingFeature.geometry.coordinates, rotateToAxis)
    }
  };
  const buildingRotPts = collectLngLatPairsFromGeoJSON(buildingRot, 4000);
  const buildingRotBox = bboxFromPoints(buildingRotPts);
  if (!Number.isFinite(buildingRotBox.cx)) return roomsFC;
  const splitX = buildingRotBox.cx;
  const leftHalf = turf.polygon([[
    [splitX - 10, buildingRotBox.miny - 10],
    [splitX, buildingRotBox.miny - 10],
    [splitX, buildingRotBox.maxy + 10],
    [splitX - 10, buildingRotBox.maxy + 10],
    [splitX - 10, buildingRotBox.miny - 10]
  ]]);
  const leftRot = turf.intersect(turf.featureCollection([buildingRot, leftHalf]));
  if (!leftRot?.geometry) return roomsFC;
  const leftTarget = {
    type: 'Feature',
    properties: {},
    geometry: {
      ...leftRot.geometry,
      coordinates: mapCoords(leftRot.geometry.coordinates, rotateFromAxis)
    }
  };

  const leftTargetPts = collectLngLatPairsFromGeoJSON(leftTarget, 4000);
  const leftTargetBox = bboxFromPoints(leftTargetPts);
  if (!Number.isFinite(leftTargetBox.minx)) return roomsFC;

  const targetLocalBox = bboxFromPoints([
    invertAffinePoint([leftTargetBox.minx, leftTargetBox.miny], affine),
    invertAffinePoint([leftTargetBox.maxx, leftTargetBox.maxy], affine)
  ]);

  const leftPts = collectLngLatPairsFromGeoJSON(leftFC, 4000);
  const leftBox = bboxFromPoints(leftPts);
  const leftCenter = [leftBox.cx, leftBox.cy];

  const rotatedLeftPts = leftPts.map((pt) => rotatePoint(pt, leftCenter, rotDelta));
  const rotatedLeftBox = bboxFromPoints(rotatedLeftPts);
  if (!Number.isFinite(rotatedLeftBox.spanX) || !Number.isFinite(rotatedLeftBox.spanY)) return roomsFC;

  const scale = Math.min(
    targetLocalBox.spanX / Math.max(1e-9, rotatedLeftBox.spanX),
    targetLocalBox.spanY / Math.max(1e-9, rotatedLeftBox.spanY)
  );
  const translate = [
    targetLocalBox.cx - rotatedLeftBox.cx,
    targetLocalBox.cy - rotatedLeftBox.cy
  ];

  const transformPoint = (pt) => {
    const rotated = rotatePoint(pt, leftCenter, rotDelta);
    const scaled = [
      (rotated[0] - rotatedLeftBox.cx) * scale + rotatedLeftBox.cx,
      (rotated[1] - rotatedLeftBox.cy) * scale + rotatedLeftBox.cy
    ];
    return [
      scaled[0] + translate[0],
      scaled[1] + translate[1]
    ];
  };

  const nextFeatures = roomsFC.features.map((f, i) => {
    if (!leftIdx.has(i)) return f;
    if (!f?.geometry?.coordinates) return f;
    return {
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: mapCoords(f.geometry.coordinates, transformPoint)
      }
    };
  });

  const next = { ...roomsFC, features: nextFeatures };
  next.__mfBasementFixed = true;
  return next;
}

async function tryLoadStairsOverlay({ basePath, floorId, map, affine, rotationOverride, fitTransform }) {
  if (!ENABLE_DOOR_STAIR_OVERLAY) return;
  if (!basePath || !floorId || !map) return;
  const normalizedFloor = String(floorId || '').trim().toUpperCase();
  const affineRotationDeg = getAffineRotationDeg(affine);
  const candidates = [
    `${basePath}/Stairs/${floorId}_Dept_Stairs.geojson`,
    `${basePath}/Stairs/${floorId}_Stairs.geojson`,
    `${basePath}/${floorId}_Dept_Stairs.geojson`,
    `${basePath}/${floorId}_Stairs.geojson`
  ];
  if (normalizedFloor && normalizedFloor !== 'BASEMENT') {
    candidates.push(`${basePath}/Stairs/BASEMENT_Stairs.geojson`);
    candidates.push(`${basePath}/BASEMENT_Stairs.geojson`);
  }

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
  fc = applyFloorplanOverlayTransform(fc, rotationOverride, fitTransform, {
    adjustBearings: true,
    bearingRotationDeg: affineRotationDeg
  });

  console.log("[stairs] loaded features", fc.features.length);

  if (map.getSource(STAIRS_SOURCE)) map.getSource(STAIRS_SOURCE).setData(fc);
  else map.addSource(STAIRS_SOURCE, { type: "geojson", data: fc });

  if (!map.getLayer(STAIRS_LAYER)) {
    try {
      if (!map.hasImage('mf-stairs-run')) {
        await loadIcon(map, 'mf-stairs-run', assetUrl('icons/stairs-run.png'));
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
          16, 0.20,
          18, 0.28,
          20, 0.36
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
        "icon-color": "#888888",
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
  const normalizeKey = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normalizeFloorEntries = (floors = []) => {
    if (!Array.isArray(floors)) return [];
    return floors
      .map((f) => {
        if (typeof f === 'string') return { id: f, url: null };
        if (!f) return null;
        const id = f.id || f.floorId || f.name || f.label;
        const url = f.url || f.path || null;
        if (!id) return null;
        return { id, url };
      })
      .filter(Boolean);
  };

  const campusSeg = encodeURIComponent(campus);
  const buildingSeg = encodeURIComponent(buildingKey);
  const url = assetUrl(`floorplans/${campusSeg}/${buildingSeg}/manifest.json`);
  const manifest = await fetchJSON(url);

  const globalManifest = await fetchJSON(FLOORPLAN_MANIFEST_URL);
  const floorsByBuilding = globalManifest?.floorsByBuilding || {};
  let globalFloors = floorsByBuilding[buildingKey];
  if (!globalFloors) {
    const matchKey = Object.keys(floorsByBuilding).find(
      (key) => normalizeKey(key) === normalizeKey(buildingKey)
    );
    globalFloors = matchKey ? floorsByBuilding[matchKey] : null;
  }
  const normalizedGlobal = normalizeFloorEntries(globalFloors || []);

  if (Array.isArray(manifest?.floors)) {
    const entries = normalizeFloorEntries(manifest.floors);
    if (!entries.length) return normalizedGlobal;
    if (normalizedGlobal.length && entries.some((e) => !e.url)) {
      const globalMap = new Map(
        normalizedGlobal
          .filter((f) => f?.id && f?.url)
          .map((f) => [f.id, f.url])
      );
      return entries.map((entry) => ({
        ...entry,
        url: entry.url || globalMap.get(entry.id) || null
      }));
    }
    return entries;
  }

  return normalizedGlobal;
}


// --- Mapbox token from Vite env (required for mapbox:// styles) ---
mapboxgl.accessToken = (
  import.meta.env.VITE_MAPBOX_TOKEN ||
  import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ||
  ''
).trim();

// Optional sanity-check
console.log('Mapbox token length:', (mapboxgl.accessToken || '').length);


// --- Floor layer IDs (keep consistent) ---
const FLOOR_SOURCE = 'floor-source';
const FLOOR_FILL_ID = "floor-fill";
const FLOOR_LINE_ID = "floor-line";
const FLOOR_DRAWING_LAYER = "floor-drawing";
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
const floorTransformCache = new Map();
const floorRoomsCache = new Map();
const buildingAggCache = new Map();
let campusAggCache = null;

const normalizeDashboardUrl = (url) => {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith(PUBLIC_BASE)) return url;
  return assetUrl(String(url).replace(/^\//, ''));
};

async function fetchRoomsForFloorUrl(floorUrl) {
  const normalized = normalizeDashboardUrl(floorUrl);
  if (!normalized) return [];
  if (floorRoomsCache.has(normalized)) return floorRoomsCache.get(normalized);
  const data = await fetchJSON(normalized);
  const feats = Array.isArray(data?.features) ? data.features : [];
  floorRoomsCache.set(normalized, feats);
  return feats;
}

async function runWithLimit(items, limit, fn) {
  const out = [];
  const queue = [...items];
  const workerCount = Math.max(1, Number(limit) || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        out.push(await fn(item));
      } catch (err) {
        console.warn('dashboard fetch failed', item, err);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function computeCampusDashboard(manifest) {
  if (campusAggCache) return campusAggCache;
  const floorUrls = [];
  for (const floors of Object.values(manifest?.floorsByBuilding || {})) {
    for (const f of floors || []) {
      if (f?.url) floorUrls.push(f.url);
    }
  }
  const floorFeaturesArrays = await runWithLimit(floorUrls, 6, fetchRoomsForFloorUrl);
  const allFeatures = floorFeaturesArrays.flat();
  campusAggCache = computeSpaceDashboard(allFeatures);
  return campusAggCache;
}

async function computeBuildingDashboard(manifest, buildingKey) {
  if (!buildingKey) return null;
  if (buildingAggCache.has(buildingKey)) return buildingAggCache.get(buildingKey);
  const floors = manifest?.floorsByBuilding?.[buildingKey] || [];
  const urls = (floors || []).map((f) => f?.url).filter(Boolean);
  const floorFeaturesArrays = await runWithLimit(urls, 6, fetchRoomsForFloorUrl);
  const feats = floorFeaturesArrays.flat();
  const metrics = computeSpaceDashboard(feats);
  buildingAggCache.set(buildingKey, metrics);
  return metrics;
}

function applyBuildingStyleForSpace(map) {
  if (!map) return;
  const layerId = 'buildings-fill';
  if (map.getLayer(layerId)) {
    try {
      map.setPaintProperty(layerId, 'fill-color', withNoFloorplanOverride('#ffffff'));
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
  const occupancyRawExpr = [
    'to-string',
    [
      'coalesce',
      ['get', 'occupancyStatus'],
      ['get', 'Occupancy Status'],
      ['get', 'OccupancyStatus'],
      ['get', 'Occupancy'],
      ['get', 'Vacancy'],
      ['get', 'vacancy'],
      ['get', 'Vacant'],
      ''
    ]
  ];
  const occupancyUpperExpr = ['upcase', occupancyRawExpr];
  const roomTypeUpperExpr = [
    'upcase',
    [
      'to-string',
      [
        'coalesce',
        ['get', '__roomType'],
        ['get', 'NCES_Type'],
        ['get', 'RoomType'],
        ['get', 'Room Type'],
        ['get', 'Type'],
        ['get', 'type'],
        ['get', 'Name'],
        ''
      ]
    ]
  ];
  const isOfficeExpr = ['in', roomTypeUpperExpr, ['literal', OFFICE_TYPE_LABELS_UPPER]];
  const hasOccupancyExpr = ['>', ['length', occupancyUpperExpr], 0];
  const isVacantExpr = [
    'any',
    ['>=', ['index-of', 'VACANT', occupancyUpperExpr], 0],
    ['>=', ['index-of', 'UNOCCUPIED', occupancyUpperExpr], 0],
    ['>=', ['index-of', 'AVAILABLE', occupancyUpperExpr], 0],
    ['>=', ['index-of', 'UNASSIGNED', occupancyUpperExpr], 0]
  ];
  const isOccupiedExpr = ['>=', ['index-of', 'OCCUPIED', occupancyUpperExpr], 0];
  const occupancyLabelExpr = [
    'case',
    hasOccupancyExpr,
    ['case', isVacantExpr, 'Vacant', isOccupiedExpr, 'Occupied', 'Unknown'],
    occupantExpr,
    'Occupied',
    'Unknown'
  ];
  const occupancyColorExpr = [
    'case',
    isOfficeExpr,
    [
      'match',
      occupancyLabelExpr,
      'Occupied',
      '#29b6f6',
      'Vacant',
      '#ff7043',
      'Unknown',
      '#e0e0e0',
      '#e0e0e0'
    ],
    '#e6e6e6'
  ];
  const vacancyColorExpr = [
    'case',
    isOfficeExpr,
    [
      'match',
      occupancyLabelExpr,
      'Vacant',
      '#ff7043',
      'Occupied',
      '#cfd8dc',
      'Unknown',
      '#cfd8dc',
      '#cfd8dc'
    ],
    '#e6e6e6'
  ];
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

    // Drawing lines above fills but under labels.
    if (map.getLayer(FLOOR_DRAWING_LAYER)) {
      if (map.getLayer(FLOOR_ROOM_LABEL_LAYER)) {
        map.moveLayer(FLOOR_DRAWING_LAYER, FLOOR_ROOM_LABEL_LAYER);
      } else {
        map.moveLayer(FLOOR_DRAWING_LAYER);
      }
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
  const { buildingId, floor, roomPatches, onOptionsCollected, currentFloorContextRef, airtableLookup } = options;

  const floorBasePath = options?.roomsBasePath || options?.wallsBasePath;
  const floorId = options?.roomsFloorId || options?.wallsFloorId || floor || null;
  let fitBuilding = affineParams?.fitBuilding || null;
  if (!fitBuilding && buildingId) {
    fitBuilding = findBuildingFeatureInMap(map, buildingId);
  }
  if (!fitBuilding && floorBasePath) {
    const folderName = getBuildingFolderFromBasePath(floorBasePath);
    if (folderName) {
      fitBuilding = findBuildingFeatureInMap(map, folderName);
    }
  }
  if (!fitBuilding && floorBasePath) {
    const buildings = await loadCampusBuildings();
    if (buildings?.features?.length) {
      const folderName = getBuildingFolderFromBasePath(floorBasePath);
      const canonicalName = BUILDING_FOLDER_TO_NAME?.[folderName] || folderName;
      fitBuilding =
        matchBuildingFeature(buildings.features, buildingId) ||
        matchBuildingFeature(buildings.features, canonicalName) ||
        matchBuildingFeature(buildings.features, folderName) ||
        null;
    }
  }
  if (!fitBuilding && floorBasePath) {
    const folderName = getBuildingFolderFromBasePath(floorBasePath);
    const canonicalName = BUILDING_FOLDER_TO_NAME?.[folderName] || folderName;
    const buildingLabel = buildingId || canonicalName;
    const key = normalizeSnapKey(buildingLabel);
    if (key && BUILDING_FORCE_FIT.has(key)) {
      fitBuilding = findBuildingFeatureInMap(map, canonicalName);
    }
  }
  let snapCorner = getSnapCornerForBuilding(fitBuilding);
  const affineBuildingLabel =
    fitBuilding?.properties?.id ||
    fitBuilding?.properties?.name ||
    buildingId ||
    '';
  const drawingAlignLabel = resolveDrawingAlignLabel({
    buildingLabel: affineBuildingLabel,
    buildingId,
    floorBasePath,
    fitBuilding
  });
  const floorAdjustLabel = resolveFloorAdjustLabel({
    buildingLabel: affineBuildingLabel,
    buildingId,
    floorBasePath,
    fitBuilding
  });
  const skipAffine = shouldSkipAffine({ buildingLabel: affineBuildingLabel, floorBasePath });
  const basePostRotateDeg = getFloorplanPostRotationOverride(affineBuildingLabel || buildingId || '', floorId || floor || '') || 0;
  const floorAdjustFromBase =
    floorBasePath && floorId ? loadFloorAdjustByBasePath(floorBasePath, floorId) : null;
  const floorAdjustFromUrl = loadFloorAdjustByUrl(url);
  const floorAdjustFromLabel = loadFloorAdjust(floorAdjustLabel, floorId || floor);
  const floorAdjustPick = pickLatestFloorAdjust({
    base: floorAdjustFromBase,
    url: floorAdjustFromUrl,
    label: floorAdjustFromLabel
  });
  const floorAdjust = floorAdjustPick.adjust;
  const postRotateDeg = basePostRotateDeg;

  let affine = null;
  let fc = null;
  let data = floorCache.get(url);
  const drawingAlign = loadDrawingAlign(drawingAlignLabel, floorId || floor);
  const drawingAlignSig = getDrawingAlignSignature(drawingAlign);
  if (data && shouldBypassFloorCache(affineBuildingLabel || buildingId || '', floorId || floor || '')) {
    floorCache.delete(url);
    floorTransformCache.delete(url);
    data = null;
  }
  if (data && snapCorner && (data.__mfTransformed || data.__mfFitted || data.__mfFitTransform)) {
    floorCache.delete(url);
    data = null;
  }
  if (data && Number.isFinite(postRotateDeg) && data.__mfPostRotation !== postRotateDeg) {
    floorCache.delete(url);
    floorTransformCache.delete(url);
    data = null;
  }
  if (data && floorBasePath && floorId && !skipAffine) {
    const cachedAffine = await loadAffineForFloor(floorBasePath, floorId);
    const sig = getAffineSignature(cachedAffine);
    if (sig && data.__mfAffineSignature && data.__mfAffineSignature !== sig) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
      data = null;
    } else if (sig && data.__mfAffineApplied && !data.__mfAffineSignature) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
      data = null;
    } else {
      affine = cachedAffine;
    }
  }
  if (data && (data.__mfDrawingAlignSignature || drawingAlignSig)) {
    if (data.__mfDrawingAlignSignature !== drawingAlignSig) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
      data = null;
    }
  }
  if (data) {
    const sig = getFloorAdjustSignature(floorAdjust);
    if (sig && data.__mfUserAdjustSignature && data.__mfUserAdjustSignature !== sig) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
      data = null;
    } else if (sig && data.__mfTransformed && !data.__mfUserAdjustSignature) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
      data = null;
    }
  }
  if (!data) {
    if (floorBasePath && floorId) {
      const roomsLoad = await loadRoomsFC({ basePath: floorBasePath, floorId });
      if (!roomsLoad.rawFC) {
        console.warn('Floor summary: no data returned', `${floorBasePath}/${floorId}_Dept.geojson`);
        return;
      }
      data = roomsLoad.rawFC;
      affine = roomsLoad.affine;
      if (skipAffine) affine = null;
      if (isFrenchChapelBasement({ buildingLabel: buildingId, floorId, floorBasePath })) {
        const fixed = applyFrenchChapelBasementFix(roomsLoad.rawFC, affine, fitBuilding);
        fc = applyAffineIfPresent(fixed, affine);
      } else if (isBabcockHallLevel3({ buildingLabel: buildingId, floorId, floorBasePath })) {
        const fixed = applyBabcockHallLevel3Fix(roomsLoad.rawFC);
        fc = applyAffineIfPresent(fixed, affine);
      } else {
        fc = roomsLoad.patchedFC;
      }
    } else {
      data = await fetchGeoJSON(url);
      if (!data) return;
    }
    floorCache.set(url, data);
  }

  if (!fc) {
    fc = ensureFeatureCollection(data) || toFeatureCollection(data);
    if (!fc?.features?.length) return;
    if (!skipAffine && !affine && floorBasePath && floorId) {
      affine = await loadAffineForFloor(floorBasePath, floorId);
    }
    if (isBabcockHallLevel3({ buildingLabel: buildingId, floorId, floorBasePath })) {
      fc = applyBabcockHallLevel3Fix(fc);
    }
    fc = applyAffineIfPresent(fc, affine);
  }

  if (drawingAlign) {
    fc = applyDrawingAlignment(fc, drawingAlign);
  }
  fc = pruneDrawingOutsideRooms(fc);

  fc = applyRoomTypeLabel(fc);
  const fitSkipLabel =
    affineBuildingLabel ||
    fitBuilding?.properties?.id ||
    fitBuilding?.properties?.name ||
    buildingId ||
    '';
  const fitSkipFloor = floorId || floor || '';
  if (shouldSkipFloorplanFit(fitSkipLabel, fitSkipFloor)) {
    fc.__mfNoFit = true;
  }

  if (!fitBuilding && floorBasePath) {
    const buildings = await loadCampusBuildings();
    if (buildings?.features?.length) {
      const folderName = getBuildingFolderFromBasePath(floorBasePath);
      const canonicalName = BUILDING_FOLDER_TO_NAME?.[folderName] || folderName;
      fitBuilding =
        matchBuildingFeature(buildings.features, buildingId) ||
        matchBuildingFeature(buildings.features, canonicalName) ||
        matchBuildingFeature(buildings.features, folderName) ||
        null;
      snapCorner = getSnapCornerForBuilding(fitBuilding);
    }
  }
  if (!fitBuilding && floorBasePath) {
    const folderName = getBuildingFolderFromBasePath(floorBasePath);
    const canonicalName = BUILDING_FOLDER_TO_NAME?.[folderName] || folderName;
    const buildingLabel = buildingId || canonicalName;
    const key = normalizeSnapKey(buildingLabel);
    if (key && BUILDING_FORCE_FIT.has(key)) {
      const buildings = await loadCampusBuildings();
      if (buildings?.features?.length) {
        fitBuilding =
          matchBuildingFeature(buildings.features, canonicalName) ||
          matchBuildingFeature(buildings.features, folderName) ||
          null;
        snapCorner = getSnapCornerForBuilding(fitBuilding);
      }
    }
  }

  const rotationOverrideDeg = Number.isFinite(affineParams?.rotationOverrideDeg)
    ? affineParams.rotationOverrideDeg
    : null;
  const cachedTransform = floorTransformCache.get(url) || {};
  if (snapCorner) {
    delete cachedTransform.fitTransform;
  }
  let rotationOverride = null;
  if (rotationOverrideDeg != null) {
    const pivot = cachedTransform.rotationPivot || turf.centroid(fc)?.geometry?.coordinates || null;
    rotationOverride = pivot ? { deg: rotationOverrideDeg, pivot } : { deg: rotationOverrideDeg };
    if (!cachedTransform.rotationPivot && pivot) {
      cachedTransform.rotationPivot = pivot;
      floorTransformCache.set(url, cachedTransform);
    }
    const rotated = applyRotationOverride(fc, rotationOverrideDeg, pivot);
    if (rotated && rotated !== fc) {
      fc = rotated;
      if (!snapCorner) {
        floorCache.set(url, fc);
      }
    }
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

  const fitCandidate = buildFitCandidate(fc);
  const fitSource = fitCandidate && fitCandidate !== fc ? fitCandidate : fc;
  let fitTransform = fc?.__mfFitTransform || cachedTransform.fitTransform || null;
  try {
    if (fitBuilding && shouldFitFloorplanToBuilding(fitSource, fitBuilding)) {
      const fitted = fitFloorplanToBuilding(fitSource, fitBuilding);
      if (fitted?.features?.length) {
        fitTransform = fitted.__mfFitTransform || null;
        if (fitSource !== fc && fitTransform) {
          const applied = applyFloorplanFitTransform(fc, fitTransform);
          if (applied?.features?.length) {
            if (fc.__mfAffineApplied) applied.__mfAffineApplied = fc.__mfAffineApplied;
            if (fc.__mfRotationOverride != null) applied.__mfRotationOverride = fc.__mfRotationOverride;
            if (fc.__mfRotationPivot) applied.__mfRotationPivot = fc.__mfRotationPivot;
            applied.__mfFitted = true;
            applied.__mfFittedBuilding = fitted.__mfFittedBuilding || '';
            applied.__mfFitTransform = fitTransform;
            fc = applied;
          }
        } else {
          fc = fitted;
        }
        data.__mfTransformed = true;
        if (!snapCorner) {
          floorCache.set(url, fc);
        }
      }
    }
  } catch {}

  const scaleOverride = getFloorplanScaleOverride(affineBuildingLabel || buildingId || '', floorId || floor || '');
  if (Number.isFinite(scaleOverride) && Math.abs(scaleOverride - 1) > 1e-3) {
    const scaleOrigin = fitTransform?.scaleOrigin || turf.centroid(fc)?.geometry?.coordinates || null;
    if (scaleOrigin) {
      fc = turf.transformScale(fc, scaleOverride, { origin: scaleOrigin });
      fitTransform = fitTransform || {
        rotationDeg: 0,
        rotationPivot: null,
        scale: 1,
        scaleOrigin,
        translateKm: 0,
        translateBearing: 0,
        nudgeMeters: null,
        refineRotationDeg: 0,
        refineRotationPivot: null
      };
      fitTransform.scale = (Number.isFinite(fitTransform.scale) ? fitTransform.scale : 1) * scaleOverride;
      fitTransform.scaleOrigin = scaleOrigin;
      data.__mfTransformed = true;
      if (!snapCorner) {
        floorCache.set(url, fc);
      }
    }
  }

  if (Number.isFinite(postRotateDeg) && Math.abs(postRotateDeg) > 1e-3) {
    const pivot =
      fitTransform?.scaleOrigin ||
      fitTransform?.rotationPivot ||
      turf.centroid(fitBuilding || fc)?.geometry?.coordinates ||
      null;
    if (pivot) {
      fc = turf.transformRotate(fc, postRotateDeg, { pivot });
      fitTransform = fitTransform || {
        rotationDeg: 0,
        rotationPivot: null,
        scale: 1,
        scaleOrigin: pivot,
        translateKm: 0,
        translateBearing: 0,
        nudgeMeters: null,
        refineRotationDeg: 0,
        refineRotationPivot: null
      };
      fitTransform.refineRotationDeg =
        (Number.isFinite(fitTransform.refineRotationDeg) ? fitTransform.refineRotationDeg : 0) +
        postRotateDeg;
      fitTransform.refineRotationPivot = pivot;
      data.__mfTransformed = true;
      data.__mfPostRotation = postRotateDeg;
      if (!snapCorner) {
        floorCache.set(url, fc);
      }
    }
  }
  const adjustPivotBase =
    fitTransform?.scaleOrigin ||
    fitTransform?.rotationPivot ||
    turf.centroid(fc)?.geometry?.coordinates ||
    null;
  if (floorAdjust) {
    const hasAdjust = hasFloorAdjust(floorAdjust);
    if (hasAdjust) {
      const adjustedResult = applyFloorAdjustWithTransform(fc, floorAdjust, fitTransform);
      if (adjustedResult?.fc && adjustedResult.fc !== fc) {
        fc = adjustedResult.fc;
        fitTransform = adjustedResult.fitTransform || fitTransform;
        data.__mfTransformed = true;
        if (!snapCorner) {
          floorCache.set(url, fc);
        }
      }
    }
  }
  if (fitTransform) {
    cachedTransform.fitTransform = fitTransform;
    floorTransformCache.set(url, cachedTransform);
  }

  if (fc && Array.isArray(fc.features) && currentFloorContextRef && typeof currentFloorContextRef === 'object') {
    currentFloorContextRef.current = {
      url,
      buildingId,
      floor,
      fc,
      floorAdjustLabel,
      floorAdjustFloorId: floorId || floor || '',
      floorAdjustBasePath: floorBasePath || null,
      floorAdjustBasePivot: adjustPivotBase || null
    };
  }

  let patchedFC = fc;
  let roomsEnriched = [];
  const canUseRoomPatches = buildingId && floor && roomPatches instanceof Map;
  const canUseAirtable = Boolean(airtableLookup);
  if (canUseRoomPatches || canUseAirtable) {
    const patchedFeatures = (fc.features || []).map((feature) => {
      const baseProps = feature.properties || {};
      let mergedProps = baseProps;
      if (canUseAirtable && detectFeatureKind(baseProps) === 'room') {
        const airtablePatch = getAirtableRoomPatch(baseProps, airtableLookup, buildingId, floor);
        if (airtablePatch) {
          mergedProps = mergePatch(mergedProps, airtablePatch);
        }
      }
      if (canUseRoomPatches) {
        const revitId = feature.id ?? baseProps.RevitId ?? baseProps.id;
        const rid = rId(buildingId, floor, revitId);
        const patch = roomPatches.get(rid);
        if (patch) {
          mergedProps = mergePatch(mergedProps, patch);
        }
      }
      const typeLabel = getRoomTypeLabelFromProps(mergedProps);
      return {
        ...feature,
        properties: {
          ...mergedProps,
          __roomType: typeLabel ? String(typeLabel).trim() : (mergedProps.__roomType || '')
        }
      };
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
  const floorSrc = getGeojsonSource(map, FLOOR_SOURCE);
  if (floorSrc) floorSrc.setData(patchedFC);
  else map.addSource(FLOOR_SOURCE, { type: 'geojson', data: patchedFC, promoteId: 'RevitId' });

  // fill colored by Department
  if (!map.getLayer(FLOOR_FILL_ID)) {
    map.addLayer({
      id: FLOOR_FILL_ID,
      type: 'fill',
      source: FLOOR_SOURCE,
      paint: FLOOR_FILL_PAINT,
      filter: ROOMS_ONLY_FILTER
    });
  } else {
    try { map.setFilter(FLOOR_FILL_ID, ROOMS_ONLY_FILTER); } catch {}
  }
  applyFloorFillExpression(map);
  ensureFloorHighlightLayer(map);

  const suppressDrawing = shouldSuppressDrawingLayer(affineBuildingLabel || buildingId || '', floorId || floor || '');
  const hasDrawingFeatures = !suppressDrawing &&
    Array.isArray(patchedFC?.features) &&
    patchedFC.features.some((f) => f?.properties?.interactive === false || f?.properties?.type === 'drawing');
  if (hasDrawingFeatures) {
    const drawingLayerNameExpr = [
      'downcase',
      [
        'to-string',
        [
          'coalesce',
          ['get', 'Layer'],
          ['get', 'layer'],
          ['get', 'FeatureClass'],
          ['get', 'featureClass'],
          ['get', 'type'],
          ['get', 'Type']
        ]
      ]
    ];
    const drawingExcludeExpr = [
      'any',
      ['>=', ['index-of', 'grid', drawingLayerNameExpr], 0],
      ['>=', ['index-of', 'area-bndy', drawingLayerNameExpr], 0],
      ['>=', ['index-of', 'area bndy', drawingLayerNameExpr], 0]
    ];
    const drawingFilter = [
      'all',
      ['==', ['get', 'interactive'], false],
      ['!', drawingExcludeExpr]
    ];
    if (!map.getLayer(FLOOR_DRAWING_LAYER)) {
      map.addLayer({
        id: FLOOR_DRAWING_LAYER,
        type: 'line',
        source: FLOOR_SOURCE,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#2f2f2f',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            16, 0.15,
            18, 0.25,
            20, 0.45
          ],
          'line-opacity': 0.6
        },
        filter: drawingFilter
      });
    } else {
      try { map.setFilter(FLOOR_DRAWING_LAYER, drawingFilter); } catch {}
    }
  }

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
      },
      filter: ROOMS_ONLY_FILTER
    });
  } else {
    try { map.setFilter(FLOOR_LINE_ID, ROOMS_ONLY_FILTER); } catch {}
  }

  ensureFloorRoomLabelLayer(map);
  // ---- WALLS OVERLAY (NEW) ----
  if (options?.wallsBasePath) {
    const floorId = options.wallsFloorId || floor || (url?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) || null;
    await tryLoadWallsOverlay({
      basePath: options.wallsBasePath,
      floorId,
      map,
      roomsFC: patchedFC,
      affine,
      rotationOverride,
      fitTransform
    });
    try { map.setPaintProperty(FLOOR_FILL_ID, "fill-opacity", 0.25); } catch {}
  }
  // ---- end walls overlay ----

  // ---- DOORS + STAIRS OVERLAY (optional) ----
    const overlayBasePath = options?.roomsBasePath || options?.wallsBasePath;
    const overlayBuildingLabel =
      buildingId ||
      affineParams?.fitBuilding?.properties?.id ||
      affineParams?.fitBuilding?.properties?.name ||
      null;
    if (overlayBasePath) {
      const overlayFloorId =
        options?.roomsFloorId ||
        options?.wallsFloorId ||
        floor ||
      (url?.match(/(BASEMENT|LEVEL_\d+|LEVEL|L\d+)/)?.[0]) ||
      null;
    if (overlayFloorId) {
        await tryLoadDoorsOverlay({
          basePath: overlayBasePath,
          floorId: overlayFloorId,
          map,
          affine,
          rotationOverride,
          fitTransform: fitTransform || cachedTransform.fitTransform || null,
          roomsFC: patchedFC,
          buildingLabel: overlayBuildingLabel
        });
      await tryLoadStairsOverlay({
        basePath: overlayBasePath,
        floorId: overlayFloorId,
        map,
        affine,
        rotationOverride,
        fitTransform: fitTransform || cachedTransform.fitTransform || null
      });
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

function isAssignableDeptName(dept) {
  const normed = String(dept || '').trim();
  if (!normed) return false;
  if (isAirtableRecordId(normed)) return false;
  const upper = normed.toUpperCase();
  return upper !== 'UNSPECIFIED' && upper !== 'UNKNOWN' && upper !== 'N/A' && upper !== 'NA';
}

function filterDeptTotals(totalsByDept) {
  const entries = Object.entries(totalsByDept || {});
  const filtered = entries.filter(([name]) => isAssignableDeptName(name));
  return Object.fromEntries(filtered);
}

function summarizeRoomRowsForPanels(roomRows = []) {
  const features = (roomRows || [])
    .map(roomRowToDashboardFeature)
    .filter(Boolean);
  if (!features.length) return null;
  const summary = summarizeFeatures(features);
  if (!summary) return null;
  const filteredTotals = filterDeptTotals(summary.totalsByDept || summary.deptCounts || {});
  const sorted = Object.entries(filteredTotals).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return {
    ...summary,
    deptCounts: filteredTotals,
    totalsByDept: filteredTotals,
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

    const type = getRoomTypeLabelFromProps(p) || 'Unspecified';
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
    const roomGuid = r.roomGuid ?? r.roomGUID ?? r.revitUniqueId ?? r.revitUniqueID ?? r['Room GUID'] ?? null;
    const fallbackId = [buildingLabel, floorId, roomLabel].filter(Boolean).join('|') || `room-${idx}`;
    const id = idCandidate || fallbackId;
    const occupant = String(r.occupant ?? '').trim();
    const vacancyRaw = String(r.vacancy ?? (occupant ? 'Occupied' : 'Unknown')).trim();
    return {
      id,
      revitId: r.revitId ?? roomGuid ?? null,
      roomGuid,
      roomId: idCandidate || fallbackId,
      buildingLabel,
      floorId,
      floorName: floorId,
      roomLabel,
      type: String(r.type ?? r.roomType ?? '').trim(),
      sf: Number(r.sf ?? r.areaSF ?? r.area ?? 0) || 0,
      department: String(r.department ?? '').trim(),
      occupant,
      vacancy: vacancyRaw,
      occupancyStatus: occupant ? 'Occupied' : 'Vacant',
      occupantDept: String(r.department ?? '').trim() || null
    };
  });
  return trimmed.filter((x) => x.id);
}

function minifyMoveScenarioInventory(inventory) {
  if (!Array.isArray(inventory)) return [];
  return inventory.map((room) => ({
    id: room?.id ?? room?.roomId ?? '',
    roomId: room?.roomId ?? room?.id ?? '',
    revitId: room?.revitId ?? room?.roomGuid ?? null,
    buildingLabel: room?.buildingLabel ?? room?.buildingName ?? room?.building ?? '',
    floorId: room?.floorId ?? room?.floorName ?? '',
    floorName: room?.floorName ?? room?.floorId ?? '',
    roomLabel: room?.roomLabel ?? room?.roomNumber ?? '',
    type: room?.type ?? room?.roomType ?? '',
    sf: Number(room?.sf ?? room?.area ?? room?.areaSF ?? 0) || 0,
    department: room?.department ?? ''
  })).filter((room) => room.id || room.roomId);
}

function shrinkMoveScenarioInventory(inventory, options = {}) {
  if (!Array.isArray(inventory) || inventory.length === 0) return [];
  const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : 700;
  const maxPerBuilding = Number.isFinite(options.maxPerBuilding) ? options.maxPerBuilding : 120;
  const maxPerType = Number.isFinite(options.maxPerType) ? options.maxPerType : 30;

  const minimal = minifyMoveScenarioInventory(inventory);

  if (minimal.length <= maxTotal) return minimal;

  const bucketed = new Map();
  for (const room of minimal) {
    const buildingKey = normalizeDashboardKey(room.buildingLabel || '');
    const typeKey = normalizeTypeMatch(room.type || '') || 'other';
    if (!bucketed.has(buildingKey)) bucketed.set(buildingKey, new Map());
    const typeMap = bucketed.get(buildingKey);
    if (!typeMap.has(typeKey)) typeMap.set(typeKey, []);
    typeMap.get(typeKey).push(room);
  }

  const picked = [];
  const addRooms = (rooms, limit) => {
    if (!Array.isArray(rooms) || limit <= 0) return;
    rooms.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0));
    for (const r of rooms.slice(0, limit)) {
      picked.push(r);
      if (picked.length >= maxTotal) return;
    }
  };

  for (const [, typeMap] of bucketed.entries()) {
    if (picked.length >= maxTotal) break;
    let buildingCount = 0;
    for (const rooms of typeMap.values()) {
      if (picked.length >= maxTotal) break;
      const remainingBuilding = maxPerBuilding - buildingCount;
      if (remainingBuilding <= 0) break;
      const take = Math.min(maxPerType, remainingBuilding);
      addRooms(rooms, take);
      buildingCount += Math.min(rooms.length, take);
    }
  }

  if (picked.length >= maxTotal) return picked.slice(0, maxTotal);
  const seen = new Set(picked.map((r) => r.id || r.roomId));
  for (const r of minimal) {
    if (picked.length >= maxTotal) break;
    const key = r.id || r.roomId;
    if (seen.has(key)) continue;
    picked.push(r);
    seen.add(key);
  }
  return picked.slice(0, maxTotal);
}

function computeScenarioTotalsFromCandidates(candidates = []) {
  const totals = { totalSF: 0, rooms: 0, roomTypes: {}, sfByRoomType: {} };
  (candidates || []).forEach((c) => {
    const sf = Number(c?.sf ?? 0) || 0;
    const type = norm(c?.type ?? c?.roomType ?? 'Unknown') || 'Unknown';
    totals.rooms += 1;
    totals.totalSF += sf;
    totals.roomTypes[type] = (totals.roomTypes[type] || 0) + 1;
    totals.sfByRoomType[type] = (totals.sfByRoomType[type] || 0) + sf;
  });
  return totals;
}

function selectScenarioInventoryByBaseline(inventory, baselineTotals, options = {}) {
  if (!Array.isArray(inventory) || !baselineTotals) return inventory || [];
  const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : 180;
  const minPerType = Number.isFinite(options.minPerType) ? options.minPerType : 4;
  const maxPerType = Number.isFinite(options.maxPerType) ? options.maxPerType : 30;
  const baselineSfByType = baselineTotals?.sfByRoomType || {};
  const baselineRoomTypes = baselineTotals?.roomTypes || {};
  const baselineTotalSf = Number(baselineTotals?.totalSF ?? 0) || 0;
  const baselineTotalRooms = Number(baselineTotals?.rooms ?? 0) || 0;

  const typeTargets = Object.entries(baselineSfByType)
    .map(([type, sf]) => {
      const key = normalizeTypeMatch(type);
      const sfVal = Number(sf || 0) || 0;
      const countVal = Number(baselineRoomTypes[type] || 0) || 0;
      return { key, label: type, sf: sfVal, count: countVal };
    })
    .filter((t) => t.key);

  if (!typeTargets.length) {
    return shrinkMoveScenarioInventory(inventory, { maxTotal, maxPerBuilding: maxTotal, maxPerType });
  }

  typeTargets.sort((a, b) => (b.sf || 0) - (a.sf || 0));
  const desiredCounts = new Map();
  typeTargets.forEach((t) => {
    const sfShare = baselineTotalSf > 0 ? t.sf / baselineTotalSf : 0;
    const countShare = baselineTotalRooms > 0 ? t.count / baselineTotalRooms : 0;
    const sfTarget = Math.round(sfShare * maxTotal);
    const countTarget = Math.round(countShare * maxTotal);
    const desired = Math.max(minPerType, sfTarget, countTarget);
    desiredCounts.set(t.key, Math.min(maxPerType, desired));
  });

  const roomsByType = new Map();
  inventory.forEach((room) => {
    const typeKey = normalizeTypeMatch(room?.type ?? room?.roomType ?? '') || 'other';
    if (!roomsByType.has(typeKey)) roomsByType.set(typeKey, []);
    roomsByType.get(typeKey).push(room);
  });
  roomsByType.forEach((rooms) => rooms.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0)));

  const picked = [];
  const pickedKeys = new Set();
  const pushRoom = (room) => {
    const key = String(room?.roomId ?? room?.id ?? room?.revitId ?? '');
    if (!key || pickedKeys.has(key)) return;
    picked.push(room);
    pickedKeys.add(key);
  };

  for (const t of typeTargets) {
    if (picked.length >= maxTotal) break;
    const rooms = roomsByType.get(t.key) || [];
    const target = desiredCounts.get(t.key) || 0;
    let added = 0;
    for (const room of rooms) {
      if (picked.length >= maxTotal || added >= target) break;
      pushRoom(room);
      added += 1;
    }
  }

  if (picked.length >= maxTotal) return picked.slice(0, maxTotal);

  const remaining = [];
  roomsByType.forEach((rooms) => rooms.forEach((r) => {
    const key = String(r?.roomId ?? r?.id ?? r?.revitId ?? '');
    if (!key || pickedKeys.has(key)) return;
    remaining.push(r);
  }));
  remaining.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0));
  for (const room of remaining) {
    if (picked.length >= maxTotal) break;
    pushRoom(room);
  }
  return picked.slice(0, maxTotal);
}

function fillScenarioCandidatesToBaseline(candidates, inventory, baselineTotals, options = {}) {
  if (!baselineTotals || !Array.isArray(inventory)) {
    return { candidates: candidates || [], added: 0 };
  }
  const baseTotal = Number(baselineTotals.totalSF ?? 0) || 0;
  if (!baseTotal) return { candidates: candidates || [], added: 0 };

  const targetTolerance = Number.isFinite(options.targetTolerance) ? options.targetTolerance : 0.1;
  const targetMin = baseTotal * (1 - targetTolerance);
  const maxCandidates = Number.isFinite(options.maxCandidates) ? options.maxCandidates : 25;

  const next = Array.isArray(candidates) ? [...candidates] : [];
  const totals = computeScenarioTotalsFromCandidates(next);
  if (totals.totalSF >= targetMin || next.length >= maxCandidates) {
    return { candidates: next, added: 0 };
  }

  const usedKeys = new Set(next.map((c) => String(c?.roomId ?? c?.id ?? c?.revitId ?? '')));
  const roomsByType = new Map();
  inventory.forEach((room) => {
    const key = String(room?.roomId ?? room?.id ?? room?.revitId ?? '');
    if (!key || usedKeys.has(key)) return;
    const typeKey = normalizeTypeMatch(room?.type ?? room?.roomType ?? '') || 'other';
    if (!roomsByType.has(typeKey)) roomsByType.set(typeKey, []);
    roomsByType.get(typeKey).push(room);
  });
  roomsByType.forEach((rooms) => rooms.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0)));

  const baselineTypeOrder = Object.keys(baselineTotals.sfByRoomType || {})
    .map((t) => normalizeTypeMatch(t))
    .filter(Boolean);

  let added = 0;
  const addRoom = (room, reason) => {
    if (!room || next.length >= maxCandidates) return false;
    next.push({
      roomId: room?.roomId ?? room?.id ?? '',
      id: room?.id ?? room?.roomId ?? '',
      revitId: room?.revitId ?? room?.roomGuid ?? null,
      buildingLabel: room?.buildingLabel ?? '',
      floorId: room?.floorId ?? room?.floorName ?? '',
      floorName: room?.floorName ?? room?.floorId ?? '',
      roomLabel: room?.roomLabel ?? '',
      type: room?.type ?? '',
      sf: Number(room?.sf ?? 0) || 0,
      rationale: reason || 'Added to reach baseline target.'
    });
    totals.totalSF += Number(room?.sf ?? 0) || 0;
    added += 1;
    return true;
  };

  for (const typeKey of baselineTypeOrder) {
    if (totals.totalSF >= targetMin || next.length >= maxCandidates) break;
    const rooms = roomsByType.get(typeKey) || [];
    while (rooms.length && totals.totalSF < targetMin && next.length < maxCandidates) {
      const room = rooms.shift();
      addRoom(room, 'Added to better match baseline room-type mix.');
    }
  }

  if (totals.totalSF < targetMin && next.length < maxCandidates) {
    const remaining = [];
    roomsByType.forEach((rooms) => rooms.forEach((room) => remaining.push(room)));
    remaining.sort((a, b) => (Number(b.sf) || 0) - (Number(a.sf) || 0));
    for (const room of remaining) {
      if (totals.totalSF >= targetMin || next.length >= maxCandidates) break;
      addRoom(room, 'Added to reach baseline total SF.');
    }
  }

  return { candidates: next, added };
}

function sanitizeVacancyLanguage(text) {
  if (!text) return text;
  return String(text)
    .replace(/^\s*vacant\s*[:\-–]\s*/i, '')
    .replace(/^\s*vacant\?\s*[:\-–]\s*/i, '')
    .replace(/\bvacancy status\b/ig, 'availability')
    .replace(/\bvacant\b/ig, 'available');
}

function getGeojsonSource(map, id) {
  try {
    const src = map?.getSource(id);
    return src && typeof src.setData === 'function' ? src : null;
  } catch {
    return null;
  }
}

function buildInventoryFromFeatures(features, buildingLabel = '', floorId = '', limit = 1200) {
  if (!Array.isArray(features)) return null;
  return features.slice(0, limit).map((f, idx) => {
    const p = f?.properties || {};
    const idCandidate = f?.id ?? p.RevitId ?? p.id ?? p.roomId ?? p.RoomId;
    const roomLabel = String(
      p.roomNumber ?? p.RoomNumber ?? p.Number ?? p.Room ?? p.Name ?? ''
    ).trim();
    const type = getRoomTypeLabelFromProps(p) || 'Unknown';
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
      floorName: floorId || String(p.floorId ?? p.floor ?? p.Floor ?? '').trim(),
      roomLabel,
      type,
      sf,
      department: dept,
      occupant,
      vacancy: occupant ? 'Occupied' : 'Unknown',
      occupancyStatus: occupant ? 'Occupied' : 'Vacant',
      occupantDept: dept || null
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
    name:       getRoomTypeLabelFromProps(p) || p.Name || '',
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

    const snapCorner = getSnapCornerForBuilding(building);
    if (snapCorner) {
      const fitTransform = {
        rotationDeg: 0,
        rotationPivot: null,
        scale: 1,
        scaleOrigin: null,
        translateKm: 0,
        translateBearing: 0,
        nudgeMeters: null,
        refineRotationDeg: 0,
        refineRotationPivot: null,
        snapCorner
      };
      const rotationMode = getSnapRotationModeForBuilding(building);
      const snapPair = getSnapCornerPairForBuilding(building);
      const pairPrimary = Array.isArray(snapPair) ? snapPair[0] : null;
      const pairSecondary = Array.isArray(snapPair) ? snapPair[1] : null;
      const pairEnabled = Boolean(pairPrimary && pairSecondary);
      const pairMode = getSnapPairModeForBuilding(building);
      let working = roomsFC;
      let cRooms = turf.centroid(roomsFC);

      if (rotationMode !== 'none' && !pairEnabled) {
        const rotationDelta = getOrientationDeltaDeg(roomsFC, building);
        if (Number.isFinite(rotationDelta) && Math.abs(rotationDelta) > 1.5) {
          const rotationPivot = cRooms?.geometry?.coordinates || null;
          fitTransform.rotationDeg = rotationDelta;
          fitTransform.rotationPivot = rotationPivot;
          const rotated = turf.transformRotate(
            roomsFC,
            rotationDelta,
            rotationPivot ? { pivot: rotationPivot } : undefined
          );
          if (rotated?.features?.length) {
            working = rotated;
            cRooms = turf.centroid(working);
          }
        }
      }

      const [rxMin, ryMin, rxMax, ryMax] = turf.bbox(working);
      const [bxMin, byMin, bxMax, byMax] = turf.bbox(building);
      if (![rxMin, ryMin, rxMax, ryMax, bxMin, byMin, bxMax, byMax].every(Number.isFinite)) {
        return roomsFC;
      }

      const rW = Math.max(1e-9, rxMax - rxMin);
      const rH = Math.max(1e-9, ryMax - ryMin);
      const bW = Math.max(1e-9, bxMax - bxMin);
      const bH = Math.max(1e-9, byMax - byMin);

      const cornerMethod = getSnapCornerMethodForBuilding(building);
      const useDirectionalCorners = cornerMethod === 'directional';
      const roomCornersPre = useDirectionalCorners
        ? getDirectionalCorners(working)
        : getBboxCorners([rxMin, ryMin, rxMax, ryMax]);
      const buildingCornersPre = useDirectionalCorners
        ? getDirectionalCorners(building)
        : getBboxCorners([bxMin, byMin, bxMax, byMax]);
      let pairScale = null;
      let pairRotationDeg = 0;
      let pairRoomPrimary = null;
      let pairRoomSecondary = null;
      let pairBuildingPrimary = null;
      let pairBuildingSecondary = null;
      if (pairPrimary && pairSecondary && roomCornersPre && buildingCornersPre) {
        pairRoomPrimary = roomCornersPre[pairPrimary];
        pairRoomSecondary = roomCornersPre[pairSecondary];
        pairBuildingPrimary = buildingCornersPre[pairPrimary];
        pairBuildingSecondary = buildingCornersPre[pairSecondary];
        if (pairRoomPrimary && pairRoomSecondary && pairBuildingPrimary && pairBuildingSecondary) {
          const roomDistKm = turf.distance(
            turf.point(pairRoomPrimary),
            turf.point(pairRoomSecondary),
            { units: 'kilometers' }
          );
          const buildingDistKm = turf.distance(
            turf.point(pairBuildingPrimary),
            turf.point(pairBuildingSecondary),
            { units: 'kilometers' }
          );
          if (Number.isFinite(roomDistKm) && Number.isFinite(buildingDistKm) && roomDistKm > 0) {
            pairScale = buildingDistKm / roomDistKm;
          }
          const roomBearing = turf.bearing(turf.point(pairRoomPrimary), turf.point(pairRoomSecondary));
          const buildingBearing = turf.bearing(turf.point(pairBuildingPrimary), turf.point(pairBuildingSecondary));
          const delta = ((buildingBearing - roomBearing + 540) % 360) - 180;
          if (Number.isFinite(delta)) pairRotationDeg = delta;
        }
      }

      const scaleOrigin = pairRoomPrimary || cRooms?.geometry?.coordinates || null;
      fitTransform.scaleOrigin = scaleOrigin;

      const FIT_MARGIN = 0.96; // 96% of building bbox
      const scaleMultiplier = getSnapScaleMultiplierForBuilding(building);
      const baseScale = Math.min(bW / rW, bH / rH) * FIT_MARGIN;
      const usePairScale = pairMode !== 'legacy' && Number.isFinite(pairScale) && pairScale > 0;
      const scale = (usePairScale ? pairScale : baseScale) * scaleMultiplier;
      const forceScale = usePairScale || Math.abs(scaleMultiplier - 1) > 1e-6;
      const shouldScale = forceScale || scale < 0.9 || scale > 1.1;
      fitTransform.scale = shouldScale ? scale : 1;

      let fitted = shouldScale
        ? turf.transformScale(working, scale, scaleOrigin ? { origin: scaleOrigin } : undefined)
        : working;

      const snapRotationOffset = getSnapRotationOffsetForBuilding(building);
      const pairRotationTotal =
        (Number.isFinite(pairRotationDeg) ? pairRotationDeg : 0) +
        (Number.isFinite(snapRotationOffset) ? snapRotationOffset : 0);
      if (
        pairEnabled &&
        pairMode !== 'legacy' &&
        Number.isFinite(pairRotationTotal) &&
        Math.abs(pairRotationTotal) > 1e-6 &&
        Array.isArray(scaleOrigin)
      ) {
        fitted = turf.transformRotate(fitted, pairRotationTotal, { pivot: scaleOrigin });
        fitTransform.rotationDeg = pairRotationTotal;
        fitTransform.rotationPivot = scaleOrigin;
      }

      const fittedBBox = !useDirectionalCorners ? turf.bbox(fitted) : null;
      const roomCorners = useDirectionalCorners
        ? getDirectionalCorners(fitted)
        : getBboxCorners(fittedBBox);
      const buildingCorners = buildingCornersPre || (useDirectionalCorners
        ? getDirectionalCorners(building)
        : getBboxCorners([bxMin, byMin, bxMax, byMax]));
      if (roomCorners && buildingCorners) {
        const usePair = pairPrimary === snapCorner && pairSecondary;
        const fromCoords = usePair ? roomCorners[pairPrimary] : roomCorners[snapCorner];
        const toCoords = usePair ? buildingCorners[pairPrimary] : buildingCorners[snapCorner];
        if (fromCoords && toCoords) {
          const fromPt = turf.point(fromCoords);
          const toPt = turf.point(toCoords);
          const distKm = turf.distance(fromPt, toPt, { units: 'kilometers' });
          const bearing = turf.bearing(fromPt, toPt);
          if (Number.isFinite(distKm) && Number.isFinite(bearing)) {
            fitted = distKm > 0
              ? turf.transformTranslate(fitted, distKm, bearing, { units: 'kilometers' })
              : fitted;
            fitTransform.translateKm = distKm;
            fitTransform.translateBearing = bearing;
          }
        }
        if (pairEnabled && usePair && pairMode !== 'legacy' && pairMode !== 'match') {
          const postRoomPrimary = roomCorners[pairPrimary];
          const postBuildingPrimary = buildingCorners[pairPrimary];
          if (postRoomPrimary && postBuildingPrimary) {
            const extraDistKm = turf.distance(
              turf.point(postRoomPrimary),
              turf.point(postBuildingPrimary),
              { units: 'kilometers' }
            );
            const extraBearing = turf.bearing(
              turf.point(postRoomPrimary),
              turf.point(postBuildingPrimary)
            );
            if (
              Number.isFinite(extraDistKm) &&
              Number.isFinite(extraBearing) &&
              extraDistKm > 1e-9
            ) {
              fitted = turf.transformTranslate(fitted, extraDistKm, extraBearing, { units: 'kilometers' });
              fitTransform.translateKm = (fitTransform.translateKm || 0) + extraDistKm;
              fitTransform.translateBearing = extraBearing;
            }
          }
        }

      }

      const snapPivot = pairBuildingPrimary || buildingCorners?.[snapCorner] || null;
      if (
        pairEnabled &&
        pairMode === 'legacy' &&
        Number.isFinite(pairRotationTotal) &&
        Math.abs(pairRotationTotal) > 1e-6 &&
        snapPivot
      ) {
        fitted = turf.transformRotate(fitted, pairRotationTotal, { pivot: snapPivot });
        fitTransform.refineRotationDeg =
          (fitTransform.refineRotationDeg || 0) + pairRotationTotal;
        fitTransform.refineRotationPivot = snapPivot;
      }
      if (snapPivot && rotationMode !== 'none' && !pairEnabled) {
        const refinedResult = refineRotationToBuilding(fitted, building, snapPivot, {
          maxDeg: 6,
          stepDeg: 0.4,
          fineStep: 0.1,
          fineWindow: 1.5,
          hullLimit: 1200
        });
        if (refinedResult?.fc) {
          fitted = refinedResult.fc;
        }
        fitTransform.refineRotationDeg = refinedResult?.angle || 0;
        fitTransform.refineRotationPivot = snapPivot;
      }

      if (!pairEnabled) {
        if (
          Number.isFinite(snapRotationOffset) &&
          Math.abs(snapRotationOffset) > 1e-6 &&
          snapPivot
        ) {
          fitted = turf.transformRotate(fitted, snapRotationOffset, { pivot: snapPivot });
          fitTransform.refineRotationDeg =
            (fitTransform.refineRotationDeg || 0) + snapRotationOffset;
          fitTransform.refineRotationPivot = snapPivot;
        }
      }

      const nudgeMeters = getSnapNudgeMetersForBuilding(building);
      if (Array.isArray(nudgeMeters)) {
        fitted = applyNudgeMeters(fitted, nudgeMeters);
        fitTransform.nudgeMeters = nudgeMeters;
      }

      if (fitted && typeof fitted === 'object') {
        fitted.__mfFitted = true;
        fitted.__mfFittedBuilding = building?.properties?.id || building?.properties?.name || '';
        fitted.__mfFitTransform = fitTransform;
        if (roomsFC.__mfAffineApplied) fitted.__mfAffineApplied = roomsFC.__mfAffineApplied;
        if (roomsFC.__mfRotationOverride != null) fitted.__mfRotationOverride = roomsFC.__mfRotationOverride;
        if (roomsFC.__mfRotationPivot) fitted.__mfRotationPivot = roomsFC.__mfRotationPivot;
        if (roomsFC.__mfFitTransformApplied) fitted.__mfFitTransformApplied = roomsFC.__mfFitTransformApplied;
      }
      return fitted;
    }

    let cRooms = turf.centroid(roomsFC);
    const cBldg = turf.centroid(building);
    const fitTransform = {
      rotationDeg: 0,
      rotationPivot: null,
      scale: 1,
      scaleOrigin: null,
      translateKm: 0,
      translateBearing: 0,
      nudgeMeters: null,
      refineRotationDeg: 0,
      refineRotationPivot: null
    };

    const rotationDelta = getOrientationDeltaDeg(roomsFC, building);
    if (Number.isFinite(rotationDelta) && Math.abs(rotationDelta) > 1.5) {
      const rotationPivot = cRooms?.geometry?.coordinates || null;
      fitTransform.rotationDeg = rotationDelta;
      fitTransform.rotationPivot = rotationPivot;
      const rotated = turf.transformRotate(
        roomsFC,
        rotationDelta,
        rotationPivot ? { pivot: rotationPivot } : undefined
      );
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
  const scaleMultiplier = getSnapScaleMultiplierForBuilding(building);
  const scale = Math.min(bW / rW, bH / rH) * FIT_MARGIN * scaleMultiplier;
  const shouldScale = scale < 0.9 || scale > 1.1;

    const scaleOrigin = cRooms?.geometry?.coordinates || null;
    fitTransform.scale = shouldScale ? scale : 1;
    fitTransform.scaleOrigin = scaleOrigin;
    let fitted = shouldScale
      ? turf.transformScale(roomsFC, scale, scaleOrigin ? { origin: scaleOrigin } : undefined)
      : roomsFC;

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

  if (snapCorner && hasValidFittedBBox) {
    const cornerMethod = getSnapCornerMethodForBuilding(building);
    const useDirectionalCorners = cornerMethod === 'directional';
    const roomCorners = useDirectionalCorners
      ? getDirectionalCorners(fitted)
      : getBboxCorners(fittedBBox);
    const buildingCorners = useDirectionalCorners
      ? getDirectionalCorners(building)
      : getBboxCorners([bxMin, byMin, bxMax, byMax]);
    if (roomCorners && buildingCorners) {
      const fromCoords = roomCorners[snapCorner];
      const toCoords = buildingCorners[snapCorner];
      if (fromCoords && toCoords) {
        const fromPt = turf.point(fromCoords);
        const toPt = turf.point(toCoords);
        const distKm = turf.distance(fromPt, toPt, { units: 'kilometers' });
        const bearing = turf.bearing(fromPt, toPt);
        if (Number.isFinite(distKm) && Number.isFinite(bearing)) {
          fitted = distKm > 0
            ? turf.transformTranslate(fitted, distKm, bearing, { units: 'kilometers' })
            : fitted;
          fitTransform.translateKm = distKm;
          fitTransform.translateBearing = bearing;
          fitTransform.snapCorner = snapCorner;
        }
      }
    }
  } else {
    const candidates = [];
    const addCandidate = (label, fromCoords, toCoords) => {
      if (!Array.isArray(fromCoords) || !Array.isArray(toCoords)) return;
      const fromPt = turf.point(fromCoords);
      const toPt = turf.point(toCoords);
      const distKm = turf.distance(fromPt, toPt, { units: 'kilometers' });
      const bearing = turf.bearing(fromPt, toPt);
      if (!Number.isFinite(distKm) || !Number.isFinite(bearing)) return;
      const translated = distKm > 0
        ? turf.transformTranslate(fitted, distKm, bearing, { units: 'kilometers' })
        : fitted;
      const hull = buildHullFeature(translated, 1200);
      const score = hull ? overlapScore(hull, building) : 0;
      candidates.push({ label, distKm, bearing, fc: translated, score });
    };

    if (hasValidFittedBBox && hasValidBuildingCenter) {
      const roomsCenter = [
        (fittedBBox[0] + fittedBBox[2]) / 2,
        (fittedBBox[1] + fittedBBox[3]) / 2
      ];
      addCandidate('center', roomsCenter, buildingCenter);
      const cornerMethod = getSnapCornerMethodForBuilding(building);
      const useDirectionalCorners = cornerMethod === 'directional';
      const roomCorners = useDirectionalCorners
        ? getDirectionalCorners(fitted)
        : getBboxCorners(fittedBBox);
      const buildingCorners = useDirectionalCorners
        ? getDirectionalCorners(building)
        : getBboxCorners([bxMin, byMin, bxMax, byMax]);
      if (roomCorners && buildingCorners) {
        Object.keys(roomCorners).forEach((corner) => {
          addCandidate(`corner-${corner}`, roomCorners[corner], buildingCorners[corner]);
        });
      }
    } else {
      addCandidate('centroid', cRooms?.geometry?.coordinates, cBldg?.geometry?.coordinates);
    }

    if (candidates.length) {
      const best = candidates.reduce((acc, cur) => {
        if (!acc) return cur;
        if (cur.score > acc.score + 1e-6) return cur;
        if (Math.abs(cur.score - acc.score) <= 1e-6 && cur.distKm < acc.distKm) return cur;
        return acc;
      }, null);
      if (best?.fc) {
        fitted = best.fc;
        fitTransform.translateKm = best.distKm;
        fitTransform.translateBearing = best.bearing;
      }
    }
  }

    const buildingPivot = cBldg?.geometry?.coordinates || buildingCenter;
    const refinedResult = refineRotationToBuilding(fitted, building, buildingPivot, {
      maxDeg: 6,
      stepDeg: 0.4,
      fineStep: 0.1,
      fineWindow: 1.5,
      hullLimit: 1200
    });
    const refined = refinedResult?.fc || fitted;
    fitTransform.refineRotationDeg = refinedResult?.angle || 0;
    fitTransform.refineRotationPivot = buildingPivot;

    if (refined && typeof refined === 'object') {
      refined.__mfFitted = true;
      refined.__mfFittedBuilding = building?.properties?.id || building?.properties?.name || '';
      refined.__mfFitTransform = fitTransform;
      if (roomsFC.__mfAffineApplied) refined.__mfAffineApplied = roomsFC.__mfAffineApplied;
      if (roomsFC.__mfRotationOverride != null) refined.__mfRotationOverride = roomsFC.__mfRotationOverride;
      if (roomsFC.__mfRotationPivot) refined.__mfRotationPivot = roomsFC.__mfRotationPivot;
      if (roomsFC.__mfFitTransformApplied) refined.__mfFitTransformApplied = roomsFC.__mfFitTransformApplied;
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

function collectLngLatPairsFromGeoJSON(input, limit = Infinity) {
  if (!input) return [];
  if (input.type === 'FeatureCollection') {
    const pts = [];
    for (const f of input.features || []) {
      if (pts.length >= limit) break;
      const next = extractLngLatPairs(f.geometry, limit - pts.length);
      if (next?.length) pts.push(...next);
    }
    return pts;
  }
  if (input.type === 'Feature') return extractLngLatPairs(input.geometry, limit);
  if (input.type) return extractLngLatPairs(input, limit);
  return [];
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
  if (!roomsFC || !buildingFeature || !pivot) return { fc: roomsFC, angle: 0 };
  const maxDeg = Number.isFinite(options.maxDeg) ? options.maxDeg : 5;
  const stepDeg = Number.isFinite(options.stepDeg) ? options.stepDeg : 0.5;
  const fineStep = Number.isFinite(options.fineStep) ? options.fineStep : 0.1;
  const fineWindow = Number.isFinite(options.fineWindow) ? options.fineWindow : 1.2;
  const hull = buildHullFeature(roomsFC, options.hullLimit || 1200);
  if (!hull) return { fc: roomsFC, angle: 0 };
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

  if (Math.abs(bestAngle) < 1e-3) return { fc: roomsFC, angle: 0 };
  const rotated = turf.transformRotate(roomsFC, bestAngle, { pivot });
  return {
    fc: rotated?.features?.length ? rotated : roomsFC,
    angle: bestAngle
  };
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

function getBboxCorners(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [minX, minY, maxX, maxY] = bbox;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return {
    nw: [minX, maxY],
    ne: [maxX, maxY],
    sw: [minX, minY],
    se: [maxX, minY]
  };
}

function getDirectionalCorners(input, limit = 4000) {
  let target = input;
  if (input?.type === 'FeatureCollection') {
    const hull = buildHullFeature(input, limit);
    if (hull?.geometry) {
      target = hull;
    }
  }
  const pts = collectLngLatPairsFromGeoJSON(target, limit);
  if (!pts.length) return null;
  const dirs = {
    nw: [-1, 1],
    ne: [1, 1],
    sw: [-1, -1],
    se: [1, -1]
  };
  const best = {
    nw: { score: -Infinity, pt: null },
    ne: { score: -Infinity, pt: null },
    sw: { score: -Infinity, pt: null },
    se: { score: -Infinity, pt: null }
  };
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    for (const key of Object.keys(dirs)) {
      const [dx, dy] = dirs[key];
      const score = (x * dx) + (y * dy);
      if (score > best[key].score) {
        best[key] = { score, pt: [x, y] };
      }
    }
  }
  return {
    nw: best.nw.pt,
    ne: best.ne.pt,
    sw: best.sw.pt,
    se: best.se.pt
  };
}

function normalizeSnapKey(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\bmemorial\b/g, '')
    .replace(/\bresidence\b/g, '')
    .replace(/\bresidency\b/g, '')
    .replace(/\b[a-z]\b/g, '')
    .replace(/theatre/g, 'theater')
    .replace(/centre/g, 'center')
    .replace(/[^a-z0-9]/g, '');
}

const BUILDING_SNAP_CONFIGS = [
  {
    keys: ['Morrison Reeves', 'Morrison-Reeves Science Center'],
    corner: 'nw',
    cornerMethod: 'directional',
    cornerPair: ['nw', 'sw'],
    pairMode: 'match',
    rotationMode: 'none'
  },
  {
    keys: ['Calvin French Chapel', 'Calvin H. French Chapel', 'French Memorial Chapel'],
    corner: 'nw',
    cornerMethod: 'directional',
    cornerPair: ['nw', 'sw'],
    pairMode: 'match'
  }
];

function buildSnapMap(configs, field) {
  const out = {};
  configs.forEach((cfg) => {
    if (!cfg || !cfg.keys || cfg[field] == null) return;
    cfg.keys.forEach((key) => {
      const norm = normalizeSnapKey(key);
      if (!norm) return;
      out[norm] = cfg[field];
    });
  });
  return out;
}

const BUILDING_AFFINE_SKIP = new Set([]);

const BUILDING_FORCE_FIT = new Set([
  normalizeSnapKey('Calvin French Chapel'),
  normalizeSnapKey('Calvin H. French Chapel'),
  normalizeSnapKey('Calvin H. French Memorial Chapel'),
  normalizeSnapKey('Kiewit Building'),
  normalizeSnapKey('Taylor Hall'),
  normalizeSnapKey('Taylor Hall Residence')
]);

function shouldSkipAffine({ buildingLabel } = {}) {
  const key = normalizeSnapKey(buildingLabel);
  return key && BUILDING_AFFINE_SKIP.has(key);
}

let campusBuildingsCache = null;
async function loadCampusBuildings() {
  if (campusBuildingsCache) return campusBuildingsCache;
  try {
    const candidates = [
      assetUrl('Hastings_College_Buildings.json'),
      '/Hastings_College_Buildings.json',
      'Hastings_College_Buildings.json'
    ];
    const result = await fetchFirstOk(candidates);
    if (result?.ok && result.data && Array.isArray(result.data.features)) {
      campusBuildingsCache = result.data;
      return result.data;
    }
  } catch {}
  return null;
}

function getBuildingFolderFromBasePath(basePath) {
  const decoded = (() => {
    try {
      return decodeURIComponent(String(basePath || ''));
    } catch {
      return String(basePath || '');
    }
  })();
  const parts = decoded.split('/').filter(Boolean);
  if (!parts.length) return '';
  const floorIdx = parts.indexOf('floorplans');
  if (floorIdx >= 0 && parts.length > floorIdx + 2) return parts[floorIdx + 2];
  return parts[parts.length - 1] || '';
}

function getSnapCornerForBuilding(buildingFeature) {
  if (!buildingFeature) return null;
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && BUILDING_SNAP_CORNERS[key]) return BUILDING_SNAP_CORNERS[key];
  }
  return null;
}

function getSnapRotationOffsetForBuilding(buildingFeature) {
  if (!buildingFeature) return null;
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && Number.isFinite(BUILDING_SNAP_ROTATION_OFFSETS[key])) {
      return BUILDING_SNAP_ROTATION_OFFSETS[key];
    }
  }
  return null;
}

function getSnapCornerMethodForBuilding(buildingFeature) {
  if (!buildingFeature) return 'bbox';
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && BUILDING_SNAP_CORNER_METHODS[key]) {
      return BUILDING_SNAP_CORNER_METHODS[key];
    }
  }
  return 'bbox';
}

function getSnapCornerPairForBuilding(buildingFeature) {
  if (!buildingFeature) return null;
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && BUILDING_SNAP_CORNER_PAIRS[key]) {
      return BUILDING_SNAP_CORNER_PAIRS[key];
    }
  }
  return null;
}

function getSnapPairModeForBuilding(buildingFeature) {
  if (!buildingFeature) return 'match';
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && BUILDING_SNAP_PAIR_MODES[key]) {
      return BUILDING_SNAP_PAIR_MODES[key];
    }
  }
  return 'match';
}

function getSnapRotationModeForBuilding(buildingFeature) {
  if (!buildingFeature) return 'auto';
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    if (key && BUILDING_SNAP_ROTATION_MODES[key]) {
      return BUILDING_SNAP_ROTATION_MODES[key];
    }
  }
  return 'auto';
}

function getSnapScaleMultiplierForBuilding(buildingFeature) {
  if (!buildingFeature) return 1;
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    const multiplier = BUILDING_SNAP_SCALE_MULTIPLIERS[key];
    if (key && Number.isFinite(multiplier)) {
      return multiplier;
    }
  }
  return 1;
}

function getSnapNudgeMetersForBuilding(buildingFeature) {
  if (!buildingFeature) return null;
  const props = buildingFeature.properties || {};
  const candidates = [
    props.id,
    props.name,
    props.Name,
    props.buildingId,
    props.buildingName,
    props.Building,
    props.building
  ];
  for (const value of candidates) {
    const key = normalizeSnapKey(value);
    const nudge = BUILDING_SNAP_NUDGE_METERS[key];
    if (key && Array.isArray(nudge) && nudge.length >= 2) {
      return nudge;
    }
  }
  return null;
}

function matchBuildingFeature(features = [], input) {
  if (!Array.isArray(features) || !features.length || !input) return null;
  const targetKey = normalizeSnapKey(input);
  if (!targetKey) return null;
  let best = null;
  let bestScore = 0;
  for (const feature of features) {
    const props = feature?.properties || {};
    const keys = [
      normalizeSnapKey(props.id),
      normalizeSnapKey(props.name),
      normalizeSnapKey(props.Name),
      normalizeSnapKey(props.buildingId),
      normalizeSnapKey(props.buildingName),
      normalizeSnapKey(props.Building),
      normalizeSnapKey(props.building)
    ].filter(Boolean);
    for (const key of keys) {
      if (!key) continue;
      const direct = key === targetKey;
      const contains = key.includes(targetKey) || targetKey.includes(key);
      if (!direct && !contains) continue;
      const score = key.length;
      if (score > bestScore) {
        best = feature;
        bestScore = score;
      }
    }
  }
  return best;
}

function shouldFitFloorplanToBuilding(roomsFC, buildingFeature) {
  try {
    if (!roomsFC || !roomsFC.features?.length || !buildingFeature) return false;
    if (roomsFC.__mfGeoreferenced || roomsFC.__mfNoFit) return false;
    const forceKey = normalizeSnapKey(buildingFeature?.properties?.id || buildingFeature?.properties?.name || '');
    if (forceKey && BUILDING_FORCE_FIT.has(forceKey)) return true;
    if (getSnapCornerForBuilding(buildingFeature)) return true;
    if (roomsFC?.__mfFitted) return false;
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
    const diagKm = turf.distance(
      turf.point([bxMin, byMin]),
      turf.point([bxMax, byMax]),
      { units: 'kilometers' }
    );
    const offsetRatio = Number.isFinite(distKm) && Number.isFinite(diagKm) && diagKm > 0
      ? distKm / diagKm
      : 0;
    const offsetMismatch = offsetRatio > 0.18;

    const noOverlap =
      rxMax < bxMin ||
      rxMin > bxMax ||
      ryMax < byMin ||
      ryMin > byMax;

    const rotationDelta = getOrientationDeltaDeg(roomsFC, buildingFeature);
    const needsRotation = Number.isFinite(rotationDelta) && Math.abs(rotationDelta) > 1.5;

    const hull = buildHullFeature(roomsFC, 1200);
    const overlap = hull ? overlapScore(hull, buildingFeature) : 1;
    const lowOverlap = overlap > 0 && overlap < 0.85;

    return scaleMismatch || farApart || noOverlap || needsRotation || offsetMismatch || lowOverlap;
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
  { name: 'Bronco Village Apt 911', folder: 'Bronco Village Apt 911' },
  { name: 'Bronco Village Apt 915', folder: 'Bronco Village Apt 915' },
  { name: 'Bronco Village Apt 917', folder: 'Bronco Village Apt 917' },
  { name: 'Bronco Village Apt 919', folder: 'Bronco Village Apt 919' },
  { name: 'Bronco Village Apt 921', folder: 'Bronco Village Apt 921' },
  { name: 'Bronco Village Apt 923', folder: 'Bronco Village Apt 923' },
  { name: 'Calvin H. French Chapel', folder: 'Calvin French Chapel' },
  { name: 'Daugherty Student Engagement Center', folder: 'Daugherty' },
  { name: 'Farrell-Fleharty', folder: 'Fleharty' },
  { name: 'Hazelrigg Student Union', folder: 'Hazzelrig' },
  { name: 'Jackson Dinsdale Art Center', folder: 'Jackson Dinsdale' },
  { name: 'Kiewit Building', folder: 'Kiewit' },
  { name: 'Lloyd Wilson Stadium', folder: 'Lloyd Wilson Stadium' },
  { name: 'McCormick Hall', folder: 'McCormick' },
  { name: 'Perkins Library', folder: 'Perkins' },
  { name: 'Physical Fitness Facility', folder: 'Physical Fitness Facility' },
  { name: 'Scott Studio Theater', folder: 'Scott Theater' },
  { name: 'Stone Health Center', folder: 'Stone Health Center' },
  { name: 'Taylor Hall', folder: 'Taylor Hall' },
  { name: 'Wilson Center', folder: 'WilsonCenter' },

  // add more as you add folders...
];

const BUILDING_FOLDER_MAP = Object.fromEntries(
  BUILDINGS_LIST.map((b) => [b.name, b.folder])
);
const BUILDING_FOLDER_SET = new Set(BUILDINGS_LIST.map((b) => b.folder));
const BUILDING_FOLDER_TO_NAME = Object.fromEntries(
  BUILDINGS_LIST.map((b) => [b.folder, b.name])
);

const normalizeBuildingBase = (value) =>
  String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/theatre/g, 'theater')
    .replace(/centre/g, 'center')
    .replace(/\bmemorial\b/g, '');
const normalizeBuildingKey = (value) =>
  normalizeBuildingBase(value).replace(/[^a-z0-9]/g, '');
const normalizeBuildingKeyLoose = (value) =>
  normalizeBuildingBase(value)
    .replace(/\b[a-z]\b/gi, '')
    .replace(/[^a-z0-9]/g, '');

const resolveBuildingNameStrict = (value) => {
  if (!value) return null;
  const normalized = normalizeBuildingKey(value);
  if (!normalized) return null;
  const aliasMatch = BUILDING_ALIAS_NORMALIZED?.[normalized];
  if (aliasMatch && BUILDING_FOLDER_MAP[aliasMatch]) return aliasMatch;
  for (const name of Object.keys(BUILDING_FOLDER_MAP)) {
    if (normalizeBuildingKey(name) === normalized) return name;
  }
  return null;
};

const resolveBuildingNameFromInput = (idOrName) => {
  if (!idOrName) return null;
  if (BUILDING_FOLDER_MAP[idOrName]) return idOrName;
  if (BUILDING_FOLDER_SET.has(idOrName)) return BUILDING_FOLDER_TO_NAME[idOrName] || null;
  const aliasMatch = BUILDING_ALIAS_REVERSE[idOrName];
  if (aliasMatch && BUILDING_FOLDER_MAP[aliasMatch]) return aliasMatch;
  const normalizedInput = normalizeBuildingKey(idOrName);
  const looseInput = normalizeBuildingKeyLoose(idOrName);
  const normalizedAlias =
    (normalizedInput && BUILDING_ALIAS_NORMALIZED?.[normalizedInput]) ||
    (looseInput && BUILDING_ALIAS_NORMALIZED_LOOSE?.[looseInput]) ||
    null;
  if (normalizedAlias && BUILDING_FOLDER_MAP[normalizedAlias]) return normalizedAlias;
  let best = null;
  let bestScore = 0;
  for (const name of Object.keys(BUILDING_FOLDER_MAP)) {
    const normalizedName = normalizeBuildingKey(name);
    const looseName = normalizeBuildingKeyLoose(name);
    const directMatch =
      normalizedInput === normalizedName || looseInput === looseName;
    const containsMatch =
      (normalizedInput && normalizedName &&
        (normalizedInput.includes(normalizedName) || normalizedName.includes(normalizedInput))) ||
      (looseInput && looseName &&
        (looseInput.includes(looseName) || looseName.includes(looseInput)));
    if (!directMatch && !containsMatch) continue;
    const score = normalizedName.length;
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
};

const BUILDING_ALIAS = {
  '1882': 'The 1882 Residence Hall',
  'Altman Hall': 'Altman Hall Residency',
  'Babcock Hall': 'Babcock Hall Residence',
  'Barrett Alumni': 'Barrett Alumni Center',
  'Batchelder Services Bldg': 'Batchelder General Services',
  'Bronc Hall': 'Bronc Hall Residence',
  'Hurley-McDonald Hall': 'hurley_mcdonald',
  'Gray Center': 'gray_center',
  'Hazelrigg Student Union': 'Hazelrigg Student Union',
  'Lloyd Wilson Stadium': 'Lloyd Wilson Field/Stadium',
  'Morrison-Reeves Science Center': 'morrison_reeves',
  'Scott Studio Theater': 'Scott Studio Theatre',
  'Stone Health Center': 'The Stone Health Center',
  'Taylor Hall': 'Taylor Hall Residence',
  'Wilson Center': 'wilson_center',
  'Farrell-Fleharty': 'Lynn Farrell Arena/Fleharty Educational Center',
  'Calvin H. French Chapel': 'Calvin French Chapel',
  'Bronco Village Apt 911': 'Bronco Village Apartments 1',
  'Bronco Village Apt 915': 'Bronco Village Apartments 2',
  'Bronco Village Apt 917': 'Bronco Village Apartments 3',
  'Bronco Village Apt 919': 'Bronco Village Apartments 4',
  'Bronco Village Apt 921': 'Bronco Village Apartments 5',
  'Bronco Village Apt 923': 'Bronco Village Apartments 6',
};
const BUILDING_ALIAS_REVERSE = {
  ...Object.fromEntries(Object.entries(BUILDING_ALIAS).map(([name, alias]) => [alias, name])),
  'Farrell Arena Fleharty Educational Center': 'Farrell-Fleharty',
  'Daugherty Center for Student Engagement': 'Daugherty Student Engagement Center',
  'Daugherty Center For Student Engagement': 'Daugherty Student Engagement Center',
  'Fleharty Center': 'Farrell-Fleharty',
  'Calvin H. French Memorial Chapel': 'Calvin H. French Chapel',
  'French Memorial Chapel': 'Calvin H. French Chapel',
  'Hazzelrig Student Union': 'Hazelrigg Student Union',
  'Hazelrigg Student Union': 'Hazelrigg Student Union',
  'Kiewit': 'Kiewit Building',
  'Scott Theatre': 'Scott Studio Theater',
  'Scott Theater': 'Scott Studio Theater',
  'Wilson Math and Computer Sci Center': 'Wilson Center'
};
const BUILDING_ALIAS_NORMALIZED = Object.fromEntries(
  Object.entries(BUILDING_ALIAS_REVERSE).map(([alias, name]) => [normalizeBuildingKey(alias), name])
);
const BUILDING_ALIAS_NORMALIZED_LOOSE = Object.fromEntries(
  Object.entries(BUILDING_ALIAS_REVERSE).map(([alias, name]) => [normalizeBuildingKeyLoose(alias), name])
);

const UTILIZATION_CSV_PATH = 'Data/Utilization/classroom_utilization.csv';

const parseCsvLine = (line) => {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
};

const parseNumber = (value) => {
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const parsePercent = (value) => {
  const cleaned = String(value ?? '').replace(/[%\s]/g, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const normalizeUtilizationRoomKey = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (/^0+\d+$/.test(raw)) return String(Number(raw));
  return raw;
};

const buildUtilizationKey = (buildingName, roomLabel) =>
  `${buildingName}||${normalizeUtilizationRoomKey(roomLabel)}`;

const parseUtilizationCsv = (csvText = '') => {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { buildings: {}, rooms: {}, campus: null };

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idxName = header.findIndex((h) => h.toLowerCase().includes('building'));
  const idxWeekly = header.findIndex((h) => h.toLowerCase().includes('weekly'));
  const idxEnroll = header.findIndex((h) => h.toLowerCase().includes('enrollment'));
  const idxCapacity = header.findIndex((h) => h.toLowerCase().includes('capacity'));
  const idxTime = header.findIndex((h) => h.toLowerCase().includes('time'));
  const idxSeat = header.findIndex((h) => h.toLowerCase().includes('seat'));
  const idxOverall = header.findIndex((h) => h.toLowerCase().includes('overall'));

  if (idxName < 0) return { buildings: {}, rooms: {}, campus: null };

  const buildings = {};
  const rooms = {};
  let campus = null;
  let currentBuilding = null;

  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const rawName = (row[idxName] ?? '').trim();
    if (!rawName) continue;
    if (/^grand total$/i.test(rawName)) {
      campus = {
        weeklyHours: parseNumber(row[idxWeekly]),
        finalEnrollment: parseNumber(row[idxEnroll]),
        totalCapacity: parseNumber(row[idxCapacity]),
        timeUtilization: parsePercent(row[idxTime]),
        seatUtilization: parsePercent(row[idxSeat]),
        overallUtilization: parsePercent(row[idxOverall])
      };
      currentBuilding = null;
      continue;
    }

    const strictBuilding = resolveBuildingNameStrict(rawName);
    const resolvedBuilding = strictBuilding || null;
    const weeklyHours = parseNumber(row[idxWeekly]);
    const finalEnrollment = parseNumber(row[idxEnroll]);
    const totalCapacity = parseNumber(row[idxCapacity]);
    const timeUtilization = parsePercent(row[idxTime]);
    const seatUtilization = parsePercent(row[idxSeat]);
    const overallUtilization = parsePercent(row[idxOverall]);

    if (resolvedBuilding) {
      currentBuilding = resolvedBuilding;
      buildings[resolvedBuilding] = {
        weeklyHours,
        finalEnrollment,
        totalCapacity,
        timeUtilization,
        seatUtilization,
        overallUtilization
      };
      continue;
    }

    if (!currentBuilding) continue;
    const roomKey = buildUtilizationKey(currentBuilding, rawName);
    rooms[roomKey] = {
      building: currentBuilding,
      roomLabel: rawName,
      weeklyHours,
      finalEnrollment,
      totalCapacity,
      timeUtilization,
      seatUtilization,
      overallUtilization
    };
  }

  return { buildings, rooms, campus };
};

const BUILDING_SNAP_CORNERS = {
  [normalizeSnapKey('Babcock Hall')]: 'nw',
  [normalizeSnapKey('Babcock Hall Residence')]: 'nw',
  [normalizeSnapKey('Gray Center')]: 'sw',
  [normalizeSnapKey('Lloyd Wilson Stadium')]: 'nw',
  [normalizeSnapKey('Lloyd Wilson Field/Stadium')]: 'nw',
  [normalizeSnapKey('Stone Health Center')]: 'nw',
  [normalizeSnapKey('The Stone Health Center')]: 'nw',
  [normalizeSnapKey('McCormick Hall')]: 'nw',
  [normalizeSnapKey('Jackson Dinsdale Art Center')]: 'nw',
  [normalizeSnapKey('Farrell-Fleharty')]: 'nw',
  [normalizeSnapKey('Lynn Farrell Arena/Fleharty Educational Center')]: 'nw',
  ...buildSnapMap(BUILDING_SNAP_CONFIGS, 'corner')
};

const BUILDING_SNAP_ROTATION_OFFSETS = {
  // Manual clockwise adjustments for snapped buildings.
  [normalizeSnapKey('Gray Center')]: 0,
  [normalizeSnapKey('McCormick Hall')]: 90
};

const BUILDING_SNAP_CORNER_METHODS = {
  // Use directional extremes for odd/rotated footprints.
  [normalizeSnapKey('Gray Center')]: 'directional',
  [normalizeSnapKey('Lloyd Wilson Stadium')]: 'directional',
  [normalizeSnapKey('Lloyd Wilson Field/Stadium')]: 'directional',
  ...buildSnapMap(BUILDING_SNAP_CONFIGS, 'cornerMethod')
};

const BUILDING_SNAP_CORNER_PAIRS = {
  // Align to two corners (primary, secondary) when snapping.
  [normalizeSnapKey('Gray Center')]: ['sw', 'nw'],
  [normalizeSnapKey('Lloyd Wilson Stadium')]: ['nw', 'sw'],
  [normalizeSnapKey('Lloyd Wilson Field/Stadium')]: ['nw', 'sw'],
  [normalizeSnapKey('Stone Health Center')]: ['nw', 'sw'],
  [normalizeSnapKey('The Stone Health Center')]: ['nw', 'sw'],
  [normalizeSnapKey('Jackson Dinsdale Art Center')]: ['nw', 'sw'],
  [normalizeSnapKey('Farrell-Fleharty')]: ['nw', 'sw'],
  [normalizeSnapKey('Lynn Farrell Arena/Fleharty Educational Center')]: ['nw', 'sw'],
  [normalizeSnapKey('Daugherty Student Engagement Center')]: ['nw', 'sw'],
  [normalizeSnapKey('McCormick Hall')]: ['nw', 'sw'],
  ...buildSnapMap(BUILDING_SNAP_CONFIGS, 'cornerPair')
};

const BUILDING_SNAP_PAIR_MODES = {
  // legacy = scale by bbox, rotate after NW snap (restores earlier behavior).
  [normalizeSnapKey('Lloyd Wilson Stadium')]: 'match',
  [normalizeSnapKey('Lloyd Wilson Field/Stadium')]: 'match',
  [normalizeSnapKey('Stone Health Center')]: 'legacy',
  [normalizeSnapKey('The Stone Health Center')]: 'legacy',
  ...buildSnapMap(BUILDING_SNAP_CONFIGS, 'pairMode')
};

const BUILDING_SNAP_ROTATION_MODES = {
  // Skip auto-rotation for buildings that already align.
  [normalizeSnapKey('Babcock Hall')]: 'none',
  [normalizeSnapKey('Babcock Hall Residence')]: 'none',
  ...buildSnapMap(BUILDING_SNAP_CONFIGS, 'rotationMode')
};

const BUILDING_SNAP_SCALE_MULTIPLIERS = {
  // Manual scale tweaks applied after auto-fit.
  [normalizeSnapKey('Gray Center')]: 1.035,
  [normalizeSnapKey('Lloyd Wilson Stadium')]: 1.0,
  [normalizeSnapKey('Lloyd Wilson Field/Stadium')]: 1.0
};

const BUILDING_SNAP_NUDGE_METERS = {
  // Nudges applied after snap (east/west, north/south).
  // (empty)
};

const FLOORPLAN_ROTATION_OVERRIDES = {
  // Wilson Center overrides (CW degrees)
  'wilson_center/basement': 184.5,
  'wilson_center/level_1': 180.5,
  // Daugherty Student Engagement Center
  'daugherty_student_engagement_center/basement': 42,
  'daugherty_student_engagement_center/level_1': 42,
  // Hurley-McDonald Hall (all floors)
  'hurley_mcdonald_hall': 180,
  // McCormick Hall (per-floor overrides)
  'mccormick_hall/basement': 84.5,
  'mccormick_hall/level_1': 88.5,
  'mccormick_hall/level_2': 88.5,
  'mccormick_hall/level_3': 100,
  // Morrison-Reeves Science Center (all floors)
  'morrison_reeves_science_center': 0,
  'morrison_reeves': 0,
  'morrison_reeves/level_1': 0,
  'morrison_reeves/level_2': 0
};

const FLOORPLAN_SCALE_OVERRIDES = {
  // Per-floor scale tweaks (multiplier).
  'babcock_hall/level_2': 1.12
};

const FLOORPLAN_POST_ROTATION_OVERRIDES = {
  // Apply after auto-fit (CW degrees).
};

const FLOORPLAN_CACHE_BUST = new Set([
  'kiewit/level_2',
  'kiewit_building/level_2',
  'babcock_hall/level_3',
  'taylor_hall',
  'taylor_hall_residence'
]);

const FLOORPLAN_DRAWING_SUPPRESS = new Set([
  'calvin_french_chapel/level_2',
  'calvin_h_french_chapel/level_2',
  'calvin_h_french_memorial_chapel/level_2'
]);

const FLOORPLAN_NO_FIT = new Set([
  'calvin_french_chapel/basement',
  'calvin_h_french_chapel/basement',
  'calvin_h_french_memorial_chapel/basement',
  'kiewit/level_2',
  'kiewit_building/level_2'
]);

const DOOR_SWING_FLIP_OVERRIDES = {
  // Doors swing reversed in this export; flip bearing 180deg.
  'daugherty_student_engagement_center': true
};

function getFloorplanRotationOverride(buildingLabel, floorId) {
  if (!buildingLabel) return null;
  const key = canon(buildingLabel);
  const floorKey = floorId ? fId(floorId) : null;
  if (floorKey) {
    const composite = `${key}/${floorKey}`;
    const floorOverride = FLOORPLAN_ROTATION_OVERRIDES[composite];
    if (Number.isFinite(floorOverride)) return floorOverride;
  }
  const override = FLOORPLAN_ROTATION_OVERRIDES[key];
  return Number.isFinite(override) ? override : null;
}

function getFloorplanScaleOverride(buildingLabel, floorId) {
  if (!buildingLabel || !floorId) return null;
  const key = canon(buildingLabel);
  const floorKey = fId(floorId);
  if (!key || !floorKey) return null;
  const composite = `${key}/${floorKey}`;
  const override = FLOORPLAN_SCALE_OVERRIDES[composite] ?? FLOORPLAN_SCALE_OVERRIDES[key];
  return Number.isFinite(override) ? override : null;
}

function getFloorplanPostRotationOverride(buildingLabel, floorId) {
  if (!buildingLabel || !floorId) return null;
  const key = canon(buildingLabel);
  const floorKey = fId(floorId);
  if (!key || !floorKey) return null;
  const composite = `${key}/${floorKey}`;
  const override =
    FLOORPLAN_POST_ROTATION_OVERRIDES[composite] ??
    FLOORPLAN_POST_ROTATION_OVERRIDES[key];
  return Number.isFinite(override) ? override : null;
}

function shouldBypassFloorCache(buildingLabel, floorId) {
  if (!buildingLabel || !floorId) return false;
  const key = canon(buildingLabel);
  const floorKey = fId(floorId);
  if (!key || !floorKey) return false;
  return FLOORPLAN_CACHE_BUST.has(`${key}/${floorKey}`) || FLOORPLAN_CACHE_BUST.has(key);
}

function shouldSuppressDrawingLayer(buildingLabel, floorId) {
  if (!buildingLabel || !floorId) return false;
  const key = canon(buildingLabel);
  const floorKey = fId(floorId);
  if (!key || !floorKey) return false;
  return FLOORPLAN_DRAWING_SUPPRESS.has(`${key}/${floorKey}`) || FLOORPLAN_DRAWING_SUPPRESS.has(key);
}

function shouldSkipFloorplanFit(buildingLabel, floorId) {
  if (!buildingLabel || !floorId) return false;
  const key = canon(buildingLabel);
  const floorKey = fId(floorId);
  if (!key || !floorKey) return false;
  return FLOORPLAN_NO_FIT.has(`${key}/${floorKey}`);
}

function shouldFlipDoorSwing(buildingLabel, floorId) {
  if (!buildingLabel) return false;
  const key = canon(buildingLabel);
  const floorKey = floorId ? fId(floorId) : null;
  if (floorKey && DOOR_SWING_FLIP_OVERRIDES[`${key}/${floorKey}`]) return true;
  return Boolean(DOOR_SWING_FLIP_OVERRIDES[key]);
}

// Floorplan view tuning
const FLOORPLAN_FIT_PADDING = 8;   // tighter frame around floor
const FLOORPLAN_SCALE = 1.0;       // auto-fit handles size; keep neutral here

const mergePatch = (props, patch) => ({ ...props, ...patch });

const normalizeDashboardKey = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const resolved = resolveBuildingNameFromInput(raw) || raw;
  return canon(resolved);
};
const normalizeRoomLookupKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const normalizeRoomLabelMatch = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const norm = normalizeRoomLookupKey(raw);
  if (!norm) return '';
  return norm.startsWith('room') && norm.length > 4 ? norm.slice(4) : norm;
};

const normalizeTypeMatch = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeDeptMatch = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const getRoomBuildingLabel = (room) =>
  room?.building ?? room?.buildingName ?? room?.buildingLabel ?? '';

const getDeptCandidates = (rooms = []) => {
  const seen = new Map();
  (DEPARTMENTS || []).forEach((name) => {
    const key = normalizeDeptMatch(name);
    if (key) seen.set(key, name);
  });
  (rooms || []).forEach((room) => {
    const name = String(room?.department ?? '').trim();
    const key = normalizeDeptMatch(name);
    if (key) seen.set(key, name);
  });
  return Array.from(seen.values());
};

const findDeptInText = (text, candidates = []) => {
  const normalizedText = normalizeDeptMatch(text);
  if (!normalizedText) return '';
  let best = '';
  let bestLen = 0;
  (candidates || []).forEach((name) => {
    const key = normalizeDeptMatch(name);
    if (!key) return;
    if (normalizedText.includes(key) && key.length > bestLen) {
      best = name;
      bestLen = key.length;
    }
  });
  return best;
};

const normalizeBuildingMatch = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const getBuildingCandidates = (rooms = []) => {
  const seen = new Map();
  (BUILDINGS_LIST || []).forEach((b) => {
    const name = String(b?.name || '').trim();
    const key = normalizeBuildingMatch(name);
    if (key) seen.set(key, name);
  });
  (rooms || []).forEach((room) => {
    const name = String(room?.building ?? room?.buildingName ?? room?.buildingLabel ?? '').trim();
    const key = normalizeBuildingMatch(name);
    if (key) seen.set(key, name);
  });
  return Array.from(seen.values());
};

const findBuildingInText = (text, candidates = []) => {
  const normalizedText = normalizeBuildingMatch(text);
  if (!normalizedText) return '';
  let best = '';
  let bestLen = 0;
  (candidates || []).forEach((name) => {
    const key = normalizeBuildingMatch(name);
    if (!key) return;
    if (normalizedText.includes(key) && key.length > bestLen) {
      best = name;
      bestLen = key.length;
    }
  });
  return best;
};

const getDeptCurrentBuildings = (rooms = [], deptName = '') => {
  const deptKey = normalizeDeptMatch(deptName);
  if (!deptKey) return [];
  const buildingSet = new Set();
  (rooms || []).forEach((room) => {
    const roomDept = normalizeDeptMatch(room?.department ?? '');
    if (roomDept && roomDept === deptKey) {
      const buildingLabel = getRoomBuildingLabel(room);
      if (buildingLabel) buildingSet.add(buildingLabel);
    }
  });
  return Array.from(buildingSet);
};

const getFeatureIdVariants = (value) => {
  if (value == null) return [];
  const variants = new Set();
  const asString = String(value);
  if (asString) variants.add(asString);
  const asNumber = Number(asString);
  if (Number.isFinite(asNumber)) variants.add(asNumber);
  return Array.from(variants);
};

const isAirtableRecordId = (value) => /^rec[a-z0-9]{6,}$/i.test(String(value || ''));
const isLinkedRecordArray = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((v) => isAirtableRecordId(v));

const OFFICE_TYPE_LABELS = [
  'Office - Staff',
  'Office - Prof and Admin',
  'Office - Prof & Admin',
  'Office - Prof/Admin',
  'Office - Faculty',
  'Office - Adjunct Faculty',
  'Office - Emeritus Faculty'
];
const OFFICE_TYPE_LABELS_UPPER = OFFICE_TYPE_LABELS.map((label) => label.toUpperCase());
const normalizeOfficeTypeLabel = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(and|&)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const OFFICE_TYPE_SET = new Set(OFFICE_TYPE_LABELS.map(normalizeOfficeTypeLabel).filter(Boolean));
const isAllowedOfficeType = (value) => OFFICE_TYPE_SET.has(normalizeOfficeTypeLabel(value));
const normalizeTeachingTypeLabel = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const isScheduledTeachingTypeLabel = (value) => {
  const norm = normalizeTeachingTypeLabel(value);
  if (!norm) return false;
  if (norm.includes('classroom')) return true;
  return (
    norm.includes('laboratory class') ||
    norm.includes('laboratory studio') ||
    norm.includes('lab class') ||
    norm.includes('lab studio')
  );
};

const normalizeFloorTokens = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const tokens = new Set();
  const canonValue = fId(raw);
  if (canonValue) tokens.add(canonValue);
  const num = Number(raw);
  if (Number.isFinite(num)) {
    tokens.add(`level_${num}`);
    if (num === 0) tokens.add('basement');
  }
  return Array.from(tokens);
};
const floorMatchesTokens = (roomFloor, targetTokens) => {
  if (!targetTokens?.length) return true;
  const roomTokens = normalizeFloorTokens(roomFloor);
  if (!roomTokens.length) return false;
  return roomTokens.some((token) => targetTokens.includes(token));
};

const resolveAvailableFloorId = (value, availableFloors = []) => {
  if (!value) return '';
  if (availableFloors.includes(value)) return value;
  const tokens = normalizeFloorTokens(value);
  if (!tokens.length) return '';
  return availableFloors.find((floorId) => floorMatchesTokens(floorId, tokens)) || '';
};

function buildAirtableRoomLookup(rooms = []) {
  const byGuid = new Map();
  const byComposite = new Map();
  if (!Array.isArray(rooms)) return { byGuid, byComposite };

  rooms.forEach((room) => {
    if (!room) return;
    const guidKey = normalizeRoomLookupKey(
      room.roomGuid ?? room.revitUniqueId ?? room['Room GUID'] ?? ''
    );
    if (guidKey) byGuid.set(guidKey, room);

    const roomIdKey = normalizeRoomLookupKey(
      room.roomId ?? room.roomNumber ?? room.roomLabel ?? room.id ?? ''
    );
    const buildingKey = normalizeDashboardKey(
      room.building ?? room.buildingName ?? room.buildingLabel ?? ''
    );
    const floorKey = normalizeDashboardKey(
      room.floor ?? room.floorName ?? room.floorId ?? ''
    );
    if (roomIdKey && buildingKey && floorKey) {
      const compositeKey = `${buildingKey}|${floorKey}|${roomIdKey}`;
      if (!byComposite.has(compositeKey)) byComposite.set(compositeKey, room);
    }
  });

  return { byGuid, byComposite };
}

function mergeAirtableRoomsWithManifest(airtableRooms = [], manifestRooms = []) {
  if (!Array.isArray(airtableRooms) || airtableRooms.length === 0) return [];
  if (!Array.isArray(manifestRooms) || manifestRooms.length === 0) return airtableRooms;

  const manifestLookup = buildAirtableRoomLookup(manifestRooms);
  return airtableRooms.map((room) => {
    if (!room) return room;
    const guidKey = normalizeRoomLookupKey(room.roomGuid ?? room.roomId ?? room.revitUniqueId ?? '');
    const manifestMatch = guidKey ? manifestLookup.byGuid.get(guidKey) : null;
    if (!manifestMatch) return room;

    const merged = { ...room };
    if (!merged.roomGuid && manifestMatch.roomGuid) merged.roomGuid = manifestMatch.roomGuid;
    if (!merged.roomId && manifestMatch.roomId) merged.roomId = manifestMatch.roomId;
    if (!merged.roomNumber && manifestMatch.roomNumber) merged.roomNumber = manifestMatch.roomNumber;
    if (!merged.roomLabel && manifestMatch.roomLabel) merged.roomLabel = manifestMatch.roomLabel;
    if (!merged.building && manifestMatch.building) merged.building = manifestMatch.building;
    if (!merged.floor && manifestMatch.floor) merged.floor = manifestMatch.floor;

    if (!merged.type || isLinkedRecordArray(merged.type)) {
      if (manifestMatch.type) merged.type = manifestMatch.type;
    }
    if (!merged.department || isLinkedRecordArray(merged.department)) {
      if (manifestMatch.department) merged.department = manifestMatch.department;
    }
    if (!Number.isFinite(Number(merged.areaSF)) || Number(merged.areaSF) <= 0) {
      if (Number.isFinite(Number(manifestMatch.areaSF)) && Number(manifestMatch.areaSF) > 0) {
        merged.areaSF = Number(manifestMatch.areaSF);
      }
    }
    return merged;
  });
}

function getAirtableRoomPatch(props = {}, lookup, buildingId, floor) {
  if (!lookup) return null;
  let room = null;
  const guidKey = normalizeRoomLookupKey(
    props.Revit_UniqueId ??
      props.RevitUniqueId ??
      props['Room GUID'] ??
      props.roomGuid ??
      ''
  );
  if (guidKey) {
    room = lookup.byGuid.get(guidKey) || null;
  }
  if (!room) {
    const roomIdKey = normalizeRoomLookupKey(
      props.Number ??
        props.RoomNumber ??
        props.number ??
        props.Room ??
        props.roomNumber ??
        ''
    );
    const buildingKey = normalizeDashboardKey(
      buildingId ?? props.Building ?? props.BuildingName ?? props.buildingId ?? ''
    );
    const floorKey = normalizeDashboardKey(
      floor ?? props.Floor ?? props.floor ?? ''
    );
    if (roomIdKey && buildingKey && floorKey) {
      room = lookup.byComposite.get(`${buildingKey}|${floorKey}|${roomIdKey}`) || null;
    }
  }
  if (!room) return null;

  const occupancyStatus = String(room.occupancyStatus ?? '').trim();
  const occupant = String(room.occupant ?? '').trim();
  const type = String(room.type ?? '').trim();
  const department = String(room.department ?? '').trim();
  if (!occupancyStatus && !occupant && !type && !department) return null;

  const patch = {};
  if (occupancyStatus) {
    patch.occupancyStatus = occupancyStatus;
    patch.OccupancyStatus = occupancyStatus;
    patch['Occupancy Status'] = occupancyStatus;
  }
  if (occupant) {
    patch.occupant = occupant;
    patch.Occupant = occupant;
  }
  if (type) {
    patch.type = type;
    patch.Type = type;
    patch['Room Type'] = type;
    patch['Room Type Description'] = type;
  }
  if (department) {
    patch.department = department;
    patch.Department = department;
  }
  const seatCount = Number(room.seatCount ?? room.SeatCount ?? room['Seat Count'] ?? 0);
  if (Number.isFinite(seatCount) && seatCount > 0) {
    patch.seatCount = seatCount;
    patch.SeatCount = seatCount;
    patch['Seat Count'] = seatCount;
  }
  return patch;
}

const hasDashboardRoomArea = (room) => {
  const area = Number(room?.areaSF ?? room?.area ?? room?.sf ?? 0);
  return Number.isFinite(area) && area > 0;
};

const toDashboardRoomRow = (feature, buildingLabel) => {
  if (!feature) return null;
  const props = feature?.properties || {};
  const area = resolveAreaSf(props);
  if (!Number.isFinite(area) || area <= 0) return null;
  const occupancyStatus = (
    props.occupancyStatus ??
    props['Occupancy Status'] ??
    props.OccupancyStatus ??
    props.vacancy ??
    props.Vacancy ??
    props.Occupancy ??
    props.Status ??
    ''
  ).toString().trim();
  const occupant = (
    props.occupant ??
    props.Occupant ??
    props.AssignedTo ??
    props.Assignee ??
    ''
  ).toString().trim();
  const roomGuid = String(
    props.Revit_UniqueId ??
    props.RevitUniqueId ??
    props['Room GUID'] ??
    ''
  ).trim();
  const roomId = String(
    props.Number ??
    props.RoomNumber ??
    props.number ??
    props.Room ??
    ''
  ).trim();
  const floor =
    props.Floor ??
    props.Level ??
    props.LevelName ??
    props['Level Name'] ??
    '';
  return {
    building: buildingLabel || '',
    floor,
    areaSF: area,
    area,
    sf: area,
    roomId: roomId || '',
    roomNumber: roomId || '',
    roomLabel: roomId || '',
    roomGuid,
    department: resolveNcesDept(props),
    type: resolveNcesType(props),
    occupancyStatus,
    occupant
  };
};

const buildCampusRoomsFromManifest = async (manifest) => {
  const floorsByBuilding = manifest?.floorsByBuilding || {};
  const jobs = [];

  const buildingNameById = new Map();
  if (Array.isArray(manifest?.buildings)) {
    manifest.buildings.forEach((b) => {
      if (!b?.id) return;
      buildingNameById.set(String(b.id), b?.name || b.id);
    });
  } else if (manifest?.buildings && typeof manifest.buildings === 'object') {
    Object.entries(manifest.buildings).forEach(([id, b]) => {
      if (!id) return;
      buildingNameById.set(String(id), b?.name || id);
    });
  }

  Object.entries(floorsByBuilding).forEach(([buildingKey, floors]) => {
    const buildingLabel = buildingNameById.get(String(buildingKey)) || buildingKey;
    (floors || []).forEach((floor) => {
      const url = typeof floor === 'string' ? floor : floor?.url;
      if (url) jobs.push({ url, buildingLabel });
    });
  });

  if (!jobs.length) return [];

  const results = await runWithLimit(jobs, 6, async (job) => {
    const feats = await fetchRoomsForFloorUrl(job.url);
    const rows = [];
    (feats || []).forEach((feature) => {
      const row = toDashboardRoomRow(feature, job.buildingLabel);
      if (row) rows.push(row);
    });
    return rows;
  });

  return results.flat();
};

const roomRowToDashboardFeature = (room) => {
  if (!room) return null;
  const area = Number(room.areaSF ?? room.area ?? room.sf ?? 0);
  if (!Number.isFinite(area) || area <= 0) return null;
  const dept = String(room.department ?? '').trim();
  const type = String(room.type ?? '').trim();
  const occupancyStatus = String(room.occupancyStatus ?? '').trim();
  const occupant = String(room.occupant ?? '').trim();
  return {
    type: 'Feature',
    properties: {
      Area_SF: area,
      Area: area,
      area,
      'Area (SF)': area,
      NCES_Department: dept,
      Department: dept,
      department: dept,
      NCES_Type: type,
      __roomType: type,
      OccupancyStatus: occupancyStatus,
      'Occupancy Status': occupancyStatus,
      occupancyStatus,
      Occupant: occupant,
      occupant
    }
  };
};

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
    if (map.getLayer(FLOOR_DRAWING_LAYER)) map.removeLayer(FLOOR_DRAWING_LAYER);
    if (map.getLayer(FLOOR_LINE_ID)) map.removeLayer(FLOOR_LINE_ID);
    if (map.getLayer(FLOOR_DOOR_LAYER)) map.removeLayer(FLOOR_DOOR_LAYER);
    if (map.getLayer(FLOOR_STAIR_LAYER)) map.removeLayer(FLOOR_STAIR_LAYER);
    if (map.getLayer(FLOOR_FILL_ID)) map.removeLayer(FLOOR_FILL_ID);
    if (getGeojsonSource(map, FLOOR_SOURCE)) map.removeSource(FLOOR_SOURCE);
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
    const src = getGeojsonSource(map, FLOOR_SOURCE);
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
    ['get', '__roomType'],
    ['get', 'RoomType'],
    ['get', 'Room Type'],
    ['get', 'Type'],
    ['get', 'type'],
    ['get', 'Name'],
    ['literal', '-']
  ];
  const textField = [
    'case',
    ['==', ['get', 'Element'], 'Room'],
    [
      'concat',
      ['coalesce', ['get', 'Number'], ['get', 'RoomNumber'], ['get', 'name'], ['literal', '-']],
      '\n',
      typeField,
      '\n',
      scenarioDeptField,
      '\n',
      ['concat', ['to-string', ['round', ['coalesce', ['get', 'Area_SF'], ['get', 'Area'], 0]]], ' SF']
    ],
    ''
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
      map.setFilter(FLOOR_ROOM_LABEL_LAYER, ROOMS_ONLY_FILTER);
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
        filter: ['all', ROOMS_ONLY_FILTER, ['!=', ['id'], -1]],
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
      }
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
const NO_FLOORPLAN_BUILDINGS = [
  '603 E 9th St',
  '603 E. 9th St',
  '607 E 9th St',
  'MacKay House',
  'McKay House',
  '905 N Elm St',
  '905 N Elm Ave',
  'Name 1',
  'Name1',
  '706 E. 7th St',
  '706 E 7th St',
  '706 E. 7th St. Residence',
  '710 E. 7th St.',
  '710 E 7th St',
  '710 E. 7th St. Residence',
  '714 E. 7th St.',
  '714 E 7th St',
  '714 E. 7th St. Residence',
  '812 N Ash St',
  '812 N Ash Ave',
  '906 E 9th St',
  'Campus Safety',
  'The 1882 Residence Hall',
  '1882 Residence Hall',
  'Hayes M. Fuhr Hall of Music',
  'Hayes M Fuhr Hall of Music'
];
const NO_FLOORPLAN_BUILDING_KEYS = NO_FLOORPLAN_BUILDINGS.map((name) => String(name || '').toLowerCase());
const BUILDING_ID_MATCH_EXPR = [
  'downcase',
  ['to-string', ['coalesce', ['get', 'id'], ['get', 'name']]]
];
const NO_FLOORPLAN_EXPR = ['in', BUILDING_ID_MATCH_EXPR, ['literal', NO_FLOORPLAN_BUILDING_KEYS]];
const withNoFloorplanOverride = (colorExpr, grayColor = '#d1d5db') => ([
  'case',
  NO_FLOORPLAN_EXPR,
  grayColor,
  colorExpr
]);
const utilizationColorForPercent = (value) => {
  if (!Number.isFinite(value)) return '#e5e7eb';
  if (value >= 80) return '#22c55e';
  if (value >= 60) return '#84cc16';
  if (value >= 40) return '#facc15';
  if (value >= 20) return '#f97316';
  return '#ef4444';
};

const StakeholderMap = ({ config, universityId, mode = 'public', persona }) => {
  const mapPageRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const previousSelectedBuildingId = useRef(null);
  const floorSelectionRef = useRef({}); // remember last selected room id per floor URL
  const spacePanelRef = useRef(null);
  const roomEditPanelRef = useRef(null);
  const scenarioPanelRef = useRef(null);

  const [mapLoaded, setMapLoaded] = useState(false);
  const [interactionMode, setInteractionMode] = useState('select');
  const [showMarkers, setShowMarkers] = useState(mode === 'admin'); // Paths feature removed
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
  const visibleMapViewOptions = mode === 'admin'
    ? MAP_VIEW_OPTIONS
    : MAP_VIEW_OPTIONS.filter((opt) => opt.value === MAP_VIEWS.SPACE_DATA);
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
  const [drawingAlignState, setDrawingAlignState] = useState(null);
  const [drawingAlignNotice, setDrawingAlignNotice] = useState('');
  const drawingAlignStateRef = useRef(null);
  const drawingAlignActiveRef = useRef(false);
  const drawingAlignCursorRef = useRef('');
  const [floorAdjustMode, setFloorAdjustMode] = useState(null); // 'rotate' | 'move'
  const [floorAdjustNotice, setFloorAdjustNotice] = useState('');
  const floorAdjustModeRef = useRef(null);
  const floorAdjustActiveRef = useRef(false);
  const floorAdjustCursorRef = useRef('');
  const floorAdjustDragRef = useRef(null);
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
  const [aiCreateScenarioStrict, setAiCreateScenarioStrict] = useState(true);
  const [aiScenarioComparePending, setAiScenarioComparePending] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [askErr, setAskErr] = useState('');
  const [askResult, setAskResult] = useState(null);
    const [dashboardMetrics, setDashboardMetrics] = useState(null);
    const [dashboardTitle, setDashboardTitle] = useState('Campus Summary');
    const [dashboardLoading, setDashboardLoading] = useState(false);
    const [dashboardError, setDashboardError] = useState(null);
  const [airtableRooms, setAirtableRooms] = useState([]);
  const [campusRooms, setCampusRooms] = useState([]);
  const [campusRoomsLoaded, setCampusRoomsLoaded] = useState(false);
  const [airtableRefreshPending, setAirtableRefreshPending] = useState(false);
  const [airtableRefreshMessage, setAirtableRefreshMessage] = useState('');
  const [airtableLastSyncedAt, setAirtableLastSyncedAt] = useState(null);
  const [utilizationData, setUtilizationData] = useState({ buildings: {}, rooms: {}, campus: null });
  const [utilizationHeatmapOn, setUtilizationHeatmapOn] = useState(false);
    const dashboardManifestRef = useRef(null);
    const campusRoomsRefreshTimerRef = useRef(null);
    const airtableRoomLookup = useMemo(
      () => buildAirtableRoomLookup(airtableRooms.length ? airtableRooms : campusRooms),
      [airtableRooms, campusRooms]
    );
  const utilizationByBuilding = useMemo(() => utilizationData?.buildings || {}, [utilizationData]);
  const utilizationByRoom = useMemo(() => utilizationData?.rooms || {}, [utilizationData]);
  const utilizationCampus = utilizationData?.campus || null;
  const utilizationByBuildingId = useMemo(() => {
    const out = {};
    Object.entries(utilizationByBuilding || {}).forEach(([name, data]) => {
      if (!name) return;
      out[name] = data;
      const alias = BUILDING_ALIAS[name];
      if (alias) out[alias] = data;
    });
    return out;
  }, [utilizationByBuilding]);
  const getUtilizationForBuilding = useCallback((buildingName) => {
    if (!buildingName) return null;
    const resolved = resolveBuildingNameFromInput(buildingName) || buildingName;
    return utilizationByBuilding[resolved] || null;
  }, [utilizationByBuilding]);
  const getUtilizationForRoom = useCallback((buildingName, roomLabel) => {
    if (!buildingName || !roomLabel) return null;
    const resolved = resolveBuildingNameFromInput(buildingName) || buildingName;
    const key = buildUtilizationKey(resolved, roomLabel);
    return utilizationByRoom[key] || null;
  }, [utilizationByRoom]);
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
  const [roomEditPanelPos, setRoomEditPanelPos] = useState(null);
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
      const src = getGeojsonSource(map, FLOOR_SOURCE);
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
      const typeLabelRaw =
        p.__roomType ??
        p.NCES_Type ??
        p.RoomType ??
        p['Room Type'] ??
        p.Type ??
        p.type ??
        p.Name ??
        '';
      const isOfficeType = isAllowedOfficeType(typeLabelRaw);
      let key = '';
      let color = '#e6e6e6';
      const normalizeOccupancyLabel = (props = {}) => {
        const raw =
          props.occupancyStatus ??
          props['Occupancy Status'] ??
          props.OccupancyStatus ??
          props.Occupancy ??
          props.Vacancy ??
          props.vacancy ??
          props.Vacant ??
          '';
        const rawStr = String(raw ?? '').trim();
        if (rawStr) {
          const upper = rawStr.toUpperCase();
          if (
            upper.includes('VACANT') ||
            upper.includes('UNOCCUPIED') ||
            upper.includes('AVAILABLE') ||
            upper.includes('UNASSIGNED')
          ) {
            return 'Vacant';
          }
          if (upper.includes('OCCUPIED')) return 'Occupied';
          return 'Unknown';
        }
        const occ = (props.occupant ?? props.Occupant ?? '').toString().trim();
        return occ ? 'Occupied' : 'Unknown';
      };
      if (mode === FLOOR_COLOR_MODES.TYPE) {
        key = (p.__roomType || '').toString().trim() || 'Unknown';
        color = colorForType(key);
      } else if (mode === FLOOR_COLOR_MODES.OCCUPANCY) {
        if (!isOfficeType) return;
        key = normalizeOccupancyLabel(p);
        color = key === 'Occupied' ? '#29b6f6' : (key === 'Vacant' ? '#ff7043' : '#cfd8dc');
      } else if (mode === FLOOR_COLOR_MODES.VACANCY) {
        if (!isOfficeType) return;
        key = normalizeOccupancyLabel(p);
        color = key === 'Vacant' ? '#ff7043' : '#cfd8dc';
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
    const src = getGeojsonSource(map, FLOOR_SOURCE);
    const data = src ? (src._data || src.serialize?.().data || null) : null;
    const fc = toFeatureCollection(data);
    const effectiveMode = mode === FLOOR_COLOR_MODES.VACANCY ? FLOOR_COLOR_MODES.OCCUPANCY : mode;

    if (effectiveMode === FLOOR_COLOR_MODES.DEPARTMENT && fc?.features?.length) {
      const deptColorMap = new Map();
      const areaSums = new Map();
      const idsByDept = new Map();
      const normalizeId = (val) => {
        if (Number.isFinite(val)) return val;
        const asNum = Number(val);
        return Number.isFinite(asNum) ? asNum : (val != null ? String(val) : null);
      };
      fc.features.forEach((f) => {
        const p = f.properties || {};
        const deptVal = getDeptFromProps(p) || 'Unspecified';
        const color = getDeptColor(deptVal) || '#e6e6e6';
        deptColorMap.set(deptVal, color);
        const areaVal = resolvePatchedArea(p);
        if (Number.isFinite(areaVal) && areaVal > 0) {
          const prev = areaSums.get(deptVal) || 0;
          areaSums.set(deptVal, prev + areaVal);
        }
        const fid = normalizeId(f.id ?? p.RevitId ?? p.id);
        if (fid != null) {
          const list = idsByDept.get(deptVal) || [];
          list.push(fid);
          idsByDept.set(deptVal, list);
        }
      });
      const pairs = [];
      deptColorMap.forEach((color, deptVal) => {
        pairs.push(deptVal, color);
      });
      const deptExpr = [
        'match',
        [
          'coalesce',
          ['feature-state', 'department'],
          ['get', 'department'],
          ['get', 'Department'],
          ['get', 'Dept'],
          ['get', 'NCES_Department'],
          ['get', 'NCES_Dept']
        ],
        ...pairs,
        '#e6e6e6'
      ];
      try {
        map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', deptExpr);
        map.setPaintProperty(FLOOR_FILL_ID, 'fill-opacity', 1);
        const legend = Array.from(deptColorMap.entries()).map(([name, color]) => ({
          name,
          color,
          areaSf: areaSums.get(name) || 0,
          ids: idsByDept.get(name) || []
        })).sort((a, b) => (b.areaSf || 0) - (a.areaSf || 0));
        setFloorLegendItems(legend);
        setFloorLegendLookup(new Map(legend.map((item) => [item.name, item.ids || []])));
        return;
      } catch {}
    }

    if (effectiveMode === FLOOR_COLOR_MODES.TYPE && fc?.features?.length) {
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
        const typeVal = (p.__roomType || '').toString().trim() || 'Unknown';
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
      const typeExprKey = [
        'case',
        ['any', ['!', ['has', '__roomType']], ['==', ['get', '__roomType'], '']],
        'Unknown',
        ['get', '__roomType']
      ];
      const typeExpr = ['match', typeExprKey, ...pairs, '#e6e6e6'];
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

    applyFloorFillExpression(map, effectiveMode);
    buildLegendForMode(effectiveMode);
    setFloorColorMode(effectiveMode);
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
    setRoomEditPanelPos(null);
  }, [clearRoomEditSelection, setFloorHighlight]);
  const roomEditTargets = roomEditData?.targets?.length
    ? roomEditData.targets
    : roomEditData
      ? [roomEditData]
      : [];
  const primaryRoomEditTarget = roomEditTargets[0] || null;
  const roomEditFeatureProps = primaryRoomEditTarget?.feature?.properties || {};
    const roomEditMergedProps = { ...roomEditFeatureProps, ...(roomEditData?.properties || {}) };
    const OCCUPANCY_OPTIONS = ['Occupied', 'Vacant', 'Unknown'];
    const resolveOccupancyStatusValue = (props = {}) => (
      props.occupancyStatus ??
      props['Occupancy Status'] ??
      props.OccupancyStatus ??
      props.Occupancy ??
      props.occupancy ??
      ''
    );
    const resolveSeatCountValue = (props = {}) => (
      props.seatCount ??
      props.SeatCount ??
      props['Seat Count'] ??
      props.Seats ??
      props.Capacity ??
      props.rm_seats ??
      props.SeatingCapacity ??
      props['NCES_Seat Count'] ??
      props['NCES_Seat_Count'] ??
      props['NCES_Seat Count'] ??
      props['NCES_SeatCount'] ??
      ''
    );
    const getMixedValue = (values = []) => {
      const uniq = Array.from(new Set((values || [])
        .map((v) => (v ?? '').toString().trim())
        .filter(Boolean)));
      if (!uniq.length) return '';
      if (uniq.length === 1) return uniq[0];
      return '__MIXED__';
    };
    const isMultiEdit = roomEditTargets.length > 1;
    const sharedOccupancyRaw = roomEditData?.properties?.occupancyStatus;
    const sharedOccupancy = sharedOccupancyRaw != null ? String(sharedOccupancyRaw).trim() : '';
    const hasSharedOccupancy = sharedOccupancy.length > 0;
    const occupancySelectionValue = isMultiEdit
      ? (hasSharedOccupancy
          ? sharedOccupancy
          : getMixedValue(roomEditTargets.map((t) => {
              const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}) };
              return resolveOccupancyStatusValue(merged);
            })))
      : (sharedOccupancy || String(resolveOccupancyStatusValue(roomEditMergedProps) || '').trim());
    const sharedSeatCountRaw = roomEditData?.properties?.seatCount;
    const sharedSeatCount = sharedSeatCountRaw != null ? String(sharedSeatCountRaw).trim() : '';
    const seatCountSelectionValue = isMultiEdit
      ? (sharedSeatCount
          ? sharedSeatCount
          : getMixedValue(roomEditTargets.map((t) => {
              const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}) };
              return resolveSeatCountValue(merged);
            })))
      : (sharedSeatCount || String(resolveSeatCountValue(roomEditMergedProps) || '').trim());
  const editHasOfficeType = roomEditTargets.length > 0 && roomEditTargets.every((t) => {
    const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}), ...(roomEditData?.properties || {}) };
    const typeLabel =
      getRoomTypeLabelFromProps(merged) ||
      merged.type ||
      merged['Room Type'] ||
      merged['Room Type Description'] ||
      '';
    return isAllowedOfficeType(typeLabel);
  });
  const editHasSeatCountType = roomEditTargets.length > 0 && roomEditTargets.every((t) => {
    const merged = { ...(t?.feature?.properties || {}), ...(t?.properties || {}), ...(roomEditData?.properties || {}) };
    const typeLabel =
      getRoomTypeLabelFromProps(merged) ||
      merged.type ||
      merged['Room Type'] ||
      merged['Room Type Description'] ||
      '';
    return isScheduledTeachingTypeLabel(typeLabel);
  });
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
  const availableFloorUrlsByBuildingRef = useRef(new Map());
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
  const getAvailableFloors = useCallback((buildingKey) => {
    if (!buildingKey) return [];
    return availableFloorsByBuildingRef.current.get(buildingKey) ?? [];
  }, []);
  const getBuildingFolderKey = useCallback((idOrName) => {
    if (!idOrName) return null;
    const resolvedName = resolveBuildingNameFromInput(idOrName);
    if (resolvedName && BUILDING_FOLDER_MAP[resolvedName]) {
      return BUILDING_FOLDER_MAP[resolvedName];
    }
    if (BUILDING_FOLDER_SET.has(idOrName)) return idOrName;
    return null;
  }, []);
  const buildFloorUrl = useCallback((buildingKeyOrName, floorId) => {
    if (!buildingKeyOrName || !floorId) return null;
    const folderKey = getBuildingFolderKey(buildingKeyOrName);
    if (!folderKey) return null;
    const floors = getAvailableFloors(folderKey);
    if (!floors.includes(floorId)) return null;
    const urlMap = availableFloorUrlsByBuildingRef.current.get(folderKey);
    const manifestUrl = urlMap?.get(floorId);
    if (manifestUrl) {
      return /^https?:\/\//i.test(manifestUrl) ? manifestUrl : assetUrl(manifestUrl);
    }
    const campusSeg = encodeURIComponent(DEFAULT_FLOORPLAN_CAMPUS);
    const buildingSeg = encodeURIComponent(folderKey);
    const floorSeg = encodeURIComponent(floorId);
    return assetUrl(`floorplans/${campusSeg}/${buildingSeg}/Rooms/${floorSeg}_Dept_Rooms.geojson`);
  }, [getAvailableFloors, getBuildingFolderKey]);
  const ensureFloorsForBuilding = useCallback(async (buildingKeyOrName) => {
    const folderKey = getBuildingFolderKey(buildingKeyOrName);
    if (!folderKey) return [];
    const cached = getAvailableFloors(folderKey);
    const hasUrls = availableFloorUrlsByBuildingRef.current.has(folderKey);
    if (cached.length && hasUrls) return cached;
    const floorEntries = await loadFloorManifest(folderKey);
    const floors = (floorEntries || []).map((f) => f?.id).filter(Boolean);
    const urlMap = new Map(
      (floorEntries || [])
        .filter((f) => f?.id && f?.url)
        .map((f) => [f.id, f.url])
    );
    availableFloorsByBuildingRef.current.set(folderKey, floors);
    availableFloorUrlsByBuildingRef.current.set(folderKey, urlMap);
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
    drawingAlignStateRef.current = drawingAlignState;
    drawingAlignActiveRef.current = Boolean(drawingAlignState);
  }, [drawingAlignState]);
  useEffect(() => {
    floorAdjustModeRef.current = floorAdjustMode;
    floorAdjustActiveRef.current = Boolean(floorAdjustMode);
  }, [floorAdjustMode]);
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (drawingAlignState) {
      drawingAlignCursorRef.current = canvas.style.cursor || '';
      canvas.style.cursor = 'crosshair';
      return;
    }
    if (!floorAdjustMode) {
      canvas.style.cursor = drawingAlignCursorRef.current || '';
    }
  }, [mapLoaded, drawingAlignState]);
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (floorAdjustMode) {
      floorAdjustCursorRef.current = canvas.style.cursor || '';
      canvas.style.cursor = floorAdjustMode === 'move' ? 'move' : 'grab';
      return;
    }
    if (!drawingAlignState) {
      canvas.style.cursor = floorAdjustCursorRef.current || '';
    }
  }, [mapLoaded, floorAdjustMode, drawingAlignState]);
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
  useEffect(() => {
    if (!drawingAlignState) return;
    setDrawingAlignState(null);
    setDrawingAlignNotice('');
  }, [selectedBuildingId, selectedBuilding, selectedFloor]);
  useEffect(() => {
    if (!floorAdjustMode) return;
    setFloorAdjustMode(null);
    setFloorAdjustNotice('');
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
  const [scenarioPanelTop, setScenarioPanelTop] = useState(20);
  const [scenarioPanelPos, setScenarioPanelPos] = useState(null);
  const pendingScenarioLoadRef = useRef(null);
  const pendingScenarioCandidatesRef = useRef(null);

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
    const source = getGeojsonSource(map, FLOOR_SOURCE);
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
    if (!getGeojsonSource(map, FLOOR_SOURCE)) return;
    roomKeys.forEach((roomKey) => {
      const info = infoMap.get(roomKey);
      if (!info?.revitId) return;
      try {
        const ids = getFeatureIdVariants(info.revitId);
        ids.forEach((id) => {
          map.removeFeatureState({ source: FLOOR_SOURCE, id }, 'scenarioColor');
          map.removeFeatureState({ source: FLOOR_SOURCE, id }, 'scenarioOutlineColor');
          map.removeFeatureState({ source: FLOOR_SOURCE, id }, 'scenarioDepartment');
        });
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
    setScenarioPanelPos(null);
    setScenarioPanelTop(20);
    setAiScenarioComparePending(false);
    resetScenarioRecolor();
  }, [clearScenarioFeatureStates, resetScenarioRecolor, updateScenarioDepartmentOnFloor]);

  const clearScenario = useCallback(() => {
    resetScenarioModeState();
  }, [resetScenarioModeState]);

  const ensureScenarioLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map || !getGeojsonSource(map, FLOOR_SOURCE)) return;
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
    const expandedIds = Array.isArray(highlightIds)
      ? highlightIds.flatMap((id) => getFeatureIdVariants(id))
      : [];
    const uniqueIds = Array.from(new Set(expandedIds));
    const filter =
      uniqueIds.length
        ? [
            'any',
            ['in', ['id'], ['literal', uniqueIds]],
            ['in', ['get', 'RevitId'], ['literal', uniqueIds]],
            ['in', ['get', 'Revit_UniqueId'], ['literal', uniqueIds]],
            ['in', ['get', 'Revit Unique Id'], ['literal', uniqueIds]],
            ['in', ['get', 'Room GUID'], ['literal', uniqueIds]]
          ]
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
      if (meta.roomGuid && meta.roomGuid !== meta.revitId) highlightIds.push(meta.roomGuid);
    });
    return { totals, highlightIds };
  }, []);

  const buildScenarioRoomMetaFromCandidate = useCallback((c, idx) => {
    const derivedRoomId = (c?.buildingLabel && (c?.floorName || c?.floorId) && c?.revitId != null)
      ? rId(c.buildingLabel, c.floorName || c.floorId, c.revitId)
      : null;
    const roomId =
      c?.roomId ||
      derivedRoomId ||
      c?.id ||
      [c?.buildingLabel, c?.floorName || c?.floorId, c?.roomLabel, idx].filter(Boolean).join('|') ||
      `cand-${idx}`;
    const roomGuid = c?.roomGuid ?? c?.revitUniqueId ?? c?.revitUniqueID ?? null;
    const revitId = c?.revitId ?? roomGuid ?? null;
    return {
      roomId,
      buildingId: c?.buildingLabel || '',
      buildingName: c?.buildingLabel || '',
      floorName: c?.floorName || c?.floorId || '',
      revitId,
      roomGuid,
      roomNumber: c?.roomLabel || '',
      roomType: c?.type || 'Unspecified',
      department: c?.department || '',
      area: Number(c?.sf || 0) || 0
    };
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

  const applyScenarioCandidates = useCallback((candidates = []) => {
    const prevSelection = previousScenarioSelectionRef.current;
    if (prevSelection?.size) {
      clearScenarioFeatureStates(Array.from(prevSelection), scenarioRoomInfoRef.current);
    }
    scenarioRoomInfoRef.current = new Map();
    previousScenarioSelectionRef.current = new Set();
    const nextSelection = new Set();
    (candidates || []).forEach((c, idx) => {
      const meta = buildScenarioRoomMetaFromCandidate(c, idx);
      if (!meta?.roomId) return;
      scenarioRoomInfoRef.current.set(meta.roomId, meta);
      nextSelection.add(meta.roomId);
    });
    setScenarioSelection(nextSelection);
    handleScenarioSelectionChange(nextSelection);
  }, [buildScenarioRoomMetaFromCandidate, clearScenarioFeatureStates, handleScenarioSelectionChange]);

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
    if (!getGeojsonSource(map, FLOOR_SOURCE)) return;
    const sanitizedState = { ...state };
    if (!Object.keys(sanitizedState).length) return;
    try {
      const ids = getFeatureIdVariants(info.revitId);
      ids.forEach((id) => {
        map.setFeatureState({ source: FLOOR_SOURCE, id }, sanitizedState);
      });
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

  const handleExportScenario = useCallback(async () => {
    if (!aiScenarioResult) {
      alert('No scenario comparison available yet.');
      return;
    }
    try {
      const doc = new jsPDF('p', 'pt', 'letter');
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 36;
      const contentWidth = pageWidth - margin * 2;
      const lineHeight = 14;
      let y = margin;

      const ensureSpace = (needed = lineHeight) => {
        if (y + needed > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
      };
      const addLine = (text, opts = {}) => {
        const indent = opts.indent || 0;
        ensureSpace(lineHeight);
        doc.text(String(text), margin + indent, y);
        y += lineHeight;
      };
      const addWrapped = (text, opts = {}) => {
        const indent = opts.indent || 0;
        const width = Math.max(50, contentWidth - indent);
        const lines = doc.splitTextToSize(String(text), width);
        lines.forEach((line) => addLine(line, { indent }));
      };
      const addSectionTitle = (text) => {
        if (!text) return;
        ensureSpace(lineHeight * 1.2);
        doc.setFont(undefined, 'bold');
        doc.setFontSize(12);
        addWrapped(text);
        doc.setFont(undefined, 'normal');
        doc.setFontSize(11);
      };
      const addBulletList = (items = []) => {
        const list = Array.isArray(items) ? items : [];
        if (!list.length) return;
        list.forEach((item) => addWrapped(`- ${item}`, { indent: 8 }));
      };

      const rollupRoomTypeCounts = (roomTypes = {}) => {
        let offices = 0;
        let classrooms = 0;
        let labs = 0;
        for (const [label, qty] of Object.entries(roomTypes || {})) {
          const s = String(label || '').toLowerCase();
          const n = Number(qty || 0) || 0;
          if (s.includes('office')) offices += n;
          else if (s.includes('class')) classrooms += n;
          else if (s.includes('lab')) labs += n;
        }
        return { offices, classrooms, labs };
      };

      const deptLabel = aiScenarioResult?.scenarioDept || scenarioAssignedDept || 'Scenario';
      const baselineLabel = scenarioBaselineTotals?.__label || 'baseline';
      const scenarioLabel = activeBuildingName || selectedBuilding || selectedBuildingId || 'scenario';
      const floorLabel = selectedFloor ? ` (${selectedFloor})` : '';

      doc.setFontSize(16);
      doc.setFont(undefined, 'bold');
      addLine('Scenario Comparison');
      doc.setFont(undefined, 'normal');
      doc.setFontSize(11);
      addWrapped(`${deptLabel} - ${baselineLabel} to ${scenarioLabel}${floorLabel}`);
      if (aiScenarioResult.summary) {
        addSectionTitle('Summary');
        addWrapped(aiScenarioResult.summary);
      }

      addSectionTitle('Totals');
      const baselineTotals = scenarioBaselineTotals || {};
      const scenarioTotalsLocal = scenarioTotals || {};
      const bCounts = rollupRoomTypeCounts(baselineTotals.roomTypes);
      const sCounts = rollupRoomTypeCounts(scenarioTotalsLocal.roomTypes);
      addLine(`Baseline (${baselineLabel})`);
      addLine(`Total SF: ${Math.round(baselineTotals.totalSF || 0).toLocaleString()}`, { indent: 8 });
      addLine(`Rooms: ${Math.round(baselineTotals.rooms || 0).toLocaleString()}`, { indent: 8 });
      if (bCounts.offices || bCounts.classrooms || bCounts.labs) {
        addLine(`Offices: ${bCounts.offices}`, { indent: 8 });
        addLine(`Classrooms: ${bCounts.classrooms}`, { indent: 8 });
        addLine(`Labs: ${bCounts.labs}`, { indent: 8 });
      }
      y += lineHeight / 2;
      addLine(`Scenario (${scenarioLabel})`);
      addLine(`Total SF: ${Math.round(scenarioTotalsLocal.totalSF || 0).toLocaleString()}`, { indent: 8 });
      addLine(`Rooms: ${Math.round(scenarioTotalsLocal.rooms || 0).toLocaleString()}`, { indent: 8 });
      if (sCounts.offices || sCounts.classrooms || sCounts.labs) {
        addLine(`Offices: ${sCounts.offices}`, { indent: 8 });
        addLine(`Classrooms: ${sCounts.classrooms}`, { indent: 8 });
        addLine(`Labs: ${sCounts.labs}`, { indent: 8 });
      }
      const deltaSf = (scenarioTotalsLocal.totalSF || 0) - (baselineTotals.totalSF || 0);
      const deltaRooms = (scenarioTotalsLocal.rooms || 0) - (baselineTotals.rooms || 0);
      addLine(`Delta SF: ${Math.round(deltaSf).toLocaleString()}`, { indent: 8 });
      addLine(`Delta Rooms: ${Math.round(deltaRooms).toLocaleString()}`, { indent: 8 });

      if (aiScenarioResult?.scenarioPros?.length) {
        addSectionTitle('Pluses');
        addBulletList(aiScenarioResult.scenarioPros);
      }
      if (aiScenarioResult?.scenarioCons?.length) {
        addSectionTitle('Minuses');
        addBulletList(aiScenarioResult.scenarioCons);
      }
      if (aiScenarioResult?.risks?.length) {
        addSectionTitle('Risks / watchouts');
        addBulletList(aiScenarioResult.risks);
      }
      if (aiScenarioResult?.notes?.length) {
        addSectionTitle('Notes');
        addBulletList(aiScenarioResult.notes);
      }
      if (Array.isArray(aiScenarioResult?.data_used) && aiScenarioResult.data_used.length) {
        addSectionTitle('Data used');
        addWrapped(aiScenarioResult.data_used.join(', '));
      }

      const addFloorplanPage = (img, label) => {
        if (!img?.data) return;
        doc.addPage();
        const imgMargin = 36;
        const imgPageWidth = doc.internal.pageSize.getWidth();
        const imgPageHeight = doc.internal.pageSize.getHeight();
        const title = label ? `Floorplan - ${label}` : 'Floorplan';
        doc.setFont(undefined, 'bold');
        doc.setFontSize(14);
        doc.text(title, imgMargin, imgMargin);
        doc.setFont(undefined, 'normal');
        doc.setFontSize(11);
        const aspect = img.height && img.width ? img.height / img.width : 1;
        let imgWidth = imgPageWidth - imgMargin * 2;
        let imgHeight = imgWidth * aspect;
        const maxHeight = imgPageHeight - imgMargin * 2 - 18;
        if (imgHeight > maxHeight) {
          imgHeight = maxHeight;
          imgWidth = imgHeight / (aspect || 1);
        }
        const imgX = imgMargin;
        const imgY = imgMargin + 18;
        doc.addImage(img.data, 'PNG', imgX, imgY, imgWidth, imgHeight);
      };

      const scenarioGroups = new Map();
      scenarioSelection.forEach((roomId) => {
        const info = scenarioRoomInfoRef.current.get(roomId);
        if (!info) return;
        const buildingLabel =
          info?.buildingName ||
          info?.buildingId ||
          activeBuildingName ||
          selectedBuilding ||
          '';
        const floorLabel = info?.floorName || info?.floorId || selectedFloor || '';
        if (!buildingLabel || !floorLabel) return;
        const key = `${canon(buildingLabel)}|${fId(floorLabel)}`;
        if (!scenarioGroups.has(key)) {
          scenarioGroups.set(key, { buildingLabel, floorLabel, ids: [] });
        }
        const entry = scenarioGroups.get(key);
        if (info?.revitId != null) entry.ids.push(info.revitId);
        if (info?.roomGuid && info.roomGuid !== info.revitId) entry.ids.push(info.roomGuid);
      });

      const scenarioPages = [];
      if (scenarioGroups.size) {
        for (const entry of scenarioGroups.values()) {
          const available = await ensureFloorsForBuilding(entry.buildingLabel);
          const resolvedFloor = resolveAvailableFloorId(entry.floorLabel, available) || entry.floorLabel;
          const floorUrl = buildFloorUrl(entry.buildingLabel, resolvedFloor);
          if (!floorUrl) continue;
          let data = floorCache.get(floorUrl);
          if (!data) {
            try {
              data = await fetchGeoJSON(floorUrl);
              if (data) floorCache.set(floorUrl, data);
            } catch {}
          }
          const fc = toFeatureCollection(data);
          if (!fc?.features?.length) continue;
          const img = generateFloorplanImageData({
            fc,
            colorMode: floorColorMode,
            solidFill: true,
            selectedIds: entry.ids,
            labelOptions: { hideDrawing: true }
          });
          if (img?.data) {
            scenarioPages.push({ img, label: `${entry.buildingLabel} - ${resolvedFloor}` });
          }
        }
      }

      if (!scenarioPages.length) {
        const highlightIds = [];
        scenarioSelection.forEach((roomId) => {
          const info = scenarioRoomInfoRef.current.get(roomId);
          if (info?.revitId != null) highlightIds.push(info.revitId);
          if (info?.roomGuid && info.roomGuid !== info.revitId) highlightIds.push(info.roomGuid);
        });
        const floorContext = currentFloorContextRef?.current;
        let floorplanData = floorContext?.fc
          ? generateFloorplanImageData({
              ...floorContext,
              colorMode: floorColorMode,
              solidFill: true,
              selectedIds: highlightIds,
              labelOptions: { hideDrawing: true }
            })
          : null;
        if (!floorplanData?.data && selectedBuilding && selectedFloor) {
          const floorUrl = buildFloorUrl(selectedBuilding, selectedFloor);
          if (floorUrl) {
            let data = floorCache.get(floorUrl);
            if (!data) {
              try {
                data = await fetchGeoJSON(floorUrl);
                if (data) floorCache.set(floorUrl, data);
              } catch {}
            }
            const fc = toFeatureCollection(data);
            if (fc?.features?.length) {
              floorplanData = generateFloorplanImageData({
                fc,
                colorMode: floorColorMode,
                solidFill: true,
                selectedIds: highlightIds,
                labelOptions: { hideDrawing: true }
              });
            }
          }
        }
        if (floorplanData?.data) {
          const label = floorContext?.floor || floorContext?.floorId || selectedFloor || '';
          addFloorplanPage(floorplanData, label || '');
        }
      } else {
        scenarioPages.forEach((page) => addFloorplanPage(page.img, page.label));
      }

      const filenameBase = `${deptLabel}-scenario-compare`
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .toLowerCase();
      doc.save(`${filenameBase}.pdf`);
    } catch (err) {
      console.error('Scenario export failed', err);
      alert('Export failed - see console for details.');
    }
  }, [
    aiScenarioResult,
    scenarioAssignedDept,
    scenarioBaselineTotals,
    scenarioTotals,
    activeBuildingName,
    selectedBuilding,
    selectedBuildingId,
    selectedFloor,
    scenarioSelection,
    floorColorMode,
    ensureFloorsForBuilding,
    resolveAvailableFloorId,
    buildFloorUrl,
    fetchGeoJSON
  ]);

  useEffect(() => {
    if (moveScenarioMode) {
      ensureScenarioLayer();
    }
  }, [moveScenarioMode, ensureScenarioLayer]);

  useEffect(() => {
    if (!moveScenarioMode || scenarioSelection.size === 0) return;
    const { highlightIds } = recomputeScenarioTotals(scenarioSelection);
    applyScenarioHighlight(highlightIds);
  }, [moveScenarioMode, scenarioSelection, floorUrl, recomputeScenarioTotals, applyScenarioHighlight]);

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
    if (!pt || scenarioPanelPos) return;
    setScenarioPanelTop(() => {
      const height = mapContainerRef.current?.clientHeight ?? 0;
      const panelHeight = Math.max(360, (height || 0) * 0.7);
      const maxTop = Math.max(8, (height || 800) - panelHeight - 40);
      const target = pt.y - 120;
      return Math.max(8, Math.min(target, maxTop));
    });
  }, [scenarioPanelPos]);

  const nudgeScenarioPanelUp = useCallback(() => {
    if (scenarioPanelPos) return;
    setScenarioPanelTop((prev) => {
      const height = mapContainerRef.current?.clientHeight ?? 0;
      const panelHeight = Math.max(360, (height || 0) * 0.7);
      const maxTop = Math.max(8, (height || 800) - panelHeight - 40);
      return Math.max(8, Math.min(prev - 40, maxTop));
    });
  }, [scenarioPanelPos]);

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
    return resolveBuildingNameFromInput(idOrName);
  }, []);

  const fetchFloorSummaryByUrl = useCallback(async (url) => {
    if (!url) return null;

    // Try original URL first, then fall back to new py export naming
    const candidates = [];
    if (typeof url === "string" && url.endsWith("_Dept.geojson")) {
      const roomsUrl = url.replace(/\/([^/]+)$/, "/Rooms/$1");
      candidates.push(url.replace("_Dept.geojson", "_Dept_Rooms.geojson").replace(/\/([^/]+)$/, "/Rooms/$1"));
      candidates.push(roomsUrl);
      candidates.push(url.replace("_Dept.geojson", "_Dept_Rooms.geojson"));
      candidates.push(url);
    } else {
      candidates.push(url);
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
    if (campusRoomsLoaded && Array.isArray(campusRooms) && campusRooms.length) {
      const buildingKey = normalizeDashboardKey(buildingId);
      if (buildingKey) {
        const scoped = campusRooms.filter((room) => {
          const roomBuilding =
            room?.building ??
            room?.buildingName ??
            room?.buildingLabel ??
            '';
          return normalizeDashboardKey(roomBuilding) === buildingKey;
        });
        const summary = summarizeRoomRowsForPanels(scoped);
        if (summary) return summary;
      }
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
  }, [fetchBuildingSummary, campusRoomsLoaded, campusRooms]);

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
    if (campusRoomsLoaded && Array.isArray(campusRooms) && campusRooms.length) {
      const buildingKey = normalizeDashboardKey(buildingId);
      if (buildingKey) {
        const scoped = campusRooms.filter((room) => {
          const roomBuilding =
            room?.building ??
            room?.buildingName ??
            room?.buildingLabel ??
            '';
          return normalizeDashboardKey(roomBuilding) === buildingKey;
        });
        const summary = summarizeRoomRowsForPanels(scoped);
        if (summary) {
          setBuildingStats(summary);
          setPanelStats(formatSummaryForPanel(summary, 'building'));
          return;
        }
      }
    }
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
    if (campusRoomsLoaded && Array.isArray(campusRooms) && campusRooms.length) {
      const buildingKey = ctx?.buildingId || selectedBuildingId || selectedBuilding;
      const floorLabel = ctx?.floorLabel || selectedFloor || '';
      const scoped = campusRooms.filter((room) => {
        const roomBuilding =
          room?.building ??
          room?.buildingName ??
          room?.buildingLabel ??
          '';
        if (normalizeDashboardKey(roomBuilding) !== normalizeDashboardKey(buildingKey)) return false;
        if (!floorLabel) return true;
        const floorTokens = normalizeFloorTokens(floorLabel);
        if (!floorTokens.length) return true;
        return floorMatchesTokens(room?.floor ?? room?.floorName ?? room?.floorId ?? '', floorTokens);
      });
      const summary = summarizeRoomRowsForPanels(scoped);
      if (summary) {
        const labeled = { ...summary, floorLabel };
        floorStatsCache.current[url] = summary;
        setFloorStats(labeled);
        setFloorLegendItems(toKeyDeptList(filterDeptTotals(summary.totalsByDept)));
        setPanelStats(formatSummaryForPanel(summary, 'floor'));
        return;
      }
    }
    const cachedUrlSummary = floorStatsCache.current[url];
    if (cachedUrlSummary) {
      const floorLabel = ctx?.floorLabel || selectedFloor || '';
      setFloorStats({ ...cachedUrlSummary, floorLabel });
      setFloorLegendItems(toKeyDeptList(filterDeptTotals(cachedUrlSummary.totalsByDept)));
      setPanelStats(formatSummaryForPanel(cachedUrlSummary, 'floor'));
      return;
    }
    if (ctx?.url === url && ctx?.key) {
      const cached = floorSummaryCacheRef.current.get(ctx.key);
      if (cached) {
        const floorLabel = ctx.floorLabel || selectedFloor || '';
        setFloorStats({ ...cached, floorLabel });
        setFloorLegendItems(toKeyDeptList(filterDeptTotals(cached.totalsByDept)));
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
        setFloorLegendItems(toKeyDeptList(filterDeptTotals(summary?.totalsByDept)));
        setPanelStats(formatSummaryForPanel(summary, 'floor'));
      })
      .catch(() => {
        if (currentFloorUrlRef.current !== url) return;
        setFloorStats(null);
        setPanelStats(formatSummaryForPanel(null, 'floor'));
      });
  }, [fetchFloorSummaryByUrl, selectedFloor]);

  const refreshCampusRoomsFromApi = useCallback(async () => {
    try {
      const res = await guardedAiFetch('/ai/api/rooms', { cache: 'no-store' });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      if (res.ok && data?.ok && Array.isArray(data.rooms)) {
        setAirtableRooms(data.rooms);
        setAirtableLastSyncedAt(new Date());
        return true;
      }
    } catch {}
    return false;
  }, []);

  const scheduleCampusRoomsRefresh = useCallback(() => {
    if (campusRoomsRefreshTimerRef.current) return;
    campusRoomsRefreshTimerRef.current = setTimeout(() => {
      campusRoomsRefreshTimerRef.current = null;
      refreshCampusRoomsFromApi();
    }, 300);
  }, [refreshCampusRoomsFromApi]);

  const handleRefreshAirtable = useCallback(async () => {
    if (airtableRefreshPending) return;
    setAirtableRefreshPending(true);
    setAirtableRefreshMessage('');
    const ok = await refreshCampusRoomsFromApi();
    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setAirtableRefreshMessage(ok ? `Refreshed ${timeLabel}` : 'Refresh failed');
    setAirtableRefreshPending(false);
  }, [airtableRefreshPending, refreshCampusRoomsFromApi]);

  useEffect(() => () => {
    if (campusRoomsRefreshTimerRef.current) {
      clearTimeout(campusRoomsRefreshTimerRef.current);
      campusRoomsRefreshTimerRef.current = null;
    }
  }, []);

  const saveRoomEdits = useCallback(
    async (edit) => {
      if (!edit || !universityId) return null;

      const { buildingId, buildingName, floorName, revitId, roomId, roomLabel, roomNumber, roomGuid, properties = {} } = edit;
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

        const typeValue = String(properties.type ?? '').trim();
        const officeTypeLabel = getRoomTypeLabelFromProps(properties) || typeValue;
        const allowOfficeFields = isAllowedOfficeType(officeTypeLabel);
        const occStatus = allowOfficeFields
          ? String(properties.occupancyStatus ?? '').trim()
          : '';
        const deptValue = String(properties.department ?? '').trim();
        const occupantProvided = properties.occupant != null;
        const occupantValue = String(properties.occupant ?? '').trim();
        const seatCountProvided = properties.seatCount != null;
        const seatCountRaw = properties.seatCount;
        const seatCountNum = Number(seatCountRaw);
        const seatCountValue = Number.isFinite(seatCountNum) && seatCountNum > 0 ? seatCountNum : null;

        const payload = {
          type: typeValue || '',
          department: deptValue || '',
          comments: properties.comments || '',
          updatedAt: serverTimestamp()
        };
        if (allowOfficeFields) {
          payload.occupant = properties.occupant || '';
          payload.occupancyStatus = properties.occupancyStatus || '';
        }
        if (seatCountProvided) {
          payload.seatCount = seatCountValue;
        }

          await setDoc(roomRef, payload, { merge: true });

          const airtableId =
            properties.airtableId ||
            properties.AirtableId ||
            properties.airtableID ||
            properties['Airtable ID'] ||
            properties['Airtable Id'] ||
            null;
          const airtablePayload = {};
          if (occStatus) airtablePayload.occupancyStatus = occStatus;
          if (typeValue) airtablePayload.type = typeValue;
          if (deptValue) airtablePayload.department = deptValue;
          if (allowOfficeFields && occupantProvided) airtablePayload.occupant = occupantValue;
          if (seatCountProvided) airtablePayload.seatCount = seatCountValue;
          const roomNumberValue = String(
            roomNumber ??
            properties.roomNumber ??
            properties.RoomNumber ??
            properties.Number ??
            roomLabel ??
            ''
          ).trim();
          const roomGuidValue = String(
            roomGuid ??
            properties.Revit_UniqueId ??
            properties.revit_unique_id ??
            properties.revitUniqueId ??
            properties.RevitUniqueId ??
            properties['Room GUID'] ??
            properties.roomGuid ??
            ''
          ).trim();
          let didUpdateAirtable = false;
          if (airtableId && Object.keys(airtablePayload).length) {
            try {
              const resp = await guardedAiFetch(`/ai/api/rooms/${airtableId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(airtablePayload)
              });
              if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                console.warn('Airtable update failed', resp.status, text);
              } else {
                didUpdateAirtable = true;
              }
            } catch (err) {
              console.warn('Airtable update failed', err);
            }
          }
          if (!didUpdateAirtable && (roomGuidValue || roomNumberValue) && Object.keys(airtablePayload).length) {
            try {
              const resp = await guardedAiFetch('/ai/api/rooms', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  roomId: roomGuidValue || roomNumberValue,
                  roomGuid: roomGuidValue || undefined,
                  building: buildingId,
                  buildingName: buildingName || '',
                  floor: floorName,
                  ...airtablePayload
                })
              });
              if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                console.warn('Airtable update by roomId failed', resp.status, text);
              } else {
                didUpdateAirtable = true;
              }
            } catch (err) {
              console.warn('Airtable update by roomId failed', err);
            }
          }

          const patchPayload = {
            type: properties.type || '',
            department: properties.department || '',
            occupant: allowOfficeFields ? (properties.occupant || '') : (properties.occupant ?? ''),
            occupancyStatus: allowOfficeFields ? (properties.occupancyStatus || '') : (properties.occupancyStatus ?? ''),
          comments: properties.comments || ''
        };
        if (seatCountProvided) {
          patchPayload.seatCount = seatCountValue;
          patchPayload.SeatCount = seatCountValue;
          patchPayload['Seat Count'] = seatCountValue;
        }

        setRoomPatches((prevMap) => {
          const next = new Map(prevMap || []);
          const patchKey = roomId || roomKey;
          const prevPatch = next.get(patchKey) || {};
          next.set(patchKey, { ...prevPatch, ...patchPayload });
          return next;
        });

        let didApplyDashboardPatch = false;
        setCampusRooms((prevRooms) => {
          if (!Array.isArray(prevRooms) || !prevRooms.length) return prevRooms;
          const airtableId =
            properties.airtableId ||
            properties.AirtableId ||
            properties.airtableID ||
            properties['Airtable ID'] ||
            properties['Airtable Id'] ||
            null;
          const normalizeKeyLoose = (value) =>
            String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
          const editRoomId = String(roomId ?? '').trim();
          const editRoomLabel = String(roomLabel ?? '').trim();
          const editRevitId = revitId != null ? String(revitId) : '';
          const areaValueRaw =
            properties.area ??
            properties.areaSF ??
            properties['Area (SF)'] ??
            properties.Area_SF ??
            properties.Area ??
            null;
          const areaValue = Number(areaValueRaw) || 0;
          const editBuildingKey = normalizeDashboardKey(buildingId);
          const editFloorKey = normalizeDashboardKey(floorName);
          const editBuildingLoose = normalizeKeyLoose(buildingId);
          const editFloorLoose = normalizeKeyLoose(floorName);
          const labelFallbackIndexes = [];
          let nextRooms = prevRooms.map((room, idx) => {
            if (!room) return room;
            const roomAirtableId =
              room.airtableId ||
              room.AirtableId ||
              room['Airtable ID'] ||
              null;
            const roomRoomId = String(room.roomId ?? room.id ?? '').trim();
            const buildingKey = normalizeDashboardKey(
              room.building ?? room.buildingName ?? room.buildingLabel ?? ''
            );
            const floorKey = normalizeDashboardKey(
              room.floor ?? room.floorId ?? room.floorName ?? ''
            );
            const buildingLoose = normalizeKeyLoose(
              room.building ?? room.buildingName ?? room.buildingLabel ?? ''
            );
            const floorLoose = normalizeKeyLoose(
              room.floor ?? room.floorId ?? room.floorName ?? ''
            );
            const buildingMatch =
              (editBuildingKey && buildingKey === editBuildingKey) ||
              (editBuildingLoose && buildingLoose === editBuildingLoose);
            const floorMatch =
              (editFloorKey && floorKey === editFloorKey) ||
              (editFloorLoose && floorLoose === editFloorLoose);
            const idMatch =
              (airtableId && roomAirtableId && String(roomAirtableId) === String(airtableId)) ||
              (editRoomId && roomRoomId === editRoomId) ||
              (editRevitId && roomRoomId === editRevitId) ||
              (editRoomLabel && roomRoomId === editRoomLabel);
            let labelMatch = false;
            if (!idMatch && buildingMatch && floorMatch && editRoomLabel) {
              const roomLabelKey = String(
                room.roomLabel ?? room.name ?? room.number ?? room.roomNumber ?? ''
              ).trim();
              const roomIdKey = String(room.roomId ?? room.id ?? '').trim();
              labelMatch =
                (roomLabelKey && roomLabelKey === editRoomLabel) ||
                (roomIdKey && roomIdKey === editRoomLabel);
            }
            if (!idMatch && !labelMatch) {
              if (editRoomLabel && !buildingMatch && !floorMatch) {
                const roomIdKey = String(room.roomId ?? room.id ?? '').trim();
                if (roomIdKey && roomIdKey === editRoomLabel) {
                  labelFallbackIndexes.push(idx);
                }
              }
              return room;
            }
            didApplyDashboardPatch = true;
            return {
              ...room,
              type: properties.type != null ? properties.type : room.type,
              department: properties.department != null ? properties.department : room.department,
              occupant: properties.occupant != null ? properties.occupant : room.occupant,
              occupancyStatus: properties.occupancyStatus != null
                ? properties.occupancyStatus
                : room.occupancyStatus,
              seatCount: seatCountProvided ? seatCountValue : (room.seatCount ?? room.SeatCount ?? room['Seat Count']),
              area: areaValue > 0 ? areaValue : (room.area ?? room.areaSF ?? room.sf ?? room.Area_SF ?? room.Area ?? room['Area (SF)']),
              areaSF: areaValue > 0 ? areaValue : (room.areaSF ?? room.sf ?? room.area ?? room.Area_SF ?? room.Area ?? room['Area (SF)']),
              sf: areaValue > 0 ? areaValue : (room.sf ?? room.areaSF ?? room.area ?? room.Area_SF ?? room.Area ?? room['Area (SF)']),
              roomLabel: room.roomLabel ?? room.name ?? room.number ?? room.roomNumber ?? editRoomLabel,
              comments: properties.comments != null ? properties.comments : room.comments
            };
          });
          if (!didApplyDashboardPatch && editRoomLabel && labelFallbackIndexes.length === 1) {
            const idx = labelFallbackIndexes[0];
            if (nextRooms[idx]) {
              didApplyDashboardPatch = true;
                nextRooms[idx] = {
                  ...nextRooms[idx],
                  type: properties.type != null ? properties.type : nextRooms[idx].type,
                  department: properties.department != null ? properties.department : nextRooms[idx].department,
                  occupant: properties.occupant != null ? properties.occupant : nextRooms[idx].occupant,
                  occupancyStatus: properties.occupancyStatus != null
                    ? properties.occupancyStatus
                    : nextRooms[idx].occupancyStatus,
                  seatCount: seatCountProvided ? seatCountValue : (nextRooms[idx].seatCount ?? nextRooms[idx].SeatCount ?? nextRooms[idx]['Seat Count']),
                  area: areaValue > 0 ? areaValue : (nextRooms[idx].area ?? nextRooms[idx].areaSF ?? nextRooms[idx].sf),
                  areaSF: areaValue > 0 ? areaValue : (nextRooms[idx].areaSF ?? nextRooms[idx].sf ?? nextRooms[idx].area),
                  sf: areaValue > 0 ? areaValue : (nextRooms[idx].sf ?? nextRooms[idx].areaSF ?? nextRooms[idx].area),
                  roomLabel: nextRooms[idx].roomLabel ?? nextRooms[idx].name ?? nextRooms[idx].number ?? editRoomLabel,
                  comments: properties.comments != null ? properties.comments : nextRooms[idx].comments
                };
            }
          }
          if (!didApplyDashboardPatch && editRoomLabel) {
            const roomLabelKey = normalizeKeyLoose(editRoomLabel);
            const buildingKey = normalizeKeyLoose(buildingId);
            const floorKey = normalizeKeyLoose(floorName);
            const alreadyExists = nextRooms.some((room) => {
              const roomBuildingKey = normalizeKeyLoose(
                room?.building ?? room?.buildingName ?? room?.buildingLabel ?? ''
              );
              const roomFloorKey = normalizeKeyLoose(
                room?.floor ?? room?.floorId ?? room?.floorName ?? ''
              );
              const roomLabelKeyExisting = normalizeKeyLoose(
                room?.roomLabel ?? room?.name ?? room?.number ?? room?.roomNumber ?? room?.roomId ?? room?.id ?? ''
              );
              return (
                roomLabelKeyExisting &&
                roomLabelKeyExisting === roomLabelKey &&
                (!buildingKey || roomBuildingKey === buildingKey) &&
                (!floorKey || roomFloorKey === floorKey)
              );
            });
            if (!alreadyExists) {
              didApplyDashboardPatch = true;
              nextRooms = [
                ...nextRooms,
                {
                  roomId: editRoomLabel,
                  roomLabel: editRoomLabel,
                  building: buildingId,
                  floor: floorName,
                  area: areaValue || 0,
                  areaSF: areaValue || 0,
                  sf: areaValue || 0,
                  type: properties.type || '',
                  department: properties.department || '',
                  occupant: properties.occupant || '',
                  occupancyStatus: properties.occupancyStatus || '',
                  seatCount: seatCountProvided ? seatCountValue : null,
                  comments: properties.comments || ''
                }
              ];
            }
          }
          return nextRooms;
        });
        if (didUpdateAirtable) {
          scheduleCampusRoomsRefresh();
        }

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
    [db, universityId, scheduleCampusRoomsRefresh]
  );

  // Initialize defaults on mount: first building + LEVEL_1 (or fallback)
useEffect(() => {
  if (selectedBuilding) return;
  if (!BUILDINGS_LIST.length) return;

  const first = BUILDINGS_LIST[0].name;
  setSelectedBuilding(first);
  setSelectedFloor('LEVEL_1');
}, []);

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

  const getDrawingAlignContext = useCallback(() => {
    const rawLabel = activeBuildingName || selectedBuildingId || selectedBuilding || '';
    const buildingLabel = resolveDrawingAlignLabel({
      buildingLabel: rawLabel,
      buildingId: selectedBuildingId || selectedBuilding || ''
    });
    const floorId = panelSelectedFloor || selectedFloor || '';
    return {
      buildingLabel: buildingLabel || rawLabel,
      floorId
    };
  }, [activeBuildingName, selectedBuildingId, selectedBuilding, panelSelectedFloor, selectedFloor]);

  const getFloorAdjustContext = useCallback(() => {
    const floorId = panelSelectedFloor || selectedFloor || '';
    const currentUrl = currentFloorContextRef.current?.url || null;
    const currentBasePath = currentFloorContextRef.current?.floorAdjustBasePath || null;
    const urlFolder =
      currentUrl
        ? getBuildingFolderFromBasePath(currentUrl)
        : null;
    const folderKey = getBuildingFolderKey(selectedBuildingId || selectedBuilding) || urlFolder;
    const storedLabel = currentFloorContextRef.current?.floorAdjustLabel || null;
    const storedFloorId = currentFloorContextRef.current?.floorAdjustFloorId || null;
    const rawLabel = activeBuildingName || selectedBuildingId || selectedBuilding || '';
    const buildingLabel =
      storedLabel ||
      folderKey ||
      resolveDrawingAlignLabel({
        buildingLabel: rawLabel,
        buildingId: selectedBuildingId || selectedBuilding || ''
      }) ||
      rawLabel;
    const resolvedFloorId =
      storedFloorId && fId(storedFloorId) === fId(floorId)
        ? storedFloorId
        : floorId;
    return { buildingLabel, floorId: resolvedFloorId, url: currentUrl, basePath: currentBasePath };
  }, [activeBuildingName, selectedBuildingId, selectedBuilding, panelSelectedFloor, selectedFloor, getBuildingFolderKey]);

  const buildFloorAdjustDocId = useCallback((buildingLabel, floorId) => {
    const key = canon(buildingLabel || '');
    const floorKey = fId(floorId || '');
    if (!key || !floorKey) return null;
    return `${key}__${floorKey}`;
  }, []);

  const loadFloorAdjustFromDb = useCallback(
    async (buildingLabel, floorId) => {
      if (!universityId || !buildingLabel || !floorId) return null;
      const docId = buildFloorAdjustDocId(buildingLabel, floorId);
      if (!docId) return null;
      try {
        const ref = doc(db, 'universities', universityId, 'floorAdjustments', docId);
        const snap = await getDoc(ref);
        if (!snap.exists()) return null;
        return snap.data() || null;
      } catch {
        return null;
      }
    },
    [db, universityId, buildFloorAdjustDocId]
  );

  const saveFloorAdjustToDb = useCallback(
    async (buildingLabel, floorId, adjust) => {
      if (!universityId || !buildingLabel || !floorId || !adjust) return;
      const docId = buildFloorAdjustDocId(buildingLabel, floorId);
      if (!docId) return;
      try {
        const ref = doc(db, 'universities', universityId, 'floorAdjustments', docId);
        await setDoc(
          ref,
          {
            buildingLabel,
            floorId,
            rotationDeg: Number.isFinite(adjust.rotationDeg) ? adjust.rotationDeg : 0,
            scale: Number.isFinite(adjust.scale) ? adjust.scale : 1,
            translateMeters: Array.isArray(adjust.translateMeters) ? adjust.translateMeters : [0, 0],
            translateLngLat: Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : null,
            anchorLngLat: Array.isArray(adjust.anchorLngLat) ? adjust.anchorLngLat : null,
            pivot: Array.isArray(adjust.pivot) ? adjust.pivot : null,
            updatedAt: serverTimestamp(),
            updatedBy: authUser?.uid || authUser?.email || null
          },
          { merge: true }
        );
      } catch {}
    },
    [db, universityId, buildFloorAdjustDocId, authUser]
  );

  const computeDrawingAlign = useCallback((roomPts, drawingPts) => {
    if (!Array.isArray(roomPts) || roomPts.length < 2) return null;
    if (!Array.isArray(drawingPts) || drawingPts.length < 2) return null;
    const [r1, r2] = roomPts;
    const [d1, d2] = drawingPts;
    const rvx = r2[0] - r1[0];
    const rvy = r2[1] - r1[1];
    const dvx = d2[0] - d1[0];
    const dvy = d2[1] - d1[1];
    const roomDist = Math.hypot(rvx, rvy);
    const drawDist = Math.hypot(dvx, dvy);
    if (!Number.isFinite(roomDist) || !Number.isFinite(drawDist) || roomDist <= 0 || drawDist <= 0) return null;
    const roomAngle = Math.atan2(rvy, rvx);
    const drawAngle = Math.atan2(dvy, dvx);
    const rotationDeg = ((roomAngle - drawAngle) * 180) / Math.PI;
    const scale = roomDist / drawDist;
    return {
      rotationDeg,
      scale,
      pivot: d1,
      target: r1
    };
  }, []);

  const cancelDrawingAlign = useCallback(() => {
    setDrawingAlignState(null);
    setDrawingAlignNotice('');
  }, []);

  const startDrawingAlign = useCallback(() => {
    if (!mapRef.current || !mapRef.current.getLayer(FLOOR_FILL_ID)) {
      alert('Load a floorplan first, then start align.');
      return;
    }
    const { buildingLabel, floorId } = getDrawingAlignContext();
    if (!buildingLabel || !floorId) {
      alert('Select a building and floor before aligning.');
      return;
    }
    setDrawingAlignNotice('');
    setDrawingAlignState({
      buildingLabel,
      floorId,
      roomPts: [],
      drawingPts: [],
      step: 0
    });
  }, [getDrawingAlignContext]);

  const clearDrawingAlignForFloor = useCallback(async () => {
    const { buildingLabel, floorId } = getDrawingAlignContext();
    if (!buildingLabel || !floorId) return;
    clearDrawingAlign(buildingLabel, floorId);
    setDrawingAlignNotice('');
    const url = buildFloorUrl(selectedBuilding, floorId);
    if (url) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
    }
    await handleLoadFloorplan(floorId);
  }, [getDrawingAlignContext, selectedBuilding, buildFloorUrl, handleLoadFloorplan]);

  const startFloorRotate = useCallback(() => {
    if (!mapRef.current || !mapRef.current.getLayer(FLOOR_FILL_ID)) {
      alert('Load a floorplan first, then rotate.');
      return;
    }
    const { buildingLabel, floorId } = getFloorAdjustContext();
    if (!buildingLabel || !floorId) {
      alert('Select a building and floor before rotating.');
      return;
    }
    setFloorAdjustNotice('');
    setFloorAdjustMode('rotate');
  }, [getFloorAdjustContext]);

  const startFloorMove = useCallback(() => {
    if (!mapRef.current || !mapRef.current.getLayer(FLOOR_FILL_ID)) {
      alert('Load a floorplan first, then move.');
      return;
    }
    const { buildingLabel, floorId } = getFloorAdjustContext();
    if (!buildingLabel || !floorId) {
      alert('Select a building and floor before moving.');
      return;
    }
    setFloorAdjustNotice('');
    setFloorAdjustMode('move');
  }, [getFloorAdjustContext]);

  const cancelFloorAdjust = useCallback(() => {
    setFloorAdjustMode(null);
    setFloorAdjustNotice('');
    try { mapRef.current?.dragPan?.enable(); } catch {}
  }, []);

  const clearFloorAdjustForFloor = useCallback(async () => {
    const { buildingLabel, floorId } = getFloorAdjustContext();
    if (!buildingLabel || !floorId) return;
    const adjustLabel = currentFloorContextRef.current?.floorAdjustLabel || buildingLabel;
    clearFloorAdjust(adjustLabel, floorId);
    const adjustBasePath = currentFloorContextRef.current?.floorAdjustBasePath || null;
    if (adjustBasePath) clearFloorAdjustByBasePath(adjustBasePath, floorId);
    const adjustUrl = currentFloorContextRef.current?.url || buildFloorUrl(selectedBuilding, floorId);
    if (adjustUrl) clearFloorAdjustByUrl(adjustUrl);
    try {
      await saveFloorAdjustToDb(adjustLabel, floorId, {
        rotationDeg: 0,
        scale: 1,
        translateMeters: [0, 0],
        translateLngLat: null,
        anchorLngLat: null,
        pivot: null
      });
    } catch {}
    setFloorAdjustNotice('');
    const url = adjustUrl || buildFloorUrl(selectedBuilding, floorId);
    if (url) {
      floorCache.delete(url);
      floorTransformCache.delete(url);
    }
    await handleLoadFloorplan(floorId);
  }, [getFloorAdjustContext, selectedBuilding, buildFloorUrl, handleLoadFloorplan, saveFloorAdjustToDb]);

  const drawingAlignContext = getDrawingAlignContext();
  const drawingAlignStored = Boolean(
    loadDrawingAlign(drawingAlignContext.buildingLabel, drawingAlignContext.floorId)
  );
  const drawingAlignStepLabel = drawingAlignState
    ? (DRAWING_ALIGN_STEPS[drawingAlignState.step]?.label || '')
    : '';
  const drawingAlignStep = drawingAlignState ? drawingAlignState.step : 0;
  const drawingAlignActive = Boolean(drawingAlignState);

  const floorAdjustContext = getFloorAdjustContext();
  const floorAdjustByBase = floorAdjustContext.basePath
    ? loadFloorAdjustByBasePath(floorAdjustContext.basePath, floorAdjustContext.floorId)
    : null;
  const floorAdjustByUrl = floorAdjustContext.url ? loadFloorAdjustByUrl(floorAdjustContext.url) : null;
  const floorAdjustByLabel = loadFloorAdjust(floorAdjustContext.buildingLabel, floorAdjustContext.floorId);
  const floorAdjustPick = pickLatestFloorAdjust({
    base: floorAdjustByBase,
    url: floorAdjustByUrl,
    label: floorAdjustByLabel
  });
  const floorAdjustValue = floorAdjustPick.adjust;
  const floorAdjustDebugInfo = isAdminUser ? {
    source: floorAdjustPick.source,
    labelKey: buildFloorAdjustKey(floorAdjustContext.buildingLabel, floorAdjustContext.floorId),
    urlKey: floorAdjustContext.url ? buildFloorAdjustUrlKey(floorAdjustContext.url) : null,
    baseKey: floorAdjustContext.basePath
      ? buildFloorAdjustFloorKey(floorAdjustContext.basePath, floorAdjustContext.floorId)
      : null,
    floorId: floorAdjustContext.floorId,
    url: floorAdjustContext.url,
    basePath: floorAdjustContext.basePath,
    savedAt: floorAdjustValue?.savedAt || 0,
    rotationDeg: floorAdjustValue?.rotationDeg || 0,
    scale: floorAdjustValue?.scale || 1,
    translateMeters: floorAdjustValue?.translateMeters || [0, 0],
    translateLngLat: floorAdjustValue?.translateLngLat || null,
    anchorLngLat: floorAdjustValue?.anchorLngLat || null,
    pivot: floorAdjustValue?.pivot || currentFloorContextRef.current?.floorAdjustBasePivot || null,
    storedKeys: (() => {
      if (typeof window === 'undefined' || !window.localStorage) return [];
      try {
        const all = Object.keys(window.localStorage).filter((k) =>
          k.startsWith(FLOORPLAN_ADJUST_STORAGE_PREFIX) ||
          k.startsWith(FLOORPLAN_ADJUST_URL_PREFIX) ||
          k.startsWith(FLOORPLAN_ADJUST_FLOOR_PREFIX)
        );
        const floorKey = fId(floorAdjustContext.floorId || '');
        return all.filter((k) => floorKey && k.includes(`/${floorKey}`));
      } catch {
        return [];
      }
    })()
  } : null;
  const floorRotateValue = floorAdjustValue?.rotationDeg || 0;
  const floorScaleValue = floorAdjustValue?.scale || 1;
  const floorTranslateValue = floorAdjustValue?.translateMeters || [0, 0];
  const floorAdjustStored = hasFloorAdjust(floorAdjustValue);

  const loadSelectedFloor = useCallback(() => {
    if (!panelSelectedFloor) return;
    if (panelSelectedFloor !== selectedFloor) {
      setSelectedFloor(panelSelectedFloor);
    }
    handlePanelLoadFloor(panelSelectedFloor);
  }, [panelSelectedFloor, handlePanelLoadFloor, selectedFloor]);

  async function handleLoadFloorplan(floorOverride) {
    if (!mapLoaded || !mapRef.current) return false;
    const floorIdRaw = floorOverride || selectedFloor;
    const buildingKey = getBuildingFolderKey(selectedBuildingId || selectedBuilding);
    const buildingFloors = buildingKey ? getAvailableFloors(buildingKey) : availableFloors;
    const floorId = resolveAvailableFloorId(floorIdRaw, buildingFloors);
    if (!floorId) {
      alert('This floor is not available for this building.');
      return false;
    }
    if (floorId !== selectedFloor) {
      setSelectedFloor(floorId);
    }
    const url = buildFloorUrl(selectedBuilding, floorId);
    if (!url) { alert('No file mapped for that floor.'); return false; }
    try {
      setPopupMode('floor');
      setFloorStats(null);
      setPanelStats({ loading: true, mode: 'floor' });
      const lastSel = floorSelectionRef.current?.[url];
      const buildingFolder = getBuildingFolderKey(selectedBuildingId || selectedBuilding);
      const basePath = buildingFolder
        ? assetUrl(`floorplans/Hastings/${buildingFolder}`)
        : null;
      const urlFolder = url ? getBuildingFolderFromBasePath(url) : null;
      const adjustLabel =
        buildingKey ||
        urlFolder ||
        resolveBuildingNameFromInput(selectedBuildingId || selectedBuilding || '') ||
        selectedBuildingId ||
        selectedBuilding;
      const localAdjustByBase = basePath ? loadFloorAdjustByBasePath(basePath, floorId) : null;
      const localAdjustByUrl = url ? loadFloorAdjustByUrl(url) : null;
      const localAdjustByLabel = loadFloorAdjust(adjustLabel, floorId);
      const localPick = pickLatestFloorAdjust({
        base: localAdjustByBase,
        url: localAdjustByUrl,
        label: localAdjustByLabel
      });
      const localAdjust = localPick.adjust;
      const localHasAdjust = hasFloorAdjust(localAdjust);
      const localSavedAt = Number(localAdjust?.savedAt) || 0;
      const dbAdjust = await loadFloorAdjustFromDb(adjustLabel, floorId);
      if (dbAdjust) {
        const dbCandidate = {
          rotationDeg: Number(dbAdjust.rotationDeg) || 0,
          scale: Number(dbAdjust.scale) || 1,
          translateMeters: Array.isArray(dbAdjust.translateMeters) ? dbAdjust.translateMeters : [0, 0],
          translateLngLat: Array.isArray(dbAdjust.translateLngLat) ? dbAdjust.translateLngLat : null,
          anchorLngLat: Array.isArray(dbAdjust.anchorLngLat) ? dbAdjust.anchorLngLat : null,
          pivot: Array.isArray(dbAdjust.pivot) ? dbAdjust.pivot : null
        };
        const dbHasAdjust =
          hasFloorAdjust(dbCandidate);
        const dbUpdatedAtMs = (() => {
          const ts = dbAdjust.updatedAt;
          if (ts?.toMillis) return ts.toMillis();
          if (Number.isFinite(ts?.seconds)) return ts.seconds * 1000;
          return 0;
        })();
        const shouldPreferDb = dbUpdatedAtMs
          ? dbUpdatedAtMs >= localSavedAt
          : (!localHasAdjust && dbHasAdjust);
        if (shouldPreferDb) {
          saveFloorAdjust(adjustLabel, floorId, dbCandidate);
          if (url) saveFloorAdjustByUrl(url, dbCandidate);
          if (basePath) saveFloorAdjustByBasePath(basePath, floorId, dbCandidate);
          if (url) {
            floorCache.delete(url);
            floorTransformCache.delete(url);
          }
        }
      }
      let fitBuilding = selectedBuildingFeatureRef.current || null;
      const targetRaw = String(selectedBuildingId || selectedBuilding || '');
      try {
        const targetKey = normalizeSnapKey(targetRaw);
        const fitKey = normalizeSnapKey(fitBuilding?.properties?.id || fitBuilding?.properties?.name || '');
        if (!fitKey || (targetKey && fitKey !== targetKey)) {
          fitBuilding = null;
        }
      } catch {}
      if (!fitBuilding) {
        try {
          const feats = config?.buildings?.features || [];
          const directMatch = feats.find((f) => String(f.properties?.id) === targetRaw) || null;
          if (directMatch) {
            fitBuilding = directMatch;
          } else {
            fitBuilding = matchBuildingFeature(feats, targetRaw);
          }
          if (fitBuilding) {
            selectedBuildingFeatureRef.current = fitBuilding;
          }
        } catch {}
      }
      if (!fitBuilding && activeBuildingFeature) {
        fitBuilding = activeBuildingFeature;
        selectedBuildingFeatureRef.current = activeBuildingFeature;
      }
      if (!fitBuilding) {
        fitBuilding = findBuildingFeatureInMap(mapRef.current, targetRaw);
        if (fitBuilding) {
          selectedBuildingFeatureRef.current = fitBuilding;
        }
      }
      const rotationOverrideDeg = getFloorplanRotationOverride(
        fitBuilding?.properties?.id ||
        fitBuilding?.properties?.name ||
        selectedBuildingId ||
        selectedBuilding,
        floorId
      );
      const loadResult = await loadFloorGeojson(mapRef.current, url, lastSel, { fitBuilding, rotationOverrideDeg }, {
        buildingId: selectedBuildingId || selectedBuilding,
        floor: floorId,
        roomPatches,
        airtableLookup: airtableRoomLookup,
        currentFloorContextRef,
        roomsBasePath: basePath,
        roomsFloorId: floorId,
        wallsBasePath: basePath,
        wallsFloorId: floorId,
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
      const canonicalFloorId = fId(floorId || '');
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
        floorLabel: floorId,
        floorAdjustLabel: adjustLabel || currentFloorContextRef.current?.floorAdjustLabel || null,
        floorAdjustFloorId: floorId,
        floorAdjustBasePath: basePath || currentFloorContextRef.current?.floorAdjustBasePath || null
      };

      const summaryFromRooms = (campusRoomsLoaded && Array.isArray(campusRooms) && campusRooms.length)
        ? summarizeRoomRowsForPanels(
            campusRooms.filter((room) => {
              const roomBuilding =
                room?.building ??
                room?.buildingName ??
                room?.buildingLabel ??
                '';
              if (normalizeDashboardKey(roomBuilding) !== normalizeDashboardKey(selectedBuildingId || selectedBuilding)) return false;
              const floorTokens = normalizeFloorTokens(floorId);
              if (!floorTokens.length) return true;
              return floorMatchesTokens(room?.floor ?? room?.floorName ?? room?.floorId ?? '', floorTokens);
            })
          )
        : null;

      const summaryToUse = summaryFromRooms || loadResult.summary || null;
      if (summaryToUse) {
        floorStatsCache.current[url] = summaryToUse;
        floorSummaryCacheRef.current.set(url, summaryToUse);
        const summaryWithLabel = { ...summaryToUse, floorLabel: floorId };
        setFloorStats(summaryWithLabel);
        setFloorLegendItems(toKeyDeptList(filterDeptTotals(summaryToUse.totalsByDept)));
        if (currentFloorUrlRef.current === url) {
          setPanelStats(formatSummaryForPanel(summaryToUse, 'floor'));
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
    const res = await guardedAiFetch('/ai/explain-floor', {
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
    const res = await guardedAiFetch('/ai/explain-campus', {
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
    const res = await guardedAiFetch('/ai/compare-scenario', {
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
    const res = await guardedAiFetch('/ai/create-move-scenario', {
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
    const res = await guardedAiFetch('/ai/ask-mapfluence', {
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
    const res = await guardedAiFetch('/ai/explain-building', {
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
      const buildingNameForRows =
        resolveBuildingNameFromInput(selectedBuildingId || selectedBuilding) ||
        selectedBuilding ||
        selectedBuildingId ||
        '';

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

  useEffect(() => {
    if (!aiScenarioComparePending) return;
    if (!scenarioAssignedDept || !scenarioTotals?.rooms) return;
    setAiScenarioComparePending(false);
    onCompareScenario();
  }, [aiScenarioComparePending, scenarioAssignedDept, scenarioTotals, onCompareScenario]);

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
    const aiBase = (import.meta.env.VITE_AI_BASE_URL || '').trim();
    const isStaticHost = typeof window !== 'undefined' && window.location.hostname.includes('github.io');
    if (isStaticHost && !aiBase) {
      setAiStatus('down');
      return () => {};
    }

    const healthUrl = aiBase ? `${aiBase.replace(/\/$/, '')}/ai/health` : '/ai/health';
    const ping = async () => {
      try {
        const r = await fetch(healthUrl, { cache: 'no-store' });
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
      solidFill: true,
      labelOptions: { hideDrawing: true }
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
      setScenarioPanelPos(null);
      setScenarioPanelTop(20);
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
        const typeVal = getRoomTypeLabelFromProps(merged) || merged.Name || '';
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

      const allRooms = (campusRoomsLoaded && Array.isArray(campusRooms)) ? campusRooms : [];
      const deptCandidates = getDeptCandidates(allRooms);
      const inferredDept = scenarioAssignedDept || findDeptInText(request, deptCandidates) || '';
      const excludeBuildings = inferredDept ? getDeptCurrentBuildings(allRooms, inferredDept) : [];
      const excludeBuildingKeys = new Set(
        (excludeBuildings || []).map((name) => normalizeDashboardKey(name)).filter(Boolean)
      );
      const buildingCandidates = getBuildingCandidates(allRooms);
      const inferredBuilding = findBuildingInText(request, buildingCandidates) || '';

      const buildingLabel = inferredBuilding || activeBuildingName || selectedBuilding || '';
      const floorId = ''; // avoid biasing to a single floor; inventory is campus-wide

      let inventory = [];
      if (campusRoomsLoaded && Array.isArray(campusRooms) && campusRooms.length) {
        inventory = buildInventoryFromRoomRows(campusRooms, 2000) || [];
      } else {
        try {
          const rows = await collectSpaceRows('__all__', '');
          inventory = buildInventoryFromRoomRows(rows, 250) || [];
        } catch {}
      }

      if (!inventory.length) {
        const featureList =
          currentFloorContextRef?.current?.fc?.features ||
          [];
        inventory = buildInventoryFromFeatures(featureList, buildingLabel, floorId, 250) || [];
      }

      if (!inventory.length) {
        throw new Error('No room inventory loaded yet. Load Space Data or a floorplan first.');
      }

      if (inferredBuilding) {
        const targetKey = normalizeDashboardKey(inferredBuilding);
        const filteredInventory = inventory.filter((room) => {
          const buildingName =
            room?.buildingLabel ??
            room?.building ??
            room?.buildingName ??
            '';
          return normalizeDashboardKey(buildingName) === targetKey;
        });
        if (!filteredInventory.length) {
          throw new Error(`No rooms found for ${inferredBuilding}.`);
        }
        inventory = filteredInventory;
      }

      if (excludeBuildingKeys.size) {
        const filteredInventory = inventory.filter((room) => {
          const buildingName =
            room?.buildingLabel ??
            room?.building ??
            room?.buildingName ??
            '';
          return !excludeBuildingKeys.has(normalizeDashboardKey(buildingName));
        });
        if (!filteredInventory.length) {
          throw new Error(
            `No rooms available outside the current ${inferredDept || 'department'} home building(s).`
          );
        }
        inventory = filteredInventory;
      }

      inventory = minifyMoveScenarioInventory(inventory);

      let baselineTotals = null;
      let baselineBuildingLabel = '';
      if (inferredDept) {
        try {
          const { perBuilding, campusTotals } = await computeDeptTotalsByBuildingAcrossCampus(inferredDept, {
            ensureFloorsForBuilding,
            buildFloorUrl,
            floorCache,
            fetchGeoJSON
          });
          const baselineEntry = Object.entries(perBuilding || {}).sort(
            (a, b) => (b[1]?.totalSF || 0) - (a[1]?.totalSF || 0) || (b[1]?.rooms || 0) - (a[1]?.rooms || 0)
          )[0] || null;
          baselineTotals = baselineEntry ? baselineEntry[1] : campusTotals;
          baselineBuildingLabel = baselineEntry ? baselineEntry[0] : '';
          if (baselineTotals) {
            baselineTotals = { ...baselineTotals, __label: baselineBuildingLabel || 'campus' };
          }
        } catch {}
      }

      const inventoryTrimOptions = inferredBuilding
        ? { maxTotal: 260, maxPerBuilding: 260, maxPerType: 35 }
        : { maxTotal: 220, maxPerBuilding: 90, maxPerType: 25 };
      if (baselineTotals && inventory.length > inventoryTrimOptions.maxTotal) {
        inventory = selectScenarioInventoryByBaseline(inventory, baselineTotals, {
          maxTotal: inventoryTrimOptions.maxTotal,
          minPerType: inferredBuilding ? 8 : 5,
          maxPerType: inferredBuilding ? 45 : 35
        });
      } else {
        inventory = shrinkMoveScenarioInventory(inventory, inventoryTrimOptions);
      }

      const inventoryLookup = new Map();
      inventory.forEach((room) => {
        if (!room) return;
        const keys = [room.roomId, room.id, room.revitId].filter((v) => v != null).map((v) => String(v));
        keys.forEach((key) => {
          if (!inventoryLookup.has(key)) inventoryLookup.set(key, room);
        });
      });
      const findInventoryMatchForCandidate = (candidate) => {
        if (!candidate || !inventory.length) return null;
        const buildingKey = normalizeDashboardKey(candidate?.buildingLabel || '');
        const floorTokens = normalizeFloorTokens(candidate?.floorName || candidate?.floorId || '');
        const roomLabelKey = normalizeRoomLabelMatch(candidate?.roomLabel || candidate?.roomNumber || '');
        if (roomLabelKey) {
          const direct = inventory.find((room) => {
            const roomBuilding = normalizeDashboardKey(
              room?.buildingLabel ?? room?.buildingName ?? room?.building ?? ''
            );
            if (buildingKey && roomBuilding !== buildingKey) return false;
            if (floorTokens.length && !floorMatchesTokens(room?.floorName ?? room?.floorId ?? '', floorTokens)) {
              return false;
            }
            const roomLabelMatch = normalizeRoomLabelMatch(room?.roomLabel ?? room?.roomNumber ?? '');
            return roomLabelMatch && roomLabelMatch === roomLabelKey;
          });
          if (direct) return direct;
        }
        const typeKey = normalizeTypeMatch(candidate?.type || '');
        const candidateSf = Number(candidate?.sf || 0);
        const hasSf = Number.isFinite(candidateSf) && candidateSf > 0;
        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        inventory.forEach((room) => {
          const roomBuilding = normalizeDashboardKey(
            room?.buildingLabel ?? room?.buildingName ?? room?.building ?? ''
          );
          if (buildingKey && roomBuilding !== buildingKey) return;
          if (floorTokens.length && !floorMatchesTokens(room?.floorName ?? room?.floorId ?? '', floorTokens)) return;
          const roomTypeKey = normalizeTypeMatch(room?.type || room?.roomType || '');
          let score = 0;
          if (typeKey && roomTypeKey) score += (roomTypeKey === typeKey ? 0 : 1000);
          else if (typeKey) score += 500;
          if (hasSf) {
            const roomSf = Number(room?.sf ?? room?.area ?? room?.areaSF ?? 0);
            if (Number.isFinite(roomSf)) score += Math.abs(roomSf - candidateSf);
          }
          if (score < bestScore) {
            bestScore = score;
            best = room;
          }
        });
        return best;
      };

      const context = {
        universityId,
        campusLabel: activeUniversityName || universityId || 'Campus',
        buildingLabel,
        floorId,
        moveScenarioMode: true,
        scenarioDepartment: scenarioAssignedDept || inferredDept || '',
        targetDepartment: inferredDept || scenarioAssignedDept || '',
        excludeBuildings: excludeBuildings || [],
        scenarioLabel: (scenarioLabel || '').trim(),
        scope: inferredBuilding ? 'building' : 'campus'
      };

      const baselineTotalsForConstraints = baselineTotals
        ? {
            totalSF: Math.round(baselineTotals.totalSF || 0),
            rooms: Math.round(baselineTotals.rooms || 0),
            sfByType: Object.entries(baselineTotals.sfByRoomType || {}).map(([type, sf]) => ({
              type,
              sf: Math.round(Number(sf || 0) || 0)
            })),
            roomTypes: Object.entries(baselineTotals.roomTypes || {}).map(([type, count]) => ({
              type,
              count: Math.round(Number(count || 0) || 0)
            }))
          }
        : null;
      const scenarioConstraints = baselineTotalsForConstraints
        ? { baselineTotals: baselineTotalsForConstraints, targetSfTolerance: aiCreateScenarioStrict ? 0.05 : 0.1 }
        : null;

      const out = await createMoveScenario({ request, context, inventory, constraints: scenarioConstraints });
      const recommended = Array.isArray(out?.recommendedCandidates)
        ? out.recommendedCandidates.map((c) => {
          const keys = [c?.roomId, c?.id, c?.revitId].filter((v) => v != null).map((v) => String(v));
          const match = keys.map((k) => inventoryLookup.get(k)).find(Boolean) || findInventoryMatchForCandidate(c);
          if (!match) {
            return {
              ...c,
              floorName: c?.floorName || c?.floorId || '',
              rationale: sanitizeVacancyLanguage(c?.rationale)
            };
          }
          const matchSf = Number(match.sf ?? match.area ?? match.areaSF ?? 0);
          const candidateSf = Number(c?.sf ?? 0);
          return {
            ...c,
            roomId: c?.roomId || match.roomId || match.id || '',
            id: c?.id || match.id || match.roomId || '',
            revitId: c?.revitId ?? match.revitId ?? null,
            roomGuid: c?.roomGuid ?? match.roomGuid ?? match.revitId ?? null,
            buildingLabel: c?.buildingLabel || match.buildingLabel || match.buildingName || match.building || '',
            roomLabel: c?.roomLabel || match.roomLabel || match.roomNumber || '',
            type: c?.type || match.type || match.roomType || '',
            sf: Number.isFinite(candidateSf) && candidateSf > 0
              ? candidateSf
              : (Number.isFinite(matchSf) ? matchSf : 0),
            vacancy: match.vacancy ?? c.vacancy,
            occupant: match.occupant ?? c.occupant,
            occupancyStatus: match.occupancyStatus ?? c.occupancyStatus,
            occupantDept: match.occupantDept ?? c.occupantDept,
            department: match.department ?? c.department,
            floorName: c?.floorName || c?.floorId || match.floorName || match.floorId || '',
            rationale: sanitizeVacancyLanguage(c?.rationale)
          };
        })
        : [];
      let adjustedCandidates = recommended;
      let autoFillNote = '';
      if (baselineTotals) {
        const { candidates: filled, added } = fillScenarioCandidatesToBaseline(
          recommended,
          inventory,
          baselineTotals,
          { targetTolerance: scenarioConstraints?.targetSfTolerance ?? 0.1, maxCandidates: aiCreateScenarioStrict ? 40 : 30 }
        );
        if (added > 0) {
          adjustedCandidates = filled;
          autoFillNote = `Auto-filled ${added} rooms to better match baseline SF and room-type mix.`;
        }
      }
      const baselineTotalSF = baselineTotals?.totalSF || out?.baselineTotals?.totalSF || 0;
      const tolerancePct = Math.round(((scenarioConstraints?.targetSfTolerance ?? 0.1) * 100));
      const baselineCriteria = baselineTotalSF
        ? [`Aim for total SF within +/-${tolerancePct}% of baseline department total SF (${Math.round(baselineTotalSF).toLocaleString()} SF).`]
        : [];
      const cleanedCriteria = Array.isArray(out?.selectionCriteria)
        ? out.selectionCriteria.filter((c) => !/baseline|total\s*sf|sf within/i.test(c || ''))
        : [];
      setAiCreateScenarioResult({
        ...out,
        baselineTotals: baselineTotals || out?.baselineTotals,
        selectionCriteria: [...baselineCriteria, ...(autoFillNote ? [autoFillNote] : []), ...cleanedCriteria],
        recommendedCandidates: adjustedCandidates
      });
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
    campusRoomsLoaded,
    campusRooms,
    collectSpaceRows,
    createMoveScenario,
    ensureFloorsForBuilding,
    buildFloorUrl,
    fetchGeoJSON,
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

      const allRooms = (campusRoomsLoaded && Array.isArray(campusRooms)) ? campusRooms : [];
      const deptCandidates = getDeptCandidates(allRooms);
      const inferredDept = findDeptInText(q, deptCandidates) || '';
      const buildingCandidates = getBuildingCandidates(allRooms);
      const inferredBuilding = findBuildingInText(q, buildingCandidates) || '';
      const relocationQuery =
        /best new suitable home|suitable home|best home|relocat|move|find space|new home|anywhere|entire campus|campus-wide/i
          .test(q);
      const floorMentioned = /\b(basement|ground floor|first floor|second floor|third floor|fourth floor|fifth floor|sixth floor|seventh floor|eighth floor|ninth floor|tenth floor|level\s*\d+|level\s*(one|two|three|four|five|six|seven|eight|nine|ten)|lvl\s*\d+|floor\s*\d+|floor\s*(one|two|three|four|five|six|seven|eight|nine|ten))\b/i
        .test(q);
      const campusWideQuery = /\b(entire campus|campus[-\s]?wide|across campus|anywhere on campus)\b/i.test(q) ||
        ((/\bwhere\s+(is|are)\b|\blocation of\b|\bwhere\b.*\b(located|location)\b|\bwhich building\b|\bwhat building\b/i.test(q)) &&
          inferredDept && !inferredBuilding);
      const excludeBuildings = (relocationQuery && inferredDept)
        ? getDeptCurrentBuildings(allRooms, inferredDept)
        : [];
      const excludeBuildingKeys = new Set(
        (excludeBuildings || []).map((name) => normalizeDashboardKey(name)).filter(Boolean)
      );

      const buildingIdVal = selectedBuildingId || selectedBuilding || '';
      const buildingNameForRows =
        resolveBuildingNameFromInput(selectedBuildingId || selectedBuilding) ||
        selectedBuilding ||
        selectedBuildingId ||
        '';
      const forceCampusScope = relocationQuery || campusWideQuery;
      const shouldUseFloorScope = !forceCampusScope && loadedSingleFloor && floorMentioned;
      const context = {
        universityId,
        buildingId: buildingIdVal,
        buildingLabel: forceCampusScope
          ? (activeUniversityName || universityId || 'Campus')
          : (activeBuildingName || buildingNameForRows || ''),
        floorId: shouldUseFloorScope ? (selectedFloor || '') : '',
        scope: forceCampusScope ? 'campus' : (shouldUseFloorScope ? 'floor' : (buildingIdVal ? 'building' : 'campus')),
        targetDepartment: inferredDept || '',
        excludeBuildings: excludeBuildings || []
      };

      const baseScopeRooms = (() => {
        if (!campusRoomsLoaded) return [];
        if (forceCampusScope) return campusRooms;
        const hasBuildingScope = Boolean(selectedBuildingId) || Boolean(selectedBuilding) || loadedSingleFloor;
        if (!hasBuildingScope) return campusRooms;
        const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
        if (!buildingLabel) return campusRooms;
        const buildingKeys = new Set([
          normalizeDashboardKey(activeBuildingName),
          normalizeDashboardKey(selectedBuildingId),
          normalizeDashboardKey(selectedBuilding)
        ].filter(Boolean));
        if (!buildingKeys.size) return campusRooms;
        const buildingRooms = campusRooms.filter((room) => {
          const roomBuilding =
            room?.building ??
            room?.buildingName ??
            room?.buildingLabel ??
            '';
          return buildingKeys.has(normalizeDashboardKey(roomBuilding));
        });
        if (!shouldUseFloorScope) return buildingRooms;
        const floorLabel = (currentFloorContextRef.current?.floorLabel || selectedFloor || '').trim();
        const floorTokens = normalizeFloorTokens(floorLabel);
        if (!floorTokens.length) return buildingRooms;
        return buildingRooms.filter((room) =>
          floorMatchesTokens(room?.floor ?? room?.floorName ?? room?.floorId ?? '', floorTokens)
        );
      })();
      const scopeRooms = excludeBuildingKeys.size
        ? baseScopeRooms.filter((room) => {
          const buildingLabel = getRoomBuildingLabel(room);
          return !excludeBuildingKeys.has(normalizeDashboardKey(buildingLabel));
        })
        : baseScopeRooms;
      const fallbackSummary = summarizeRoomRowsForPanels(scopeRooms);
      const floorFallback = (!floorStats && shouldUseFloorScope && fallbackSummary)
        ? { ...fallbackSummary, floorLabel: selectedFloor || '' }
        : null;
      const buildingFallback = (!buildingStats && !shouldUseFloorScope && buildingIdVal && fallbackSummary)
        ? fallbackSummary
        : null;
      let roomRowsPayload = null;
      if (scopeRooms.length) {
        roomRowsPayload = scopeRooms.map((room) => {
          const areaVal = Number(room?.areaSF ?? room?.area ?? room?.sf ?? 0);
          const seatCountVal = Number(room?.seatCount ?? room?.SeatCount ?? room?.['Seat Count'] ?? 0);
          const roomNumber =
            room?.roomNumber ??
            room?.roomLabel ??
            room?.roomId ??
            room?.id ??
            '';
          return {
            building: room?.building ?? room?.buildingName ?? room?.buildingLabel ?? buildingNameForRows,
            floor: room?.floor ?? room?.floorName ?? room?.floorId ?? '',
            roomNumber: roomNumber || '',
            type: String(room?.type ?? room?.roomType ?? '').trim(),
            department: String(room?.department ?? '').trim(),
            area: Number.isFinite(areaVal) ? areaVal : '',
            seatCount: Number.isFinite(seatCountVal) && seatCountVal > 0 ? seatCountVal : '',
            occupant: String(room?.occupant ?? '').trim(),
            occupancyStatus: String(room?.occupancyStatus ?? '').trim()
          };
        });
      } else {
        try {
          const buildingFilter = forceCampusScope ? '__all__' : (buildingNameForRows || '__all__');
          const rows = await collectSpaceRows(buildingFilter, '');
          if (Array.isArray(rows)) {
            const filteredRows = excludeBuildingKeys.size
              ? rows.filter((row) => !excludeBuildingKeys.has(normalizeDashboardKey(row.building)))
              : rows;
            roomRowsPayload = buildingNameForRows ? filteredRows : filteredRows.slice(0, 250);
          } else {
            roomRowsPayload = null;
          }
        } catch {
          roomRowsPayload = null;
        }
      }
      const data = {
        campusStats,
        buildingStats: buildingStats || buildingFallback || undefined,
        floorStats: shouldUseFloorScope ? (floorStats || floorFallback || undefined) : undefined,
        dashboardMetrics: dashboardMetrics || undefined,
        scopeSummary: fallbackSummary || undefined,
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
    campusRoomsLoaded,
    campusRooms,
    campusStats,
    buildingStats,
    floorStats,
    dashboardMetrics,
    loadedSingleFloor,
    askMapfluence,
    resolveBuildingNameFromInput,
    collectSpaceRows
  ]);

  useEffect(() => {
    const pending = pendingScenarioLoadRef.current;
    if (!pending) return;
    if (pending.buildingLabel !== selectedBuilding || pending.floorId !== selectedFloor) return;
    pendingScenarioLoadRef.current = null;
    const candidates = pendingScenarioCandidatesRef.current || [];
    pendingScenarioCandidatesRef.current = null;
    (async () => {
      try {
        const loaded = await handleLoadFloorplan();
        if (!loaded) return;
      } catch {}
      applyScenarioCandidates(candidates);
    })();
  }, [selectedBuilding, selectedFloor, handleLoadFloorplan, applyScenarioCandidates]);

  const applyAiMoveCandidatesToScenario = useCallback(async () => {
    const candidates = aiCreateScenarioResult?.recommendedCandidates || [];
    if (!candidates.length) return;
    const deptGuess = aiCreateScenarioResult?.scenarioDept || scenarioAssignedDept || '';
    setMoveScenarioMode(true);
    if (deptGuess) setScenarioAssignedDept(deptGuess);

    const first = candidates[0];
    const targetBuilding = first?.buildingLabel || selectedBuilding;
    const targetFloor = first?.floorName || first?.floorId || selectedFloor;
    let resolvedFloor = targetFloor;
    if (targetBuilding) {
      const available = await ensureFloorsForBuilding(targetBuilding);
      const matched = resolveAvailableFloorId(targetFloor, available);
      resolvedFloor = matched || available?.[0] || targetFloor;
    }
    const shouldLoad = targetBuilding && resolvedFloor &&
      (targetBuilding !== selectedBuilding || resolvedFloor !== selectedFloor);
    if (shouldLoad) {
      pendingScenarioLoadRef.current = { buildingLabel: targetBuilding, floorId: resolvedFloor };
      pendingScenarioCandidatesRef.current = candidates;
      setSelectedBuilding(targetBuilding);
      setSelectedFloor(resolvedFloor);
      return;
    }

    applyScenarioCandidates(candidates);
  }, [
    aiCreateScenarioResult?.recommendedCandidates,
    aiCreateScenarioResult?.scenarioDept,
    applyScenarioCandidates,
    ensureFloorsForBuilding,
    scenarioAssignedDept,
    selectedBuilding,
    selectedFloor,
    setMoveScenarioMode,
    setScenarioAssignedDept,
    setSelectedBuilding,
    setSelectedFloor
  ]);

  const applyAiScenarioToComparison = useCallback((aiResult) => {
    const candidates = aiResult?.recommendedCandidates || [];
    if (!candidates.length) return;
    const deptGuess = aiResult?.scenarioDept || scenarioAssignedDept || '';
    setMoveScenarioMode(true);
    if (deptGuess) setScenarioAssignedDept(deptGuess);
    applyScenarioCandidates(candidates);
    setAiScenarioComparePending(true);
  }, [
    applyScenarioCandidates,
    scenarioAssignedDept,
    setMoveScenarioMode,
    setScenarioAssignedDept
  ]);

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
  const [spacePanelPos, setSpacePanelPos] = useState(null);
  const [aiScenarioPos, setAiScenarioPos] = useState(null);
  const [aiCreateScenarioResultPos, setAiCreateScenarioResultPos] = useState(null);
  const getMapPageBounds = useCallback(() => {
    const rect = mapPageRef.current?.getBoundingClientRect();
    return rect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }, []);
  const getViewportBounds = useCallback(() => ({
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight
  }), []);
  const handleSpacePanelDragStart = useCallback(
    (event) => beginPanelDrag(event, spacePanelRef, setSpacePanelPos, getMapPageBounds),
    [getMapPageBounds]
  );
  const handleRoomEditDragStart = useCallback(
    (event) => beginPanelDrag(event, roomEditPanelRef, setRoomEditPanelPos, getViewportBounds),
    [getViewportBounds]
  );
  const handleScenarioPanelDragStart = useCallback(
    (event) => beginPanelDrag(event, scenarioPanelRef, setScenarioPanelPos, getMapPageBounds),
    [getMapPageBounds]
  );
  const aiScenarioPanelRef = useRef(null);
  const aiCreateScenarioResultRef = useRef(null);
  const handleAiScenarioDragStart = useCallback(
    (event) => beginPanelDrag(event, aiScenarioPanelRef, setAiScenarioPos, getViewportBounds),
    [getViewportBounds]
  );
  const handleAiCreateScenarioResultDragStart = useCallback(
    (event) => beginPanelDrag(event, aiCreateScenarioResultRef, setAiCreateScenarioResultPos, getViewportBounds),
    [getViewportBounds]
  );
  const spacePanelDragHandleProps = {
    onPointerDown: handleSpacePanelDragStart,
    style: { cursor: 'grab', userSelect: 'none', touchAction: 'none' }
  };
  const roomEditDragHandleProps = {
    onPointerDown: handleRoomEditDragStart,
    style: { cursor: 'grab', userSelect: 'none', touchAction: 'none' }
  };
  const scenarioPanelDragHandleProps = {
    onPointerDown: handleScenarioPanelDragStart,
    style: { cursor: 'grab', userSelect: 'none', touchAction: 'none' }
  };
  const aiScenarioDragHandleProps = {
    onPointerDown: handleAiScenarioDragStart,
    style: { cursor: 'grab', userSelect: 'none', touchAction: 'none' }
  };
  const aiCreateScenarioResultDragHandleProps = {
    onPointerDown: handleAiCreateScenarioResultDragStart,
    style: { cursor: 'grab', userSelect: 'none', touchAction: 'none' }
  };

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
        buildingName: from.buildingName,
        floorName: from.floorId,
        revitId: from.revitId,
        roomLabel: from.roomLabel,
        properties: { occupant: '' }
      });
      const toSaved = await saveRoomEdits({
        roomId: to.roomId,
        buildingId: to.buildingId,
        buildingName: to.buildingName,
        floorName: to.floorId,
        revitId: to.revitId,
        roomLabel: to.roomLabel,
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
      const floorEntries = await loadFloorManifest(folderKey);
      if (cancelled) return;
      const floors = (floorEntries || []).map((f) => f?.id).filter(Boolean);
      const urlMap = new Map(
        (floorEntries || [])
          .filter((f) => f?.id && f?.url)
          .map((f) => [f.id, f.url])
      );
      availableFloorsByBuildingRef.current.set(folderKey, floors);
      availableFloorUrlsByBuildingRef.current.set(folderKey, urlMap);
      if (floors.length) {
        setAvailableFloors(floors);
        setSelectedFloor((prev) => (prev && floors.includes(prev) ? prev : floors[0]));
      } else {
        clearFloors();
      }
    })();

    return () => { cancelled = true; };
  }, [selectedBuildingId, selectedBuilding, getBuildingFolderKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDashboardLoading(true);
      setDashboardError(null);
      setDashboardTitle('Campus Summary');
      try {
        const res = await guardedAiFetch('/ai/api/rooms', { cache: 'no-store' });
        let data = null;
        try {
          data = await res.json();
        } catch {}
        if (!res.ok) {
          const msg = data?.error || data?.message || `Rooms fetch failed (${res.status})`;
          throw new Error(msg);
        }
        if (data?.ok && Array.isArray(data.rooms)) {
          if (!cancelled) {
            setAirtableRooms(data.rooms);
            setAirtableLastSyncedAt(new Date());
          }
          if (data.rooms.some(hasDashboardRoomArea)) {
            return;
          }
        }
        throw new Error('Rooms payload missing or invalid');
      } catch (err) {
        try {
          let manifest = dashboardManifestRef.current;
          if (!manifest) {
            manifest = await fetchJSON(FLOORPLAN_MANIFEST_URL);
            dashboardManifestRef.current = manifest;
          }
          const rooms = await buildCampusRoomsFromManifest(manifest);
          if (!rooms.length) throw new Error('No floorplan rooms found for dashboard');
          if (!cancelled) {
            setCampusRooms(rooms);
            setDashboardError(null);
            setCampusRoomsLoaded(true);
          }
        } catch (fallbackErr) {
          if (!cancelled) setDashboardError(fallbackErr);
        }
      } finally {
        if (!cancelled) {
          setDashboardLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [universityId]);

  useEffect(() => {
    const intervalMs = 30 * 60 * 1000;
    const id = setInterval(() => {
      refreshCampusRoomsFromApi();
    }, intervalMs);
    return () => clearInterval(id);
  }, [refreshCampusRoomsFromApi]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(assetUrl(UTILIZATION_CSV_PATH), { cache: 'no-store' });
        if (!res.ok) throw new Error(`Utilization CSV fetch failed (${res.status})`);
        const text = await res.text();
        const parsed = parseUtilizationCsv(text);
        if (!cancelled) setUtilizationData(parsed);
      } catch (err) {
        console.warn('Unable to load classroom utilization data', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dashboardScopeRooms = useMemo(() => {
    if (!campusRoomsLoaded) return [];
    const hasBuildingScope = Boolean(selectedBuildingId) || loadedSingleFloor;
    if (!hasBuildingScope) return campusRooms;
    const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
    const hasBuilding = Boolean(buildingLabel);
    if (!hasBuilding) return campusRooms;
    const buildingKeys = new Set([
      normalizeDashboardKey(activeBuildingName),
      normalizeDashboardKey(selectedBuildingId),
      normalizeDashboardKey(selectedBuilding)
    ].filter(Boolean));
    if (!buildingKeys.size) return campusRooms;
    const buildingRooms = campusRooms.filter((room) => {
      const roomBuilding =
        room?.building ??
        room?.buildingName ??
        room?.buildingLabel ??
        '';
      return buildingKeys.has(normalizeDashboardKey(roomBuilding));
    });
    const hasFloor = Boolean(loadedSingleFloor && buildingLabel);
    if (!hasFloor) return buildingRooms;
    const floorLabel = (currentFloorContextRef.current?.floorLabel || selectedFloor || '').trim();
    const floorTokens = normalizeFloorTokens(floorLabel);
    if (!floorTokens.length) return buildingRooms;
    return buildingRooms.filter((room) =>
      floorMatchesTokens(room?.floor ?? room?.floorName ?? room?.floorId ?? '', floorTokens)
    );
  }, [
    campusRooms,
    campusRoomsLoaded,
    activeBuildingName,
    selectedBuildingId,
    selectedBuilding,
    loadedSingleFloor,
    selectedFloor
  ]);

  const dashboardScopeLabel = useMemo(() => {
    const hasBuildingScope = Boolean(selectedBuildingId) || loadedSingleFloor;
    if (!hasBuildingScope) return 'Campus';
    const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
    const hasBuilding = Boolean(buildingLabel);
    if (!hasBuilding) return 'Campus';
    const floorLabel = (floorStats?.floorLabel || currentFloorContextRef.current?.floorLabel || selectedFloor || '').trim();
    const hasFloor = Boolean(loadedSingleFloor && buildingLabel && floorLabel);
    return hasFloor ? `${buildingLabel} ${floorLabel}` : buildingLabel;
  }, [
    activeBuildingName,
    selectedBuildingId,
    selectedBuilding,
    loadedSingleFloor,
    selectedFloor,
    floorStats
  ]);

  const dashboardUtilization = useMemo(() => {
    const hasBuildingScope = Boolean(selectedBuildingId) || loadedSingleFloor;
    if (hasBuildingScope) {
      const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
      if (!buildingLabel) return null;
      return getUtilizationForBuilding(buildingLabel);
    }
    return utilizationCampus;
  }, [
    activeBuildingName,
    selectedBuildingId,
    selectedBuilding,
    loadedSingleFloor,
    utilizationCampus,
    getUtilizationForBuilding
  ]);

  const dashboardUtilizationLabel = useMemo(() => {
    const hasBuildingScope = Boolean(selectedBuildingId) || loadedSingleFloor;
    if (hasBuildingScope) {
      const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
      return buildingLabel || '';
    }
    if (utilizationCampus) return activeUniversityName || 'Campus';
    return '';
  }, [
    activeBuildingName,
    selectedBuildingId,
    selectedBuilding,
    loadedSingleFloor,
    utilizationCampus,
    activeUniversityName
  ]);

  const dashboardRoomFeatures = useMemo(() => {
    return (dashboardScopeRooms || [])
      .map(roomRowToDashboardFeature)
      .filter(Boolean);
  }, [dashboardScopeRooms]);

  useEffect(() => {
    if (!airtableRooms.length) return;
    let cancelled = false;
    const needsManifest = airtableRooms.some(
      (room) => isLinkedRecordArray(room?.type) || isLinkedRecordArray(room?.department)
    );
    if (!needsManifest) {
      if (!cancelled) {
        setCampusRooms(airtableRooms);
        setCampusRoomsLoaded(true);
      }
      return;
    }

    (async () => {
      try {
        let manifest = dashboardManifestRef.current;
        if (!manifest) {
          manifest = await fetchJSON(FLOORPLAN_MANIFEST_URL);
          dashboardManifestRef.current = manifest;
        }
        const manifestRooms = await buildCampusRoomsFromManifest(manifest);
        if (cancelled) return;
        const merged = mergeAirtableRoomsWithManifest(airtableRooms, manifestRooms);
        setCampusRooms(merged);
        setCampusRoomsLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setCampusRooms(airtableRooms);
          setCampusRoomsLoaded(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [airtableRooms]);

  useEffect(() => {
    if (!campusRoomsLoaded) return;
    const hasBuildingScope = Boolean(selectedBuildingId) || loadedSingleFloor;
    const buildingLabel = (activeBuildingName || selectedBuildingId || selectedBuilding || '').trim();
    const floorLabel = (floorStats?.floorLabel || currentFloorContextRef.current?.floorLabel || selectedFloor || '').trim();
    const hasBuilding = Boolean(hasBuildingScope && buildingLabel);
    const hasFloor = Boolean(loadedSingleFloor && buildingLabel && floorLabel);
    const nextTitle = hasFloor
      ? `${buildingLabel} ${floorLabel} Summary`
      : (hasBuilding ? `${buildingLabel} Summary` : 'Campus Summary');
    setDashboardTitle(nextTitle);
    try {
      const metrics = computeSpaceDashboard(dashboardRoomFeatures);
      setDashboardMetrics(metrics);
    } catch (err) {
      setDashboardError(err);
    }
  }, [
    campusRoomsLoaded,
    dashboardRoomFeatures,
    activeBuildingName,
    selectedBuildingId,
    selectedBuilding,
    loadedSingleFloor,
    selectedFloor,
    floorStats
  ]);

  useEffect(() => {
    if (!campusRoomsLoaded || !Array.isArray(campusRooms) || !campusRooms.length) return;
    if (loadedSingleFloor) return;
    const buildingId = selectedBuildingId || selectedBuilding;
    if (!buildingId) return;
    const buildingKey = normalizeDashboardKey(buildingId);
    if (!buildingKey) return;
    const scoped = campusRooms.filter((room) => {
      const roomBuilding =
        room?.building ??
        room?.buildingName ??
        room?.buildingLabel ??
        '';
      return normalizeDashboardKey(roomBuilding) === buildingKey;
    });
    const summary = summarizeRoomRowsForPanels(scoped);
    if (!summary) return;
    setBuildingStats(summary);
    setPanelStats(formatSummaryForPanel(summary, 'building'));
  }, [
    campusRoomsLoaded,
    campusRooms,
    loadedSingleFloor,
    selectedBuildingId,
    selectedBuilding
  ]);

  useEffect(() => {
    if (!campusRoomsLoaded || !loadedSingleFloor) return;
    const scoped = Array.isArray(dashboardScopeRooms) ? dashboardScopeRooms : [];
    if (!scoped.length) return;
    const ctx = currentFloorContextRef.current || {};
    const url = ctx.url || currentFloorUrlRef.current;
    const floorLabel = ctx.floorLabel || selectedFloor || ctx.floor || '';
    if (!url) return;
    const summary = summarizeRoomRowsForPanels(scoped);
    if (!summary) return;
    const summaryWithLabel = { ...summary, floorLabel };
    floorStatsCache.current[url] = summary;
    floorSummaryCacheRef.current.set(url, summary);
    if (ctx.key) floorSummaryCacheRef.current.set(ctx.key, summary);
    setFloorStats(summaryWithLabel);
    setFloorLegendItems(toKeyDeptList(filterDeptTotals(summary.totalsByDept)));
    setPanelStats(formatSummaryForPanel(summary, 'floor'));
  }, [
    campusRoomsLoaded,
    loadedSingleFloor,
    dashboardScopeRooms,
    selectedFloor
  ]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !loadedSingleFloor) return;
    const hasAirtableLookup = Boolean(airtableRoomLookup?.byGuid?.size || airtableRoomLookup?.byComposite?.size);
    const hasRoomPatches = roomPatches instanceof Map && roomPatches.size > 0;
    if (!hasAirtableLookup && !hasRoomPatches) return;
    const map = mapRef.current;
    const src = getGeojsonSource(map, FLOOR_SOURCE);
    if (!src) return;
    const data = src._data || src.serialize?.()?.data || null;
    const fc = toFeatureCollection(data);
    if (!fc?.features?.length) return;

    const ctx = currentFloorContextRef.current || {};
    const buildingKey = ctx.buildingId || selectedBuildingId || selectedBuilding;
    const floorKey = ctx.floorLabel || ctx.floorId || ctx.floor || selectedFloor;
    let changed = false;
    const nextFeatures = fc.features.map((feature) => {
      if (!feature) return feature;
      const props = feature.properties || {};
      if (detectFeatureKind(props) !== 'room') return feature;
      let mergedProps = props;
      let didPatch = false;
      if (hasAirtableLookup) {
        const airtablePatch = getAirtableRoomPatch(props, airtableRoomLookup, buildingKey, floorKey);
        if (airtablePatch) {
          mergedProps = mergePatch(mergedProps, airtablePatch);
          didPatch = true;
        }
      }
      if (hasRoomPatches && buildingKey && floorKey) {
        const revitId = feature.id ?? props.RevitId ?? props.id;
        const rid = revitId != null ? rId(buildingKey, floorKey, revitId) : null;
        const patch = rid ? roomPatches.get(rid) || null : null;
        if (patch) {
          mergedProps = mergePatch(mergedProps, patch);
          didPatch = true;
        }
      }
      const typeLabel = getRoomTypeLabelFromProps(mergedProps);
      const nextRoomType = typeLabel ? String(typeLabel).trim() : (mergedProps.__roomType || '');
      if (!didPatch && nextRoomType === props.__roomType) return feature;
      changed = true;
      return {
        ...feature,
        properties: { ...mergedProps, __roomType: nextRoomType }
      };
    });

    if (!changed) return;
    const nextFC = { ...fc, features: nextFeatures };
    try {
      src.setData(nextFC);
    } catch {}
    if (currentFloorContextRef.current) {
      currentFloorContextRef.current = { ...currentFloorContextRef.current, fc: nextFC };
    }
    try {
      applyFloorColorMode(floorColorMode);
    } catch {}
  }, [
    airtableRoomLookup,
    roomPatches,
    floorColorMode,
    loadedSingleFloor,
    mapLoaded,
    selectedBuildingId,
    selectedBuilding,
    selectedFloor,
    applyFloorColorMode
  ]);

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
          await loadIcon(mapInstance, 'mf-door-swing', '/StakeholderMap/icons/door-swing.png');
        } catch (err) {
          console.warn('Door icon load failed:', err);
        }
        try {
          await loadIcon(mapInstance, 'mf-stairs-run', '/StakeholderMap/icons/stairs-run.png');
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
        'fill-extrusion-color': withNoFloorplanOverride(defaultBuildingColor),
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
        'fill-extrusion-color': withNoFloorplanOverride(defaultBuildingColor),
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
        const floorHits = map.queryRenderedFeatures(e.point, { layers: [FLOOR_FILL_ID] });
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
        applyExtrusion(withNoFloorplanOverride('#ffffff'), 1.0);
      } else {
        applyFill('buildings-layer', withNoFloorplanOverride('#ffffff'), 1.0);
      }
    }
    applyBuildingStyleForSpace(map);
  } else {
    if (buildingsLayer) {
      if (buildingsLayer.type === 'fill-extrusion') {
        applyExtrusion(withNoFloorplanOverride(defaultBuildingColor), 0.7);
      } else {
        applyFill('buildings-layer', withNoFloorplanOverride(defaultBuildingColor), 0.7);
      }
    }
    if (buildingsFill) {
      applyFill('buildings-fill', withNoFloorplanOverride(defaultBuildingColor), 0.2);
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

    if (previousSelectedBuildingId.current) {
      map.setFeatureState({ source: 'buildings', id: previousSelectedBuildingId.current }, { selected: false });
    }
    if (selectedBuildingId) {
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
  const map = mapRef.current;
  if (mapView === MAP_VIEWS.SPACE_DATA) {
    if (utilizationHeatmapOn && utilizationByBuildingId && Object.keys(utilizationByBuildingId).length > 0) {
      const matchExpr = ['match', ['get', 'id']];
      Object.entries(utilizationByBuildingId).forEach(([name, data]) => {
        const overall = Number.isFinite(data?.overallUtilization) ? data.overallUtilization : null;
        const color = utilizationColorForPercent(overall);
        matchExpr.push(name, color);
      });
      matchExpr.push('#e5e7eb');
      const finalExpr = withNoFloorplanOverride(matchExpr);
      try {
        map.setPaintProperty('buildings-layer', 'fill-extrusion-color', finalExpr);
        map.setPaintProperty('buildings-layer', 'fill-extrusion-opacity', 0.2);
        if (map.getLayer('buildings-fill')) {
          map.setPaintProperty('buildings-fill', 'fill-color', finalExpr);
          map.setPaintProperty('buildings-fill', 'fill-opacity', 0.55);
          map.setPaintProperty('buildings-fill', 'fill-outline-color', 'rgba(0,0,0,0)');
        }
      } catch {}
    } else {
      // in Space Data we keep buildings pure white; do not recolor
      try {
        map.setPaintProperty('buildings-layer', 'fill-extrusion-color', withNoFloorplanOverride('#ffffff'));
        map.setPaintProperty('buildings-layer', 'fill-extrusion-opacity', 0.7);
        if (map.getLayer('buildings-fill')) {
          map.setPaintProperty('buildings-fill', 'fill-color', withNoFloorplanOverride('#ffffff'));
          map.setPaintProperty('buildings-fill', 'fill-opacity', 0.0);
        }
      } catch {}
    }
    return;
  }

  if (map.getLayer('buildings-fill')) {
    try {
      map.setPaintProperty('buildings-fill', 'fill-opacity', 0.0);
    } catch {}
  }
  try {
    map.setPaintProperty('buildings-layer', 'fill-extrusion-opacity', 0.7);
  } catch {}

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
    const finalExpr = withNoFloorplanOverride(matchExpr);

    if (hasEntries) {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', finalExpr);
    } else {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', withNoFloorplanOverride(defaultBuildingColor));
    }
  }, [buildingConditions, buildingAssessments, mapLoaded, mode, mapView, utilizationHeatmapOn, utilizationByBuildingId]);

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

    const handleDrawingAlignClick = (e) => {
      const state = drawingAlignStateRef.current;
      if (!state) return;
      try {
        e.preventDefault?.();
        if (e.originalEvent) {
          e.originalEvent.preventDefault?.();
          e.originalEvent.stopPropagation?.();
          e.originalEvent.cancelBubble = true;
        }
      } catch {}

      const step = Number(state.step) || 0;
      const isRoomStep = step < 2;
      const targetLayer = isRoomStep ? FLOOR_FILL_ID : FLOOR_DRAWING_LAYER;
      const ctx = currentFloorContextRef.current;
      const fc = ctx?.fc || null;
      let snappedPoint = null;

      if (isRoomStep) {
        if (map.getLayer(targetLayer)) {
          const hits = map.queryRenderedFeatures(e.point, { layers: [targetLayer] }) || [];
          if (hits.length) {
            const rawPoint = [e.lngLat.lng, e.lngLat.lat];
            snappedPoint = snapToNearestVertex(hits[0], rawPoint);
          }
        }
        if (!snappedPoint && fc) {
          snappedPoint = findNearestVertexInFloor({
            map,
            fc,
            isDrawing: false,
            screenPoint: e.point,
            maxPixels: DRAWING_ALIGN_ROOM_RADIUS_PX,
            maxPoints: DRAWING_ALIGN_POINT_LIMIT
          });
        }
        if (!snappedPoint) {
          setDrawingAlignNotice('Click closer to a room polygon (or zoom in).');
          return;
        }
      } else {
        const hasDrawingCandidates = Boolean(
          fc?.features?.some((f) => {
            const gt = f?.geometry?.type || '';
            return isDrawingFeature(f?.properties || {}) || gt === 'LineString' || gt === 'MultiLineString';
          })
        );
        if (fc) {
          snappedPoint = findNearestVertexInFloor({
            map,
            fc,
            isDrawing: true,
            screenPoint: e.point,
            maxPixels: DRAWING_ALIGN_DRAWING_RADIUS_PX,
            maxPoints: DRAWING_ALIGN_POINT_LIMIT
          });
        }
        if (!snappedPoint && hasDrawingCandidates && fc) {
          snappedPoint = findNearestVertexInFloor({
            map,
            fc,
            isDrawing: true,
            screenPoint: e.point,
            maxPixels: null,
            maxPoints: DRAWING_ALIGN_POINT_LIMIT
          });
        }
        if (!snappedPoint) {
          setDrawingAlignNotice(
            hasDrawingCandidates
              ? 'No drawing vertex nearby. Zoom in and click closer to linework.'
              : 'No drawing linework found on this floor.'
          );
          return;
        }
      }
      const next = {
        ...state,
        roomPts: Array.isArray(state.roomPts) ? [...state.roomPts] : [],
        drawingPts: Array.isArray(state.drawingPts) ? [...state.drawingPts] : []
      };

      if (isRoomStep) next.roomPts.push(snappedPoint);
      else next.drawingPts.push(snappedPoint);
      next.step = step + 1;

      if (next.step >= DRAWING_ALIGN_STEPS.length) {
        const align = computeDrawingAlign(next.roomPts, next.drawingPts);
        if (!align) {
          setDrawingAlignNotice('Unable to compute alignment from those points.');
          return;
        }
        const ok = saveDrawingAlign(state.buildingLabel, state.floorId, align);
        if (!ok) {
          setDrawingAlignNotice('Failed to save alignment in local storage.');
          return;
        }
        setDrawingAlignState(null);
        setDrawingAlignNotice('');
        const url = buildFloorUrl(selectedBuilding, state.floorId);
        if (url) {
          floorCache.delete(url);
          floorTransformCache.delete(url);
        }
        handleLoadFloorplan(state.floorId);
        return;
      }

      setDrawingAlignNotice('');
      setDrawingAlignState(next);
    };

    map.on('click', handleDrawingAlignClick);
    return () => {
      try { map.off('click', handleDrawingAlignClick); } catch {}
    };
  }, [mapLoaded, selectedBuilding, buildFloorUrl, handleLoadFloorplan, computeDrawingAlign]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    const toMetersDelta = (startLngLat, nextLngLat) => {
      const eastDistKm = turf.distance(
        turf.point([startLngLat.lng, startLngLat.lat]),
        turf.point([nextLngLat.lng, startLngLat.lat]),
        { units: 'kilometers' }
      );
      const northDistKm = turf.distance(
        turf.point([startLngLat.lng, startLngLat.lat]),
        turf.point([startLngLat.lng, nextLngLat.lat]),
        { units: 'kilometers' }
      );
      const east = (nextLngLat.lng >= startLngLat.lng ? 1 : -1) * eastDistKm * 1000;
      const north = (nextLngLat.lat >= startLngLat.lat ? 1 : -1) * northDistKm * 1000;
      return [east, north];
    };

    const onMouseDown = (e) => {
      if (!floorAdjustActiveRef.current) return;
      try {
        e.preventDefault?.();
        if (e.originalEvent) {
          e.originalEvent.preventDefault?.();
          e.originalEvent.stopPropagation?.();
          e.originalEvent.cancelBubble = true;
        }
      } catch {}

      const mode = floorAdjustModeRef.current;
      if (!mode) return;
      const ctx = getFloorAdjustContext();
      const adjustUrl = ctx.url || buildFloorUrl(selectedBuilding, ctx.floorId);
      const adjustBasePath = ctx.basePath || currentFloorContextRef.current?.floorAdjustBasePath || null;
      const basePivot = currentFloorContextRef.current?.floorAdjustBasePivot || null;
      const adjustByBase = adjustBasePath ? loadFloorAdjustByBasePath(adjustBasePath, ctx.floorId) : null;
      const adjustBaseHasAdjust = hasFloorAdjust(adjustByBase);
      const adjustByUrl = adjustUrl ? loadFloorAdjustByUrl(adjustUrl) : null;
      const adjustUrlHasAdjust = hasFloorAdjust(adjustByUrl);
      const adjust = adjustBaseHasAdjust
        ? adjustByBase
        : (adjustUrlHasAdjust
            ? adjustByUrl
            : loadFloorAdjust(ctx.buildingLabel, ctx.floorId));
      const startTranslateLngLat = Array.isArray(adjust.translateLngLat) ? adjust.translateLngLat : [0, 0];
      const adjustLabel =
        currentFloorContextRef.current?.floorAdjustLabel ||
        (adjustUrl ? getBuildingFolderFromBasePath(adjustUrl) : null) ||
        ctx.buildingLabel;
      const src = getGeojsonSource(map, FLOOR_SOURCE);
      const baseData = src?._data || currentFloorContextRef.current?.fc || null;
      if (!baseData) {
        setFloorAdjustNotice('No floor data to adjust.');
        return;
      }
      let pivot = null;
      try {
        pivot = turf.centroid(baseData)?.geometry?.coordinates || null;
      } catch {
        pivot = null;
      }
      if (!pivot) {
        setFloorAdjustNotice('Unable to find a transform pivot.');
        return;
      }
      const pivotScreen = map.project({ lng: pivot[0], lat: pivot[1] });
      const startAngle = Math.atan2(e.point.y - pivotScreen.y, e.point.x - pivotScreen.x);
      floorAdjustDragRef.current = {
        mode,
        baseData: JSON.parse(JSON.stringify(baseData)),
        pivot,
        pivotScreen,
        startAngle,
        startRotation: adjust.rotationDeg || 0,
        startScale: adjust.scale || 1,
        startTranslate: adjust.translateMeters || [0, 0],
        startTranslateLngLat,
        startLngLat: e.lngLat,
        buildingLabel: ctx.buildingLabel,
        floorId: ctx.floorId,
        adjustUrl,
        adjustLabel,
        adjustBasePath,
        basePivot
      };
      try { map.dragPan.disable(); } catch {}
      try { map.getCanvas().style.cursor = mode === 'move' ? 'grabbing' : 'grabbing'; } catch {}
    };

    const onMouseMove = (e) => {
      const drag = floorAdjustDragRef.current;
      if (!drag) return;
      const src = getGeojsonSource(map, FLOOR_SOURCE);
      if (!src) return;
      if (drag.mode === 'rotate') {
        const angle = Math.atan2(e.point.y - drag.pivotScreen.y, e.point.x - drag.pivotScreen.x);
        const deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
        const rotated = turf.transformRotate(drag.baseData, deltaDeg, { pivot: drag.pivot });
        src.setData(rotated);
        return;
      }
      if (drag.mode === 'move') {
        const [east, north] = toMetersDelta(drag.startLngLat, e.lngLat);
        const deltaLng = e.lngLat.lng - drag.startLngLat.lng;
        const deltaLat = e.lngLat.lat - drag.startLngLat.lat;
        const moved = applyNudgeLngLat(drag.baseData, [deltaLng, deltaLat]);
        src.setData(moved);
      }
    };

    const onMouseUp = (e) => {
      const drag = floorAdjustDragRef.current;
      if (!drag) return;
      let nextAdjust = loadFloorAdjust(drag.buildingLabel, drag.floorId);
      if (drag.mode === 'rotate') {
        const angle = Math.atan2(e.point.y - drag.pivotScreen.y, e.point.x - drag.pivotScreen.x);
        const deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
        const savePivot =
          Array.isArray(drag.basePivot) ? drag.basePivot :
          (Array.isArray(drag.pivot) ? drag.pivot : nextAdjust.pivot);
        nextAdjust = {
          ...nextAdjust,
          rotationDeg: (drag.startRotation || 0) + deltaDeg,
          pivot: savePivot
        };
      } else if (drag.mode === 'move') {
        const [east, north] = toMetersDelta(drag.startLngLat, e.lngLat);
        const deltaLng = e.lngLat.lng - drag.startLngLat.lng;
        const deltaLat = e.lngLat.lat - drag.startLngLat.lat;
        const savePivot =
          Array.isArray(drag.basePivot) ? drag.basePivot :
          (Array.isArray(drag.pivot) ? drag.pivot : nextAdjust.pivot);
        nextAdjust = {
          ...nextAdjust,
          translateMeters: [
            (drag.startTranslate?.[0] || 0) + east,
            (drag.startTranslate?.[1] || 0) + north
          ],
          translateLngLat: [
            (drag.startTranslateLngLat?.[0] || 0) + deltaLng,
            (drag.startTranslateLngLat?.[1] || 0) + deltaLat
          ],
          pivot: savePivot
        };
      }
      const src = getGeojsonSource(map, FLOOR_SOURCE);
      const currentData = src?._data || currentFloorContextRef.current?.fc || null;
      const anchorLngLat = getFloorAdjustAnchorLngLat(currentData);
      if (anchorLngLat) {
        nextAdjust = { ...nextAdjust, anchorLngLat };
      }
      const saveLabel = drag.adjustLabel || drag.buildingLabel;
      saveFloorAdjust(saveLabel, drag.floorId, nextAdjust);
      if (drag.adjustUrl) saveFloorAdjustByUrl(drag.adjustUrl, nextAdjust);
      if (drag.adjustBasePath) saveFloorAdjustByBasePath(drag.adjustBasePath, drag.floorId, nextAdjust);
      try { saveFloorAdjustToDb(saveLabel, drag.floorId, nextAdjust); } catch {}
      const sig = getFloorAdjustSignature(nextAdjust);
      if (sig && currentData) {
        const cached = { ...currentData, __mfUserAdjustSignature: sig };
        if (drag.adjustUrl) {
          floorCache.set(drag.adjustUrl, cached);
        }
        currentFloorContextRef.current = {
          ...(currentFloorContextRef.current || {}),
          fc: cached
        };
      }
      floorAdjustDragRef.current = null;
      setFloorAdjustMode(null);
      setFloorAdjustNotice('');
      const url = drag.adjustUrl || buildFloorUrl(selectedBuilding, drag.floorId);
      if (url && !drag.adjustUrl) {
        floorCache.delete(url);
        floorTransformCache.delete(url);
      }
      try { map.dragPan.enable(); } catch {}
      try { map.getCanvas().style.cursor = drag.mode === 'move' ? 'move' : 'grab'; } catch {}
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    return () => {
      try { map.off('mousedown', onMouseDown); } catch {}
      try { map.off('mousemove', onMouseMove); } catch {}
      try { map.off('mouseup', onMouseUp); } catch {}
    };
  }, [mapLoaded, selectedBuilding, buildFloorUrl, getFloorAdjustContext, saveFloorAdjustToDb]);

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

      if (drawingAlignActiveRef.current || floorAdjustActiveRef.current) return;
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

          const roomTypeLabel = (getRoomTypeLabelFromProps(rawProps) || rawProps.__roomType || '').trim();

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
      const buildingName =
        activeBuildingName ||
        rawProps.BuildingName ||
        rawProps.Building ||
        selectedBuilding ||
        selectedBuildingId ||
        buildingId ||
        '';
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
      const initialRoomType = (getRoomTypeLabelFromProps(pp) || pp.__roomType || '').trim();
      const initialDept = (pp.__dept || getDeptFromProps(pp) || '').trim();
      const initialOccupant = pp.occupant ?? pp.Occupant ?? '';
        const initialComments = pp.comments ?? pp.Comments ?? '';
        const initialOccupancyStatus = resolveOccupancyStatusValue(pp);
      const resolvedArea = resolvePatchedArea(pp);
      let displayRoomType = initialRoomType;
      let displayDept = initialDept;
      let displayAreaValue = Number.isFinite(resolvedArea) ? resolvedArea : null;
      let displayOccupant = initialOccupant;
      const categoryCode = getRoomCategoryCode(pp);
      const seatCount = getSeatCount(pp);
      const typeFlags = detectRoomTypeFlags(pp);
    const isOffice = isOfficeCategory(categoryCode) || typeFlags.isOfficeText;
    const isTeaching = isScheduledTeachingTypeLabel(initialRoomType) || isTeachingCategory(categoryCode) || typeFlags.isTeachingText;
      const canonicalRoomId = (buildingId && derivedFloorDefault && revitId != null)
        ? rId(buildingId, derivedFloorDefault, revitId)
        : null;
      const movingOccupant = (displayOccupant ?? '').toString().trim();
      const roomLabel = roomNum2 || '-';
      const roomGuidValue = String(
        pp.Revit_UniqueId ??
        pp.RevitUniqueId ??
        rawProps.Revit_UniqueId ??
        rawProps.RevitUniqueId ??
        rawProps['Room GUID'] ??
        ''
      ).trim();
      const buildingKey = normalizeDashboardKey(buildingId);
      const floorTokens = normalizeFloorTokens(derivedFloorDefault);
      const roomNumberKey = String(roomNum2 ?? '').trim();
      const roomsForAirtableMatch = airtableRooms?.length ? airtableRooms : campusRooms;
      const matchingAirtableRoom = Array.isArray(roomsForAirtableMatch)
        ? roomsForAirtableMatch.find((room) => {
            if (!room) return false;
            const roomIdValue = String(room?.roomId ?? room?.roomNumber ?? room?.roomLabel ?? '').trim();
            const roomGuidFromRow = String(room?.roomGuid ?? room?.revitUniqueId ?? '').trim();
            if (
              roomGuidValue &&
              (roomGuidFromRow === roomGuidValue || roomIdValue === roomGuidValue)
            ) {
              return true;
            }
            const roomBuildingKey = normalizeDashboardKey(
              room?.building ?? room?.buildingName ?? room?.buildingLabel ?? ''
            );
            if (buildingKey && roomBuildingKey !== buildingKey) return false;
            if (floorTokens.length &&
              !floorMatchesTokens(room?.floor ?? room?.floorName ?? room?.floorId ?? '', floorTokens)
            ) {
              return false;
            }
            return roomNumberKey && roomIdValue === roomNumberKey;
          })
        : null;
      const airtableIdFromMatch =
        matchingAirtableRoom?.airtableId ||
        matchingAirtableRoom?.AirtableId ||
        matchingAirtableRoom?.['Airtable ID'] ||
        null;

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
            buildingName,
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
            buildingName,
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
            roomGuid: roomGuidValue || null,
            roomLabel,
            roomNumber: roomNum2 || '',
            feature: f,
            flags: { isOffice, isTeaching },
            highlightId: selId,
            properties: {
              type: displayRoomType || '',
              department: displayDept || '',
              area: Number.isFinite(displayAreaValue) ? displayAreaValue : '',
              occupant: displayOccupant || '',
              occupancyStatus: initialOccupancyStatus || '',
              comments: initialComments || '',
              roomGuid: roomGuidValue || '',
              Revit_UniqueId: roomGuidValue || '',
              airtableId: airtableIdFromMatch
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
          ? `<div class="mf-popup-actions" style="margin-top:6px;padding-top:6px;gap:6px;flex-wrap:wrap;width:100%;">
               <button id="mf-room-edit-btn" class="mf-btn tiny">${editLabel}</button>
               ${showClearSelection ? `<button id="mf-clear-edit-selection" class="mf-btn tiny" style="background:#f4f4f4;color:#333;">Clear Selection</button>` : ''}
             </div>`
          : '';

        // Decide what to show in the "occupancy" row
        const hasSeatCount = Number.isFinite(seatCount) && seatCount > 0;
        const occupantTrimmed = (displayOccupant ?? '').toString().trim();
        const isClassroomType = isScheduledTeachingTypeLabel(displayRoomType || '');

        const seatCountValue = hasSeatCount ? seatCount.toLocaleString() : '-';
        const seatCountRowHtml = isClassroomType
          ? `<div><b>Seat Count:</b> ${seatCountValue}</div>`
          : '';

        const occupancyValue = occupantTrimmed.length ? occupantTrimmed : '-';
        const occupancyRowHtml = isClassroomType
          ? ''
          : `<div><b>Occupant:</b> ${occupancyValue}</div>`;

        const utilization = isClassroomType
          ? getUtilizationForRoom(buildingName, roomNum2 || roomLabel || '')
          : null;
        const hasUtilization = utilization && (
          Number.isFinite(utilization.timeUtilization) ||
          Number.isFinite(utilization.seatUtilization)
        );
        const renderUtilizationBarHtml = (label, value, color) => {
          if (!Number.isFinite(value)) return '';
          const width = Math.max(0, Math.min(value, 100));
          return `
            <div style="margin-top:3px;">
              <div style="font-size:10px;color:#444;">${label}: ${Math.round(value)}%</div>
              <div style="height:4px;background:#e4e7ec;border-radius:999px;overflow:hidden;">
                <div style="width:${width}%;height:100%;background:${color};"></div>
              </div>
            </div>
          `;
        };
        const utilizationHtml = hasUtilization
          ? `
            <div style="margin-top:6px; width:100%; max-width:220px;">
              ${renderUtilizationBarHtml('Time Util', utilization.timeUtilization, '#3b82f6')}
              ${renderUtilizationBarHtml('Seat Util', utilization.seatUtilization, '#f59e0b')}
            </div>
          `
          : '';

        const selectionCountHtml = canEditRoom && selectionCount
          ? `<div style="font-size:11px;color:#555;margin-top:6px;">Rooms selected: ${selectionCount}</div>`
          : '';

        return `
          <div class="mf-popup" style="min-width:340px;max-width:460px;background:#fff;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.15);padding:2px;">
            <div class="mf-popup-body" style="padding:8px 12px 16px 12px;">
              <div class="mf-title">Room ${roomNum2 || '-'}</div>
              <div><b>Room Type:</b></div>
              <div style="white-space:normal;word-break:break-word;margin-bottom:2px;">${displayRoomType || '-'}</div>
              <div><b>Department:</b> ${displayDept || '-'}</div>
              <div><b>Area (SF):</b> ${areaText || '-'}</div>
              <div><b>Floor:</b> ${floorName}</div>
              ${seatCountRowHtml}
              ${occupancyRowHtml}
              ${utilizationHtml}
              ${selectionCountHtml}
              ${editButtonHtml}
            </div>
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
        maxWidth: '520px'
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
          occupancyStatus: deriveSharedValue('occupancyStatus'),
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

    const onEnter = () => {
      if (drawingAlignActiveRef.current || floorAdjustActiveRef.current) return;
      try { map.getCanvas().style.cursor = 'pointer'; } catch {}
    };
    const onLeave = () => {
      if (drawingAlignActiveRef.current || floorAdjustActiveRef.current) return;
      try { map.getCanvas().style.cursor = ''; } catch {}
    };

    map.on('click', FLOOR_FILL_ID, onFloorClick);
    map.on('mouseenter', FLOOR_FILL_ID, onEnter);
    map.on('mouseleave', FLOOR_FILL_ID, onLeave);
    // Doors/stairs are visual only; keep them non-interactive.

    return () => {
      try {
        map.off('click', FLOOR_FILL_ID, onFloorClick);
        map.off('mouseenter', FLOOR_FILL_ID, onEnter);
        map.off('mouseleave', FLOOR_FILL_ID, onLeave);
        // No door/stair handlers to detach.
      } catch {}
      currentRoomFeatureRef.current = null;
    };
  }, [mapLoaded, floorUrl, selectedBuilding, selectedBuildingId, selectedFloor, showFloorStats, setMapView, setIsTechnicalPanelOpen, setIsBuildingPanelCollapsed, setPanelAnchor, panelStats, roomPatches, campusRooms, airtableRooms, isAdminUser, authUser, universityId, resolveBuildingPlanKey, fetchBuildingSummary, fetchFloorSummaryByUrl, mapView, floorStatsByBuilding, moveScenarioMode, moveMode, pendingMove, setFloorHighlight, roomEditSelection, clearRoomEditSelection, applySelectionHighlight, getHighlightIdsForSelection]);

useEffect(() => {
  if (!mapLoaded || !mapRef.current) return;
  const map = mapRef.current;

  const onBackgroundClick = (e) => {
    const mapInstance = mapRef.current;
    if (!mapInstance) return;
    if (drawingAlignActiveRef.current || floorAdjustActiveRef.current) return;

    const selectedId = selectedBuildingIdRef.current;
    if (!selectedId) return;

    const hasFloorLayer = !!mapInstance.getLayer(FLOOR_FILL_ID);

    if (!hasFloorLayer) {
      showBuildingStats(selectedId);
      return;
    }

    const pt = e.point;
    const floorHits = mapInstance.queryRenderedFeatures(pt, { layers: [FLOOR_FILL_ID] });
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
      const img = generateFloorplanImageData({ fc, colorMode: floorColorMode, solidFill: true, labelOptions: { hideDrawing: true } });
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
  <div ref={mapPageRef} className="map-page-container">
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>Ask Mapfluence</div>
                  <span
                    title="AI-generated response based on currently loaded space data."
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(0,0,0,0.15)',
                      background: '#f7f7ff'
                    }}
                  >
                    {"\u2728 AI"}
                  </span>
                </div>
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
          zIndex: 10004,
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Ask Mapfluence</div>
                <span
                  title="AI-generated response based on currently loaded space data."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid rgba(0,0,0,0.15)',
                    background: '#f7f7ff'
                  }}
                >
                  {"\u2728 AI"}
                </span>
              </div>
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

      <div className="mf-right-rail">
        <div className="mf-right-logos">
          <div className="logo-box">
            <div className="mapfluence-title">MAPFLUENCE</div>
            <img
              className="mf-logo mf-logo--mapfluence"
              src={assetUrl('Clark_Enersen_Logo.png')}
              alt="Clark & Enersen Logo"
            />
          </div>
          <div className="logo-box">
            <img
              className="mf-logo mf-logo--hc"
              src={assetUrl('HC_image.png')}
              alt="Hastings College"
            />
          </div>
        </div>
        <div className="dashboard-box">
          <SpaceDashboardPanel
            title={dashboardTitle}
            scopeLabel={dashboardScopeLabel}
            metrics={dashboardMetrics}
            loading={dashboardLoading}
            error={dashboardError}
            utilization={dashboardUtilization}
            utilizationScopeLabel={dashboardUtilizationLabel}
            heatmapOn={utilizationHeatmapOn}
            onToggleHeatmap={setUtilizationHeatmapOn}
          />
        </div>
      </div>

    {mode === 'admin' && (
      <>
        {mapView === MAP_VIEWS.ASSESSMENT && selectedBuildingId && !isTechnicalPanelOpen && panelAnchor && (
          <div
            className="floating-panel"
            style={{
              position: 'absolute', zIndex: 40,
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

    {mapView === MAP_VIEWS.SPACE_DATA && (selectedBuildingId || selectedBuilding) && !isBuildingPanelCollapsed && (() => {
      const containerWidth = mapContainerRef.current?.clientWidth || 1000;
      const containerHeight = mapContainerRef.current?.clientHeight || 800;
      const PANEL_WIDTH = 360;
      const PANEL_HEIGHT = 420;
      const margin = 16;
      const rightRailWidth = 260;
      const rightRailGap = 24;
      const rightRailOffset = 140;
      const clamp = (val, min, max) => Math.max(min, Math.min(val, max));
      const panelWidth = Math.max(300, Math.min(PANEL_WIDTH, containerWidth - margin * 2));
      const sideMargin = margin + 40;
      const rightAligned = clamp(containerWidth - panelWidth - sideMargin, 12, containerWidth - panelWidth - 12);
      const leftAligned = clamp(
        containerWidth - panelWidth - rightRailWidth - rightRailGap - rightRailOffset,
        320,
        containerWidth - panelWidth - 12
      );
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
              const left = rightAligned;
              const top = clamp(screenPoint.y - PANEL_HEIGHT * 0.35, 8, containerHeight - PANEL_HEIGHT - 8);
              floorAnchor = { left, top };
            }
          }
        } catch {}
      }
      const buildingPanelStyle = {
        position: 'absolute',
        zIndex: 40,
        left: safeLeft,
        top: safeTop,
        width: panelWidth,
        maxHeight: '75vh',
        overflow: 'auto'
      };
      const floorPanelStyle = floorAnchor
        ? {
          position: 'absolute',
          zIndex: 40,
          left: Math.max(12, Math.min(floorAnchor.left, containerWidth - panelWidth - margin)),
          top: anchoredTop,
          width: panelWidth,
          maxHeight: '80vh',
          overflow: 'auto'
        }
        : buildingPanelStyle;
      const panelStyle = popupMode === 'floor' ? floorPanelStyle : buildingPanelStyle;
      const resolvedPanelStyle = spacePanelPos
        ? { ...panelStyle, left: spacePanelPos.x, top: spacePanelPos.y }
        : panelStyle;
      return (
        <div ref={spacePanelRef} className="floating-panel" style={resolvedPanelStyle}>
          {popupMode === 'building' && (
            <BuildingPanel
              buildingName={activeBuildingName}
              stats={buildingStats}
              keyDepts={toKeyDeptList(buildingStats?.totalsByDept)}
              utilization={getUtilizationForBuilding(activeBuildingName)}
              floors={availableFloors}
              selectedFloor={panelSelectedFloor}
              onChangeFloor={(fl) => setSelectedFloor(fl)}
              onLoadFloorplan={loadSelectedFloor}
              onExportCSV={() => exportSpaceCsv(activeBuildingName || selectedBuildingId || selectedBuilding)}
              onClose={() => {
                setIsBuildingPanelCollapsed(true);
                setSelectedBuildingId(null);
                setPanelAnchor(null);
                setSpacePanelPos(null);
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
              dragHandleProps={spacePanelDragHandleProps}
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
                setSpacePanelPos(null);
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
              rotateActive={floorAdjustMode === 'rotate'}
              moveActive={floorAdjustMode === 'move'}
              rotateValue={floorRotateValue}
              scaleValue={floorScaleValue}
              rotateNotice={floorAdjustNotice}
              rotateStored={floorAdjustStored}
              adjustDebugInfo={floorAdjustDebugInfo}
              onStartRotate={startFloorRotate}
              onStartMove={startFloorMove}
              onCancelRotate={cancelFloorAdjust}
              onClearRotate={clearFloorAdjustForFloor}
              onSaveAdjust={async () => {
                const ctx = getFloorAdjustContext();
                if (!ctx?.buildingLabel || !ctx?.floorId) return;
                const adjustLabel =
                  currentFloorContextRef.current?.floorAdjustLabel ||
                  ctx.buildingLabel;
                const adjustUrl = ctx.url || currentFloorContextRef.current?.url || buildFloorUrl(selectedBuilding, ctx.floorId);
                const adjustBasePath = ctx.basePath || currentFloorContextRef.current?.floorAdjustBasePath || null;
                const adjust = floorAdjustValue || loadFloorAdjust(adjustLabel, ctx.floorId);
                const pivot =
                  currentFloorContextRef.current?.floorAdjustBasePivot ||
                  (currentFloorContextRef.current?.fc
                    ? (turf.centroid(currentFloorContextRef.current.fc)?.geometry?.coordinates || null)
                    : null);
                const src = getGeojsonSource(mapRef.current, FLOOR_SOURCE);
                const currentData = src?._data || currentFloorContextRef.current?.fc || null;
                const anchorLngLat = getFloorAdjustAnchorLngLat(currentData);
                const adjustWithPivot = {
                  ...adjust,
                  pivot: Array.isArray(adjust.pivot) ? adjust.pivot : (Array.isArray(pivot) ? pivot : null),
                  anchorLngLat: anchorLngLat || adjust.anchorLngLat || null
                };
                saveFloorAdjust(adjustLabel, ctx.floorId, adjustWithPivot);
                if (adjustUrl) saveFloorAdjustByUrl(adjustUrl, adjustWithPivot);
                if (adjustBasePath) saveFloorAdjustByBasePath(adjustBasePath, ctx.floorId, adjustWithPivot);
                try { await saveFloorAdjustToDb(adjustLabel, ctx.floorId, adjustWithPivot); } catch {}
                if (adjustUrl) {
                  floorCache.delete(adjustUrl);
                  floorTransformCache.delete(adjustUrl);
                }
              }}
              saveAdjustDisabled={!floorAdjustStored}
              onScaleChange={(delta) => {
                const ctx = getFloorAdjustContext();
                if (!ctx?.buildingLabel || !ctx?.floorId) return;
                const adjustUrl = ctx.url || currentFloorContextRef.current?.url || buildFloorUrl(selectedBuilding, ctx.floorId);
                const adjustBasePath = ctx.basePath || currentFloorContextRef.current?.floorAdjustBasePath || null;
                const adjustByBase = adjustBasePath ? loadFloorAdjustByBasePath(adjustBasePath, ctx.floorId) : null;
                const adjustBaseHasAdjust = hasFloorAdjust(adjustByBase);
                const adjustByUrl = adjustUrl ? loadFloorAdjustByUrl(adjustUrl) : null;
                const adjustUrlHasAdjust = hasFloorAdjust(adjustByUrl);
                const adjust = adjustBaseHasAdjust
                  ? adjustByBase
                  : (adjustUrlHasAdjust
                      ? adjustByUrl
                      : loadFloorAdjust(ctx.buildingLabel, ctx.floorId));
                const nextScale = Math.max(0.5, Math.min(2.5, (adjust.scale || 1) + delta));
                const factor = nextScale / (adjust.scale || 1);
                const src = getGeojsonSource(mapRef.current, FLOOR_SOURCE);
                const baseData = src?._data || currentFloorContextRef.current?.fc || null;
                const scalePivot = baseData ? (turf.centroid(baseData)?.geometry?.coordinates || null) : null;
                let scaled = null;
                if (baseData && scalePivot && Number.isFinite(factor) && Math.abs(factor - 1) > 1e-6) {
                  scaled = turf.transformScale(baseData, factor, { origin: scalePivot });
                  if (src) src.setData(scaled);
                }
                const nextAdjust = { ...adjust, scale: nextScale };
                const adjustLabel =
                  currentFloorContextRef.current?.floorAdjustLabel ||
                  ctx.buildingLabel;
                const adjustPivot =
                  currentFloorContextRef.current?.floorAdjustBasePivot ||
                  (baseData ? (turf.centroid(baseData)?.geometry?.coordinates || null) : null);
                const nextAdjustWithPivot = {
                  ...nextAdjust,
                  pivot: Array.isArray(adjustPivot) ? adjustPivot : nextAdjust.pivot,
                  anchorLngLat: getFloorAdjustAnchorLngLat(scaled || src?._data || baseData) || nextAdjust.anchorLngLat || null
                };
                saveFloorAdjust(adjustLabel, ctx.floorId, nextAdjustWithPivot);
                if (adjustUrl) saveFloorAdjustByUrl(adjustUrl, nextAdjustWithPivot);
                if (adjustBasePath) saveFloorAdjustByBasePath(adjustBasePath, ctx.floorId, nextAdjustWithPivot);
                try { saveFloorAdjustToDb(adjustLabel, ctx.floorId, nextAdjustWithPivot); } catch {}
                const sig = getFloorAdjustSignature(nextAdjustWithPivot);
                const currentData = baseData || currentFloorContextRef.current?.fc || null;
                if (sig && currentData) {
                  const cached = { ...currentData, __mfUserAdjustSignature: sig };
                  if (adjustUrl) {
                    floorCache.set(adjustUrl, cached);
                  }
                  currentFloorContextRef.current = {
                    ...(currentFloorContextRef.current || {}),
                    fc: cached
                  };
                }
                const url = adjustUrl || buildFloorUrl(selectedBuilding, ctx.floorId);
                if (url && !adjustUrl) {
                  floorCache.delete(url);
                  floorTransformCache.delete(url);
                }
              }}
              dragHandleProps={spacePanelDragHandleProps}
            />
          )}
        </div>
      );
    })()}

    {/* Move Scenario Summary Panel */}
    {moveScenarioMode && scenarioPanelVisible && (
      <div
        ref={scenarioPanelRef}
        className="floating-panel"
        style={{
          position: 'absolute',
          zIndex: 60,
          right: scenarioPanelPos ? 'auto' : 16,
          left: scenarioPanelPos ? scenarioPanelPos.x : 'auto',
          top: scenarioPanelPos ? scenarioPanelPos.y : scenarioPanelTop,
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
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}
          {...scenarioPanelDragHandleProps}
        >
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
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Rooms by Room Type Description</div>
          {combinedScenarioRoomStats.length === 0 ? (
            <div style={{ fontSize: 12, fontStyle: 'italic', color: '#666' }}>No rooms selected.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Room Type Description</th>
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
              const imgData = generateFloorplanImageData({
                ...currentFloorContextRef.current,
                labelOptions: { hideDrawing: true }
              });
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
              const deptLines = doc.splitTextToSize(deptText, Math.max(50, textWidth - badgeSize - 6));
              deptLines.forEach((line, idx) => {
                doc.text(line, textX + badgeSize + 6, y + badgeSize - 4 + idx * lineHeight);
              });
              doc.setFont(undefined, 'normal');
              y += Math.max(badgeSize, deptLines.length * lineHeight) + lineHeight / 2;
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
          <div className="control-section theme-selector" style={{ marginTop: 6 }}>
            <label htmlFor="theme-select" style={{ marginRight: 8 }}>Map View:</label>
            <select
              id="theme-select"
              value={mapView}
              onChange={(e) => setMapView(e.target.value)}
              disabled={visibleMapViewOptions.length <= 1}
            >
              {visibleMapViewOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

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
                <h4 style={{ margin: '2px 0 4px 0', fontSize: 12.5 }}>Space Data Export</h4>
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
                  {mode === 'admin' && (
                    <button
                      className="btn"
                      style={{ width: '100%' }}
                      onClick={handleRefreshAirtable}
                      disabled={airtableRefreshPending}
                    >
                      {airtableRefreshPending ? 'Refreshing Airtable...' : 'Refresh Airtable Data'}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#555', marginTop: 2, minHeight: 0 }}>
                  {exportSpaceMessage || (exportSpaceMode === 'summary'
                    ? 'Summary export adds a campus total (when exporting all buildings) plus one row per building.'
                    : '')}
                </div>
                {mode === 'admin' && airtableRefreshMessage && (
                  <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                    {airtableRefreshMessage}
                  </div>
                )}
                {mode === 'admin' && (
                  <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                    Last synced: {airtableLastSyncedAt
                      ? airtableLastSyncedAt.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
                      : 'Not yet'}
                  </div>
                )}
              </div>

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

            {mode === 'admin' && (
              <div style={{ marginTop: 6 }}>
                <button
                  disabled={aiStatus !== 'ok'}
                  onClick={() => setAiCreateScenarioOpen(true)}
                  style={{ width: '100%', padding: '5px 7px', fontSize: 11 }}
                >
                  {"\u2728 Create move scenario"}
                </button>
              </div>
            )}

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
          background: 'rgba(0,0,0,0.35)'
        }}
      >
        <div
          ref={roomEditPanelRef}
          className="mf-room-edit-panel"
          style={{
            position: 'absolute',
            left: roomEditPanelPos ? roomEditPanelPos.x : '50%',
            top: roomEditPanelPos ? roomEditPanelPos.y : '50%',
            transform: roomEditPanelPos ? 'none' : 'translate(-50%, -50%)',
            width: 520,
            maxWidth: '90vw',
            background: '#fff',
            borderRadius: 14,
            padding: 16,
            boxShadow: '0 18px 36px rgba(0,0,0,0.2)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }} {...roomEditDragHandleProps}>
            <h4 style={{ margin: 0 }}>
              {roomEditTargets.length > 1
                ? `Edit ${roomEditTargets.length} Rooms`
                : `Edit Room ${roomEditData.feature?.properties?.name || roomEditData.roomLabel || ''}`}
            </h4>
          </div>

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
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Room Type Description</th>
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
            label="Room Type"
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

          {editHasOfficeType && (
            <div className="mf-form-row">
              <label>Occupant</label>
              <input
                className="mf-input"
                type="text"
                value={roomEditData.properties?.occupant ?? ''}
                onChange={(e) =>
                  setRoomEditData((prev) => (prev ? ({ ...prev, properties: { ...prev.properties, occupant: e.target.value } }) : prev))
                }
                placeholder="(optional)"
              />
            </div>
          )}

          <div className="mf-form-row">
            <label>Area (SF)</label>
            <input
              className="mf-input"
              value={roomEditData.properties?.area ?? ''}
              disabled
              readOnly
            />
          </div>

          {editHasSeatCountType && (
            <div className="mf-form-row">
              <label>Seat Count</label>
              <input
                className="mf-input"
                type="number"
                min="0"
                value={seatCountSelectionValue === '__MIXED__' ? '' : seatCountSelectionValue}
                placeholder={isMultiEdit && seatCountSelectionValue === '__MIXED__' ? 'varies' : ''}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setRoomEditData((prev) => (
                    prev
                      ? ({
                          ...prev,
                          properties: {
                            ...prev.properties,
                            seatCount: nextValue
                          }
                        })
                      : prev
                  ));
                }}
              />
            </div>
          )}

          {editHasOfficeType && (
            <div className="mf-form-row">
              <label>Occupancy Status</label>
              <select
                className="mf-input"
                value={occupancySelectionValue === '__MIXED__' ? '' : occupancySelectionValue}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setRoomEditData((prev) => (
                    prev
                      ? ({
                          ...prev,
                          properties: {
                            ...prev.properties,
                            occupancyStatus: nextValue || (isMultiEdit ? null : '')
                          }
                        })
                      : prev
                  ));
                }}
              >
                {isMultiEdit && occupancySelectionValue === '__MIXED__'
                  ? <option value="">-- Mixed --</option>
                  : <option value="">--</option>}
                {OCCUPANCY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
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
                const multiEdit = targets.length > 1;
                const sharedProps = roomEditData.properties || {};
                const mapRefCurrent = mapRef.current;
                const src = getGeojsonSource(mapRefCurrent, FLOOR_SOURCE);
                const sourceData = src ? (src._data || src.serialize?.().data || null) : null;
                const patchedFeatures = sourceData ? (toFeatureCollection(sourceData)?.features || []) : [];
                for (const tgt of targets) {
                  const fallbackProps = {
                    type: tgt.properties?.type ?? tgt.feature?.properties?.type ?? '',
                    department: tgt.properties?.department ?? tgt.feature?.properties?.department ?? '',
                    occupant: tgt.properties?.occupant ?? tgt.feature?.properties?.occupant ?? '',
                    occupancyStatus:
                      tgt.properties?.occupancyStatus ??
                      tgt.feature?.properties?.occupancyStatus ??
                      tgt.properties?.['Occupancy Status'] ??
                      tgt.feature?.properties?.['Occupancy Status'] ??
                      tgt.properties?.OccupancyStatus ??
                      tgt.feature?.properties?.OccupancyStatus ??
                      '',
                    comments: tgt.properties?.comments ?? tgt.feature?.properties?.comments ?? '',
                    seatCount: getSeatCount({ ...(tgt.feature?.properties || {}), ...(tgt.properties || {}) })
                  };
                  const hasOccupancyOverride =
                    sharedProps.occupancyStatus != null &&
                    String(sharedProps.occupancyStatus).trim() !== '';
                  const occupancyStatusValue = hasOccupancyOverride
                    ? sharedProps.occupancyStatus
                    : fallbackProps.occupancyStatus;
                  const occupantValue = editHasOfficeType
                    ? (multiEdit
                        ? (sharedProps.occupant != null && String(sharedProps.occupant).trim() !== ''
                            ? sharedProps.occupant
                            : fallbackProps.occupant)
                        : (sharedProps.occupant ?? fallbackProps.occupant))
                    : undefined;
                  const seatCountValue = editHasSeatCountType
                    ? (sharedProps.seatCount != null
                        ? sharedProps.seatCount
                        : fallbackProps.seatCount)
                    : undefined;
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
                        : fallbackProps.department,
                    ...(editHasOfficeType ? { occupancyStatus: occupancyStatusValue, occupant: occupantValue } : {}),
                    ...(editHasSeatCountType ? { seatCount: seatCountValue } : {})
                  };
                  if (editHasOfficeType) {
                    propsForTarget.OccupancyStatus = occupancyStatusValue;
                    propsForTarget['Occupancy Status'] = occupancyStatusValue;
                  }
                  const saved = await saveRoomEdits({
                    roomId: tgt.roomId,
                    buildingId: tgt.buildingId,
                    buildingName: tgt.buildingName,
                    floorName: tgt.floorName,
                    revitId: tgt.revitId,
                    roomLabel: tgt.roomLabel,
                    roomNumber: tgt.roomNumber,
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
                          if (editHasOfficeType) {
                            feat.properties.Occupant = propsForTarget.occupant ?? feat.properties.Occupant;
                            feat.properties.occupant = feat.properties.Occupant;
                            feat.properties.occupancyStatus =
                              propsForTarget.occupancyStatus ?? feat.properties.occupancyStatus;
                            feat.properties.OccupancyStatus =
                              propsForTarget.OccupancyStatus ?? feat.properties.OccupancyStatus;
                            feat.properties['Occupancy Status'] =
                              propsForTarget['Occupancy Status'] ?? feat.properties['Occupancy Status'];
                          }
                          if (editHasSeatCountType) {
                            feat.properties.SeatCount = propsForTarget.seatCount ?? feat.properties.SeatCount;
                            feat.properties['Seat Count'] = propsForTarget.seatCount ?? feat.properties['Seat Count'];
                            feat.properties.seatCount = propsForTarget.seatCount ?? feat.properties.seatCount;
                          }
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
        const scenarioDeptLabel = aiScenarioResult?.scenarioDept || scenarioAssignedDept || 'Selected Dept';
        const baselineBuildingLabel = scenarioBaselineTotals?.__label || 'baseline';
        const scenarioBuildingLabel = activeBuildingName || selectedBuilding || selectedBuildingId || 'scenario';
        const baselineTitle = `Baseline (${scenarioDeptLabel} in ${baselineBuildingLabel})`;
        const scenarioTitle = `Scenario (${scenarioDeptLabel} to ${scenarioBuildingLabel})`;

        const bCounts = rollupRoomTypeCounts(b.roomTypes);
        const sCounts = rollupRoomTypeCounts(s.roomTypes);

      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10006,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.45)'
          }}
        >
          <div
            ref={aiScenarioPanelRef}
            style={{
              position: 'fixed',
              left: aiScenarioPos ? aiScenarioPos.x : '50%',
              top: aiScenarioPos ? aiScenarioPos.y : '50%',
              transform: aiScenarioPos ? 'none' : 'translate(-50%, -50%)',
              width: 'min(760px, 92vw)',
              background: '#fff',
              borderRadius: 12,
              padding: 16,
              boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
              maxHeight: '90vh',
              overflow: 'auto'
            }}
          >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div {...aiScenarioDragHandleProps} style={{ fontWeight: 700 }}>
                  {`${scenarioAssignedDept || 'Scenario'} - ${scenarioBaselineTotals?.__label || 'baseline'} to ${activeBuildingName || 'scenario'}${selectedFloor ? ` (${selectedFloor})` : ''}`}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={handleExportScenario}>Export Scenario (PDF)</button>
                  <button className="btn" onClick={() => setAiScenarioOpen(false)}>Close</button>
                </div>
              </div>

            <p style={{ marginTop: 10 }}>{aiScenarioResult.summary}</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
                <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {baselineTitle}
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
                    {scenarioTitle}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>Create move scenario (AI)</div>
                  <span
                    title="AI-generated scenario plan based on currently loaded space data."
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(0,0,0,0.15)',
                      background: '#f7f7ff'
                    }}
                  >
                    {"\u2728 AI"}
                  </span>
                </div>
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

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#444' }}>
              <input
                type="checkbox"
                checked={aiCreateScenarioStrict}
                onChange={(e) => setAiCreateScenarioStrict(e.target.checked)}
              />
              Strict fit (±5% target)
            </label>
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
          zIndex: 10004,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(0,0,0,0.45)'
        }}
      >
        <div
          ref={aiCreateScenarioResultRef}
          style={{
            position: 'fixed',
            left: aiCreateScenarioResultPos ? aiCreateScenarioResultPos.x : '50%',
            top: aiCreateScenarioResultPos ? aiCreateScenarioResultPos.y : '50%',
            transform: aiCreateScenarioResultPos ? 'none' : 'translate(-50%, -50%)',
            width: 'min(760px, 92vw)',
            background: '#fff',
            borderRadius: 12,
            padding: 12,
            boxShadow: '0 22px 44px rgba(0,0,0,0.25)',
            lineHeight: 1.35,
            fontSize: 12,
            maxHeight: '90vh',
            overflow: 'auto'
          }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} {...aiCreateScenarioResultDragHandleProps}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>
                    {aiCreateScenarioResult.title || 'Move scenario plan'}
                  </div>
                  <span
                    title="AI-generated scenario plan based on currently loaded space data."
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(0,0,0,0.15)',
                      background: '#f7f7ff'
                    }}
                  >
                    {"\u2728 AI"}
                  </span>
                </div>
                {aiCreateScenarioResult.interpretedIntent ? (
                  <div style={{ fontSize: 12, color: '#555' }}>{aiCreateScenarioResult.interpretedIntent}</div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => applyAiScenarioToComparison(aiCreateScenarioResult)}>
                  Add to Scenario Comparison
                </button>
                <button className="btn" onClick={() => setAiCreateScenarioResult(null)}>Close</button>
              </div>
            </div>

            {aiCreateScenarioResult.selectionCriteria?.filter((c) => !/vacan/i.test(c || '')).length ? (
              <div style={{ marginTop: 10 }}>
                <b>Selection criteria</b>
                <ul style={{ margin: '6px 0 10px 18px', padding: 0 }}>
                  {aiCreateScenarioResult.selectionCriteria
                    .filter((c) => !/vacan/i.test(c || ''))
                    .map((c, i) => <li key={i}>{c}</li>)}
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
                    <div style={{ textAlign: 'right' }}>Match / Notes</div>
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
                        <div style={{ textAlign: 'right' }}>
                          {(() => {
                            const occupant = String(c.occupant || '').trim();
                            const dept = String(c.occupantDept || c.department || '').trim();
                            if (occupant) {
                              return `⚠️ Occupied — requires relocation${dept ? ` of ${dept}` : ''}`;
                            }
                            return '';
                          })()}
                        </div>
                        <div>{sanitizeVacancyLanguage(c.rationale) || ''}</div>
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




















