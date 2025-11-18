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

    const dept =
      (props.department ||
        props.Department ||
        props.Dept ||
        '').toString().trim();

    if (dept) {
      const prev = deptMap.get(dept) || { name: dept, sf: 0, rooms: 0 };
      prev.sf += area;
      prev.rooms += 1;
      deptMap.set(dept, prev);
    }

    const type =
      (props.type ||
        props.roomType ||
        props.RoomType ||
        props.RoomTypeName ||
        props.Type ||
        '').toString().toUpperCase();

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
  "Classroom - General",
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
  "Office - Prof and Admin",
  "Office - Staff",
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

function collectFloorOptions(features) {
  const types = new Set(ROOM_TYPES.map(norm));
  const depts = new Set(DEPARTMENTS.map(norm));

  for (const f of features || []) {
    const p = f.properties || {};
    const t = norm(p.type ?? p.roomType ?? p.Name ?? p.RoomType ?? p.Type);
    const d = norm(p.department ?? p.Department ?? p.Dept);
    if (t) types.add(t);
    if (d) depts.add(d);
  }
  return {
    typeOptions: Array.from(types).filter(Boolean).sort(),
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
  const normalizeDept = (props) => {
    const dept = norm(props?.department ?? props?.Department ?? props?.Dept ?? '');
    return dept || '';
  };
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
    const scenarioDept = norm(
      props?.scenarioDepartment ??
      props?.ScenarioDepartment ??
      props?.scenarioDept ??
      ''
    );
    const baseDept = normalizeDept(props);
    const deptName = scenarioDept || baseDept;
    const baseColor = deptName ? getDeptColor(deptName) : null;
    const fill = baseColor
      ? convertHexWithAlpha(baseColor, scenarioDept ? 0.9 : 0.4)
      : '#f7f7f7';
    const outline = baseColor || '#2b2b2b';
    const geom = feature?.geometry;
    if (!geom || !geom.coordinates) continue;
    const drawGeom = (geomCoords, geomType) => {
      if (!Array.isArray(geomCoords)) return;
      if (geomType === 'Polygon') {
        ctx.fillStyle = fill;
        ctx.strokeStyle = outline;
        ctx.lineWidth = 1.5;
        geomCoords.forEach((ring) => {
          drawPoly(ring);
          ctx.fill();
          ctx.stroke();
        });
      } else if (geomType === 'MultiPolygon') {
        geomCoords.forEach((poly) => drawGeom(poly, 'Polygon'));
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
    const labelLines = buildLabelLines(props, scenarioDept, baseDept, normalizedArea);
    drawLabelOnFeature(feature, labelLines);
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

function applyFloorFillExpression(map) {
  if (!map || !map.getLayer(FLOOR_FILL_ID)) return;
  try {
    map.setPaintProperty(FLOOR_FILL_ID, 'fill-color', deptFillExpression());
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

// Fit-to-building (scale+translate) tuning
const FIT_MARGIN = 0.90;   // tighter/looser fit inside building bbox
const EXTRA_SHRINK = 0.85; // additional ?make smaller? factor

async function fetchGeoJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !ct.includes('json')) {
      console.debug('Floor load: not JSON, skipping', url, ct || res.status);
      floorCache.delete(url);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.debug('Floor load fetch threw:', url, err);
    floorCache.delete(url);
    return null;
  }
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
    const c = gj?.features?.[0]?.geometry?.coordinates;
    if (!c) return false;
    const flat = c.flat(3);
    const [x, y] = flat;
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
  } catch { return false; }
}

async function loadFloorGeojson(map, url, rehighlightId, affineParams, options = {}) {
  if (!map || !url) return;
  const { buildingId, floor, roomPatches, onOptionsCollected, currentFloorContextRef } = options;

  let data = floorCache.get(url);
  if (!data) {
    data = await fetchGeoJSON(url);
    if (!data) return;
    floorCache.set(url, data);
  }

  let fc = toFeatureCollection(data);
  if (!fc?.features?.length) return;

  if (fc && Array.isArray(fc.features) && currentFloorContextRef && typeof currentFloorContextRef === 'object') {
    currentFloorContextRef.current = { url, buildingId, floor, fc };
  }

  fc.features.forEach((feature, i) => {
    if (feature && feature.id == null) {
      feature.id = feature.properties?.RevitId ?? i;
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
    if (fitBuilding) {
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
    map.addLayer({ id: FLOOR_LINE_ID, type: 'line', source: FLOOR_SOURCE, paint: { 'line-color': '#444', 'line-width': 1.25 } });
  }

  ensureFloorRoomLabelLayer(map);

  // Ensure highlight layer draws above the fill (but under outline)
  try {
    if (map.getLayer(FLOOR_HL_ID) && map.getLayer(FLOOR_LINE_ID)) {
      map.moveLayer(FLOOR_HL_ID, FLOOR_LINE_ID);
    }

    
  } catch {}

  // re-apply selection if any (normalize to string id)
  if (rehighlightId != null && map.getLayer(FLOOR_HL_ID)) {
    const hlFilter = [
      'any',
      ['==', ['id'], rehighlightId],
      ['==', ['get', 'RevitId'], rehighlightId]
    ];
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

function summarizeFeatures(features = []) {
  let totalSf = 0;
  let classroomSf = 0;
  let rooms = 0;
  let classroomCount = 0;
  const deptCounts = new Map();

  features.forEach((feature) => {
    const props = feature?.properties || {};
    const area = resolvePatchedArea(props);
    const numericArea = Number.isFinite(area) ? area : 0;
    totalSf += numericArea;
    rooms += 1;

    const dept = norm(props.department ?? props.Department ?? props.Dept);
    if (dept) {
      deptCounts.set(dept, (deptCounts.get(dept) || 0) + numericArea);
    }

    const typeStr = norm(props.type ?? props.roomType ?? props.Name ?? props.RoomType ?? props.Type).toLowerCase();
    if (typeStr.includes('class') || typeStr.includes('lecture')) {
      classroomSf += numericArea;
      classroomCount += 1;
    }
  });

  const sorted = Array.from(deptCounts.entries()).sort((a, b) => b[1] - a[1]);
  const totalsByDept = Object.fromEntries(sorted);
  const keyDepts = sorted.slice(0, 6).map(([name]) => name);

  return {
    totalSf,
    classroomSf,
    rooms,
    classroomCount,
    deptCounts: totalsByDept,
    totalsByDept,
    keyDepts
  };
}

function finalizeCombinedSummary(combined) {
  const sorted = Array.from(combined.deptCounts.entries()).sort((a, b) => b[1] - a[1]);
  const totalsByDept = Object.fromEntries(sorted);
  return {
    totalSf: combined.totalSf,
    classroomSf: combined.classroomSf,
    rooms: combined.rooms,
    classroomCount: combined.classroomCount,
    deptCounts: totalsByDept,
    totalsByDept,
    keyDepts: sorted.slice(0, 6).map(([name]) => name)
  };
}

function formatSummaryForPanel(summary, mode) {
  if (!summary) {
    return {
      loading: false,
      mode,
      totalSf: '-',
      classroomSf: '-',
      rooms: '-',
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
    rooms: fmtCount(summary.rooms),
    classroomCount: fmtCount(summary.classroomCount),
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

    const cRooms = turf.centroid(roomsFC);
    const cBldg = turf.centroid(building);

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

    return fitted;
  } catch {
    return roomsFC;
  }
}

// Extract all [lng, lat] pairs from any geometry (handles deep nesting)
function extractLngLatPairs(geom) {
  const out = [];
  function collect(c) {
    if (!c) return;
    if (typeof c[0] === 'number') out.push([c[0], c[1]]);
    else c.forEach(collect);
  }
  if (geom?.type === 'GeometryCollection') (geom.geometries || []).forEach((g) => collect(g.coordinates));
  else collect(geom?.coordinates);
  return out;
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
  { name: 'Dougherty Center', folder: 'Dougherty' },
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
    if (map.getLayer(FLOOR_FILL_ID)) map.removeLayer(FLOOR_FILL_ID);
    if (map.getSource(FLOOR_SOURCE)) map.removeSource(FLOOR_SOURCE);
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
  if (map.getLayer(FLOOR_ROOM_LABEL_LAYER)) {
    bringFloorRoomLabelsToFront(map);
    return;
  }
  try {
    const scenarioDeptField = [
      'coalesce',
      ['get', 'scenarioDepartment'],
      ['get', 'department'],
      ['get', 'Department'],
      ['literal', '-']
    ];
    map.addLayer(
      {
        id: FLOOR_ROOM_LABEL_LAYER,
        type: 'symbol',
        source: FLOOR_SOURCE,
        layout: {
          'text-field': [
            'format',
            ['coalesce', ['get', 'Number'], ['get', 'RoomNumber'], ['get', 'name'], ['literal', '-']],
            '\n',
            ['coalesce', ['get', 'RoomType'], ['get', 'Type'], ['get', 'type'], ['get', 'Name'], ['literal', '-']],
            '\n',
            scenarioDeptField,
            '\n',
            ['concat', ['coalesce', ['to-string', ['round', ['coalesce', ['get', 'Area_SF'], ['get', 'Area'], 0]]], ['literal', '0']], ' SF']
          ],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0,
          15, 0,
          16, 0,
          17, 0,
          18, 0,
          19, 9,
        ],
            'text-line-height': 1.0,
          'text-variable-anchor': ['center'],
          'text-radial-offset': 0,
          'text-anchor': 'center',
          'text-justify': 'center',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-max-width': 5
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
  const [isBuildingPanelCollapsed, setIsBuildingPanelCollapsed] = useState(false);

  const baseTypeOptions = useMemo(() => Array.from(new Set(ROOM_TYPES)).sort(), []);
  const baseDeptOptions = useMemo(() => Array.from(new Set([...Object.keys(DEPT_COLORS), ...DEPARTMENTS])).sort(), []);

  // ===== STATS STATE + REFS =====
  const [buildingStats, setBuildingStats] = useState(null); // { totalSf, rooms, classroomSf, classroomCount, totalsByDept }
  const [floorStats, setFloorStats] = useState(null);       // same shape for current floor
  const [popupMode, setPopupMode] = useState('building');
  const [panelStats, setPanelStats] = useState(null); // legacy stats for existing UI panels
  const [floorStatsByBuilding, setFloorStatsByBuilding] = useState({});
  const [typeOptions, setTypeOptions] = useState(baseTypeOptions);
  const [deptOptions, setDeptOptions] = useState(baseDeptOptions);
  const mergeOptionsList = (prev, next) => {
    const seen = new Set(prev);
    (next || []).forEach((item) => {
      if (item) seen.add(item);
    });
    return Array.from(seen).sort();
  };

  const [roomPatches, setRoomPatches] = useState(new Map());
  const [roomEditOpen, setRoomEditOpen] = useState(false);
  const [roomEditData, setRoomEditData] = useState(null);
  const closeRoomEdit = useCallback(() => {
    setRoomEditOpen(false);
    setRoomEditData(null);
  }, []);
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

  const estimatePanelAnchor = (pt) => {
    const width = mapContainerRef.current?.clientWidth ?? 0;
    const height = mapContainerRef.current?.clientHeight ?? 0;
    const x = pt.x + 110;
    const y = pt.y - 60;
    return {
      x: Math.min(Math.max(x, 8), (width || 1000) - 260),
      y: Math.min(Math.max(y, 8), (height || 800) - 220)
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

  const setFloorHighlight = useCallback((id) => {
    const map = mapRef.current;
    if (!map || !map.getLayer(FLOOR_HL_ID)) return;
    const filter = id != null
      ? ['any', ['==', ['id'], id], ['==', ['get', 'RevitId'], id]]
      : ['==', ['id'], ''];
    try {
      map.setFilter(FLOOR_HL_ID, filter);
      if (map.getLayer(FLOOR_HL_BORDER_ID)) {
        map.setFilter(FLOOR_HL_BORDER_ID, filter);
      }
    } catch {}
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
    if (floorStatsCache.current[url]) return floorStatsCache.current[url];

    let data = floorCache.get(url);
    if (!data) {
      data = await fetchGeoJSON(url);
      if (!data) {
        console.warn('Floor summary: no data returned', url);
        return null;
      }
      floorCache.set(url, data);
    }

    const fc = toFeatureCollection(data);
    if (!Array.isArray(fc?.features)) {
      console.warn('Floor summary: no features, skipping', url);
      return null;
    }

    const sum = summarizeFeatures(fc.features);
    floorStatsCache.current[url] = sum;
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
    const combined = { totalSf: 0, classroomSf: 0, rooms: 0, classroomCount: 0, deptCounts: new Map() };

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
      combined.rooms += stats.rooms || 0;
      combined.classroomCount += stats.classroomCount || 0;
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
        totalsByDept: {}
      };
    }
    const sum = await fetchBuildingSummary(buildingId);
    return sum ?? {
      totalSf: undefined,
      rooms: undefined,
      classroomSf: undefined,
      classroomCount: undefined,
      totalsByDept: {}
    };
  }, [fetchBuildingSummary]);

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

  const handleLoadFloorplan = useCallback(async () => {
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
        onOptionsCollected: ({ typeOptions: types, deptOptions: depts }) => {
          if (types) setTypeOptions((prev) => mergeOptionsList(prev, types));
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
        if (currentFloorUrlRef.current === url) {
          setPanelStats(formatSummaryForPanel(loadResult.summary, 'floor'));
        }
      } else {
        setFloorStats(null);
        setPanelStats(formatSummaryForPanel(null, 'floor'));
      }
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
  }, [mapLoaded, selectedBuilding, selectedFloor, config, selectedBuildingId, buildFloorUrl, roomPatches, availableFloors, mapView]);

  const handleUnloadFloorplan = useCallback(() => {
    unloadFloorplan(mapRef.current, currentFloorUrlRef);
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

  // Alias wrapper used by BuildingPanel "Load" button
  const onPanelLoadFloor = useCallback(async (floorId) => {
    await handleLoadFloorplan(floorId);
  }, [handleLoadFloorplan]);  // ---------- Minimal admin actions to avoid runtime errors ----------
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

    try {
      mapInstance.addControl(new mapboxgl.NavigationControl(), 'top-right');
      // mapInstance.addControl(new mapboxgl.FullscreenControl());
    } catch (e) {
      console.warn('Adding controls failed:', e);
    }

    // 4) Load/resize safely
    mapInstance.once('load', () => {
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

      const renderReadOnlyPopup = () => {
        const areaText = Number.isFinite(displayAreaValue) && displayAreaValue !== 0
          ? Math.round(displayAreaValue).toLocaleString()
          : '';
        const editButtonHtml = canEditRoom
          ? `<div style="margin-top:8px">
              <button id="mf-room-edit-btn" class="mf-btn tiny">Edit</button>
            </div>`
          : '';
        const occupantText = (displayOccupant && String(displayOccupant).trim().length)
          ? displayOccupant
          : '-';
        return `
          <div class="mf-popup">
            <div class="mf-popup-body">
              <div class="mf-title">Room ${roomNum2 || '-'}</div>
              <div><b>Type:</b> ${displayRoomType || '-'}</div>
              <div><b>Department:</b> ${displayDept || '-'}</div>
              <div><b>Area (SF):</b> ${areaText || '-'}</div>
              <div><b>Floor:</b> ${floorName}</div>
              <div><b>Occupant:</b> ${occupantText}</div>
            </div>

            <div style="margin-top:8px">
              <button id="mf-show-floor" class="mf-btn tiny">Show Floor Data</button>
            </div>

            ${editButtonHtml}
          </div>`;
      };

      const popup = new mapboxgl.Popup({
        closeButton: true,
        offset: 12,
        maxWidth: '380px'
      })
        .setLngLat(e.lngLat)
        .setHTML(renderReadOnlyPopup())
        .addTo(map);

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
        setRoomEditData({
          roomId, buildingId, floorName, revitId, feature: f,
          roomLabel: roomNum2 || '-',
          properties: {
            type: displayRoomType || '',
            department: displayDept || '',
            area: Number.isFinite(displayAreaValue) ? displayAreaValue : '',
            occupant: displayOccupant || '',
            comments: initialComments || ''
          },
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
        setRoomEditOpen(true);
      };

      function attachReadOnlyEvents() {
        const el = popup.getElement();
        if (!el) return;
        el.querySelector('#mf-show-floor')?.addEventListener('click', handleShowFloor);
        if (canEditRoom) {
          el.querySelector('#mf-room-edit-btn')?.addEventListener('click', handleEdit);
        }
      }

      attachReadOnlyEvents();
    };

    const onEnter = () => { try { map.getCanvas().style.cursor = 'pointer'; } catch {} };
    const onLeave = () => { try { map.getCanvas().style.cursor = ''; } catch {} };

    map.on('click', FLOOR_FILL_ID, onFloorClick);
    map.on('mouseenter', FLOOR_FILL_ID, onEnter);
    map.on('mouseleave', FLOOR_FILL_ID, onLeave);

    return () => {
      try {
        map.off('click', FLOOR_FILL_ID, onFloorClick);
        map.off('mouseenter', FLOOR_FILL_ID, onEnter);
        map.off('mouseleave', FLOOR_FILL_ID, onLeave);
      } catch {}
      currentRoomFeatureRef.current = null;
    };
  }, [mapLoaded, floorUrl, selectedBuilding, selectedBuildingId, selectedFloor, showFloorStats, setMapView, setIsTechnicalPanelOpen, setIsBuildingPanelCollapsed, setPanelAnchor, panelStats, roomPatches, isAdminUser, authUser, universityId, resolveBuildingPlanKey, fetchBuildingSummary, fetchFloorSummaryByUrl, mapView, floorStatsByBuilding, moveScenarioMode, moveMode, pendingMove]);

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

  const activeBuildingFeature = useMemo(() => {
    const feats = config?.buildings?.features || [];
    return feats.find((f) => String(f?.properties?.id) === String(selectedBuildingId)) || null;
  }, [config, selectedBuildingId]);
  const activeBuildingName =
    activeBuildingFeature?.properties?.name ||
    selectedBuilding ||
    selectedBuildingId ||
    'Building';
  const activeBuildingId = selectedBuildingId || selectedBuilding || '';
  const panelSelectedFloor = selectedFloor ?? (availableFloors?.[0] || '');
  const loadSelectedFloor = useCallback(() => {
    if (!panelSelectedFloor) return;
    if (panelSelectedFloor !== selectedFloor) {
      setSelectedFloor(panelSelectedFloor);
    }
    onPanelLoadFloor(panelSelectedFloor);
  }, [panelSelectedFloor, onPanelLoadFloor, selectedFloor]);

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

    {mode === 'admin' && mapView === MAP_VIEWS.SPACE_DATA && selectedBuildingId && panelAnchor && !isBuildingPanelCollapsed && (
      <div
        className="floating-panel"
        style={{
          position: 'absolute',
          zIndex: 10,
          left: Math.max(8, Math.min(panelAnchor.x + 12, (mapContainerRef.current?.clientWidth || 1000) - 360)),
          top: Math.max(8, Math.min(panelAnchor.y + 12, (mapContainerRef.current?.clientHeight || 800) - 260)),
        }}
      >
        {popupMode === 'building' && (
          <BuildingPanel
            buildingName={activeBuildingName}
            stats={buildingStats}
            keyDepts={toKeyDeptList(buildingStats?.totalsByDept)}
            floors={availableFloors}
            selectedFloor={panelSelectedFloor}
            onChangeFloor={(fl) => setSelectedFloor(fl)}
            onLoadFloorplan={loadSelectedFloor}
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
          />
        )}
        {popupMode === 'floor' && (
          <FloorPanel
            buildingName={activeBuildingName}
            floorLabel={floorStats?.floorLabel || panelSelectedFloor}
            stats={floorStats}
            keyDepts={toKeyDeptList(floorStats?.totalsByDept)}
            floors={availableFloors}
            selectedFloor={panelSelectedFloor}
            onChangeFloor={(fl) => setSelectedFloor(fl)}
            onLoadFloorplan={loadSelectedFloor}
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
          />
        )}
      </div>
    )}

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
            placeholder="e.g. Art Dept to Hurley – Option A"
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div><b>Total SF:</b> {Math.round(scenarioTotals.totalSF).toLocaleString()}</div>
          <div><b>Rooms:</b> {scenarioTotals.rooms}</div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>SF by Room Type</div>
          {Object.keys(scenarioTotals.sfByRoomType).length === 0 ? (
            <div style={{ fontSize: 12, fontStyle: 'italic', color: '#666' }}>No rooms selected.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12 }}>
              <tbody>
                {Object.entries(scenarioTotals.sfByRoomType).map(([type, sf]) => (
                  <tr key={type}>
                    <td>{type}</td>
                    <td style={{ textAlign: 'right' }}>{Math.round(sf).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Room Type Counts</div>
          {Object.keys(scenarioTotals.roomTypes).length === 0 ? (
            <div style={{ fontSize: 12, fontStyle: 'italic', color: '#666' }}>No rooms selected.</div>
          ) : (
            <table style={{ width: '100%', fontSize: 12 }}>
              <tbody>
                {Object.entries(scenarioTotals.roomTypes).map(([type, count]) => (
                  <tr key={type}>
                    <td>{type}</td>
                    <td style={{ textAlign: 'right' }}>{count}</td>
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

              const summaryLabel = scenarioLabel || 'Move Scenario';
              const textX = imageAdded ? imgWidth + margin * 2 : margin;
              const textWidth = pageWidth - textX - margin;
              const lineHeight = 16;
              let y = margin;
              doc.setFontSize(14);
              const summaryLines = doc.splitTextToSize(summaryLabel, textWidth);
              doc.text(summaryLines, textX, y);
              y += lineHeight * summaryLines.length;
              doc.setFontSize(12);
              const addLine = (txt) => {
                doc.text(txt, textX, y, { maxWidth: textWidth });
                y += lineHeight;
              };
              addLine(`Total SF: ${Math.round(scenarioTotals.totalSF).toLocaleString()}`);
              addLine(`Rooms: ${scenarioTotals.rooms}`);
              y += lineHeight / 2;
              addLine('SF by Room Type:');
              doc.setFont(undefined, 'normal');
              Object.entries(scenarioTotals.sfByRoomType).forEach(([type, sf]) => {
                const line = `${type}: ${Math.round(sf).toLocaleString()} SF`;
                addLine(line);
              });
              y += lineHeight / 2;
              addLine('Room Type Counts:');
              Object.entries(scenarioTotals.roomTypes).forEach(([type, count]) => {
                addLine(`${type}: ${count}`);
              });
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
      <div className="map-controls-panel">
        <div className="map-controls">

          {/* Admin access - compact header layout */}
          {mode === 'admin' && (
            <div className="control-section" style={{ background: '#fff', padding: 8, border: '1px solid #ddd', borderRadius: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                <h5 style={{ margin: 0 }}>Admin access</h5>
                {!authUser ? (
                  <button onClick={handleAdminSignIn}>Sign in with Google</button>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
            <div className="control-section theme-selector" style={{ marginTop: 8 }}>
              <label htmlFor="theme-select" style={{ marginRight: 8 }}>Map View:</label>
              <select id="theme-select" value={mapView} onChange={(e) => setMapView(e.target.value)}>
                {MAP_VIEW_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Data Filters */}
          {mode === 'admin' && (
            <div className="control-section data-filters" style={{ marginTop: 8 }}>
              <h4 style={{ margin: '0 0 6px 0' }}>Data Filters</h4>
              <div className="filter-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={showStudentMarkers}
                    onChange={() => setShowStudentMarkers(v => !v)}
                  />
                  Show Student Markers
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={showStaffMarkers}
                    onChange={() => setShowStaffMarkers(v => !v)}
                  />
                  Show Staff Markers
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={moveScenarioMode}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setMoveScenarioMode(enabled);
                      if (!enabled) {
                        clearScenario();
                      } else {
                        setScenarioPanelVisible(true);
                      }
                    }}
                  />
                  Move Scenario Mode
                </label>
              </div>
              {moveScenarioMode && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#555' }}>
                  Click rooms to add/remove them from a what-if scenario. Real data is not changed.
                </div>
              )}
            </div>
          )}

          {/* Mode */}
          <div className="mode-selector" style={{ marginTop: 8 }}>
            <button
              className={interactionMode === 'select' ? 'active' : ''}
              onClick={() => setInteractionMode('select')}
            >
              Select/Marker
            </button>
          </div>

          {/* Admin actions */}
          {mode === 'admin' && (
            <div className="control-section admin-controls" style={{ marginTop: 8 }}>
              <div className="actions" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="btn span-2" onClick={exportData}>Export Map Data</button>
                {config.enableDrawingEntry && (
                  <button className="btn span-2" onClick={exportDrawingEntries}>Export Drawing Entries</button>
                )}
                <button className="btn" onClick={clearMarkers}>Clear Markers</button>
                <button className="btn span-2" onClick={clearConditions}>Clear Conditions</button>
              </div>

              {/* Floorplans (simple file-based loader) */}
              <div className="floorplans-section" style={{ marginTop: 10 }}>
                <h4 style={{ margin: '0 0 6px 0' }}>Floorplans</h4>

                <div className="floorplans" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* Building select from BUILDINGS_LIST */}
                  <select
                    id="fp-building"
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

                  {/* Floor select FROM the selected building's floors */}
                  <select
                    id="fp-floor"
                    value={selectedFloor ?? ''}
                    onChange={(e) => setSelectedFloor(e.target.value)}
                    disabled={!availableFloors.length}
                  >
                    {availableFloors.map((fl) => (
                      <option key={fl} value={fl}>{fl}</option>
                    ))}
                  </select>

                  <button className="btn" onClick={handleLoadFloorplan} disabled={!availableFloors.length}>Load</button>
                  <button className="btn" onClick={handleUnloadFloorplan}>Unload</button>
                  <button className="btn" onClick={() => centerOnCurrentFloor(mapRef.current)}>Center</button>
                </div>

                <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                  Files must be named like <code>LEVEL_1_Dept.geojson</code> in
                  <br />
                  <code>public/floorplans/Hastings/&lt;BuildingFolder&gt;/</code>
                </div>
              </div>
            </div>
          )}
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
          <h4 style={{ margin: '0 0 12px 0' }}>Edit Room {roomEditData.feature?.properties?.name || roomEditData.roomLabel || ''}</h4>

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
                const saved = await saveRoomEdits({
                  roomId: roomEditData.roomId,
                  buildingId: roomEditData.buildingId,
                  floorName: roomEditData.floorName,
                  revitId: roomEditData.revitId,
                  properties: roomEditData.properties
                });
                if (saved) {
                  roomEditData.onApply?.(saved);
                  roomEditData.refreshPopup?.();
                  closeRoomEdit();
                }
              }}
            >
              Save
            </button>
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

































