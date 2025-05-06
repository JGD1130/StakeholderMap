import React from 'react';
import InteractiveMap from './StakeholderMap/InteractiveMap'; // Adjust path as needed
import './App.css'; // Example App CSS

function App() {

  // Define the configuration for the Hastings map
  // Keep paths relative to the 'public' folder structure for now
  const hastingsConfig = {
    mapId: 'hastings',
    clientName: 'Hastings College',
    center: [-98.371421, 40.592469], // Hastings specific
    zoom: 15.5,                      // Hastings specific
    // Define paths here so InteractiveMap can use them later
    boundaryGeoJsonPath: '/data/Hastings_College_Boundary.geojson',
    buildingsGeoJsonPath: '/data/Hastings_College_Buildings.geojson',
    clientLogoPath: '/data/HC_image.png'
    // Add other config options as needed (e.g., map style, initial pitch)
  };

  // In a real app, you might get the config based on URL, user login, etc.
  // const currentConfig = getConfigForClient(clientId);
  const currentConfig = hastingsConfig; // Use Hastings config for now

  return (
    <div className="App">
      {/* Pass the configuration object as a prop */}
      <InteractiveMap config={currentConfig} />
    </div>
  );
}

export default App;


