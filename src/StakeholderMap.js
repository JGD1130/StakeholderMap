import React, {
  useEffect,
  useRef,
  useState,
  useCallback
} from "react";
import mapboxgl from "mapbox-gl";
import {
  initializeApp
} from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  getDocs
} from 'firebase/firestore';

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID,
  measurementId: process.env.REACT_APP_MEASUREMENT_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Set your Mapbox access token
mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN;

const CATEGORIES = {
  environment: {
      label: "Environment",
      color: "green"
  },
  social: {
      label: "Social",
      color: "blue"
  },
  governance: {
      label: "Governance",
      color: "orange"
  },
  economic: {
      label: "Economic",
      color: "purple"
  }
};

function StakeholderMap() {
  const mapContainerRef = useRef(null);
  const [map, setMap] = useState(null);
  const [markersData, setMarkersData] = useState([]);

  // Memoized function to update heatmap data
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

  // Function to add markers to the map
  const addMarkerToMap = useCallback((marker) => {
      if (!map) return;

      const markerEl = document.createElement("div");
      markerEl.style.width = "24px";
      markerEl.style.height = "24px";
      markerEl.style.backgroundColor =
          CATEGORIES[marker.category]?.color || "#000";
      markerEl.style.borderRadius = "50%";

      new mapboxgl.Marker(markerEl)
          .setLngLat([marker.lng, marker.lat])
          .addTo(map);
  }, [map]);

  useEffect(() => {
      console.log("Mapbox access token:", process.env.REACT_APP_MAPBOX_ACCESS_TOKEN); // ADD THIS LINE
      const mapInstance = new mapboxgl.Map({
          container: mapContainerRef.current,
          style: "mapbox://styles/jack1130/cm9bgf0x6003801s3demo1lt6", // Replace with your custom style URL
          center: [-96.7005, 40.8136], // Lincoln, Nebraska
          zoom: 16,
      });

      mapInstance.on("load", () => {
          // Disable uncontrolled scrolling behavior on the webpage
          mapInstance.getContainer().addEventListener(
              "wheel",
              (event) => {
                  event.preventDefault(); // Prevent webpage scrolling
              }, {
                  passive: false
              }
          );

          // Add heatmap source and layer
          mapInstance.addSource("heatmap-data", {
              type: "geojson",
              data: {
                  type: "FeatureCollection",
                  features: []
              },
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
                      0,
                      "rgba(0,0,255,0)",
                      0.2,
                      "rgba(0,0,255,1)",
                      0.4,
                      "rgba(0,255,0,1)",
                      0.6,
                      "rgba(255,255,0,1)",
                      1,
                      "rgba(255,0,0,1)",
                  ],
              },
          });

          // Add extruded buildings layer for 3D buildings
          mapInstance.addLayer({
              id: "3d-buildings",
              source: "composite",
              "source-layer": "building",
              filter: ["==", ["get", "extrude"],
                  true
              ], // Correctly check for extrude property as boolean true
              type: "fill-extrusion",
              minzoom: 15,
              paint: {
                  "fill-extrusion-color": "#aaa",
                  "fill-extrusion-height": ["get", "height"],
                  "fill-extrusion-base": ["get", "min_height"],
                  "fill-extrusion-opacity": 0.6,
              },
          });
      });

      setMap(mapInstance);

      return () => mapInstance.remove(); // Cleanup on unmount
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
      const coordinates = e.lngLat;
      const popupNode = document.createElement("div");

      popupNode.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px; width: 200px;">
          <label>Category:</label>
          <select id="categorySelect" style="padding: 4px;">
            ${Object.entries(CATEGORIES).map(([key, val]) =>
              `<option value="${key}">${val.label}</option>`
            )}
          </select>
          <label>Comment:</label>
          <textarea id="commentBox" rows="3" style="margin-bottom: 8px;"></textarea>
          <button id="submitBtn" style="padding: 4px 8px; cursor: pointer;">Submit</button>
        </div>
      `;

      const popup = new mapboxgl.Popup({
              closeOnClick: false
          })
          .setLngLat(coordinates)
          .setDOMContent(popupNode)
          .addTo(map);

      popupNode.querySelector("#submitBtn").addEventListener("click", async () => {
          const comment = popupNode.querySelector("#commentBox").value;
          const category = popupNode.querySelector("#categorySelect").value;

          if (comment.trim() !== "") {
              const newMarkerData = {
                  lng: coordinates.lng,
                  lat: coordinates.lat,
                  comment,
                  category,
                  timestamp: new Date().toISOString(),
              };

              // Add marker to Firestore
              await addDoc(collection(db, "markers"), newMarkerData);

              // Update local state and heatmap
              setMarkersData((prev) => [...prev, newMarkerData]);
              addMarkerToMap(newMarkerData);

              popup.remove();
          }
      });
  }, [map, addMarkerToMap]);

  useEffect(() => {
      if (map) {
          map.on("click", handleMapClick);
      }

      return () => {
          if (map) {
              map.off("click", handleMapClick);
          }
      };
  }, [map, handleMapClick]);

  return (
      <div>
          <h1>Stakeholder Engagement Map</h1>
          <div ref={mapContainerRef} style={{ width: "100%", height: "600px" }} />
      </div>
  );
}

export default StakeholderMap;





















