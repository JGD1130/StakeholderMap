// src/pages/PublicMapPage.jsx
import React from 'react';
import StakeholderMap from '../components/StakeholderMap.jsx';

// --- THIS IS THE FIX ---
// We now accept universityId as a prop and pass it down.
const PublicMapPage = ({ config, universityId }) => {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <StakeholderMap config={config} universityId={universityId} mode="public" />
    </div>
  );
};

export default PublicMapPage;