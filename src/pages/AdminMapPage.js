import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

export default function AdminMapPage({ config }) { 
  return (
    // Add the className="admin-page" here
    <div className="admin-page" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <StakeholderMap mode="admin" config={config} /> 
    </div>
  );
}

