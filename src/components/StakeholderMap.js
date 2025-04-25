import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import { saveAs } from 'file-saver';
import 'mapbox-gl/dist/mapbox-gl.css';
import './StakeholderMap.css'; // Make sure this CSS file exists and is needed

// Token
mapboxgl.accessToken = 'pk.eyJ1IjoiamFjazExMzAiLCJhIjoiY205Y3kwbHJuMHBjczJrb2R6Mm44NmFkYSJ9.ZR3q-IyOfNZEjB3MKqWQTw';
console.log("Mapbox token check:", mapboxgl.accessToken ? "OK" : "MISSING!");

// Logo Path for Mapfluence logo
const logoPath = '/input_file_0.png'; // Ensure this path is correct relative to your public folder

// Hastings College Logo Path - Make sure this path is correct relative to your public folder
const hcLogoPath = '/data/HC_image.png'; // Assuming this is in public/data/

function InteractiveMap() {
  // --- State & Refs ---
  const [markers, setMarkers] = useState([]);
  const [showMarkers, setShowMarkers] = useState(true);
  const [viewAngle, setViewAngle] = useState(30);
  const [isAdmin, setIsAdmin] = useState(true);
  const [showInstructions, setShowInstructions] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null); // Holds the Mapbox map instance
  const mapboxMarkersRef = useRef(new Map()); // Stores mapbox marker instances { reactMarkerId: mapboxMarkerInstance }

  // --- Memoized ---
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

  // Function to just update React state
  const addMarkerToState = useCallback((coordinates, comment, type) => {
    const newMarker = { coordinates, comment, type, id: Date.now() + Math.random() };
    setMarkers(prev => [...prev, newMarker]);
    // The marker management useEffect will handle adding it to the map
  }, []); // No dependencies needed, only uses setMarkers

  // Create marker DOM element - Basic structure
  const createMarkerElement = useCallback((markerData) => {
    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.style.width = '18px';
    el.style.height = '18px';
    el.style.borderRadius = '50%';
    el.style.border = '2px solid white';
    el.style.boxShadow = '0 0 4px rgba(0,0,0,0.4)';
    el.style.cursor = 'pointer';
    el.style.boxSizing = 'border-box';
    el.style.backgroundColor = markerColors[markerData.type] || markerColors['Just leave a comment'];
    // Visibility handled separately
    return el;
  }, [markerColors]); // Depends on markerColors

  // Create marker popup HTML - Used for markers already added
  const createPopupHTML = useCallback((type, comment) => {
    const color = markerColors[type] || markerColors['Just leave a comment'];
    const safeComment = comment ? comment.replace(/</g, "<").replace(/>/g, ">") : '';
    return `<div style="max-width: 180px; padding: 6px 8px; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.3;"><strong style="color: ${color}; display: block; margin-bottom: 3px; text-transform: uppercase; font-size: 10px; font-weight: bold;">${type}</strong>${safeComment ? `<p style="margin: 0; word-wrap: break-word;">${safeComment}</p>` : ''}</div>`;
  }, [markerColors]); // Depends on markerColors

  // Show the popup form to add a new marker
  const showMarkerPopup = useCallback((lngLat) => {
    const map = mapRef.current;
    if (!map) return;

    document.querySelectorAll('.mapboxgl-popup').forEach(p => {
      if (p.getElement().querySelector('#confirm-marker')) { p.remove(); }
    });

    const popupNode = document.createElement('div');
    popupNode.style.cssText = `width: 250px; padding: 6px; font-family: Arial, sans-serif; background-color: white; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); box-sizing: border-box;`;

    const optionsHTML = Object.keys(markerColors).map(type => `<option value="${type}">${type}</option>`).join('');

    popupNode.innerHTML = `
      <h3 style="margin: 0 0 5px 0; font-size: 13px; color: #333; font-weight: bold;">How do you use or feel about this place?</h3>
      <div style="margin-bottom: 5px;">
        <select id="marker-type" title="Category" style="width: 100%; padding: 4px 5px; font-size: 11px; border: 1px solid #ccc; border-radius: 3px; box-sizing: border-box; -webkit-appearance: none; appearance: none; background: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23666%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E') no-repeat right 6px center; background-size: 7px auto; background-color: white; padding-right: 20px;">
          ${optionsHTML}
        </select>
      </div>
      <div id="comment-container" style="margin-bottom: 6px; display: none;">
        <textarea id="marker-comment" placeholder="Your comment..." rows="2" style="width: 100%; padding: 4px 5px; font-size: 11px; border: 1px solid #ccc; border-radius: 3px; resize: none; box-sizing: border-box; overflow-y: auto;"></textarea>
      </div>
      <div style="display: flex; gap: 5px; justify-content: space-between;">
        <button id="confirm-marker" style="flex-grow: 1; padding: 5px 8px; background-color: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;">Add</button>
        <button id="cancel-marker" style="flex-grow: 1; padding: 5px 8px; background-color: #aaa; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;">Cancel</button>
      </div>`;

    const popup = new mapboxgl.Popup({
        closeButton: true, closeOnClick: false, offset: 15, maxWidth: '260px', focusAfterOpen: false
      })
      .setDOMContent(popupNode)
      .setLngLat(lngLat)
      .addTo(map);

    const confirmBtn = popupNode.querySelector('#confirm-marker');
    const cancelBtn = popupNode.querySelector('#cancel-marker');
    const typeSelect = popupNode.querySelector('#marker-type');
    const commentText = popupNode.querySelector('#marker-comment');
    const commentContainer = popupNode.querySelector('#comment-container');

    typeSelect.value = Object.keys(markerColors)[0];

    const toggleCommentVisibility = () => {
      commentContainer.style.display = typeSelect.value === 'Just leave a comment' ? 'block' : 'none';
    };

    toggleCommentVisibility();
    typeSelect.addEventListener('change', toggleCommentVisibility);

    const handleSubmit = () => {
      const selectedType = typeSelect.value;
      const comment = selectedType === 'Just leave a comment' ? commentText.value.trim() : '';
      // Only update React state here. Effect will handle map addition.
      addMarkerToState(lngLat.toArray(), comment, selectedType);
      popup.remove();
    };

    const handleCancel = () => { popup.remove(); };

    confirmBtn.addEventListener('click', handleSubmit);
    cancelBtn.addEventListener('click', handleCancel);

    popup.on('close', () => {
      confirmBtn.removeEventListener('click', handleSubmit);
      cancelBtn.removeEventListener('click', handleCancel);
      typeSelect.removeEventListener('change', toggleCommentVisibility);
    });
  }, [markerColors, addMarkerToState]); // Depends on markerColors and the state update function

   // Define handleMapClick using useCallback
   const handleMapClick = useCallback((e) => {
    showMarkerPopup(e.lngLat);
  }, [showMarkerPopup]); // Depends on showMarkerPopup callback

  // --- Effects ---

  // Effect 1: Initialize Map (Runs ONCE on mount)
  useEffect(() => {
    console.log("MAP_INIT: Effect running");
    if (!mapContainerRef.current || mapRef.current) {
        console.log("MAP_INIT: Skipping - container ref missing or map already initialized.");
        return; // Prevent re-initialization
    }

    console.log("MAP_INIT: Initializing Mapbox GL JS");
    let mapInstance;
    try {
      mapInstance = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v11',
        // User's updated center
        center: [-98.371421, 40.592469], // Use user's coordinates [Lon, Lat]
        zoom: 15.5, // User's zoom
        pitch: viewAngle, // Use initial state for pitch
        bearing: 0,
        antialias: true
      });

      mapRef.current = mapInstance; // Store instance

      mapInstance.getCanvas().style.cursor = 'default';

      mapInstance.on('load', () => {
        console.log("MAP_INIT: Map 'load' event. Adding sources and layers...");
        const currentMap = mapRef.current; // Use ref inside load handler
        if (!currentMap) return;

        try {
          // Add Hastings College Boundary
          currentMap.addSource("hastings-boundary", { type: "geojson", data: process.env.PUBLIC_URL + "/data/Hastings_College_Boundary.geojson" });
          currentMap.addLayer({ id: "hastings-boundary-fill", type: "fill", source: "hastings-boundary", paint: { "fill-color": "rgba(128, 0, 0, 0.1)", "fill-outline-color": "#800000" } });
          currentMap.addLayer({ id: "hastings-boundary-line", type: "line", source: "hastings-boundary", paint: { "line-color": "#800000", "line-width": 2 } });

          // Add Hastings College Buildings
          currentMap.addSource("hastings-buildings", { type: "geojson", data: process.env.PUBLIC_URL + "/data/Hastings_College_Buildings.geojson" });
          currentMap.addLayer({ id: "hastings-buildings-fill", type: "fill", source: "hastings-buildings", paint: { "fill-color": "rgba(128, 0, 0, 0.3)", "fill-outline-color": "#800000" }, maxzoom: 16 });
          currentMap.addLayer({ id: "hastings-buildings-line", type: "line", source: "hastings-buildings", paint: { "line-color": "#800000", "line-width": 1 }, maxzoom: 16 });

          // Add 3D buildings layer
          const layers = currentMap.getStyle().layers;
          const labelLayerId = layers.find(l => l.type === 'symbol' && l.layout?.['text-field'])?.id;
          if (!currentMap.getLayer('3d-buildings')) {
            const cfg = { id: '3d-buildings', source: 'composite', 'source-layer': 'building', filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 14, layout: {'visibility': 'visible'}, paint: { 'fill-extrusion-color': '#aaa', 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'height']], 'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'min_height']], 'fill-extrusion-opacity': 0.6 } };
            if (labelLayerId) currentMap.addLayer(cfg, labelLayerId); else currentMap.addLayer(cfg);
          }
          console.log("MAP_INIT: Layers added successfully.");

        } catch (layerError) {
          console.error("MAP_INIT_ERROR: Adding layers:", layerError);
        }
        // Do NOT add initial markers here anymore - handled by marker sync effect
      });

      mapInstance.on('error', (e) => { console.error('MAP_ERROR:', e.error?.message || e); });

      // Attach the click listener defined outside
      mapInstance.on('click', handleMapClick);
      console.log("MAP_INIT: Click listener attached.");

    } catch (initError) {
      console.error("MAP_INIT_ERROR: Constructor:", initError);
    }

    // Cleanup function for THIS effect (runs on unmount)
    return () => {
      console.log("MAP_INIT: Cleanup running...");
      const mapToRemove = mapRef.current;
      if (mapToRemove) {
        console.log("MAP_INIT: Removing map instance and listeners.");
        try {
            mapToRemove.off('click', handleMapClick); // Remove the specific listener instance
            mapToRemove.remove();
        } catch(e) {
            console.error("MAP_INIT: Error during map cleanup:", e);
        }
        mapRef.current = null;
      }
      // Do NOT clear mapboxMarkersRef here, that's tied to the component lifecycle
      console.log("MAP_INIT: Cleanup finished.");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAngle, handleMapClick]); // Empty array means run once. Added viewAngle if initial pitch matters, handleMapClick because it's used inside.


  // Effect 2: Synchronize Mapbox Markers with React State (Runs when `markers` changes)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      // console.log("MARKER_SYNC: Skipping - Map not ready.");
      return; // Map not initialized or style not loaded yet
    }
    console.log("MARKER_SYNC: Effect running. Syncing markers...");

    const currentMapboxMarkerIds = new Set(mapboxMarkersRef.current.keys());
    const reactMarkerIds = new Set(markers.map(m => m.id));

    // 1. Add new markers (in React state but not on map)
    markers.forEach(markerData => {
      if (!currentMapboxMarkerIds.has(markerData.id)) {
        console.log("MARKER_SYNC: Adding marker", markerData.id);
        const el = createMarkerElement(markerData);
        const popup = new mapboxgl.Popup({ offset: 25, closeButton: false })
          .setHTML(createPopupHTML(markerData.type, markerData.comment));

        const newMapboxMarker = new mapboxgl.Marker({ element: el })
          .setLngLat(markerData.coordinates)
          .setPopup(popup)
          .addTo(map);

        mapboxMarkersRef.current.set(markerData.id, newMapboxMarker); // Add to our tracking Map
      }
    });

    // 2. Remove old markers (on map but not in React state)
    mapboxMarkersRef.current.forEach((markerInstance, id) => {
      if (!reactMarkerIds.has(id)) {
        console.log("MARKER_SYNC: Removing marker", id);
        try {
          markerInstance.remove();
        } catch (e) { console.warn("MARKER_SYNC: Error removing marker", id, e); }
        mapboxMarkersRef.current.delete(id); // Remove from our tracking Map
      }
    });

    // 3. Update visibility (after adding/removing)
    mapboxMarkersRef.current.forEach(markerInstance => {
        const element = markerInstance.getElement();
        if (element) {
            element.style.display = showMarkers ? 'block' : 'none';
        }
    });
    console.log("MARKER_SYNC: Sync complete. Current map markers:", mapboxMarkersRef.current.size);

  }, [markers, markerColors, showMarkers, createMarkerElement, createPopupHTML]); // Dependencies for marker sync


  // Effect 3: Handle Admin Mode Changes (Example)
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    // No admin-specific layers currently defined to toggle
  }, [isAdmin]);


  // Effect 4: Handle View Angle Changes (separate from init)
  useEffect(() => {
    const map = mapRef.current;
    if (map) {
        map.easeTo({ pitch: viewAngle, duration: 500 });
    }
  }, [viewAngle]); // Only depends on viewAngle


  // --- UI Handlers ---
  const toggleMarkers = useCallback(() => { setShowMarkers(prev => !prev); }, []);

  const updateViewAngle = useCallback((angle) => {
    setViewAngle(parseInt(angle, 10)); // Just update state, effect will handle map change
  }, []);

  const exportToCSV = useCallback(() => {
    if(markers.length === 0) { alert('No markers to export.'); return; }
    setExportLoading(true);
    console.log('CSV_EXPORT: Starting export for', markers.length, 'markers');
    try {
      const header = ['Type', 'Latitude', 'Longitude', 'Comment'];
      const escapeCSV = value => {
        const stringValue = String(value ?? "");
        if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      };
      const rows = markers.map(m => [ escapeCSV(m.type), m.coordinates[1], m.coordinates[0], escapeCSV(m.comment) ].join(','));
      const csvContent = [header.join(','), ...rows].join('\n');
      let blob;
      try { blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'}); }
      catch(blobError) { console.error('CSV_EXPORT: Blob Creation Error:', blobError); alert(`Error creating file blob: ${blobError.message || blobError}`); setExportLoading(false); return; }
      saveAs(blob, `map-markers-${new Date().toISOString().split('T')[0]}.csv`);
    } catch(error) { console.error('CSV_EXPORT: General Error:', error); alert(`An error occurred during export: ${error.message}`); }
    finally { setExportLoading(false); }
  }, [markers]);

  const clearMarkers = useCallback(() => {
    if(!isAdmin) { alert("This action requires admin privileges."); return; }
    if(markers.length === 0) { alert("There are no markers to clear."); return; }
    if(window.confirm(`Are you sure you want to delete all ${markers.length} markers? This cannot be undone.`)) {
      // Only need to clear React state. The sync effect will remove them from map.
      setMarkers([]);
      console.log("MARKERS: Cleared all markers from state.");
      // Note: Mapbox markers are cleared by the sync effect reacting to empty markers state.
    }
  }, [isAdmin, markers]);

  const toggleAdminMode = useCallback(() => { setIsAdmin(prev => !prev); }, []);

// --- Render ---
return (
  // Main container div - Sets the positioning context
  <div style={{ position: 'relative', height: '100vh', width: '100%', overflow: 'hidden' }}>

    {/* 1. Map Container (Background) */}
    <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

    {/* 2. Hastings College Logo (Top Center) */}
    <div style={{
      position: 'absolute',
      top: '10px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 10, // Base z-index for overlays

      // Appearance styles
      padding: '10px',
      backgroundColor: 'rgba(255, 255, 255, 0.9)',
      borderRadius: '6px',
      boxShadow: '0 1px 5px rgba(0,0,0,0.2)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center'
    }}>
      <img
        src={process.env.PUBLIC_URL + hcLogoPath}
        alt="Hastings College Logo"
        style={{
          height: '120px', // Adjust height as needed
          width: 'auto'
        }}
      />
    </div>

    {/* 3. Mapfluence Logo (Top Right) */}
    <div style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: 10, // Same level as HC logo, unlikely to overlap

      // Appearance styles
      display: 'flex', alignItems: 'center', padding: '10px 15px',
      backgroundColor: 'rgba(255, 255, 255, 0.8)', borderRadius: '6px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.2)'
    }}>
      <img src={process.env.PUBLIC_URL + logoPath} alt="Mapfluence Logo" style={{ height: '90px', width: 'auto', marginRight: '12px' }} />
      <span style={{ fontWeight: 'bold', fontSize: '48px', color: '#ba3d04', fontFamily: 'Arial, Helvetica, sans-serif' }}>Mapfluence</span>
    </div>

    {/* 4. Control Panel and Legend Container (Top Left) - THIS MUST BE PRESENT */}
    <div style={{
      position: 'absolute',
      top: '10px',
      left: '10px',
      zIndex: 20, // <--- INCREASED zIndex to ensure it's above other overlays
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      alignItems: 'flex-start'
    }}>
      {/* Map Controls Panel */}
      <div style={{
        backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '12px', borderRadius: '6px',
        boxShadow: '0 1px 5px rgba(0,0,0,0.2)', width: '240px', display: 'flex',
        flexDirection: 'column', gap: '10px'
      }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', borderBottom: '1px solid #eee', paddingBottom: '6px', fontWeight:'bold' }}>Map Controls</h3>
        {/* Toggle Markers Button */}
        <div style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}>
          <button onClick={toggleMarkers} style={{ padding: '6px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', backgroundColor: showMarkers ? '#e7f4e8' : '#fdecea', color: showMarkers ? '#2e7d32' : '#c62828' }}>
            {showMarkers ? 'Hide' : 'Show'} Markers ({markers.length})
          </button>
        </div>
        {/* View Angle Slider */}
        <div>
          <label htmlFor="viewAngleSlider" style={{ display: 'block', marginBottom: '3px', fontSize: '12px', color: '#555' }}>View Angle: {viewAngle}°</label>
          <input id="viewAngleSlider" type="range" min="0" max="60" value={viewAngle} onChange={(e) => updateViewAngle(e.target.value)} style={{ width: '100%', cursor: 'pointer', height: '6px' }} />
        </div>
        {/* Export and Clear Buttons */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={exportToCSV} disabled={exportLoading || markers.length === 0} style={{ padding: '8px', fontSize: '13px', cursor: (exportLoading || markers.length === 0) ? 'not-allowed' : 'pointer', backgroundColor: (exportLoading || markers.length === 0) ? '#f5f5f5' : '#2196F3', color: (exportLoading || markers.length === 0) ? '#aaa' : 'white', border: 'none', borderRadius: '4px', flex: '1' }}>
            {exportLoading ? 'Exporting...' : 'Export Data'}
          </button>
          <button onClick={clearMarkers} disabled={!isAdmin || markers.length === 0} title={!isAdmin ? "Admin privileges required" : (markers.length === 0 ? "No markers to clear" : "Clear all markers")} style={{ padding: '8px', fontSize: '13px', cursor: (!isAdmin || markers.length === 0) ? 'not-allowed' : 'pointer', backgroundColor: (!isAdmin || markers.length === 0) ? '#f5f5f5' : '#F44336', color: (!isAdmin || markers.length === 0) ? '#aaa' : 'white', border: 'none', borderRadius: '4px', flex: '1' }}>
            Clear All
          </button>
        </div>
        {/* Admin mode toggle */}
        <button onClick={toggleAdminMode} title="Toggle Admin Mode (controls data clearing)" style={{ padding: '8px', fontSize: '13px', cursor: 'pointer', backgroundColor: isAdmin ? '#673AB7' : '#9E9E9E', color: 'white', border: 'none', borderRadius: '4px' }}>
          {isAdmin ? 'Admin Mode: ON' : 'Admin Mode: OFF'}
        </button>
        {/* Instructions */}
        {showInstructions && (
          <div style={{ padding: '12px', border: '1px solid #eee', borderRadius: '4px', width: '100%', marginTop: '10px', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <h3 style={{ margin: '0', fontSize: '15px', fontWeight: 'bold' }}>How to Use</h3>
              <button onClick={() => setShowInstructions(false)} title="Hide Instructions" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: '1', padding: '0 4px', color: '#666' }}>×</button>
            </div>
            <ol style={{ margin: '0', paddingLeft: '18px', fontSize: '12px', color: '#333', listStylePosition: 'outside' }}>
               {/* List items */}
               <li style={{ marginBottom: '6px' }}>Click anywhere on the map to add a point.</li>
               <li style={{ marginBottom: '6px' }}>Select the type of interaction you have with that location from the dropdown.</li>
               <li style={{ marginBottom: '6px' }}>For the "Just leave a comment" option, type your comment in the text area that appears.</li>
               <li style={{ marginBottom: '6px' }}>Click "Add" to place your marker on the map.</li>
               <li>Use the controls panel to hide/show markers, change the view angle, or manage data (if admin).</li>
            </ol>
          </div>
        )}
      </div> {/* End Map Controls Panel */}

      {/* Legend Box */}
      <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 5px rgba(0,0,0,0.2)', width: '240px', maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', borderBottom: '1px solid #eee', paddingBottom: '6px', fontWeight: 'bold' }}>Legend</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Object.entries(markerColors).map(([type, color]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '14px', height: '14px', borderRadius: '50%', backgroundColor: color, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }} />
              <span style={{ fontSize: '12px', color: '#333', flexGrow: 1 }}>{type}</span>
            </div>
          ))}
        </div>
      </div> {/* End Legend Box */}

    </div> {/* End Control Panel and Legend Container */}

  </div> // End Main container div
);
}

export default InteractiveMap;

















  






















