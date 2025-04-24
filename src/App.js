import React from 'react';
// Make sure BrowserRouter is imported if not already
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import StakeholderMap from './components/StakeholderMap'; // Verify path is correct

function App() {
  return (
    // BrowserRouter will automatically use the 'homepage' from package.json
    // No need for explicit basename here
    <Router>
      <Routes>
        {/* Route for the base path "/" - show public mode by default */}
        <Route path="/" element={<StakeholderMap mode="public" />} />

        {/* Explicit route for /public (optional, but fine to keep) */}
        <Route path="/public" element={<StakeholderMap mode="public" />} />

        {/* Route for /admin */}
        <Route path="/admin" element={<StakeholderMap mode="admin" />} />

        {/* Catch-all: If any other path is entered, redirect to the base path ("/") */}
        {/* Alternatively, you could render a dedicated 404 component here */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;


