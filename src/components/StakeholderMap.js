import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { db } from '../firebaseConfig';
import { collection, getDocs, addDoc, serverTimestamp, GeoPoint, writeBatch } from 'firebase/firestore';
import './StakeholderMap.css';
import AssessmentPanel from './AssessmentPanel';
import BuildingInteractionPanel from './BuildingInteractionPanel';

// --- Constants ---
const stakeholderConditionConfig = {
  '5': { label: '5 = Excellent condition', color: '#4CAF50' },
  '4': { label: '4 = Good condition',      color: '#8BC34A' },
  '3': { label: '3 = Adequate condition',  color: '#FFEB3B' },
  '2': { label: '2 = Poor condition',      color: '#FF9800' },
  '1': { label: '1 = Very poor condition', color: '#F44336' }
};
const progressColors = { 0: '#85474b', 1: '#aed6f1', 2: '#5dade2', 3: '#2e86c1' };
const defaultBuildingColor = '#85474b';

const StakeholderMap = ({ config, mode = 'public' }) => {
  // --- Refs ---
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const previousSelectedBuildingId = useRef(null);

  // --- State ---
  const [mapLoaded, setMapLoaded] = useState(false);
  const [interactionMode, setInteractionMode] = useState('select');
  const [showMarkers, setShowMarkers] = useState(true);
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

  // --- Memoized Data ---
  const markerTypes = useMemo(() => ({ 'This is my favorite spot': '#006400', 'I meet friends here': '#008000', 'I study here': '#9ACD32', 'I feel safe here': '#20B2AA', 'This place is too busy': '#FFFF00', 'This place needs improvement': '#FF9800', 'I don\'t feel safe here': '#F44336', 'Just leave a comment': '#9E9E9E' }), []);
  const pathTypes = useMemo(() => ({ 'Preferred Route': { color: '#008000' }, 'Avoided Route': { color: '#F44336' } }), []);
  const [currentPathDrawType] = useState(() => Object.keys(pathTypes)[0]);

  // ====================================================================
  // CALLBACKS
  // ====================================================================
  const showMarkerPopup = useCallback((lngLat) => {
    if (!mapRef.current) return;
    const popupNode = document.createElement('div');
    popupNode.className = 'marker-prompt-popup';
    popupNode.innerHTML = `<h4>Add a Marker</h4><select id="marker-type">${Object.keys(markerTypes).map(type => `<option value="${type}">${type}</option>`).join('')}</select><textarea id="marker-comment" placeholder="Optional comment..."></textarea><div class="button-group"><button id="confirm-marker">Add</button><button id="cancel-marker">Cancel</button></div>`;
    const popup = new mapboxgl.Popup({ closeOnClick: false, maxWidth: '280px' }).setDOMContent(popupNode).setLngLat(lngLat).addTo(mapRef.current);
    popupNode.querySelector('#confirm-marker').addEventListener('click', async () => {
      const type = popupNode.querySelector('#marker-type').value;
      const comment = popupNode.querySelector('#marker-comment').value.trim();
      const markerData = { coordinates: new GeoPoint(lngLat.lat, lngLat.lng), type, comment, createdAt: serverTimestamp() };
      const docRef = await addDoc(collection(db, 'markers'), markerData);
      setMarkers(prev => [...prev, { ...markerData, id: docRef.id, coordinates: [lngLat.lng, lngLat.lat] }]);
      popup.remove();
    });
    popupNode.querySelector('#cancel-marker').addEventListener('click', () => popup.remove());
  }, [markerTypes]);

  const handleFinishPath = useCallback(async () => {
    if (newPathCoords.length < 2) { setNewPathCoords([]); return; }
    const pathData = { coordinates: newPathCoords.map(c => new GeoPoint(c[1], c[0])), type: currentPathDrawType, createdAt: serverTimestamp() };
    const docRef = await addDoc(collection(db, 'paths'), pathData);
    setPaths(prev => [...prev, { ...pathData, id: docRef.id, coordinates: newPathCoords }]);
    setNewPathCoords([]);
  }, [newPathCoords, currentPathDrawType]);

  const handleAssessmentSave = useCallback((updatedAssessment) => {
    const id = updatedAssessment.originalId;
    if (!id) { console.error("Cannot save assessment: missing originalId."); return; }
    setBuildingAssessments(prev => ({ ...prev, [id]: updatedAssessment }));
  }, []);

  const handleConditionSave = (buildingId, newCondition) => {
    setBuildingConditions(prev => ({ ...prev, [buildingId]: newCondition }));
  };

  const handleOpenTechnical = () => {
    setIsTechnicalPanelOpen(true);
  };

  const clearMarkers = useCallback(async () => {
    if (!window.confirm(`Delete ${markers.length} markers?`)) return;
    setMarkers([]);
    const batch = writeBatch(db);
    const snapshot = await getDocs(collection(db, "markers"));
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }, [markers]);

  const clearPaths = useCallback(async () => {
    if (!window.confirm(`Delete ${paths.length} paths?`)) return;
    const map = mapRef.current;
    if(map) {
      paths.forEach(path => {
        if (map.getLayer(`path-${path.id}`)) map.removeLayer(`path-${path.id}`);
        if (map.getSource(`path-${path.id}`)) map.removeSource(`path-${path.id}`);
      });
    }
    setPaths([]);
    const batch = writeBatch(db);
    const snapshot = await getDocs(collection(db, "paths"));
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }, [paths]);

  const clearConditions = useCallback(async () => {
    if (!window.confirm(`Delete ${Object.keys(buildingConditions).length} conditions?`)) return;
    setBuildingConditions({});
    const batch = writeBatch(db);
    const snapshot = await getDocs(collection(db, "buildingConditions"));
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }, [buildingConditions]);

  const exportData = useCallback(() => {
    if (markers.length === 0 && paths.length === 0 && Object.keys(buildingConditions).length === 0 && Object.keys(buildingAssessments).length === 0) {
      return alert("No data to export.");
    }
    const escapeCsvField = (field) => `"${String(field || '').replace(/"/g, '""')}"`;
    const rows = [];
    rows.push(['DataType', 'BuildingID', 'Category', 'SubCategory', 'Score', 'Notes'].join(','));
    Object.entries(buildingAssessments).forEach(([buildingId, assessment]) => {
      const notes = assessment.notes || '';
      if (assessment.scores) {
        Object.entries(assessment.scores).forEach(([category, subScores]) => {
          Object.entries(subScores).forEach(([subCategory, score]) => {
            rows.push([ escapeCsvField('TechnicalAssessment'), escapeCsvField(assessment.buildingName || buildingId), escapeCsvField(category), escapeCsvField(subCategory), escapeCsvField(score), escapeCsvField(notes) ].join(','));
          });
        });
      }
    });
    rows.push([]);
    rows.push(['DataType', 'ID', 'Type', 'Latitude', 'Longitude', 'Comment', 'PathCoordinatesJSON'].join(','));
    markers.forEach(m => { rows.push([ escapeCsvField('Marker'), escapeCsvField(m.id), escapeCsvField(m.type), escapeCsvField(m.coordinates[1]), escapeCsvField(m.coordinates[0]), escapeCsvField(m.comment), '' ].join(',')); });
    paths.forEach(p => { rows.push([ escapeCsvField('Path'), escapeCsvField(p.id), escapeCsvField(p.type), '', '', '', escapeCsvField(JSON.stringify(p.coordinates)) ].join(',')); });
    Object.entries(buildingConditions).forEach(([id, condition]) => {
      if (condition) { rows.push([ escapeCsvField('StakeholderCondition'), escapeCsvField(id), escapeCsvField(condition), '', '', '', '' ].join(',')); }
    });
    const csvContent = rows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `map-data-export-${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [markers, paths, buildingConditions, buildingAssessments]);

  // ====================================================================
  // EFFECTS
  // ====================================================================
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current || !config) return;
    mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN;
    const map = new mapboxgl.Map({ container: mapContainerRef.current, style: config.style, center: [config.lng, config.lat], zoom: config.zoom, pitch: config.pitch, bearing: config.bearing });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl());
    map.on('load', () => setMapLoaded(true));
    return () => map.remove();
  }, [config]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const markerSnap = await getDocs(collection(db, "markers"));
        setMarkers(markerSnap.docs.map(d => ({ id: d.id, ...d.data(), coordinates: [d.data().coordinates.longitude, d.data().coordinates.latitude] })));
        if (mode !== 'admin') {
          setPaths([]);
          setBuildingConditions({});
          setBuildingAssessments({});
          return;
        }
        const [pathSnap, condSnap, assessmentSnap] = await Promise.all([getDocs(collection(db, "paths")), getDocs(collection(db, "buildingConditions")), getDocs(collection(db, "buildingAssessments"))]);
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
  }, [mode]);

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
    if (showMarkers) {
      markers.forEach(marker => {
        const el = document.createElement('div');
        el.className = 'custom-marker custom-mapbox-marker';
        el.style.backgroundColor = markerTypes[marker.type] || '#9E9E9E';
        new mapboxgl.Marker(el).setLngLat(marker.coordinates).setPopup(new mapboxgl.Popup({ offset: 25 }).setText(marker.comment || marker.type)).addTo(map);
      });
    }
  }, [markers, showMarkers, markerTypes, mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const existingPathLayers = map.getStyle().layers.filter(layer => layer.id.startsWith('path-'));
    existingPathLayers.forEach(layer => {
      map.removeLayer(layer.id);
      if (map.getSource(layer.id)) { map.removeSource(layer.id); }
    });
    if (mode === 'admin' && showPaths) {
      paths.forEach(path => {
        const sourceId = `path-${path.id}`;
        map.addSource(sourceId, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: path.coordinates } } });
        map.addLayer({ id: sourceId, type: 'line', source: sourceId, paint: { 'line-color': pathTypes[path.type]?.color || '#000', 'line-width': 4 } });
      });
    }
  }, [paths, showPaths, pathTypes, mapLoaded, mode]);
  
  // THIS IS THE CORRECTED COLORING EFFECT
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !mapRef.current.getLayer('buildings-layer')) return;
    const map = mapRef.current;
    const matchExpr = ['match', ['get', 'id']];

    if (mode === 'admin' && mapTheme === 'progress') {
      if (Object.keys(buildingAssessments).length > 0) {
        Object.entries(buildingAssessments).forEach(([buildingId, assessment]) => {
          let completedSections = 0;
          if (assessment.scores?.architecture && Object.values(assessment.scores.architecture).some(s => s > 0)) completedSections++;
          if (assessment.scores?.engineering && Object.values(assessment.scores.engineering).some(s => s > 0)) completedSections++;
          if (assessment.scores?.functionality && Object.values(assessment.scores.functionality).some(s => s > 0)) completedSections++;
          const key = assessment.originalId || buildingId;
          matchExpr.push(key, progressColors[completedSections]);
        });
      }
    } else if (mode === 'admin' && mapTheme === 'stakeholder') {
      if (Object.keys(buildingConditions).length > 0) {
        Object.entries(buildingConditions).forEach(([id, conditionValue]) => {
          const conditionData = stakeholderConditionConfig[conditionValue];
          if (conditionData) {
            matchExpr.push(id, conditionData.color);
          }
        });
      }
    }

    matchExpr.push(defaultBuildingColor);
    if (matchExpr.length >= 4) {
      map.setPaintProperty('buildings-layer', 'fill-extrusion-color', matchExpr);
    }
  }, [buildingConditions, buildingAssessments, mapLoaded, mode, mapTheme]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const handleMapClick = (e) => {
      if (interactionMode === 'drawPath' && mode === 'admin') {
        setNewPathCoords(prev => [...prev, e.lngLat.toArray()]);
        return;
      }
      if (interactionMode === 'select' && mode === 'admin') {
        const features = map.queryRenderedFeatures(e.point, { layers: ['buildings-layer'] });
        if (features.length > 0) {
          setSelectedBuildingId(features[0].properties.id);
          setIsTechnicalPanelOpen(false); // Reset to show interaction panel first
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

  // ====================================================================
  // RENDER LOGIC
  // ====================================================================
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
          <img src={config.logos.clarkEnersen} alt="Clark & Enersen Logo" />
        </div>
        <div className="logo-box">
          <img src={config.logos.hastings} alt="Hastings College Logo" />
        </div>
      </div>

      {showHelp && (
        <div className="help-panel">
          <button className="close-button" onClick={() => setShowHelp(false)}>×</button>
          <h4>How to Use This Map</h4>
          <ul>
            <li>Click on the map to add a marker.</li>
            {mode === 'admin' && ( <><li>Double-click to finish drawing a path.</li><li>Click on a building to select and update its condition.</li></> )}
            <li>Use the controls to toggle markers.</li>
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
          <div className="control-section">
            <div className="button-row">
              <button onClick={() => setShowMarkers(s => !s)}>{showMarkers ? `Hide Markers (${markers.length})` : `Show Markers (${markers.length})`}</button>
              {mode === 'admin' && ( <button onClick={() => setShowPaths(s => !s)}>{showPaths ? `Hide Paths (${paths.length})` : `Show Paths (${paths.length})`}</button> )}
            </div>
          </div>
          {mode === 'admin' && (
            <div className="control-section admin-controls">
              <div className="button-row">
                <button onClick={exportData}>Export Data</button>
                <button onClick={clearMarkers}>Clear Markers</button>
              </div>
              <div className="button-row">
                <button onClick={clearPaths}>Clear Paths</button>
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