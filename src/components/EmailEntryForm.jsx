// src/components/EmailEntryForm.jsx
import React, { useState } from 'react';
import { db } from '../firebaseConfig'; // Make sure this path is correct
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import './EmailEntryForm.css'; // You'll create this CSS file

const EmailEntryForm = ({ universityId, onSuccess, onCancel }) => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    setLoading(true);
    try {
      const drawingEntriesCollection = collection(db, 'universities', universityId, 'drawingEntries');
      await addDoc(drawingEntriesCollection, {
        email: email,
        submittedAt: serverTimestamp(),
      });
      onSuccess(); // Call the callback to indicate success and proceed to map
    } catch (err) {
      console.error("Error saving email:", err);
      setError('Failed to save email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="email-entry-overlay">
      <div className="email-entry-modal">
        <h3>Enter to Win!</h3>
        <p>Please enter your Hastings.edu email address for a chance to win a prize!</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Your email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            aria-label="Email address for prize drawing"
          />
          {error && <p className="error-message">{error}</p>}
          <div className="button-group">
            <button type="submit" disabled={loading}>
              {loading ? 'Submitting...' : 'Submit & Go to Map'}
            </button>
            <button type="button" onClick={onCancel} disabled={loading}>
              No Thanks, Go to Map
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EmailEntryForm;
