import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import StakeholderMap from './components/StakeholderMap';

// HARDCODE the basename for testing GitHub Pages deployment
const basename = "/StakeholderMap";

function App() {
  return (
    <BrowserRouter basename={basename}>
      <Routes>
        {/* Routes remain relative to the basename */}
        <Route path="/" element={<StakeholderMap mode="public" />} />
        <Route path="/public" element={<StakeholderMap mode="public" />} />
        <Route path="/admin" element={<StakeholderMap mode="admin" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;


