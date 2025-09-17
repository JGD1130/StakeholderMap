// src/pages/PublicMapPage.jsx --- NEW AND IMPROVED VERSION ---
import React from 'react';
import StakeholderMap from '../components/StakeholderMap';
import EmailEntryForm from '../components/EmailEntryForm';

const PublicMapPage = ({ config, universityId, persona }) => {
  // Use a state to track if the user has interacted with the form.
  
  const [formInteracted, setFormInteracted] = React.useState(false);

  const handleFormCompletion = () => {
  // Now, we only update the React state. The browser's session memory is not used.
  setFormInteracted(true);
};

  // Determine if the email form should be shown.
  // It should only show for the 'student' persona, if the config enables it,
  // AND if the user hasn't already interacted with it.
  const shouldShowEmailForm = 
    persona === 'student' && 
    config?.enableDrawingEntry && 
    !formInteracted;

  if (shouldShowEmailForm) {
    // If we need to show the form, render it and pass the completion handler.
    return (
      <EmailEntryForm
        universityId={universityId}
        onSuccess={handleFormCompletion}
        onCancel={handleFormCompletion} // Both success and cancel count as completion
      />
    );
  } else {
    // In all other cases (staff, admin, or student who has finished the form),
    // render the map.
    return (
      <StakeholderMap 
        config={config} 
        universityId={universityId} 
        persona={persona} 
      />
    );
  }
};

export default PublicMapPage;

