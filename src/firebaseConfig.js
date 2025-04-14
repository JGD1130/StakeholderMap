// Import Firebase modules
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDqdNAi8z3vx8TJcbVwUN37GJtt4vGH_Cs",
  authDomain: "stakeholder-map-a4bdc.firebaseapp.com",
  projectId: "stakeholder-map-a4bdc",
  storageBucket: "stakeholder-map-a4bdc.firebasestorage.app",
  messagingSenderId: "201968932417",
  appId: "1:201968932417:web:c6053a304f5dc5f2ffd8c0",
  measurementId: "G-BEB17GFMBJ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app); // Initialize Firestore
const analytics = getAnalytics(app); // Initialize Analytics

export { app, db, analytics }; // Export Firebase services
