// 1. All imports at the very top
import React from 'react'; // No useMemo needed if config is static outside
import StakeholderMap from './components/StakeholderMap';
import './App.css';

// 2. Define constants like hastingsConfig at the top level, after imports
//    but BEFORE your component function definition.
const hastingsConfig = {
  initialCenter: [-98.371421, 40.592469], // Hastings specific coords [Lon, Lat]
  initialZoom: 15.5,                      // Hastings specific zoom
  boundary: '/data/Hastings_College_Boundary.geojson',
  buildings: '/data/Hastings_College_Buildings.geojson',
  logo: '/data/HC_image.png',
  name: 'Hastings College', // Explicitly set the name StakeholderMap expects
  initialPitch: 30,
};

// 3. Define your function component
function App() {
  // Inside the App function, you can directly use hastingsConfig
  // because it's defined in the module scope (outer scope).
  // No need to redefine it here or use currentConfig unless you want to.

  return (
    <div className="App">
      <h1>{hastingsConfig.name} Stakeholder Map</h1> {/* Use name from the config */}
      <StakeholderMap 
        config={hastingsConfig} // Pass the stable hastingsConfig object
        mode="admin" 
      />
    </div>
  );
}

// 4. Export your component at the very end (or also at the top level)
export default App;