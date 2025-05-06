import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import { saveAs } from 'file-saver';
import 'mapbox-gl/dist/mapbox-gl.css';
import './StakeholderMap.css'; // Make sure this CSS file exists and is needed

// Token
mapboxgl.accessToken = 'pk.eyJ1IjoiamFjazExMzAiLCJhIjoiY205Y3kwbHJuMHBjczJrb2R6Mm44NmFkYSJ9.ZR3q-IyOfNZEjB3MKqWQTw';
// console.log("Mapbox token check:", mapboxgl.accessToken ? "OK" : "MISSING!"); // Optional: Keep for debugging

// Logo Path for Mapfluence logo
const logoPath = '/input_file_0.png'; // Ensure this path is correct relative to your public folder

// Hastings College Logo Path - Default path
const hcLogoPath = '/data/HC_image.png'; // Assuming this is in public/data/

// Main Component
function InteractiveMap({ config, mode = "public" }) { // Receive config prop, default mode
  // --- State & Refs ---
  const [markers, setMarkers] = useState([]);
  const [showMarkers, setShowMarkers] = useState(true);
  const [viewAngle, setViewAngle] = useState(30);
  const [showInstructions, setShowInstructions] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null); // Holds the Mapbox map instance
  const mapboxMarkersRef = useRef(new Map()); // Stores mapbox marker instances { reactMarkerId: mapboxMarkerInstance }

  // --- State for Pathways ---
  const [drawingMode, setDrawingMode] = useState('marker'); // 'marker' or 'path'
  const [currentPathCoordinates, setCurrentPathCoordinates] = useState([]); // Store coords for path being drawn
  const [paths, setPaths] = useState([]); // Store finalized paths [{ id: ..., coordinates: [...], type: ...}, ...]
  const [showPaths, setShowPaths] = useState(true); // State to control path visibility

  // Determine admin view based on prop
  const isAdminView = mode === 'admin';

  // --- Memoized ---
  // Marker colors configuration
  const markerColors = useMemo(() => ({
    'This is my favorite spot': '#006400',
    'I meet friends here': '#008000',
    'I study here': '#9ACD32',
    'I feel safe here': '#20B2AA',
    'This place is too busy': '#FFFF00',
    'This place needs improvement': '#FF9800',
    'I don\'t feel safe here': '#F44336',
    'Just leave a comment': '#9E9E9E'
  }), []);

  // --- Callbacks ---

  // Add a new marker to the React state
  const addMarkerToState = useCallback((coordinates, comment, type) => {
    const newMarker = { coordinates, comment, type, id: `marker-${Date.now()}-${Math.random()}` };
    setMarkers(prev => [...prev, newMarker]);
    // console.log("Added marker to state:", newMarker.id); // Optional log
  }, []);

  // Create DOM element for a map marker
  const createMarkerElement = useCallback((markerData) => {
    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.style.width = '18px'; el.style.height = '18px'; el.style.borderRadius = '50%';
    el.style.border = '2px solid white'; el.style.boxShadow = '0 0 4px rgba(0,0,0,0.4)';
    el.style.cursor = 'pointer'; el.style.boxSizing = 'border-box';
    el.style.backgroundColor = markerColors[markerData.type] || markerColors['Just leave a comment'];
    return el;
  }, [markerColors]);

  // Create HTML content for a marker's popup
  const createPopupHTML = useCallback((type, comment) => {
    const color = markerColors[type] || markerColors['Just leave a comment'];
    const safeComment = comment ? comment.replace(/</g, "<").replace(/>/g, ">") : '';
    return `<div style="max-width: 180px; padding: 6px 8px; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.3;"><strong style="color: ${color}; display: block; margin-bottom: 3px; text-transform: uppercase; font-size: 10px; font-weight: bold;">${type}</strong>${safeComment ? `<p style="margin: 0; word-wrap: break-word;">${safeComment}</p>` : ''}</div>`;
  }, [markerColors]);

  // Show the popup form to add a new marker
  const showMarkerPopup = useCallback((lngLat) => {
    const map = mapRef.current; if (!map) return;
    document.querySelectorAll('.mapboxgl-popup').forEach(p => { if (p.getElement().querySelector('#confirm-marker')) { p.remove(); } });
    const popupNode = document.createElement('div');
    popupNode.style.cssText = `width: 250px; padding: 6px; font-family: Arial, sans-serif; background-color: white; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); box-sizing: border-box;`;
    const optionsHTML = Object.keys(markerColors).map(type => `<option value="${type}">${type}</option>`).join('');
    popupNode.innerHTML = `
      <h3 style="margin: 0 0 5px 0; font-size: 13px; color: #333; font-weight: bold;">How do you use or feel about this place?</h3> <div style="margin-bottom: 5px;"> <select id="marker-type" title="Category" style="width: 100%; padding: 4px 5px; font-size: 11px; border: 1px solid #ccc; border-radius: 3px; box-sizing: border-box; -webkit-appearance: none; appearance: none; background: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23666%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E') no-repeat right 6px center; background-size: 7px auto; background-color: white; padding-right: 20px;">${optionsHTML}</select> </div> <div id="comment-container" style="margin-bottom: 6px; display: none;"> <textarea id="marker-comment" placeholder="Your comment..." rows="2" style="width: 100%; padding: 4px 5px; font-size: 11px; border: 1px solid #ccc; border-radius: 3px; resize: none; box-sizing: border-box; overflow-y: auto;"></textarea> </div> <div style="display: flex; gap: 5px; justify-content: space-between;"> <button id="confirm-marker" style="flex-grow: 1; padding: 5px 8px; background-color: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;">Add</button> <button id="cancel-marker" style="flex-grow: 1; padding: 5px 8px; background-color: #aaa; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;">Cancel</button> </div>`;
    const popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: false, offset: 15, maxWidth: '260px', focusAfterOpen: false }).setDOMContent(popupNode).setLngLat(lngLat).addTo(map);
    const confirmBtn = popupNode.querySelector('#confirm-marker'), cancelBtn = popupNode.querySelector('#cancel-marker'), typeSelect = popupNode.querySelector('#marker-type'), commentText = popupNode.querySelector('#marker-comment'), commentContainer = popupNode.querySelector('#comment-container');
    typeSelect.value = Object.keys(markerColors)[0];
    const toggleCommentVisibility = () => { commentContainer.style.display = typeSelect.value === 'Just leave a comment' ? 'block' : 'none'; };
    toggleCommentVisibility(); typeSelect.addEventListener('change', toggleCommentVisibility);
    const handleSubmit = () => { const selectedType = typeSelect.value, comment = selectedType === 'Just leave a comment' ? commentText.value.trim() : ''; addMarkerToState(lngLat.toArray(), comment, selectedType); popup.remove(); };
    const handleCancel = () => { popup.remove(); };
    confirmBtn.addEventListener('click', handleSubmit); cancelBtn.addEventListener('click', handleCancel);
    popup.on('close', () => { confirmBtn.removeEventListener('click', handleSubmit); cancelBtn.removeEventListener('click', handleCancel); typeSelect.removeEventListener('change', toggleCommentVisibility); });
  }, [markerColors, addMarkerToState]);

  // Callback to finalize and save the currently drawn path
  const finalizeCurrentPath = useCallback(() => {
    if (currentPathCoordinates.length < 2) { console.log("PATH_FINALIZE: Not enough points (< 2), discarding."); setCurrentPathCoordinates([]); return; }
    const newPath = { id: `path-${Date.now()}-${Math.random()}`, coordinates: [...currentPathCoordinates], type: 'Walking Route' };
    // console.log("PATH_FINALIZE: Saving path:", newPath.id); // Optional log
    setPaths(prevPaths => [...prevPaths, newPath]);
    setCurrentPathCoordinates([]);
  }, [currentPathCoordinates]);


  // --- Effects ---

  // Effect 1: Initialize Map
  useEffect(() => {
    // console.log("MAP_INIT: Effect running"); // Optional log
    if (!mapContainerRef.current) { console.log("MAP_INIT: Skipping - No container ref"); return; }
    if (mapRef.current) { console.log("MAP_INIT: Skipping - Map already initialized"); return; }

    // console.log("MAP_INIT: Initializing Mapbox GL JS..."); // Optional log
    let mapInstance;
    try {
      const initialCenter = config?.initialCenter || [-98.371132, 40.593874]; // Your Google Maps Coord
      const initialZoom = config?.initialZoom || 15.5;
      // console.log("MAP_INIT: Using initialCenter:", initialCenter, "initialZoom:", initialZoom); // Optional log

      mapInstance = new mapboxgl.Map({
        container: mapContainerRef.current, style: 'mapbox://styles/mapbox/streets-v11',
        center: initialCenter, zoom: initialZoom, pitch: viewAngle, bearing: 0, antialias: true
      });
      mapRef.current = mapInstance;
      mapInstance.getCanvas().style.cursor = 'default';

      mapInstance.on('load', () => {
        // console.log("MAP_INIT: Map 'load' event triggered."); // Optional log
        const currentMap = mapRef.current; if (!currentMap) { console.error("MAP_INIT: Map ref null during load!"); return; }
        // --- FORCE CENTER/ZOOM ON LOAD ---
console.log("MAP_INIT: Forcing center/zoom after load.");
currentMap.jumpTo({
   center: initialCenter, // Make sure initialCenter is defined above
   zoom: initialZoom,     // Make sure initialZoom is defined above
   pitch: viewAngle      // Make sure viewAngle state is accessible
});
// Verify the center *after* forcing it
console.log("MAP_INIT: Map center after jumpTo:", currentMap.getCenter());
// --- END FORCE CENTER ---

        // *** FIX FOR INITIAL EXTENT ***
        // console.log("MAP_INIT: Forcing center/zoom after load."); // Optional log
        currentMap.jumpTo({ center: initialCenter, zoom: initialZoom, pitch: viewAngle });
        // console.log("MAP_INIT: Map center after jumpTo:", currentMap.getCenter()); // Optional log
        // *** END FIX ***

        try {
          const boundaryPath = config?.boundary, buildingsPath = config?.buildings;
          if (boundaryPath) {
            currentMap.addSource("college-boundary", { type: "geojson", data: process.env.PUBLIC_URL + boundaryPath });
            currentMap.addLayer({ id: "college-boundary-fill", type: "fill", source: "college-boundary", paint: { "fill-color": "rgba(128, 0, 0, 0.1)", "fill-outline-color": "#800000" } });
            currentMap.addLayer({ id: "college-boundary-line", type: "line", source: "college-boundary", paint: { "line-color": "#800000", "line-width": 2 } });
          }
          if (buildingsPath) {
            currentMap.addSource("college-buildings", { type: "geojson", data: process.env.PUBLIC_URL + buildingsPath });
            currentMap.addLayer({ id: "college-buildings-fill", type: "fill", source: "college-buildings", paint: { "fill-color": "rgba(128, 0, 0, 0.3)", "fill-outline-color": "#800000" }, maxzoom: 16 });
            currentMap.addLayer({ id: "college-buildings-line", type: "line", source: "college-buildings", paint: { "line-color": "#800000", "line-width": 1 }, maxzoom: 16 });
          }
          const layers = currentMap.getStyle().layers, labelLayerId = layers.find(l => l.type === 'symbol' && l.layout?.['text-field'])?.id;
          if (!currentMap.getLayer('3d-buildings')) {
            const cfg = { id: '3d-buildings', source: 'composite', 'source-layer': 'building', filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 14, layout: {'visibility': 'visible'}, paint: { 'fill-extrusion-color': '#aaa', 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'height']], 'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'min_height']], 'fill-extrusion-opacity': 0.6 } };
            if (labelLayerId) { currentMap.addLayer(cfg, labelLayerId); } else { currentMap.addLayer(cfg); }
          }
          // console.log("MAP_INIT: Layer adding complete."); // Optional log
        } catch (layerError) { console.error("MAP_INIT_ERROR: Adding sources/layers failed:", layerError); }
      });
      mapInstance.on('error', (e) => { console.error('MAP_ERROR:', e.error?.message || e); });
    } catch (initError) { console.error("MAP_INIT_ERROR: Mapbox constructor failed:", initError); }
    return () => {
      // console.log("MAP_INIT: Cleanup running..."); // Optional log
      const mapToRemove = mapRef.current;
      if (mapToRemove) {
        // console.log("MAP_INIT: Removing map instance."); // Optional log
        try { mapToRemove.remove(); } catch(e) { console.error("MAP_INIT: Error during map instance cleanup:", e); }
        mapRef.current = null;
      }
      // console.log("MAP_INIT: Cleanup finished."); // Optional log
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]); // Dependency: config


  // Effect 2: Synchronize Mapbox Markers with React State
  useEffect(() => {
    const map = mapRef.current; if (!map || !map.isStyleLoaded()) return;
    const currentMapboxMarkerIds = new Set(mapboxMarkersRef.current.keys());
    const reactMarkerIds = new Set(markers.map(m => m.id));
    markers.forEach(markerData => {
      if (!currentMapboxMarkerIds.has(markerData.id)) {
        const el = createMarkerElement(markerData);
        const popup = new mapboxgl.Popup({ offset: 25, closeButton: false }).setHTML(createPopupHTML(markerData.type, markerData.comment));
        const newMapboxMarker = new mapboxgl.Marker({ element: el }).setLngLat(markerData.coordinates).setPopup(popup).addTo(map);
        mapboxMarkersRef.current.set(markerData.id, newMapboxMarker);
      }
    });
    mapboxMarkersRef.current.forEach((markerInstance, id) => {
      if (!reactMarkerIds.has(id)) { try { markerInstance.remove(); } catch (e) { /* ignore */ } mapboxMarkersRef.current.delete(id); }
    });
    mapboxMarkersRef.current.forEach((markerInstance) => {
        const element = markerInstance.getElement();
        if (element) { element.style.display = showMarkers ? 'block' : 'none'; }
    });
  }, [markers, markerColors, showMarkers, createMarkerElement, createPopupHTML]);


  // Effect 3: Handle Admin Mode Changes (Placeholder)
  useEffect(() => { /* Optional logic based on isAdminView */ }, [isAdminView]);


  // Effect 4: Handle View Angle Changes
  useEffect(() => { const map = mapRef.current; if (map) { map.easeTo({ pitch: viewAngle, duration: 500 }); } }, [viewAngle]);


  // Effect 5: Display the path currently being drawn
  useEffect(() => {
    const map = mapRef.current; if (!map || !map.isStyleLoaded()) { return; }
    const sourceId = 'drawing-path-source'; const layerId = 'drawing-path-layer'; const verticesLayerId = layerId + '-vertices';
    let source = map.getSource(sourceId);
    const geojsonData = { type: 'FeatureCollection', features: currentPathCoordinates.length >= 1 ? [{ type: 'Feature', geometry: { type: currentPathCoordinates.length === 1 ? 'Point' : 'LineString', coordinates: currentPathCoordinates.length === 1 ? currentPathCoordinates[0] : currentPathCoordinates, } }] : [] };
    const targetVisibility = showPaths ? 'visible' : 'none'; // Respect showPaths toggle

    if (!source) {
      // console.log("DRAW_PATH: Adding drawing source and layers"); // Optional log
      map.addSource(sourceId, { type: 'geojson', data: geojsonData });
      map.addLayer({ id: layerId, type: 'line', source: sourceId, layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': targetVisibility }, paint: { 'line-color': '#ff00ff', 'line-width': 3, 'line-dasharray': [2, 2] }, filter: ['==', '$type', 'LineString'] });
      map.addLayer({ id: verticesLayerId, type: 'circle', source: sourceId, layout: { 'visibility': targetVisibility }, paint: { 'circle-radius': 4, 'circle-color': '#ff00ff' } });
    } else {
      source.setData(geojsonData);
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', targetVisibility);
      if (map.getLayer(verticesLayerId)) map.setLayoutProperty(verticesLayerId, 'visibility', targetVisibility);
    }
  }, [currentPathCoordinates, showPaths]); // Dependencies: currentPathCoordinates, showPaths


  // Effect 6: Manage Map Click Listener based on Drawing Mode
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const clickHandler = (e) => {
      if (drawingMode === 'marker') { showMarkerPopup(e.lngLat); }
      else if (drawingMode === 'path') { setCurrentPathCoordinates(prevCoords => [...prevCoords, e.lngLat.toArray()]); }
    };
    map.on('click', clickHandler);
    return () => { if (map.getStyle()) map.off('click', clickHandler); };
  }, [drawingMode, showMarkerPopup]); // Dependencies: drawingMode, showMarkerPopup


  // Effect 7: Manage Double Click Listener for Finishing Paths
  useEffect(() => {
    const map = mapRef.current; if (!map || drawingMode !== 'path') return;
    const doubleClickHandler = (e) => { e.preventDefault(); finalizeCurrentPath(); };
    map.on('dblclick', doubleClickHandler);
    return () => { if (map.getStyle()) map.off('dblclick', doubleClickHandler); };
  }, [drawingMode, finalizeCurrentPath]); // Dependencies: drawingMode, finalizeCurrentPath


  // Effect 8: Synchronize saved 'paths' state with Mapbox layers & handle visibility
  useEffect(() => {
    const map = mapRef.current; if (!map || !map.isStyleLoaded()) return;
    const sourceId = 'saved-paths-source'; const layerId = 'saved-paths-layer';
    let source = map.getSource(sourceId);
    const geojsonData = { type: 'FeatureCollection', features: paths.map(path => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: path.coordinates }, properties: { id: path.id, type: path.type || 'Default Path' } })) };
    const targetVisibility = showPaths ? 'visible' : 'none';

    if (!source) {
      // console.log("SAVED_PATHS: Adding source and layer"); // Optional log
      map.addSource(sourceId, { type: 'geojson', data: geojsonData });
      map.addLayer({ id: layerId, type: 'line', source: sourceId, layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': targetVisibility }, paint: { 'line-color': '#0000ff', 'line-width': 4, 'line-opacity': 0.8 } });
    } else {
      source.setData(geojsonData);
      // --- This is the line to check for ---
      if (map.getLayer(layerId)) { const currentVisibility = map.getLayoutProperty(layerId, 'visibility'); if (currentVisibility !== targetVisibility) map.setLayoutProperty(layerId, 'visibility', targetVisibility); }
      else {
         // Layer might have been removed if map style changed? Re-add it.
        //  console.warn("SAVED_PATHS: Layer missing, attempting to re-add."); // Optional log
         try { map.addLayer({ id: layerId, type: 'line', source: sourceId, layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': targetVisibility }, paint: { 'line-color': '#0000ff', 'line-width': 4, 'line-opacity': 0.8 } }); }
         catch (e) { console.error("SAVED_PATHS: Failed to re-add layer.", e); }
      }
    }
  }, [paths, showPaths]); // Dependencies: paths, showPaths


  // --- UI Handlers ---
  const toggleMarkers = useCallback(() => { setShowMarkers(prev => !prev); }, []);
  const updateViewAngle = useCallback((angle) => { setViewAngle(parseInt(angle, 10)); }, []);
  const exportToCSV = useCallback(() => {
    if(markers.length === 0) { alert('No marker data to export.'); return; }
    setExportLoading(true);
    try {
      const header = ['Type', 'Latitude', 'Longitude', 'Comment'];
      const escapeCSV = value => { const s = String(value ?? ""); return (s.includes(',')||s.includes('\n')||s.includes('"')) ? `"${s.replace(/"/g,'""')}"` : s; };
      const rows = markers.map(m => [ escapeCSV(m.type), m.coordinates[1], m.coordinates[0], escapeCSV(m.comment) ].join(','));
      const csvContent = [header.join(','), ...rows].join('\n');
      let blob;
      try { blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'}); }
      catch(blobError) { console.error('CSV_EXPORT: Blob Error:', blobError); alert(`Blob Error: ${blobError.message || blobError}`); setExportLoading(false); return; }
      saveAs(blob, `map-markers-${new Date().toISOString().split('T')[0]}.csv`);
    } catch(error) { console.error('CSV_EXPORT: General Error:', error); alert(`Export Error: ${error.message}`); }
    finally { setExportLoading(false); }
  }, [markers]);

  const clearMarkers = useCallback(() => { // Renamed from clearAll for clarity, only clears markers now
    if (!isAdminView) { alert("Admin privileges required."); return; }
    if (markers.length === 0) { alert("No markers to clear."); return; }
    if (window.confirm(`Delete all ${markers.length} markers? This cannot be undone.`)) {
      setMarkers([]);
      // console.log("MARKERS: Cleared markers from state."); // Optional log
    }
  }, [isAdminView, markers]);

  // TODO: Add clearPaths handler later

  // --- Render Function ---
  return (
    <div style={{ position: 'relative', height: '100vh', width: '100%', overflow: 'hidden' }}>

      {/* Map Container */}
      <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Hastings College Logo (Top Center) */}
      <div style={{ position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: 10, padding: '10px', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', boxShadow: '0 1px 5px rgba(0,0,0,0.2)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <img src={process.env.PUBLIC_URL + (config?.logo || hcLogoPath)} alt={`${config?.name || 'College'} Logo`} style={{ height: '140px', width: 'auto' }} />
      </div>

      {/* Mapfluence Logo (Top Right) */}
      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 10, display: 'flex', alignItems: 'center', padding: '10px 15px', backgroundColor: 'rgba(255, 255, 255, 0.8)', borderRadius: '6px', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>
        <img src={process.env.PUBLIC_URL + logoPath} alt="Mapfluence Logo" style={{ height: '90px', width: 'auto', marginRight: '12px' }} />
        <span style={{ fontWeight: 'bold', fontSize: '48px', color: '#ba3d04', fontFamily: 'Arial, sans-serif' }}>Mapfluence</span>
      </div>

      {/* Control Panel and Legend Container (Top Left) */}
      <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 20, display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>

        {/* Map Controls Panel */}
        <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 5px rgba(0,0,0,0.2)', width: '240px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', borderBottom: '1px solid #eee', paddingBottom: '6px', fontWeight:'bold' }}>Map Controls</h3>

          {/* Mode Switching Buttons */}
          <div style={{ display: 'flex', gap: '5px', marginBottom: '5px' }}>
            <button onClick={() => setDrawingMode('marker')} disabled={drawingMode === 'marker'} title="Click map to add point markers" style={{ padding: '5px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', flex: 1, backgroundColor: drawingMode === 'marker' ? '#c8e6c9' : '#fff', fontWeight: drawingMode === 'marker' ? 'bold' : 'normal' }}> Add Marker </button>
            <button onClick={() => setDrawingMode('path')} disabled={drawingMode === 'path'} title="Click map points to draw a path, double-click to finish" style={{ padding: '5px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', flex: 1, backgroundColor: drawingMode === 'path' ? '#c8e6c9' : '#fff', fontWeight: drawingMode === 'path' ? 'bold' : 'normal' }}> Draw Path </button>
          </div>

          {/* Toggle Markers Button */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <button onClick={toggleMarkers} style={{ padding: '6px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', backgroundColor: showMarkers ? '#e7f4e8' : '#fdecea', color: showMarkers ? '#2e7d32' : '#c62828' }}> {showMarkers ? 'Hide' : 'Show'} Markers ({markers.length}) </button>
          </div>

          {/* Toggle Paths Button */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <button onClick={() => setShowPaths(prev => !prev)} style={{ padding: '6px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', backgroundColor: showPaths ? '#e7f4e8' : '#fdecea', color: showPaths ? '#2e7d32' : '#c62828' }} > {showPaths ? 'Hide' : 'Show'} Paths ({paths.length}) </button>
          </div>


          {/* View Angle Slider */}
          <div>
            <label htmlFor="viewAngleSlider" style={{ display: 'block', marginBottom: '3px', fontSize: '12px', color: '#555' }}>View Angle: {viewAngle}°</label>
            <input id="viewAngleSlider" type="range" min="0" max="60" value={viewAngle} onChange={(e) => updateViewAngle(e.target.value)} style={{ width: '100%', cursor: 'pointer', height: '6px' }} />
          </div>

          {/* Export and Clear Buttons */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={exportToCSV} disabled={exportLoading || markers.length === 0} style={{ padding: '8px', fontSize: '13px', cursor: (exportLoading || markers.length === 0) ? 'not-allowed' : 'pointer', backgroundColor: (exportLoading || markers.length === 0) ? '#f5f5f5' : '#2196F3', color: (exportLoading || markers.length === 0) ? '#aaa' : 'white', border: 'none', borderRadius: '4px', flex: '1' }}> {exportLoading ? 'Exporting...' : 'Export Data'} </button>
            {/* Note: Clear button currently only clears markers */}
            {isAdminView && ( <button onClick={clearMarkers} disabled={markers.length === 0 /* && paths.length === 0 */} title={"Clear all markers"} style={{ padding: '8px', fontSize: '13px', cursor: (markers.length === 0 /* && paths.length === 0 */) ? 'not-allowed' : 'pointer', backgroundColor: (markers.length === 0 /* && paths.length === 0 */) ? '#f5f5f5' : '#F44336', color: (markers.length === 0 /* && paths.length === 0 */) ? '#aaa' : 'white', border: 'none', borderRadius: '4px', flex: '1' }}> Clear Markers </button> )}
             {/* TODO: Add Clear Paths button? */}
          </div>

          {/* Instructions */}
          {showInstructions && (
            <div style={{ padding: '12px', border: '1px solid #eee', borderRadius: '4px', width: '100%', marginTop: '10px', boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}> <h3 style={{ margin: '0', fontSize: '15px', fontWeight: 'bold' }}>How to Use</h3> <button onClick={() => setShowInstructions(false)} title="Hide Instructions" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: '1', padding: '0 4px', color: '#666' }}>×</button> </div>
              <ol style={{ margin: '0', paddingLeft: '18px', fontSize: '12px', color: '#333', listStylePosition: 'outside' }}>
                 <li style={{ marginBottom: '6px' }}>Select 'Add Marker' or 'Draw Path' mode.</li>
                 <li style={{ marginBottom: '6px' }}>Click on the map to place points.</li>
                 <li style={{ marginBottom: '6px' }}>Follow prompts for marker details.</li>
                 <li style={{ marginBottom: '6px' }}>Path drawing: Click points, then **double-click** to finish.</li>
                 <li>Use controls to hide/show markers/paths, change view angle, etc.</li>
              </ol>
            </div>
          )}
        </div> {/* End Map Controls Panel */}

        {/* Legend Box */}
        <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 5px rgba(0,0,0,0.2)', width: '240px', maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', borderBottom: '1px solid #eee', paddingBottom: '6px', fontWeight: 'bold' }}>Legend</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
             {/* Legend Item Mapping */}
             {Object.entries(markerColors).map(([type, color]) => (
               <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                 <div style={{ width: '14px', height: '14px', borderRadius: '50%', backgroundColor: color, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }} />
                 <span style={{ fontSize: '12px', color: '#333', flexGrow: 1 }}>{type}</span>
               </div>
             ))}
             {/* TODO: Add legend items for path types later */}
          </div>
        </div> {/* End Legend Box */}

      </div> {/* End Control Panel and Legend Container */}

    </div> // End Main container div
  ); // End return statement
} // End InteractiveMap function component

// Define defaultProps OUTSIDE the component function
InteractiveMap.defaultProps = {
  config: {
    initialCenter: [-98.371132, 40.593874], // Default center
    initialZoom: 15.5,
    logo: hcLogoPath,
    name: 'Hastings College',
    boundary: '/data/Hastings_College_Boundary.geojson',
    buildings: '/data/Hastings_College_Buildings.geojson'
  },
  mode: 'public'
};

// Export the component
export default InteractiveMap;



















  





















