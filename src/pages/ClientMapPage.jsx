import React from 'react';
import StakeholderMap from '../components/StakeholderMap.jsx';

const ClientMapPage = ({ config, universityId, tenant = null, engagementMode = false, technicalMode = false }) => {
  return (
    <div className="client-page" style={{ width: '100%', height: '100%' }}>
      <StakeholderMap
        config={config}
        universityId={universityId}
        tenant={tenant}
        mode="client"
        engagementMode={engagementMode}
        technicalMode={technicalMode}
      />
    </div>
  );
};

export default ClientMapPage;
