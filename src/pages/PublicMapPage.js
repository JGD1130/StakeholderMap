import React from 'react';
import StakeholderMap from '../components/StakeholderMap';

// It now receives 'config' as a prop
export default function PublicMapPage({ config }) { 
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Pass the config and the mode prop. 'mode="public"' is redundant
          if we set it as the default, but it's good to be explicit. */}
      <StakeholderMap mode="public" config={config} />
    </div>
  );
}
