import React, { useState, useEffect } from 'react';
import StakeholderMap from './components/StakeholderMap';
import './App.css';

function App() {
  const [config, setConfig] = useState(null);
  
  // We are hard-coding isAdmin to true for now, since that's the mode we need to work in.
  const isAdmin = true; 

  useEffect(() => {
  const fetchConfig = async () => {
    try {
      // This is the new, correct line
const response = await fetch(process.env.PUBLIC_URL + '/config.json');
      const configData = await response.json();

      // --- NEW: Process paths to be absolute ---
      const processedConfig = {
  ...configData,
  buildings: process.env.PUBLIC_URL + configData.buildings,
  boundary: process.env.PUBLIC_URL + configData.boundary, // <-- ADD THIS LINE
  logos: {
    clarkEnersen: process.env.PUBLIC_URL + configData.logos.clarkEnersen,
    hastings: process.env.PUBLIC_URL + configData.logos.hastings,
  }
};
      
      setConfig(processedConfig); // Set the new, processed config

    } catch (error) {
      console.error("Failed to fetch or process map configuration:", error);
    }
  };

  fetchConfig();
}, []);// The empty array ensures this runs only once when the app starts

  return (
    <div className="App">
      <header className="App-header">
        {/* The h1 is now optional, as you have a title in your map component */}
      </header>
      <main>
        {/* We pass the loaded config down to the map component */}
        <StakeholderMap config={config} isAdmin={isAdmin} />
      </main>
    </div>
  );
}

export default App;
