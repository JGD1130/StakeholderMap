import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, getDocs } from "firebase/firestore";

// Firebase config
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

mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN;

const CATEGORIES = {
  Favorite: { label: "Favorite Place", color: "green" },
  Improvement: { label: "Needs Improvement", color: "orange" },
  Concern: { label: "Concern", color: "red" },
  Idea: { label: "Idea", color: "purple" },
};

function StakeholderMap() {
  const mapContainerRef = useRef(null);
  const [map, setMap] = useState(null);
  const [markersData, setMarkersData] = useState([]);

  const updateHeatmapData = useCallback((data) => {
    if (!map) return;
    const features = data.map((point) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [point.lng, point.lat],
      },
    }));
    map.getSource("heatmap-data")?.setData({
      type: "FeatureCollection",
      features,
    });
  }, [map]);

  const addMarkerToMap = useCallback((marker) => {
    if (!map) return;
    const el = document.createElement("div");
    el.style.width = "20px";
    el.style.height = "20px";
    el.style.backgroundColor = CATEGORIES[marker.category]?.color || "black";
    el.style.borderRadius = "50%";
    new mapboxgl.Marker(el)
      .setLngLat([marker.lng, marker.lat])
      .addTo(map);
  }, [map]);

  useEffect(() => {
    const mapInstance = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-96.7005, 40.8136],
      zoom: 16,
    });

    mapInstance.on("load", () => {
      // Add custom footprint GeoJSON
      mapInstance.addSource("footprints", {
        type: "geojson",
        data: "/data/footprints.geojson",
      });

      mapInstance.addLayer({
        id: "footprints-layer",
        type: "fill",
        source: "footprints",
        layout: {},
        paint: {
          "fill-color": "#ff6600",
          "fill-opacity": 0.5,
        },
      });

      // Add heatmap source/layer
      mapInstance.addSource("heatmap-data", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      mapInstance.addLayer({
        id: "heatmap-layer",
        type: "heatmap",
        source: "heatmap-data",
        paint: {
          "heatmap-weight": 1,
          "heatmap-intensity": 0.8,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0, "rgba(0,0,255,0)",
            0.2, "rgba(0,0,255,1)",
            0.4, "rgba(0,255,0,1)",
            0.6, "rgba(255,255,0,1)",
            1, "rgba(255,0,0,1)",
          ],
        },
      });

      // Add 3D buildings layer (inserted just before label layer)
      const layers = mapInstance.getStyle().layers;
      const labelLayerId = layers.find(
        (l) => l.type === "symbol" && l.layout["text-field"]
      )?.id;

      mapInstance.addLayer(
        {
          id: "3d-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 15,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": ["get", "min_height"],
            "fill-extrusion-opacity": 0.6,
          },
        },
        labelLayerId
      );
    });

    setMap(mapInstance);
    return () => mapInstance.remove();
  }, []);

  useEffect(() => {
    const fetchMarkers = async () => {
      if (!map) return;
      const querySnapshot = await getDocs(collection(db, "markers"));
      const fetchedMarkers = querySnapshot.docs.map((doc) => doc.data());
      setMarkersData(fetchedMarkers);
      fetchedMarkers.forEach(addMarkerToMap);
    };
    fetchMarkers();
  }, [map, addMarkerToMap]);

  useEffect(() => {
    updateHeatmapData(markersData);
  }, [markersData, updateHeatmapData]);

  const handleMapClick = useCallback((e) => {
    const coords = e.lngLat;
    const popupNode = document.createElement("div");
    popupNode.innerHTML = `
      <div>
        <label>Category:</label>
        <select id="cat">
          ${Object.entries(CATEGORIES)
            .map(([key, val]) => `<option value="${key}">${val.label}</option>`)
            .join("")}
        </select><br/>
        <label>Comment:</label>
        <textarea id="comment" rows="3" style="width:100%"></textarea><br/>
        <button id="submit">Submit</button>
      </div>
    `;

    const popup = new mapboxgl.Popup()
      .setLngLat(coords)
      .setDOMContent(popupNode)
      .addTo(map);

    popupNode.querySelector("#submit").addEventListener("click", async () => {
      const comment = popupNode.querySelector("#comment").value;
      const category = popupNode.querySelector("#cat").value;
      const newMarker = {
        lng: coords.lng,
        lat: coords.lat,
        comment,
        category,
        timestamp: new Date().toISOString(),
      };

      await addDoc(collection(db, "markers"), newMarker);
      setMarkersData((prev) => [...prev, newMarker]);
      addMarkerToMap(newMarker);
      popup.remove();
    });
  }, [map, addMarkerToMap]);

  useEffect(() => {
    if (map) map.on("click", handleMapClick);
    return () => {
      if (map) map.off("click", handleMapClick);
    };
  }, [map, handleMapClick]);

  return (
    <div>
      <h2>Stakeholder Engagement Map</h2>
      <div ref={mapContainerRef} style={{ height: "600px", width: "100%" }} />
    </div>
  );
}

export default StakeholderMap;


  






















