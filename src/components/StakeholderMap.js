import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc } from "firebase/firestore";
import { saveAs } from 'file-saver';
import 'mapbox-gl/dist/mapbox-gl.css';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID,
  measurementId: process.env.REACT_APP_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

if (!process.env.REACT_APP_MAPBOX_ACCESS_TOKEN) {
  console.error("Mapbox access token is missing!");
} else {
  mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN;
}

const CATEGORIES = {
  Favorite: { label: "Favorite Place", color: "green" },
  Improvement: { label: "Needs Improvement", color: "orange" },
  Concern: { label: "Concern", color: "red" },
  Idea: { label: "Idea", color: "gray" }, // Changed to gray
};

function StakeholderMap() {
  const mapContainerRef = useRef(null);
  const markerRefs = useRef([]);
  const [map, setMap] = useState(null);
  const [markersData, setMarkersData] = useState([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [pitch, setPitch] = useState(30);
  const [exportLoading, setExportLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [bearing, setBearing] = useState(0); // North-facing

  // Reset all markers
  const resetMarkers = useCallback(async () => {
    if (!isAdmin || !window.confirm("Are you sure you want to delete ALL markers?")) return;
    
    try {
      const querySnapshot = await getDocs(collection(db, "markers"));
      const deletePromises = querySnapshot.docs.map(docRef => 
        deleteDoc(doc(db, "markers", docRef.id))
      );
      await Promise.all(deletePromises);
      setMarkersData([]);
      markerRefs.current.forEach(m => m.remove());
      markerRefs.current = [];
      updateHeatmapData([]);
      alert("All markers have been deleted");
    } catch (error) {
      console.error("Error deleting markers:", error);
      alert("Failed to delete markers");
    }
  }, [isAdmin]);

  // Initialize map with north orientation
  useEffect(() => {
    if (!mapContainerRef.current || !mapboxgl.accessToken) return;

    const mapInstance = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-96.7005, 40.8136],
      zoom: 14.5,
      pitch: pitch,
      bearing: bearing, // North-facing
      antialias: true
    });

    // Set cursor to pointer
    mapInstance.getCanvas().style.cursor = 'pointer';

    mapInstance.on("load", () => {
      setMapLoaded(true);
      
      try {
        // Footprints layer with zoom-based visibility
        mapInstance.addSource("footprints", {
          type: "geojson",
          data: "/data/footprints.geojson",
        });

        mapInstance.addLayer({
          id: "footprints-layer",
          type: "fill",
          source: "footprints",
          layout: {
            visibility: showBuildings ? 'visible' : 'none'
          },
          paint: {
            "fill-color": "#ff6600",
            "fill-opacity": ["interpolate", ["linear"], ["zoom"],
              14, 0.5,
              16, 0.3,
              17, 0
            ],
          },
        });

        // Heatmap source with persistent visibility
        mapInstance.addSource("heatmap-data", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        mapInstance.addLayer({
          id: "heatmap-layer",
          type: "heatmap",
          source: "heatmap-data",
          paint: {
            "heatmap-weight": [
              "case",
              ["==", ["get", "category"], "Concern"], 1.2,
              ["==", ["get", "category"], "Improvement"], 1.1,
              1
            ],
            "heatmap-intensity": 0.8,
            "heatmap-opacity": showMarkers ? 0.8 : 0, // Changed from visibility to opacity
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(0,0,255,0)",
              0.2, "rgba(0,0,255,1)",
              0.4, "rgba(0,255,0,1)",
              0.6, "rgba(255,255,0,1)",
              1, "rgba(255,0,0,1)",
            ],
          },
        });

        // 3D buildings with visibility control
        const layers = mapInstance.getStyle().layers;
        const labelLayerId = layers.find(
          (l) => l.type === "symbol" && l.layout["text-field"]
        )?.id;

        if (labelLayerId) {
          mapInstance.addLayer({
            id: "3d-buildings",
            source: "composite",
            "source-layer": "building",
            filter: ["==", "extrude", "true"],
            type: "fill-extrusion",
            minzoom: 15,
            layout: {
              visibility: showBuildings ? 'visible' : 'none'
            },
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": ["get", "height"],
              "fill-extrusion-base": ["get", "min_height"],
              "fill-extrusion-opacity": 0.6,
            },
          }, labelLayerId);
        }

        // Zoom-based footprint visibility
        mapInstance.on('zoom', () => {
          if (!mapInstance.getLayer('footprints-layer')) return;
          
          const zoomLevel = mapInstance.getZoom();
          const visibility = zoomLevel > 16 ? 'none' : showBuildings ? 'visible' : 'none';
          mapInstance.setLayoutProperty('footprints-layer', 'visibility', visibility);
        });

      } catch (error) {
        console.error("Error initializing map layers:", error);
      }
    });

    mapInstance.on("error", (e) => {
      console.error("Map error:", e.error);
    });

    setMap(mapInstance);

    return () => {
      markerRefs.current.forEach(m => m.remove());
      if (mapInstance) mapInstance.remove();
    };
  }, [pitch, showBuildings, showMarkers, bearing]);

  // Fetch markers
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const fetchMarkers = async () => {
      try {
        const querySnapshot = await getDocs(collection(db, "markers"));
        const fetchedMarkers = querySnapshot.docs.map((doc) => doc.data());
        setMarkersData(fetchedMarkers);
      } catch (error) {
        console.error("Error fetching markers:", error);
      }
    };

    fetchMarkers();
  }, [map, mapLoaded]);

  // Update markers and heatmap
  useEffect(() => {
    if (!map || !mapLoaded) return;

    updateHeatmapData(markersData);
    
    markerRefs.current.forEach(m => m.remove());
    markerRefs.current = [];
    
    markersData.forEach(marker => {
      try {
        const el = document.createElement("div");
        el.style.width = "20px";
        el.style.height = "20px";
        el.style.backgroundColor = CATEGORIES[marker.category]?.color || "black";
        el.style.borderRadius = "50%";
        el.style.display = showMarkers ? 'block' : 'none';
        
        const m = new mapboxgl.Marker(el)
          .setLngLat([marker.lng, marker.lat])
          .addTo(map);
          
        markerRefs.current.push(m);
      } catch (error) {
        console.error("Error creating marker:", error);
      }
    });
  }, [markersData, updateHeatmapData, map, mapLoaded, showMarkers]);

  // Update heatmap data
  const updateHeatmapData = useCallback((data) => {
    if (!map || !mapLoaded) return;
    
    try {
      const features = data.map((point) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.lng, point.lat],
        },
        properties: {
          category: point.category
        }
      }));
      
      if (map.getSource("heatmap-data")) {
        map.getSource("heatmap-data").setData({
          type: "FeatureCollection",
          features,
        });
        // Update opacity instead of visibility
        map.setPaintProperty('heatmap-layer', 'heatmap-opacity', showMarkers ? 0.8 : 0);
      }
    } catch (error) {
      console.error("Error updating heatmap data:", error);
    }
  }, [map, mapLoaded, showMarkers]);

  // Handle map clicks
  const handleMapClick = useCallback((e) => {
    if (!map || !mapLoaded) return;

    const coords = e.lngLat;
    const popupNode = document.createElement("div");
    popupNode.className = "feedback-popup";
    popupNode.innerHTML = `
      <div style="width: 240px; max-height: 180px; overflow-y: auto;">
        <label><strong>Category:</strong></label><br/>
        <select id="cat" style="width: 100%;">
          ${Object.entries(CATEGORIES)
            .map(([key, val]) => `<option value="${key}">${val.label}</option>`)
            .join("")}
        </select><br/><br/>
        <label><strong>Comment (optional):</strong></label><br/>
        <textarea id="comment" rows="3" style="width: 100%; resize: vertical;"></textarea><br/>
        <button id="submit" style="margin-top: 6px;">Submit</button>
        <button id="cancel" style="margin-top: 6px; margin-left: 8px;">Cancel</button>
      </div>
    `;

    const popup = new mapboxgl.Popup({ anchor: "top", offset: 25, closeOnClick: true })
      .setLngLat(coords)
      .setDOMContent(popupNode)
      .addTo(map);

    const handleSubmit = async () => {
      const category = popupNode.querySelector("#cat").value;
      const comment = popupNode.querySelector("#comment").value;

      try {
        const newMarker = {
          lng: coords.lng,
          lat: coords.lat,
          comment: comment || "(No comment provided)",
          category,
          timestamp: new Date().toISOString(),
        };

        await addDoc(collection(db, "markers"), newMarker);
        setMarkersData((prev) => [...prev, newMarker]);
      } catch (error) {
        console.error("Error adding marker:", error);
      } finally {
        popup.remove();
      }
    };

    popupNode.querySelector("#submit").addEventListener("click", handleSubmit);
    popupNode.querySelector("#cancel").addEventListener("click", () => popup.remove());

    return () => {
      popupNode.querySelector("#submit")?.removeEventListener("click", handleSubmit);
      popupNode.querySelector("#cancel")?.removeEventListener("click", () => popup.remove());
    };
  }, [map, mapLoaded]);

  // Set up click handler
  useEffect(() => {
    if (!map || !mapLoaded) return;

    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
  }, [map, mapLoaded, handleMapClick]);

  // Export to CSV
  const exportToCSV = useCallback(() => {
    if (markersData.length === 0) {
      alert("No data to export");
      return;
    }

    setExportLoading(true);
    try {
      const headers = Object.keys(markersData[0]).join(',');
      const rows = markersData.map(marker => 
        Object.values(marker).map(value => 
          typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value
        ).join(',')
      ).join('\n');

      const csv = `${headers}\n${rows}`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      saveAs(blob, `map_data_${new Date().toISOString().slice(0,10)}.csv`);
    } catch (error) {
      console.error("Export failed:", error);
      alert("Export failed. See console for details.");
    } finally {
      setExportLoading(false);
    }
  }, [markersData]);

  // Toggle markers visibility
  const toggleMarkers = useCallback(() => {
    setShowMarkers(prev => !prev);
  }, []);

  // Toggle buildings visibility
  const toggleBuildings = useCallback(() => {
    setShowBuildings(prev => !prev);
  }, []);

  // Update map pitch
  const updatePitch = useCallback((newPitch) => {
    setPitch(newPitch);
    if (map) {
      map.easeTo({ 
        pitch: newPitch,
        duration: 1000,
        essential: true
      });
    }
  }, [map]);

  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden", position: "relative" }}>
      {/* Enhanced control panel */}
      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          backgroundColor: "white",
          padding: "15px",
          borderRadius: "8px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
          zIndex: 1,
          width: "250px",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}
      >
        <div style={{ fontSize: "16px", fontWeight: "bold", marginBottom: "8px" }}>
          Map Controls
        </div>
        
        <button 
          onClick={toggleMarkers}
          style={{
            padding: "8px",
            backgroundColor: showMarkers ? "#4CAF50" : "#f44336",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          {showMarkers ? '✓ Showing Markers' : '× Hiding Markers'}
        </button>
        
        <button 
          onClick={toggleBuildings}
          style={{
            padding: "8px",
            backgroundColor: showBuildings ? "#4CAF50" : "#f44336",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          {showBuildings ? '✓ Showing Buildings' : '× Hiding Buildings'}
        </button>
        
        <button 
          onClick={exportToCSV}
          disabled={exportLoading}
          style={{
            padding: "8px",
            backgroundColor: exportLoading ? "#cccccc" : "#2196F3",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: exportLoading ? "wait" : "pointer"
          }}
        >
          {exportLoading ? 'Exporting...' : 'Export Data to CSV'}
        </button>
        
        <div style={{ marginTop: "8px" }}>
          <div style={{ marginBottom: "4px" }}>
            <label>View Angle: {pitch}°</label>
          </div>
          <input 
            type="range" 
            min="0" 
            max="60" 
            value={pitch} 
            onChange={(e) => updatePitch(parseInt(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        {isAdmin && (
          <button 
            onClick={resetMarkers}
            style={{
              padding: "8px",
              backgroundColor: "#ff5722",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer"
            }}
          >
            Delete All Markers
          </button>
        )}

        <div style={{ marginTop: "8px" }}>
          <label>
            <input 
              type="checkbox" 
              checked={isAdmin} 
              onChange={() => setIsAdmin(!isAdmin)} 
              style={{ marginRight: "8px" }}
            />
            Admin Mode
          </label>
        </div>
        
        <div style={{ marginTop: "8px", fontSize: "12px", color: "#666" }}>
          <div>Click anywhere on the map</div>
          <div>to add new feedback</div>
        </div>
        
        {!mapLoaded && (
          <div style={{ marginTop: "8px", color: "#2196F3" }}>
            Loading map...
          </div>
        )}
      </div>

      <div
        ref={mapContainerRef}
        id="map"
        style={{ 
          width: "100%", 
          height: "100%", 
          cursor: "pointer",
          position: "absolute",
          top: 0,
          left: 0
        }}
      />
    </div>
  );
}

export default StakeholderMap;























  






















