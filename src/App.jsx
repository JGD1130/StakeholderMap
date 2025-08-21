import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage';
import AdminMapPage from './pages/AdminMapPage';
import './App.css';

// --- ULTIMATE DEBUGGING STEP ---
// We are importing everything directly into this file.
// If there is a typo in any filename or folder name, the error
// message in the terminal will tell us exactly which line failed.

// Import the raw JSON data
import hastingsConfigData from './Configs/Hastings.json';
import rockhurstConfigData from './Configs/Rockhurst.json';

// Import the GeoJSON data (with the corrected .json extension)
import hastingsBuildings from './geojson/Hastings_College_Buildings.json';
import hastingsBoundary from './geojson/Hastings_College_Boundary.json';
import rockhurstBuildings from './geojson/RockhurstU_Buildings.json';
import rockhurstBoundary from './geojson/RockhurstU_Boundary.json';

// Assemble the final, complete config objects right here
const finalHastingsConfig = {
  ...hastingsConfigData,
  buildings: hastingsBuildings,
  boundary: hastingsBoundary,
};

const finalRockhurstConfig = {
  ...rockhurstConfigData,
  buildings: rockhurstBuildings,
  boundary: rockhurstBoundary,
};

// Create a simple lookup object for the final configs
const universityConfigs = {
  hastings: finalHastingsConfig,
  rockhurst: finalRockhurstConfig,
};

function UniversityMapLoader() {
  const { universityId } = useParams();
  
  // Directly get the fully-assembled config object
  const config = universityConfigs[universityId];

  // This check is now much simpler
  if (!config) {
    return <div>Error: Configuration not found for "{universityId}". Please check the spelling.</div>;
  }

  return (
    <Routes>
      <Route path="/admin" element={<AdminMapPage config={config} universityId={universityId} />} />
      <Route path="/" element={<PublicMapPage config={config} universityId={universityId} />} />
    </Routes>
  );
}

function App() {
  return (
    <Router basename="/StakeholderMap">
      <Routes>
        <Route path="/:universityId/*" element={<UniversityMapLoader />} />
        <Route path="/" element={<div>Please select a university (e.g., /hastings or /rockhurst)</div>} />
      </Routes>
    </Router>
  );
}

export default App;

