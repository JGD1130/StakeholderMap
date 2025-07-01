import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage';
import AdminMapPage from './pages/AdminMapPage';
import './App.css';

function App() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        // --- FIX 1: Correctly fetch the config file ---
        const response = await fetch(process.env.PUBLIC_URL + '/config.json');
        
        if (!response.ok) {
          throw new Error(`HTTP error fetching config! status: ${response.status}`);
        }
        
        const configData = await response.json();

        // --- FIX 2: Correctly prepend the public path to logos ---
        // This makes sure image paths work on localhost and GitHub pages.
        if (configData.logos) {
          Object.keys(configData.logos).forEach(key => {
            const logoPath = configData.logos[key];
            if (logoPath && logoPath.startsWith('/')) {
              configData.logos[key] = process.env.PUBLIC_URL + logoPath;
            }
          });
        }
        
        // This also applies the fix to any file paths for GeoJSON data
        // just in case you are loading them from files.
        if (configData.buildings && typeof configData.buildings === 'string' && configData.buildings.startsWith('/')) {
           configData.buildings = process.env.PUBLIC_URL + configData.buildings;
        }
        if (configData.boundary && typeof configData.boundary === 'string' && configData.boundary.startsWith('/')) {
           configData.boundary = process.env.PUBLIC_URL + configData.boundary;
        }

        setConfig(configData);

      } catch (error) {
        console.error("Failed to fetch or process map configuration:", error);
      }
    };

    fetchConfig();
  }, []);

  if (!config) {
    return <div>Loading Map Configuration...</div>;
  }

  return (
    <Router basename="/StakeholderMap">
      <Routes>
        <Route path="/admin" element={<AdminMapPage config={config} />} />
        <Route path="/" element={<PublicMapPage config={config} />} />
      </Routes>
    </Router>
  );
}

export default App;
