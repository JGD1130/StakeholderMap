import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { db } from '../firebaseConfig';
import { collection, getDocs, addDoc, serverTimestamp, GeoPoint, writeBatch, doc, setDoc, query, where } from 'firebase/firestore';
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
  const [sessionMarkers, setSessionMarkers] = useState([]); // <-- ADD THIS LINE
  const [showStudentMarkers, setShowStudentMarkers] = useState(true);
  const [showStaffMarkers, setShowStaffMarkers] = useState(true);

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
    const id = updatedAssessment.originalId;
    if (!id) { console.error("Cannot save assessment: missing originalId."); return; }
    const docRef = doc(assessmentsCollection, id.replace(/\//g, '__'));
    await setDoc(docRef, updatedAssessment, { merge: true });
    setBuildingAssessments(prev => ({ ...prev, [id]: updatedAssessment }));
  }, [assessmentsCollection]);

  const handleConditionSave = async (buildingId, newCondition) => {
    const docRef = doc(conditionsCollection, buildingId.replace(/\//g, '__'));
    await setDoc(docRef, { condition: newCondition, originalId: buildingId }, { merge: true });
    setBuildingConditions(prev => ({ ...prev, [buildingId]: newCondition }));
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
    if (mapRef.current || !mapContainerRef.current || !config) return;
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    const map = new mapboxgl.Map({ container: mapContainerRef.current, style: config.style, center: [config.lng, config.lat], zoom: config.zoom, pitch: config.pitch, bearing: config.bearing });
    mapRef.current = map;
    console.log('STAKEHOLDERMAP: admin map created');
    // TEMP: expose map to the browser console for debugging
    if (typeof window !== 'undefined') window.__MAP__ = map;
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
      // keep exposed after style reloads
      if (typeof window !== 'undefined') window.__MAP__ = map;
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
    // TEMP: expose map to the console
    if (typeof window !== 'undefined' && map) window.__MAP__ = map;
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
    const enable = import.meta.env.VITE_ENABLE_FLOORPLANS_ADMIN === 'true';
    if (isAdmin && enable) {
      // Helper to insert before first symbol layer to ensure visibility
      function firstSymbolLayerId(m) {
        const layers = m.getStyle().layers || [];
        for (const l of layers) if (l.type === 'symbol') return l.id;
        return undefined;
      }
      const beforeId = firstSymbolLayerId(map);

      if (!map.getSource('gray-center-fl1')) {
        // Use Vite base since app is served under a subpath
        const url = `${import.meta.env.BASE_URL}Gray_Center_FL_1.simpl.geojson`;
        map.addSource('gray-center-fl1', { type: 'geojson', data: url });

        // Confirm source load
        map.on('sourcedata', (e) => {
          if (e.sourceId === 'gray-center-fl1' && e.isSourceLoaded) {
            console.log('✅ gray-center-fl1 loaded');
          }
        });

        // Immediately after adding the source, do a one-time fit to bounds
        fetch(url)
          .then(r => r.json())
          .then(g => {
            const pts = [];
            for (const f of g.features || []) {
              if (!f.geometry) continue;
              const arr = f.geometry.type && f.geometry.type.includes('Polygon')
                ? (f.geometry.coordinates || []).flat(2)
                : (f.geometry.coordinates || []).flat();
              for (let i = 0; i < arr.length; i += 2) pts.push([arr[i], arr[i + 1]]);
            }
            if (pts.length) {
              const xs = pts.map(p => p[0]);
              const ys = pts.map(p => p[1]);
              const sw = [Math.min(...xs), Math.min(...ys)];
              const ne = [Math.max(...xs), Math.max(...ys)];
              map.fitBounds([sw, ne], { padding: 40 });
            }
          })
          .catch(err => console.warn('Could not fit bounds for gray-center-fl1:', err?.message || err));

        // Rooms (fill)
        if (!map.getLayer('rooms-fill')) {
          map.addLayer({
            id: 'rooms-fill',
            type: 'fill',
            source: 'gray-center-fl1',
            filter: ['==', ['get', 'kind'], 'room'],
            paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.25 },
          }, beforeId);
        }

        // Walls (line)
        if (!map.getLayer('walls')) {
          map.addLayer({
            id: 'walls',
            type: 'line',
            source: 'gray-center-fl1',
            filter: ['==', ['get', 'kind'], 'wall'],
            paint: { 'line-color': '#333', 'line-width': 1.5 },
          }, beforeId);
        }
      }
    }
    // Cleanup: only remove what we added
    return () => {
      const m = mapRef.current;
      if (!m) return;
      ['rooms-fill', 'walls', 'gray-center-room-labels', 'gray-center-walls', 'gray-center-rooms']
        .forEach((id) => { if (m.getLayer(id)) m.removeLayer(id); });
      if (m.getSource('gray-center-fl1')) m.removeSource('gray-center-fl1');
    };
  }, [mapLoaded, config]);

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
      return;
    }
  }
  setSelectedBuildingId(null);
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
          {selectedBuildingId && !isTechnicalPanelOpen && (
            <BuildingInteractionPanel
              buildingId={selectedBuildingId}
              buildingName={config?.buildings?.features?.find(f => f.properties.id === selectedBuildingId)?.properties?.name}
              currentCondition={buildingConditions[selectedBuildingId]}
              onSave={handleConditionSave}
              onOpenTechnical={handleOpenTechnical}
              onClose={() => {
                setSelectedBuildingId(null);
                setIsTechnicalPanelOpen(false);
              }}
            />
          )}
          {selectedBuildingId && isTechnicalPanelOpen && (
            <AssessmentPanel
              buildingId={selectedBuildingId}
              assessments={buildingAssessments}
              onClose={() => setIsTechnicalPanelOpen(false)}
              onSave={handleAssessmentSave}
            />
          )}
        </>
      )}

      {isControlsVisible && (
        <div className="map-controls-panel">
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

