// src/pages/AdminMapPage.js
import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

export default function AdminMapPage() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <StakeholderMap mode="admin" />
    </div>
  );
}

