import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { db } from '../firebaseConfig';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';
import {
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
  GeoPoint,
  writeBatch,
  setDoc,
  query,
  where
} from 'firebase/firestore';
import { doc, getDoc } from 'firebase/firestore';
import './StakeholderMap.css';
import AssessmentPanel from './AssessmentPanel.jsx';
import BuildingInteractionPanel from './BuildingInteractionPanel.jsx';
import { surveyConfigs } from '../surveyConfigs';
import * as turf from '@turf/turf';

const stakeholderConditionConfig = {
  '5': { label: '5 = Excellent condition', color: '#4CAF50' },
  '4': { label: '4 = Good condition',      color: '#8BC34A' },
  '3': { label: '3 = Adequate condition',  color: '#FFEB3B' },
  '2': { label: '2 = Poor condition',      color: '#FF9800' },
  '1': { label: '1 = Very poor condition', color: '#F44336' }
};
const progressColors = { 0: '#85474b', 1: '#aed6f1', 2: '#5dade2', 3: '#2e86c1' };
const defaultBuildingColor = '#85474b';
// Disable legacy Gray Center auto-add to prevent duplicates
const USE_OLD_AUTOADD = false;

const StakeholderMap = ({ config, universityId, mode = 'public', persona }) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const previousSelectedBuildingId = useRef(null);

  if (!universityId) {
    return <div>Loading University...</div>;
  }
  
  const [mapLoaded, setMapLoaded] = useState(false);
  const [interactionMode, setInteractionMode] = useState('select');
  // This will default to TRUE for admins, and FALSE for everyone else ('public').
  const [showMarkers, setShowMarkers] = useState(mode === 'admin');
  const [showPaths, setShowPaths] = useState(true);
  const [showHelp, setShowHelp] = useState(true);
  const [markers, setMarkers] = useState([]);
  const [paths, setPaths] = useState([]);
  const [newPathCoords, setNewPathCoords] = useState([]);
  const [buildingConditions, setBuildingConditions] = useState({});
  const [buildingAssessments, setBuildingAssessments] = useState({});
  const [selectedBuildingId, setSelectedBuildingId] = useState(null);
  const [mapTheme, setMapTheme] = useState('progress');
  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [isTechnicalPanelOpen, setIsTechnicalPanelOpen] = useState(false);
  // --- Admin auth state (simple) ---
  const [authUser, setAuthUser] = useState(null);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [sessionMarkers, setSessionMarkers] = useState([]); // <-- ADD THIS LINE
  const [showStudentMarkers, setShowStudentMarkers] = useState(true);
  const [showStaffMarkers, setShowStaffMarkers] = useState(true);
  // Room attributes loaded from Firestore per building/floor (admin)
  const roomAttrsRef = useRef({});
  // Floorplans manifest (admin-only)
  const [fpManifest, setFpManifest] = useState(null);
  // Floorplans manifest + UI state (admin)
  const [floorManifest, setFloorManifest] = useState(null);
  const [selectedBuilding, setSelectedBuilding] = useState('');
  const [selectedFloor, setSelectedFloor] = useState('');
  const [loadedFloors, setLoadedFloors] = useState([]); // ['Building-FL1']
  const loadedFloorsRef = useRef([]); // track loaded srcIds for cleanup
  // Anchor for floating panels near click
  const [panelAnchor, setPanelAnchor] = useState(null); // { x, y } in pixels

  const filteredMarkers = useMemo(() => {
    // If both are turned off, return an empty array quickly.
    if (!showStudentMarkers && !showStaffMarkers) {
      return [];
    }
    // Filter the main markers list based on the toggle states.
    return markers.filter(marker => {
      if (showStudentMarkers && marker.persona === 'student') {
        return true;
      }
      if (showStaffMarkers && marker.persona === 'staff') {
        return true;
      }
      // Include markers that might not have a persona (e.g., from early testing)
      if (mode === 'admin' && !marker.persona) {
        return true;
      }
      return false;
    });
  }, [markers, showStudentMarkers, showStaffMarkers, mode]);

  const markerTypes = useMemo(() => {
    if (mode === 'admin') {
      return { ...surveyConfigs.student, ...surveyConfigs.staff };
    }
    return surveyConfigs[persona] || surveyConfigs.default;
  }, [persona, mode]);

  const pathTypes = useMemo(() => ({ 'Preferred Route': { color: '#008000' }, 'Avoided Route': { color: '#F44336' } }), []);
  const [currentPathDrawType] = useState(() => Object.keys(pathTypes)[0]);

  const markersCollection = useMemo(() => collection(db, 'universities', universityId, 'markers'), [universityId]);
  const pathsCollection = useMemo(() => collection(db, 'universities', universityId, 'paths'), [universityId]);
  const conditionsCollection = useMemo(() => collection(db, 'universities', universityId, 'buildingConditions'), [universityId]);
  const assessmentsCollection = useMemo(() => collection(db, 'universities', universityId, 'buildingAssessments'), [universityId]);
  const drawingEntriesCollection = useMemo(() => collection(db, 'universities', universityId, 'drawingEntries'), [universityId]);

  const showMarkerPopup = useCallback((lngLat) => {
    if (!mapRef.current) return;
    const popupNode = document.createElement('div');
    popupNode.className = 'marker-prompt-popup';

    

    popupNode.innerHTML = `
      <h4>Add a Marker</h4>
      <select id="marker-type">${Object.keys(markerTypes).map(type => `<option value="${type}">${type}</option>`).join('')}</select>
      <textarea id="marker-comment" placeholder="Optional comment..."></textarea>  
      <div class="button-group">
        <button id="confirm-marker">Add</button>
        <button id="cancel-marker">Cancel</button>
      </div>`;
      
    const popup = new mapboxgl.Popup({ closeOnClick: false, maxWidth: '280px' }).setDOMContent(popupNode).setLngLat(lngLat).addTo(mapRef.current);

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
      
      // We still add to the main `markers` list to save the data, but it won't be displayed for public users.
      setMarkers(prev => [...prev, newMarker]); 

      // --- THIS IS THE KEY CHANGE ---
      // We add the new marker to our temporary session list, which WILL be displayed.
      setSessionMarkers(prev => [...prev, newMarker]); 
      
      // We don't need setShowMarkers(true) anymore, so you can ensure that line is removed.

      popup.remove();
    });
    popupNode.querySelector('#cancel-marker').addEventListener('click', () => popup.remove());
  }, [markerTypes, markersCollection, drawingEntriesCollection, persona, config.enableDrawingEntry]);

  const handleFinishPath = useCallback(async () => {
    if (newPathCoords.length < 2) { setNewPathCoords([]); return; }
    const pathData = { coordinates: newPathCoords.map(c => new GeoPoint(c[1], c[0])), type: currentPathDrawType, createdAt: serverTimestamp() };
    const docRef = await addDoc(pathsCollection, pathData);
    setPaths(prev => [...prev, { ...pathData, id: docRef.id, coordinates: newPathCoords }]);
    setNewPathCoords([]);
  }, [newPathCoords, currentPathDrawType, pathsCollection]);

  const handleAssessmentSave = useCallback(async (updatedAssessment) => {
    if (!isAdminUser) {
      alert('Please sign in as an admin.');
      return;
    }
    const id = updatedAssessment.originalId;
    if (!id) { console.error("Cannot save assessment: missing originalId."); return; }
    const docRef = doc(assessmentsCollection, id.replace(/\//g, '__'));
    await setDoc(docRef, updatedAssessment, { merge: true });
    setBuildingAssessments(prev => ({ ...prev, [id]: updatedAssessment }));
  }, [assessmentsCollection, isAdminUser]);

  const handleConditionSave = async (buildingId, newCondition) => {
    if (!isAdminUser) {
      alert('Please sign in as an admin.');
      return;
    }
    try {
      const docRef = doc(conditionsCollection, buildingId.replace(/\//g, '__'));
      await setDoc(docRef, { condition: newCondition, originalId: buildingId }, { merge: true });
      // Update local state (drives the normal effect)
      setBuildingConditions(prev => ({ ...prev, [buildingId]: newCondition }));
      // Force an immediate recolor for snappy UX
      const map = mapRef.current;
      if (map && map.getSource('buildings')) {
        const matchExpr = ['match', ['get', 'id']];
        const cfg = {
          '5': '#4CAF50',
          '4': '#8BC34A',
          '3': '#FFEB3B',
          '2': '#FF9800',
          '1': '#F44336'
        };
        const merged = { ...(buildingConditions || {}) };
        merged[buildingId] = newCondition;
        Object.entries(merged).forEach(([id, cond]) => {
          if (cfg[String(cond)]) matchExpr.push(id, cfg[String(cond)]);
        });
        matchExpr.push('#85474b'); // defaultBuildingColor
        map.setPaintProperty('buildings-layer', 'fill-extrusion-color', matchExpr);
      }
    } catch (err) {
      console.error('Failed to save stakeholder condition:', err);
      alert('Save failed. Are you signed in as an admin and do rules allow writes?');
    }
  };
  
  const handleOpenTechnical = () => setIsTechnicalPanelOpen(true);

  const clearCollection = useCallback(async (collectionRef, name, stateSetter) => {
    if (!window.confirm(`Are you sure you want to delete all ${name} for ${universityId}? This cannot be undone.`)) return;
    stateSetter([]);
    const batch = writeBatch(db);
    const snapshot = await getDocs(collectionRef);
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }, [universityId]);

  const clearMarkers = () => clearCollection(markersCollection, 'markers', setMarkers);
  const clearPaths = () => clearCollection(pathsCollection, 'paths', setPaths);
  const clearConditions = () => clearCollection(conditionsCollection, 'building conditions', setBuildingConditions);

  const exportData = useCallback(() => {
    if (markers.length === 0 && paths.length === 0 && Object.keys(buildingConditions).length === 0 && Object.keys(buildingAssessments).length === 0) {
      return alert("No data to export.");
    }

    // --- NEW GEOSPATIAL LOGIC STARTS HERE ---

    // 1. Define the buffer distance in meters. You can easily change this value.
    const bufferDistanceInMeters = 5;

    // 2. Create the buffered building polygons once, for efficiency.
    const buildingFeatures = config?.buildings?.features || [];
    const bufferedBuildings = buildingFeatures.map(feature => {
      // Use Turf.js to create a new polygon that is X meters larger than the original.
      const bufferedPolygon = turf.buffer(feature, bufferDistanceInMeters, { units: 'meters' });
      return {
        id: feature.properties.id, // Store the building's ID/name
        geometry: bufferedPolygon.geometry // Store the new, larger shape
      };
    });

    // --- GEOSPATIAL LOGIC ENDS HERE ---

    const escapeCsvField = (field) => `"${String(field || '').replace(/"/g, '""')}"`;
    const rows = [];
    
    // Header for Technical Assessments
    rows.push(['DataType', 'BuildingID', 'Category', 'SubCategory', 'Score', 'Notes'].join(','));
    Object.entries(buildingAssessments).forEach(([buildingId, assessment]) => {
      // ... (This part remains the same)
      const notes = assessment.notes || '';
      if (assessment.scores) {
        Object.entries(assessment.scores).forEach(([category, subScores]) => {
          Object.entries(subScores).forEach(([subCategory, score]) => {
            rows.push([ escapeCsvField('TechnicalAssessment'), escapeCsvField(assessment.buildingName || buildingId), escapeCsvField(category), escapeCsvField(subCategory), escapeCsvField(score), escapeCsvField(notes) ].join(','));
          });
        });
      }
    });

    // Header for Markers, Paths, and Conditions
    rows.push([]);
    rows.push(['DataType', 'BuildingID', 'ID', 'Type', 'Persona', 'Latitude', 'Longitude', 'Comment', 'PathCoordinatesJSON'].join(','));

    // --- MODIFIED MARKER EXPORT LOGIC ---
    markers.forEach(m => {
      // For each marker, find which buffered building it falls into.
      const markerPoint = turf.point(m.coordinates);
      let foundBuildingId = ''; // Default to empty

      for (const building of bufferedBuildings) {
        if (turf.booleanPointInPolygon(markerPoint, building.geometry)) {
          foundBuildingId = building.id;
          break; // Stop checking once we find the first match
        }
      }
      
      // Now, use the foundBuildingId when creating the CSV row.
      rows.push([
        escapeCsvField('Marker'),
        escapeCsvField(foundBuildingId), // This column is now populated!
        escapeCsvField(m.id),
        escapeCsvField(m.type),
        escapeCsvField(m.persona),
        escapeCsvField(m.coordinates[1]),
        escapeCsvField(m.coordinates[0]),
        escapeCsvField(m.comment),
        ''
      ].join(','));
    });

    // Paths and Conditions export (remains the same)
    paths.forEach(p => { rows.push([ escapeCsvField('Path'), '', escapeCsvField(p.id), escapeCsvField(p.type), '', '', '', '', escapeCsvField(JSON.stringify(p.coordinates)) ].join(',')); });
    Object.entries(buildingConditions).forEach(([id, condition]) => {
      if (condition) { rows.push([ escapeCsvField('StakeholderCondition'), escapeCsvField(id), '', escapeCsvField(condition), '', '', '', '', '' ].join(',')); }
    });
    
    // CSV creation and download (remains the same)
    const csvContent = rows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `${universityId}-map-data-export-${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [markers, paths, buildingConditions, buildingAssessments, universityId, config]); // Add 'config' to dependency array

  const exportDrawingEntries = useCallback(async () => {
    try {
      console.log("Fetching drawing entries..."); // Added for debugging
      const snapshot = await getDocs(drawingEntriesCollection);

      if (snapshot.empty) {
        console.log("No entries found.");
        return alert("No drawing entries to export.");
      }
      
      console.log(`Found ${snapshot.size} entries.`); // Added for debugging

      const rows = [['Email', 'SubmittedAt'].join(',')];
      snapshot.forEach(doc => {
        const data = doc.data();
        const email = data.email || '';
        // Safely format the timestamp
        const date = data.submittedAt ? data.submittedAt.toDate().toLocaleString() : 'N/A';
        rows.push([`"${email}"`, `"${date}"`].join(','));
      });

      const csvContent = rows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);

      link.setAttribute("href", url);
      link.setAttribute("download", `${universityId}-drawing-entries-${new Date().toISOString().slice(0, 10)}.csv`);
      
      // --- THIS IS THE CRITICAL LINE THAT WAS MISSING ---
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

    } catch (error) {
      console.error("Failed to export drawing entries:", error);
      alert("An error occurred while exporting drawing entries. Please check the console for details.");
    }
  }, [drawingEntriesCollection, universityId]);

  useEffect(() => {
    const authInstance = getAuth();
    getRedirectResult(authInstance).catch(() => {});
    const unsub = onAuthStateChanged(authInstance, async (user) => {
      setAuthUser(user || null);
      if (!user) { setIsAdminUser(false); return; }
      try {
        const roleSnap = await getDoc(doc(db, 'universities', universityId, 'roles', user.uid));
        setIsAdminUser(!!roleSnap.exists() && roleSnap.data()?.role === 'admin');
      } catch {
        setIsAdminUser(false);
      }
    });
    return () => unsub();
  }, [universityId]);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current || !config) return;
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    const map = new mapboxgl.Map({ container: mapContainerRef.current, style: config.style, center: [config.lng, config.lat], zoom: config.zoom, pitch: config.pitch, bearing: config.bearing });
    mapRef.current = map;
    console.log('STAKEHOLDERMAP: admin map created');
    // TEMP: click to log lng/lat for control points
    // Remove after collecting three control points
    let clicks = 0;
    map.on('click', (e) => {
      clicks++;
      console.log(`P${clicks}:`, e.lngLat.toArray()); // [lng, lat]
      if (clicks === 3) console.log('Got 3 points. Use these in geojson-affine script.');
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl());
    map.on('load', () => {
      console.log('STAKEHOLDERMAP: admin map loaded');
      setMapLoaded(true);
    });
    return () => map.remove();
  }, [config]);

  useEffect(() => {
    if (!universityId) return;
    const fetchData = async () => {
      try {
        // --- MODIFIED SECTION START ---

        let markersQuery;

        // If the mode is 'admin', we fetch all markers.
        // Otherwise, we create a query to only fetch markers where the 'persona'
        // field matches the current user's persona ('student' or 'staff').
        if (mode === 'admin') {
          markersQuery = query(markersCollection);
        } else {
          markersQuery = query(markersCollection, where('persona', '==', persona));
        }

        // Now we execute the query we just built
        const markerSnap = await getDocs(markersQuery);

        // --- MODIFIED SECTION END ---

        setMarkers(markerSnap.docs.map(d => ({ id: d.id, ...d.data(), coordinates: [d.data().coordinates.longitude, d.data().coordinates.latitude] })));
        
        // This part remains the same, it only runs for admins
        if (mode !== 'admin') {
          setPaths([]); setBuildingConditions({}); setBuildingAssessments({});
          return;
        }

        const [pathSnap, condSnap, assessmentSnap] = await Promise.all([
          getDocs(pathsCollection),
          getDocs(conditionsCollection),
          getDocs(assessmentsCollection)
        ]);
        
        setPaths(pathSnap.docs.map(d => ({ id: d.id, ...d.data(), coordinates: d.data().coordinates.map(g => [g.longitude, g.latitude]) })));
        
        const condData = {};
        condSnap.forEach(d => { const id = d.data().originalId || d.id.replace(/__/g, "/"); condData[id] = d.data().condition; });
        setBuildingConditions(condData);
        
        const assessmentData = {};
        assessmentSnap.forEach(doc => { const key = doc.data().originalId || doc.id.replace(/__/g, "/"); assessmentData[key] = doc.data(); });
        setBuildingAssessments(assessmentData);

      } catch (error) {
        console.error("Failed to fetch data:", error);
        setPaths([]); setBuildingConditions({}); setBuildingAssessments({});
      }
    };
    fetchData();
  }, [mode, universityId, persona, markersCollection, pathsCollection, conditionsCollection, assessmentsCollection]); // IMPORTANT: 'persona' is added here

  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !config) return;
    const map = mapRef.current;
    if (!map.getSource('buildings')) {
      map.addSource('buildings', { type: 'geojson', data: config.buildings, promoteId: 'id' });
      map.addLayer({ id: 'buildings-layer', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': defaultBuildingColor, 'fill-extrusion-height': 15, 'fill-extrusion-opacity': 0.7 } });
      map.addLayer({ id: 'buildings-outline', type: 'line', source: 'buildings', paint: { 'line-color': '#007bff', 'line-width': 2.5, 'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0] } });
    }
    if (config.boundary && !map.getSource('boundary')) {
      map.addSource('boundary', { type: 'geojson', data: config.boundary });
      map.addLayer({ id: 'boundary-layer', type: 'line', source: 'boundary', paint: { 'line-color': '#a9040e', 'line-width': 3, 'line-dasharray': [2, 2] } });
    }

    // Add floorplan GeoJSON (rooms and walls) — georeferenced (admin-only)
    const isAdmin = location.pathname.includes('/hastings/admin');
    const enable = false; // disable legacy auto-load to avoid duplicates
    if (isAdmin && enable) {
      // Helper to insert before first symbol layer to ensure visibility
      function firstSymbolLayerId(m) {
        const layers = m.getStyle().layers || [];
        for (const l of layers) if (l.type === 'symbol') return l.id;
        return undefined;
      }
      const beforeId = firstSymbolLayerId(map);
      const base = import.meta.env.BASE_URL;

      (async () => {
        // Load manifest
        let manifest;
        try {
          manifest = await fetch(`${base}floorplans/manifest.json`).then((r) => r.json());
        } catch (err) {
          console.warn('Failed to load floorplans manifest:', err?.message || err);
          return;
        }

        async function loadRoomAttributes(buildingId, floorId) {
          try {
            const qRooms = query(
              collection(db, 'universities', universityId, 'rooms'),
              where('bldg', '==', buildingId),
              where('floor', '==', floorId)
            );
            const snap = await getDocs(qRooms);
            const attrs = {};
            snap.forEach((doc) => { attrs[doc.id] = doc.data(); });
            return attrs;
          } catch (err) {
            console.warn('Failed to load room attributes:', err?.message || err);
            return {};
          }
        }

        async function loadFloor(buildingId, floorId) {
          const item = manifest?.[buildingId]?.floors?.[floorId];
          if (!item) return;
          const srcId = `${buildingId}-${floorId}`;
          if (map.getSource(srcId)) return;
          const url = `${base}${item.url}`;
          map.addSource(srcId, { type: 'geojson', data: url });
          loadedFloorsRef.current.push(srcId);

          // Fit to bounds once
          try {
            const g = await fetch(url).then((r) => r.json());
            const pts = [];
            for (const f of g.features || []) {
              if (!f.geometry) continue;
              const arr = f.geometry.type && f.geometry.type.includes('Polygon')
                ? (f.geometry.coordinates || []).flat(2)
                : (f.geometry.coordinates || []).flat();
              for (let i = 0; i < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]);
            }
            if (pts.length) {
              const xs = pts.map((p) => p[0]);
              const ys = pts.map((p) => p[1]);
              const sw = [Math.min(...xs), Math.min(...ys)];
              const ne = [Math.max(...xs), Math.max(...ys)];
              map.fitBounds([sw, ne], { padding: 40 });
            }
          } catch (err) {
            console.warn('Could not fit bounds for', srcId, err?.message || err);
          }

          // Load room attributes for this floor
          const attrs = await loadRoomAttributes(buildingId, floorId);
          roomAttrsRef.current[srcId] = attrs;

          // Layers
          const roomsLayerId = `${srcId}-rooms`;
          const wallsLayerId = `${srcId}-walls`;
          if (!map.getLayer(roomsLayerId)) {
            map.addLayer({ id: roomsLayerId, type: 'fill', source: srcId, filter: ['==', ['get', 'kind'], 'room'], paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.25 } }, beforeId);
            map.on('mouseenter', roomsLayerId, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', roomsLayerId, () => { map.getCanvas().style.cursor = ''; });
            map.on('click', roomsLayerId, (e) => {
              const f = e.features && e.features[0];
              if (!f) return;
              const id = f.properties?.id || '(no id)';
              const attrsById = roomAttrsRef.current?.[srcId] || {};
              const r = attrsById[id] || {};
              const dept = r.dept ?? f.properties?.dept ?? '—';
              const type = r.type ?? f.properties?.type ?? '—';
              const area = r.area ?? '—';
              const html = `<div><strong>Room</strong> ${id}</div><div>Dept: ${dept}</div><div>Type: ${type}</div><div>Area: ${area}</div>`;
              new mapboxgl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
            });
          }
          if (!map.getLayer(wallsLayerId)) {
            map.addLayer({ id: wallsLayerId, type: 'line', source: srcId, filter: ['==', ['get', 'kind'], 'wall'], paint: { 'line-color': '#333', 'line-width': 1.5 } }, beforeId);
          }
        }

        // Initial example load
        await loadFloor('GrayCenter', 'FL1');
      })();
      
      // end admin block
    }
    // Cleanup: only remove what we added
    return () => {
      const m = mapRef.current;
      if (!m) return;
      // Remove dynamic floor layers/sources
      const toRemove = [...(loadedFloorsRef.current || [])];
      toRemove.forEach((srcId) => {
        const roomsId = `${srcId}-rooms`;
        const wallsId = `${srcId}-walls`;
        if (m.getLayer(roomsId)) m.removeLayer(roomsId);
        if (m.getLayer(wallsId)) m.removeLayer(wallsId);
        if (m.getSource(srcId)) m.removeSource(srcId);
      });
      // Legacy cleanup
      ['rooms-fill', 'walls', 'gray-center-room-labels', 'gray-center-walls', 'gray-center-rooms']
        .forEach((id) => { if (m.getLayer(id)) m.removeLayer(id); });
      if (m.getSource('gray-center-fl1')) m.removeSource('gray-center-fl1');
    };
  }, [mapLoaded, config]);

  // Fetch floorplan manifest (admin only)
  useEffect(() => {
    if (mode !== 'admin') return;
    const base = import.meta.env.BASE_URL;
    fetch(`${base}floorplans/manifest.json`)
      .then(r => r.json())
      .then(setFpManifest)
      .catch(() => {});
  }, [mode]);

  // Auth: sign-in / sign-out handlers (admin tools)
  async function handleAdminSignIn() {
    const authInstance = getAuth();
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(authInstance, provider);
    } catch {
      await signInWithRedirect(authInstance, provider);
    }
  }
  function handleAdminSignOut() {
    signOut(getAuth());
  }

  // Generic helpers to load/unload any floor from manifest
  async function loadFloor(buildingId, floorId) {
    const map = mapRef.current;
    if (!map || !fpManifest) return;

    // Clean up any stale legacy artifacts before adding fresh
    const srcId = `${buildingId}-${floorId}`;
    [`${srcId}-rooms`, `${srcId}-walls`, 'rooms-fill', 'walls'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(srcId)) map.removeSource(srcId);
    if (map.getSource('gray-center-fl1')) map.removeSource('gray-center-fl1');

    const item = fpManifest?.[buildingId]?.floors?.[floorId];
    if (!item) { console.warn(`${buildingId} ${floorId} not in manifest`); return; }
    if (map.getSource(srcId)) return;

    const url = `${import.meta.env.BASE_URL}${item.url}`;
    map.addSource(srcId, { type: 'geojson', data: url });

    const beforeId = (map.getStyle().layers || []).find(l => l.type === 'symbol')?.id;

    map.addLayer({
      id: `${srcId}-rooms`,
      type: 'fill',
      source: srcId,
      filter: ['==', ['get', 'kind'], 'room'],
      paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.25 }
    }, beforeId);

    map.addLayer({
      id: `${srcId}-walls`,
      type: 'line',
      source: srcId,
      filter: ['==', ['get', 'kind'], 'wall'],
      paint: { 'line-color': '#333', 'line-width': 1.5 }
    }, beforeId);

    // Optional: Fit to bounds once
    try {
      const g = await fetch(url).then(r => r.json());
      const pts = [];
      for (const ft of g.features || []) {
        const arr = ft.geometry?.type?.includes('Polygon')
          ? (ft.geometry.coordinates || []).flat(2)
          : (ft.geometry?.coordinates || []).flat();
        for (let i = 0; i < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]);
      }
      if (pts.length) {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40 });
      }
    } catch {}
  }

  function unloadFloor(buildingId, floorId) {
    const map = mapRef.current;
    if (!map) return;
    const srcId = `${buildingId}-${floorId}`;
    ['rooms','walls'].forEach(k => {
      const id = `${srcId}-${k}`;
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(srcId)) map.removeSource(srcId);
  }

  // Backward-compat buttons: call generic helpers for GrayCenter-FL1
  async function loadGrayCenterFL1() { await loadFloor('GrayCenter', 'FL1'); }
  function unloadGrayCenterFL1() { unloadFloor('GrayCenter', 'FL1'); }

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    if (mode !== 'admin' && selectedBuildingId) setSelectedBuildingId(null);
    if (previousSelectedBuildingId.current) map.setFeatureState({ source: 'buildings', id: previousSelectedBuildingId.current }, { selected: false });
    if (selectedBuildingId && mode === 'admin') map.setFeatureState({ source: 'buildings', id: selectedBuildingId }, { selected: true });
    previousSelectedBuildingId.current = selectedBuildingId;
  }, [selectedBuildingId, mapLoaded, mode]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    
    map.getCanvas().parentElement.querySelectorAll('.custom-mapbox-marker').forEach(markerEl => markerEl.remove());

    // --- UPDATED LOGIC ---
    // For admins, use our new filtered list. For public users, use the session list.
    const markersToDraw = mode === 'admin' ? filteredMarkers : sessionMarkers;
    
    markersToDraw.forEach(marker => {
      const el = document.createElement('div');
      el.className = 'custom-marker custom-mapbox-marker';
      el.style.backgroundColor = markerTypes[marker.type] || '#9E9E9E';
      new mapboxgl.Marker(el)
        .setLngLat(marker.coordinates)
        .setPopup(new mapboxgl.Popup({ offset: 25 }).setText(marker.comment || marker.type))
        .addTo(map);
    });
    
  }, [filteredMarkers, sessionMarkers, markerTypes, mapLoaded, mode]); // Use filteredMarkers in dependency array

  useEffect(() => {
  // This entire effect is for admin-only path drawing and cleanup.
  // It was causing a crash for public users, so we now prevent it from running for them.
  if (mode === 'admin') {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    
    // First, clean up any existing path layers from a previous render.
    const existingPathLayers = map.getStyle().layers.filter(layer => layer.id.startsWith('path-'));
    existingPathLayers.forEach(layer => {
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      // Add a safety check for the source, just in case
      if (layer.source && map.getSource(layer.source)) {
        map.removeSource(layer.source);
      }
    });

    // Then, if paths are visible, draw the new ones.
    if (showPaths) {
      paths.forEach(path => {
        const sourceId = `path-source-${path.id}`;
        const layerId = `path-layer-${path.id}`;
        if(map.getSource(sourceId)) return; // Avoid re-adding
        map.addSource(sourceId, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: path.coordinates } } });
        map.addLayer({ id: layerId, type: 'line', source: sourceId, paint: { 'line-color': pathTypes[path.type]?.color || '#000', 'line-width': 4 } });
      });
    }
  }
}, [paths, showPaths, pathTypes, mapLoaded, mode]); // The dependency array remains the same
  
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !mapRef.current.getSource('buildings')) return;
    const map = mapRef.current;
    const matchExpr = ['match', ['get', 'id']];
    let hasEntries = false;

    if (mode === 'admin' && mapTheme === 'progress' && Object.keys(buildingAssessments).length > 0) {
        Object.entries(buildingAssessments).forEach(([buildingId, assessment]) => {
          let completedSections = 0;
          if (assessment.scores?.architecture && Object.values(assessment.scores.architecture).some(s => s > 0)) completedSections++;
          if (assessment.scores?.engineering && Object.values(assessment.scores.engineering).some(s => s > 0)) completedSections++;
          if (assessment.scores?.functionality && Object.values(assessment.scores.functionality).some(s => s > 0)) completedSections++;
          matchExpr.push(assessment.originalId || buildingId, progressColors[completedSections]);
          hasEntries = true;
        });
    } else if (mode === 'admin' && mapTheme === 'stakeholder' && Object.keys(buildingConditions).length > 0) {
        Object.entries(buildingConditions).forEach(([id, conditionValue]) => {
          const conditionData = stakeholderConditionConfig[conditionValue];
          if (conditionData) {
            matchExpr.push(id, conditionData.color);
            hasEntries = true;
          }
        });
    }
    
    matchExpr.push(defaultBuildingColor);
    
    if(hasEntries) {
        map.setPaintProperty('buildings-layer', 'fill-extrusion-color', matchExpr);
    } else {
        map.setPaintProperty('buildings-layer', 'fill-extrusion-color', defaultBuildingColor);
    }
  }, [buildingConditions, buildingAssessments, mapLoaded, mode, mapTheme]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const handleMapClick = (e) => {
  //  ▼▼▼ THIS IS THE ONLY PART YOU NEED TO ADD ▼▼▼
  // Check if the click was on an existing marker.
  // If so, do nothing and let the marker's own popup appear.
  if (e.originalEvent.target.closest('.custom-marker')) {
    return;
  }
  //  ▲▲▲ END OF THE NEW PART ▲▲▲

  // --- The rest of the function remains exactly the same ---
  if (interactionMode === 'drawPath' && mode === 'admin') {
    setNewPathCoords(prev => [...prev, e.lngLat.toArray()]);
    return;
  }
  if (interactionMode === 'select' && mode === 'admin') {
    const features = map.queryRenderedFeatures(e.point, { layers: ['buildings-layer'] });
    if (features.length > 0) {
      setSelectedBuildingId(features[0].properties.id);
      setIsTechnicalPanelOpen(false);
      // anchor panel near where you clicked (pixel coords)
      const pt = map.project(e.lngLat);
      setPanelAnchor({ x: pt.x, y: pt.y });
      return;
    }
  }
  setSelectedBuildingId(null);
  setPanelAnchor(null);
  showMarkerPopup(e.lngLat);
};
    const handleDblClick = () => { if (interactionMode === 'drawPath' && mode === 'admin') handleFinishPath(); };
    map.on('click', handleMapClick);
    map.on('dblclick', handleDblClick);
    return () => { map.off('click', handleMapClick); map.off('dblclick', handleDblClick); };
  }, [mapLoaded, mode, interactionMode, handleFinishPath, showMarkerPopup]);

  if (!config) { return <div>Loading Map Configuration...</div>; }

  return (
    <div className="map-page-container">
      <div ref={mapContainerRef} className="map-container" />

      {mode === 'admin' && (
        <button className="controls-toggle-button" onClick={() => setIsControlsVisible(v => !v)}>
          {isControlsVisible ? 'Hide Controls' : 'Show Controls'}
        </button>
      )}

      <div className="logo-panel-right">
        <div className="logo-box">
          <div className="mapfluence-title">MAPFLUENCE</div>
          <img src={`${import.meta.env.BASE_URL}Clark_Enersen_Logo.png`} alt="Clark & Enersen Logo" />
        </div>
        <div className="logo-box">
          <img src={`${import.meta.env.BASE_URL}${config.universityName === 'Hastings College' ? 'HC_image.png' : 'RockhurstU_Logo.png'}`} alt={`${config.universityName} Logo`} />
        </div>
      </div>

      {showHelp && (
        <div className="help-panel">
          <button className="close-button" onClick={() => setShowHelp(false)}>×</button>
          <h4>How to Use This Map</h4>
          <ul>
    <li>Click on the map to add a marker.</li>
    {mode === 'admin' && (
      <>
        <li>Double-click to finish drawing a path.</li>
        <li>Click on a building to select and update its condition.</li>
        {/* This instruction will now ONLY render if the mode is 'admin' */}
        <li>Use the controls to toggle markers.</li>
      </>
    )}
  </ul>
          <button className="close-button-main" onClick={() => setShowHelp(false)}>Close</button>
        </div>
      )}

      {mode === 'admin' && (
        <>
          {selectedBuildingId && !isTechnicalPanelOpen && panelAnchor && (
            <div
              className="floating-panel"
              style={{
                position: 'absolute',
                zIndex: 10,
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
                onOpenTechnical={handleOpenTechnical}
                onClose={() => {
                  setSelectedBuildingId(null);
                  setIsTechnicalPanelOpen(false);
                  setPanelAnchor(null);
                }}
                canWrite={isAdminUser}
              />
            </div>
          )}

          {selectedBuildingId && isTechnicalPanelOpen && (
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

      {isControlsVisible && (
        <div className="map-controls-panel">
          {mode === 'admin' && (
            <div className="control-section" style={{background:'#fff', padding:8, border:'1px solid #ddd', borderRadius:6}}>
              <h5>Admin access</h5>
              {!authUser ? (
                <button onClick={handleAdminSignIn}>Sign in with Google</button>
              ) : (
                <div style={{display:'flex', gap:8, alignItems:'center'}}>
                  <span style={{fontSize:12}}>
                    {authUser.email} {isAdminUser ? '(admin)' : '(no admin role)'}
                  </span>
                  <button onClick={handleAdminSignOut}>Sign out</button>
                </div>
              )}
            </div>
          )}
          {mode === 'admin' && (
            <div className="control-section theme-selector">
              <label htmlFor="theme-select">Map View:</label>
              <select id="theme-select" value={mapTheme} onChange={(e) => setMapTheme(e.target.value)}>
                <option value="stakeholder">Stakeholder Condition</option>
                <option value="progress">Assessment Progress</option>
              </select>
            </div>
          )}
          {mode === 'admin' && (
            <div className="control-section data-filters">
              <h5>Data Filters</h5>
              <div className="filter-item">
                <input
                  type="checkbox"
                  id="student-filter"
                  checked={showStudentMarkers}
                  onChange={() => setShowStudentMarkers(v => !v)}
                />
                <label htmlFor="student-filter">Show Student Markers</label>
              </div>
              <div className="filter-item">
                <input
                  type="checkbox"
                  id="staff-filter"
                  checked={showStaffMarkers}
                  onChange={() => setShowStaffMarkers(v => !v)}
                />
                <label htmlFor="staff-filter">Show Staff Markers</label>
              </div>
            </div>
          )}
          
          <div className="mode-selector">
            <button className={interactionMode === 'select' ? 'active' : ''} onClick={() => setInteractionMode('select')}>
              Select/Marker
            </button>
            {mode === 'admin' && (
              <button className={interactionMode === 'drawPath' ? 'active' : ''} onClick={() => setInteractionMode('drawPath')}>
                Draw Path
              </button>
            )}
          </div>
          <div className="button-row">
  {/* This button will now ONLY render if the mode is 'admin' */}
  {mode === 'admin' && (
    <button onClick={() => setShowMarkers(s => !s)}>
      {showMarkers ? `Hide Markers (${filteredMarkers.length})` : `Show Markers (${filteredMarkers.length})`}
    </button>
  )}
  {mode === 'admin' && (
    <button onClick={() => setShowPaths(s => !s)}>
      {showPaths ? `Hide Paths (${paths.length})` : `Show Paths (${paths.length})`}
    </button>
  )}
</div>
          {mode === 'admin' && (
            <div className="control-section admin-controls">
              <div className="button-row">
                <button onClick={exportData}>Export Map Data</button>
                {config.enableDrawingEntry && (
                  <button onClick={exportDrawingEntries}>Export Drawing Entries</button>
                )}
              </div>
              <div className="button-row">
                <button onClick={clearMarkers}>Clear Markers</button>
                <button onClick={clearPaths}>Clear Paths</button>
              </div>
              <div className="button-row">
                <button onClick={clearConditions}>Clear Conditions</button>
              </div>
            </div>
          )}
          {mode === 'admin' && (
            <div className="control-section floorplans-controls">
              <h5>Floorplans</h5>
              <div className="button-row">
                <select
                  value={selectedBuilding}
                  onChange={(e) => { setSelectedBuilding(e.target.value); setSelectedFloor(''); }}
                >
                  <option value="">Select Building…</option>
                  {fpManifest && Object.keys(fpManifest).map((b) => (
                    <option key={b} value={b}>{fpManifest[b]?.display || b}</option>
                  ))}
                </select>
                <select
                  value={selectedFloor}
                  onChange={(e) => setSelectedFloor(e.target.value)}
                  disabled={!selectedBuilding}
                >
                  <option value="">Select Floor…</option>
                  {selectedBuilding && fpManifest && Object.keys(fpManifest[selectedBuilding]?.floors || {}).map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    if (!selectedBuilding || !selectedFloor) return;
                    const map = mapRef.current; if (!map) return;
                    const base = import.meta.env.BASE_URL;
                    const item = fpManifest?.[selectedBuilding]?.floors?.[selectedFloor];
                    if (!item) return;
                    const srcId = `${selectedBuilding}-${selectedFloor}`;
                    if (!map.getSource(srcId)) {
                      const url = `${base}${item.url}`;
                      map.addSource(srcId, { type: 'geojson', data: url });
                      const beforeId = (map.getStyle().layers || []).find(l => l.type === 'symbol')?.id;
                      if (!map.getLayer(`${srcId}-rooms`)) {
                        map.addLayer({ id: `${srcId}-rooms`, type: 'fill', source: srcId, filter: ['==', ['get', 'kind'], 'room'], paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.25 } }, beforeId);
                        map.on('mouseenter', `${srcId}-rooms`, () => { map.getCanvas().style.cursor = 'pointer'; });
                        map.on('mouseleave', `${srcId}-rooms`, () => { map.getCanvas().style.cursor = ''; });
                        map.on('click', `${srcId}-rooms`, (e) => {
                          const f = e.features && e.features[0];
                          if (!f) return;
                          const id = f.properties?.id || '(no id)';
                          const attrsById = (roomAttrsRef.current && roomAttrsRef.current[srcId]) || {};
                          const r = attrsById[id] || {};
                          const dept = r.dept ?? f.properties?.dept ?? '—';
                          const type = r.type ?? f.properties?.type ?? '—';
                          const area = r.area ?? '—';
                          const html = `<div><strong>Room</strong> ${id}</div><div>Dept: ${dept}</div><div>Type: ${type}</div><div>Area: ${area}</div>`;
                          new mapboxgl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
                        });
                      }
                      if (!map.getLayer(`${srcId}-walls`)) {
                        map.addLayer({ id: `${srcId}-walls`, type: 'line', source: srcId, filter: ['==', ['get', 'kind'], 'wall'], paint: { 'line-color': '#333', 'line-width': 1.5 } }, beforeId);
                      }
                      setLoadedFloors((prev) => Array.from(new Set([...prev, srcId])));
                      // load attributes for this floor
                      try {
                        const qRooms = query(collection(db, 'universities', universityId, 'rooms'), where('bldg', '==', selectedBuilding), where('floor', '==', selectedFloor));
                        const snap = await getDocs(qRooms);
                        const attrs = {}; snap.forEach(d => { attrs[d.id] = d.data(); });
                        roomAttrsRef.current = { ...(roomAttrsRef.current||{}), [srcId]: attrs };
                      } catch {}
                    }
                  }}
                >Load</button>
                <button
                  onClick={() => {
                    if (!selectedBuilding || !selectedFloor) return;
                    const map = mapRef.current; if (!map) return;
                    const srcId = `${selectedBuilding}-${selectedFloor}`;
                    if (map.getLayer(`${srcId}-rooms`)) map.removeLayer(`${srcId}-rooms`);
                    if (map.getLayer(`${srcId}-walls`)) map.removeLayer(`${srcId}-walls`);
                    if (map.getSource(srcId)) map.removeSource(srcId);
                    setLoadedFloors((prev) => prev.filter(id => id !== srcId));
                  }}
                >Unload</button>
                <button
                  onClick={async () => {
                    if (!selectedBuilding || !selectedFloor) return;
                    const map = mapRef.current; if (!map) return;
                    const base = import.meta.env.BASE_URL;
                    const item = fpManifest?.[selectedBuilding]?.floors?.[selectedFloor];
                    if (!item) return;
                    try {
                      const g = await fetch(`${base}${item.url}`).then(r=>r.json());
                      const pts = [];
                      for (const f of g.features || []) {
                        if (!f.geometry) continue;
                        const arr = f.geometry.type && f.geometry.type.includes('Polygon') ? (f.geometry.coordinates || []).flat(2) : (f.geometry.coordinates || []).flat();
                        for (let i=0;i<arr.length;i+=2) pts.push([arr[i], arr[i+1]]);
                      }
                      if (pts.length) {
                        const xs = pts.map(p=>p[0]); const ys = pts.map(p=>p[1]);
                        map.fitBounds([[Math.min(...xs), Math.min(...ys)],[Math.max(...xs), Math.max(...ys)]], { padding: 40 });
                      }
                    } catch {}
                  }}
                >Center</button>
              </div>
              {loadedFloors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div><strong>Loaded floors</strong></div>
                  {loadedFloors.map((id) => (
                    <div key={id} className="button-row">
                      <span>{id}</span>
                      <button onClick={() => {
                        const map = mapRef.current; if (!map) return;
                        if (map.getLayer(`${id}-rooms`)) map.removeLayer(`${id}-rooms`);
                        if (map.getLayer(`${id}-walls`)) map.removeLayer(`${id}-walls`);
                        if (map.getSource(id)) map.removeSource(id);
                        setLoadedFloors(prev => prev.filter(x => x !== id));
                      }}>Remove</button>
                      <button onClick={async () => {
                        const [b,f] = id.split('-');
                        const base = import.meta.env.BASE_URL;
                        const item = fpManifest?.[b]?.floors?.[f]; if (!item) return;
                        try {
                          const g = await fetch(`${base}${item.url}`).then(r=>r.json());
                          const pts = [];
                          for (const f of g.features || []) {
                            if (!f.geometry) continue;
                            const arr = f.geometry.type && f.geometry.type.includes('Polygon') ? (f.geometry.coordinates || []).flat(2) : (f.geometry.coordinates || []).flat();
                            for (let i=0;i<arr.length;i+=2) pts.push([arr[i], arr[i+1]]);
                          }
                          if (pts.length) {
                            const xs = pts.map(p=>p[0]); const ys = pts.map(p=>p[1]);
                            mapRef.current.fitBounds([[Math.min(...xs), Math.min(...ys)],[Math.max(...xs), Math.max(...ys)]], { padding: 40 });
                          }
                        } catch {}
                      }}>Center</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          

          <div className="legend">
            <h4>Legend</h4>
            <div className="legend-section">
              <h5>Marker Types</h5>
              {Object.entries(markerTypes).map(([type, color]) => (
                <div key={type} className="legend-item"><span className="legend-color-box" style={{backgroundColor: color}}></span>{type}</div>
              ))}
            </div>
            {mode === 'admin' && (
              <>
                <div className="legend-section">
                  <h5>Path Types</h5>
                  {Object.entries(pathTypes).map(([type, {color}]) => (
                    <div key={type} className="legend-item"><span className="legend-color-box" style={{backgroundColor: color, border: `2px solid ${color}`}}></span>{type}</div>
                  ))}
                </div>
                {mapTheme === 'stakeholder' ? (
                  <div className="legend-section">
                    <h5>Building Conditions</h5>
                    {Object.entries(stakeholderConditionConfig).map(([value, { label, color }]) => (
                      <div key={value} className="legend-item"><span className="legend-color-box" style={{backgroundColor: color}}></span>{label}</div>
                    ))}
                  </div>
                ) : (
                  <div className="legend-section">
                    <h5>Assessment Progress</h5>
                    {Object.entries(progressColors).filter(([key])=>key > 0).map(([key, color]) => (
                      <div key={key} className="legend-item"><span className="legend-color-box" style={{backgroundColor: color}}></span>{key}/3 Complete</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default StakeholderMap;
