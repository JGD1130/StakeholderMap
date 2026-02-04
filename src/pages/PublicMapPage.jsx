// src/pages/PublicMapPage.jsx --- NEW AND IMPROVED VERSION ---
import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

const PublicMapPage = ({ config, universityId, persona }) => (
  <StakeholderMap
    config={config}
    universityId={universityId}
    persona={persona}
  />
);

export default PublicMapPage;

