// src/pages/PublicMapPage.jsx --- NEW AND IMPROVED VERSION ---
import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

const PublicMapPage = ({ config, universityId, persona, engagementMode = false, technicalMode = false, tenant = null }) => (
  <StakeholderMap
    config={config}
    universityId={universityId}
    tenant={tenant}
    persona={persona}
    engagementMode={engagementMode}
    technicalMode={technicalMode}
  />
);

export default PublicMapPage;

