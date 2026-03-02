// src/App.jsx --- FINAL CORRECT VERSION ---
import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import PublicMapPage from './pages/PublicMapPage.jsx';
import AdminMapPage from './pages/AdminMapPage.jsx';
import { getConfig } from './configLoader';
import { getTenantConfigId, resolveTenant } from './tenants/registry';
import './App.css';

function UniversityMapLoader({ engagementMode = false }) {
  const { universityId, persona } = useParams();
  const tenant = resolveTenant(universityId);
  const configId = getTenantConfigId(universityId);
  const config = getConfig(configId);

  if (!config) {
    if (tenant?.status === 'planned') {
      return <div>Tenant "{universityId}" is scaffolded but not configured yet.</div>;
    }
    return <div>Error: Configuration not found for "{universityId}".</div>;
  }

  const isAdmin = window.location.pathname.includes('/admin');
  const mode = isAdmin ? 'admin' : 'public';

  if (isAdmin) {
    return <AdminMapPage config={config} universityId={universityId} tenant={tenant} />;
  } else {
    return (
      <PublicMapPage
        config={config}
        universityId={universityId}
        persona={persona}
        engagementMode={engagementMode}
        tenant={tenant}
      />
    );
  }
}

function App() {
  return (
    // This basename is CRITICAL for GitHub Pages deployment in a subdirectory
    <Router basename="/StakeholderMap">
      <Routes>
        <Route path="/:universityId/admin" element={<UniversityMapLoader />} />
        <Route path="/:universityId/engagement" element={<UniversityMapLoader engagementMode />} />
        {/* THIS IS THE LINE TO FIX */}
        <Route path="/:universityId/:persona" element={<UniversityMapLoader />} /> 
        <Route path="/:universityId/survey" element={<UniversityMapLoader />} />
        <Route path="/:universityId" element={<UniversityMapLoader />} />
        <Route path="/" element={<div>Please select a university by navigating to its URL (e.g., /hastings)</div>} />
      </Routes>
    </Router>
  );
}

export default App;
