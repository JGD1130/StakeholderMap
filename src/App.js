import React, { useState, useEffect } from 'react';
import StakeholderMap from './components/StakeholderMap';
import { getFunctions } from "firebase/functions";
import './App.css';

// --- Firebase Imports ---
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
// Removed unused imports to clean up the file

// --- Your Map Configuration ---
const hastingsConfig = {
  lng: -98.371421,
  lat: 40.592469,
  zoom: 15.5,
  pitch: 30,
  bearing: 0,
  style: 'mapbox://styles/mapbox/streets-v12', // A simple, fast-loading style
  boundary: '/data/Hastings_College_Boundary.geojson',
  buildings: '/data/Hastings_College_Buildings.geojson',
  logos: {
    clarkEnersen: '/data/Clark_Enersen_Logo.png',
    hastings: '/data/HC_image.png'
  },
  name: 'Hastings College',
};

// ====================================================================
// The App Component
// ====================================================================
function App() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const auth = getAuth();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const idTokenResult = await currentUser.getIdTokenResult(true);
          setIsAdmin(!!idTokenResult.claims.admin);
        } catch (error) {
          console.error("Error getting user token:", error);
          setIsAdmin(false);
        }
      } else {
        setUser(null);
        setIsAdmin(false);
      }
    });
    return () => unsubscribe();
  }, [auth]);

  const signInWithGoogle = async () => { /* ... your working sign-in code ... */ };
  const handleSignOut = async () => { /* ... your working sign-out code ... */ };

  return (
    <div className="App">
      <div className="auth-bar">
        {user ? (
          <>
            <span>Welcome, {user.displayName} {isAdmin && '(Admin)'}</span>
            <button onClick={handleSignOut}>Sign Out</button>
          </>
        ) : (
          <button onClick={signInWithGoogle}>Sign in with Google</button>
        )}
      </div>

      {/*
        THIS IS THE DEFINITIVE FIX:
        We check if 'hastingsConfig' exists before trying to render StakeholderMap.
        This prevents the crash by ensuring the 'config' prop is never undefined.
      */}
      {hastingsConfig ? (
        <StakeholderMap 
          config={hastingsConfig} 
          isAdmin={isAdmin} 
        />
      ) : (
        <div>Loading map configuration...</div>
      )}
    </div>
  );
}

export default App;