import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams, Link } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage.jsx';
import AdminMapPage from './pages/AdminMapPage.jsx';
import { getConfig } from './configLoader';
import './App.css';

// A new component to show when a user visits the base university URL
function UniversityLandingPage() {
    const { universityId } = useParams();
    const config = getConfig(universityId);

    if (!config) {
        return <div>Configuration for "{universityId}" not found.</div>;
    }

    return (
        <div className="landing-page">
            <h2>{config.universityName} Stakeholder Map</h2>
            <p>Please select your role to continue to the survey:</p>
            <div className="landing-links">
                <Link to={`/${universityId}/student`} className="landing-link-button">I am a Student</Link>
                <Link to={`/${universityId}/staff`} className="landing-link-button">I am a Staff/Faculty Member</Link>
            </div>
            <div className="admin-link">
                <Link to={`/${universityId}/admin`}>Admin Login</Link>
            </div>
        </div>
    );
}

function UniversityMapLoader() {
  // --- UPDATED: We now get `persona` from the URL ---
  const { universityId, persona } = useParams();
  const config = getConfig(universityId);

  if (!config) {
    return <div>Error: Configuration not found for "{universityId}".</div>;
  }

  // The mode is 'admin' if the path contains '/admin'
  const isAdmin = window.location.pathname.includes('/admin');
  const mode = isAdmin ? 'admin' : 'public';

  if (isAdmin) {
    // If it's admin mode, render the AdminMapPage
    return <AdminMapPage config={config} universityId={universityId} />;
  } else {
    // Otherwise, render the PublicMapPage and pass the persona
    return <PublicMapPage config={config} universityId={universityId} persona={persona} />;
  }
}

function App() {
  return (
    <Router basename="/StakeholderMap">
      <Routes>
        {/* --- NEW ROUTING LOGIC --- */}
        <Route path="/:universityId/admin" element={<UniversityMapLoader />} />
        <Route path="/:universityId/:persona" element={<UniversityMapLoader />} />
        <Route path="/:universityId" element={<UniversityLandingPage />} />
        <Route path="/" element={<div>Please select a university by navigating to its URL (e.g., /hastings)</div>} />
      </Routes>
    </Router>
  );
}

export default App;