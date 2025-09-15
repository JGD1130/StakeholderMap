// src/pages/PublicMapPage.jsx
import React from 'react';
import StakeholderMap from '../components/StakeholderMap.jsx';

// --- UPDATED: Pass the `persona` prop down ---
const PublicMapPage = ({ config, universityId, persona }) => {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <StakeholderMap config={config} universityId={universityId} mode="public" persona={persona} />
    </div>
  );
};

export default PublicMapPage;