import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage.jsx';
import AdminMapPage from './pages/AdminMapPage.jsx';
import { getConfig } from './configLoader'; // <-- Use our new loader
import './App.css';

function UniversityMapLoader() {
  const { universityId } = useParams();
  
  // Directly get the fully-assembled config object. No fetching, no waiting.
  const config = getConfig(universityId);

  if (!config) {
    return <div>Error: Configuration not found for "{universityId}".</div>;
  }

  // Pass the complete config object down to the page.
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