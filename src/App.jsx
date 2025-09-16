// src/App.jsx --- FINAL CORRECT VERSION ---
import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams, Link } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage.jsx';
import AdminMapPage from './pages/AdminMapPage.jsx';
import { getConfig } from './configLoader';
import './App.css';

function UniversityMapLoader() {
  const { universityId, persona } = useParams();
  const config = getConfig(universityId);

  if (!config) {
    return <div>Error: Configuration not found for "{universityId}".</div>;
  }

  const isAdmin = window.location.pathname.includes('/admin');
  const mode = isAdmin ? 'admin' : 'public';

  if (isAdmin) {
    return <AdminMapPage config={config} universityId={universityId} />;
  } else {
    return <PublicMapPage config={config} universityId={universityId} persona={persona} />;
  }
}

function UniversityLandingPage() {
    const { universityId } = useParams();
    const config = getConfig(universityId);
    if (!config) return <div>Loading...</div>;
    return (
        <div className="landing-page">
            <h2>{config.universityName} Stakeholder Map</h2>
            <p>Please select your role to continue to the survey:</p>
            <div className="landing-links">
                {/* VERIFY THIS LINE uses '/student' (singular) */}
                <Link to={`/${universityId}/student`} className="landing-link-button">I am a Student</Link>
                
                {/* This one should be correct already */}
                <Link to={`/${universityId}/staff`} className="landing-link-button">I am a Staff/Faculty Member</Link>
            </div>
        </div>
    );
}

function App() {
  return (
    // This basename is CRITICAL for GitHub Pages deployment in a subdirectory
    <Router basename="/StakeholderMap">
      <Routes>
        <Route path="/:universityId/admin" element={<UniversityMapLoader />} />
        {/* THIS IS THE LINE TO FIX */}
        <Route path="/:universityId/:persona" element={<UniversityMapLoader />} /> 
        <Route path="/:universityId" element={<UniversityLandingPage />} />
        <Route path="/" element={<div>Please select a university by navigating to its URL (e.g., /hastings)</div>} />
      </Routes>
    </Router>
  );
}

export default App;
