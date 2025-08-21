// src/pages/AdminMapPage.jsx
import React from 'react';
import StakeholderMap from '../components/StakeholderMap.jsx';

// --- THIS IS THE FIX ---
// We now accept universityId as a prop and pass it down.
const AdminMapPage = ({ config, universityId }) => {
  return (
    <div className="admin-page" style={{ width: '100%', height: '100%' }}>
      <StakeholderMap config={config} universityId={universityId} mode="admin" />
    </div>
  );
};

export default AdminMapPage;
