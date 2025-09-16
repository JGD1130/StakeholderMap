// src/pages/PublicMapPage.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// FIX #1: The path to StakeholderMap.jsx
// It's in the components folder, so we go up one level (..) then into components/
import StakeholderMap from '../components/StakeholderMap'; 

// FIX #2: The path to EmailEntryForm.jsx
// It's in the SAME folder (pages), so we use a relative path (./)
import EmailEntryForm from '../components/EmailEntryForm';

const PublicMapPage = ({ config, universityId, persona }) => {
  const navigate = useNavigate();
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailFormSubmitted, setEmailFormSubmitted] = useState(false);

  useEffect(() => {
    // Only show email form for 'student' persona and if it hasn't been submitted
    if (persona === 'student' && config.enableDrawingEntry && !sessionStorage.getItem('emailSubmittedForMap')) {
      setShowEmailForm(true);
    } else {
      setShowEmailForm(false);
    }
  }, [persona, config.enableDrawingEntry]); // Depend on persona and config setting

  const handleEmailSuccess = () => {
    setEmailFormSubmitted(true);
    setShowEmailForm(false);
    // Optionally, store something in session storage to prevent re-showing
    // the form if the user navigates away and back within the same session.
    sessionStorage.setItem('emailSubmittedForMap', 'true');
  };

  const handleEmailCancel = () => {
    setEmailFormSubmitted(true); // Treat as submitted (skipped) to show map
    setShowEmailForm(false);
    sessionStorage.setItem('emailSubmittedForMap', 'true'); // Still prevent re-showing
  };

  // If the email form is visible, render it.
  if (showEmailForm) {
    return (
      <EmailEntryForm
        universityId={universityId}
        onSuccess={handleEmailSuccess}
        onCancel={handleEmailCancel}
      />
    );
  }

  // If the persona is student AND drawing entry is enabled AND the form hasn't been submitted/skipped,
  // then we should *wait* for the form interaction.
  // Otherwise, render the map.
  if (persona === 'student' && config.enableDrawingEntry && !emailFormSubmitted) {
      // This state should ideally not be reached if showEmailForm is true and handled above,
      // but as a fallback, we could render a loader or nothing until the decision is made.
      // For now, if showEmailForm is false but emailFormSubmitted is also false,
      // it means the useEffect likely hasn't caught up, or an unexpected state.
      // Let's ensure the form is shown if needed, otherwise proceed.
      return null; // Or a loading spinner
  }

  // Render the map when the form is not needed or has been dealt with.
  return (
    <StakeholderMap config={config} universityId={universityId} persona={persona} />
  );
};

export default PublicMapPage;
