// src/firebaseConfig.js

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDqdNAi8z3vx8TJcbVwUN37GJtt4vGH_Cs", // Keep your actual key here
  authDomain: "stakeholder-map-a4bdc.firebaseapp.com", // Keep your actual domain here
  projectId: "stakeholder-map-a4bdc",   // Keep your actual project ID here
  storageBucket: "stakeholder-map-a4bdc.firebasestorage.app",
  messagingSenderId: "201968932417",
  appId: "1:201968932417:web:c6053a304f5dc5f2ffd8c0",
  measurementId: "G-BEB17GFMBJ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Cloud Firestore and get a reference to the service
const db = getFirestore(app);

// Export the database instance so we can use it in other files
export { db };
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export { onAuthStateChanged, signInWithPopup, signOut };
