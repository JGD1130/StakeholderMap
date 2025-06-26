import React, { useState, useEffect } from 'react';
import StakeholderMap from './components/StakeholderMap';
import './App.css';

// --- Firebase Imports ---
// We import our *initialized* services directly from the config file
import { auth, functions } from './firebaseConfig'; 
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";

// --- Your Map Configuration ---
const hastingsConfig = {
  lng: -98.371421,
  lat: 40.592469,
  zoom: 15.5,
  pitch: 30,
  bearing: 0,
  style: 'mapbox://styles/mapbox/outdoors-v12',
  boundary: '/data/Hastings_College_Boundary.geojson',
  buildings: '/data/Hastings_College_Buildings.geojson',
  logos: {
    clarkEnersen: '/data/Clark_Enersen_Logo.png',
    hastings: '/data/HC_image.png'
  },
  name: 'Hastings College',
  firestorePrefix: "hastings",
};

// ====================================================================
// The App Component
// ====================================================================
function App() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const idTokenResult = await currentUser.getIdTokenResult(true);
          const userIsAdmin = !!idTokenResult.claims.admin;
          setIsAdmin(userIsAdmin);
          console.log("User is an Admin:", userIsAdmin);
        } catch (error) {
          console.error("Token error:", error);
          setIsAdmin(false);
        }
      } else {
        setUser(null);
        setIsAdmin(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // --- FULLY IMPLEMENTED HELPER FUNCTIONS ---

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Error during Google sign-in:", error);
      alert("Could not sign in. See console for details.");
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Error during sign-out:", error);
    }
  };

  const makeAdmin = async () => {
    const email = prompt("Enter the email address to make an admin:");
    if (!email) return;
    try {
      const addAdminRole = httpsCallable(functions, 'addAdminRole');
      const result = await addAdminRole({ email });
      alert(result.data.message);
      // Force a refresh of the user's token to get the new admin claim
      if (user) {
        await user.getIdTokenResult(true);
        // Force a re-render to reflect the new admin status immediately
        const idTokenResult = await user.getIdTokenResult();
        setIsAdmin(!!idTokenResult.claims.admin);
      }
    } catch (error) {
      console.error("Error making admin:", error);
      alert("Error: " + error.message);
    }
  };

  // --- JSX RENDER BLOCK ---
  return (
    <div className="App">
      <div className="auth-bar">
        {user ? (
          <>
            <span>Welcome, {user.displayName} {isAdmin && '(Admin)'}</span>
            <button onClick={handleSignOut}>Sign Out</button>
            <button onClick={makeAdmin} style={{ backgroundColor: '#f8d7da' }}>Make User Admin</button>
          </>
        ) : (
          <button onClick={signInWithGoogle}>Sign in with Google</button>
        )}
      </div>
      <StakeholderMap config={hastingsConfig} isAdmin={isAdmin} />
    </div>
  );
}

export default App;
