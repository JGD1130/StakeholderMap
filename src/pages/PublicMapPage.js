// src/pages/PublicMapPage.js
import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

export default function PublicMapPage() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <StakeholderMap mode="public" />
    </div>
  );
}

