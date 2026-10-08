import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LookupPage } from './pages/LookupPage';
import { ReportPage } from './pages/ReportPage';
import { BadgePage } from './pages/BadgePage';

export default function App() {
  return (
    <Routes>
      {/* Home: brand enters a creator address */}
      <Route path="/" element={<LookupPage />} />

      {/* Auto-generated proof-of-audience report */}
      <Route path="/report/:address" element={<ReportPage />} />

      {/* Public shareable live verification badge — the core differentiator */}
      <Route path="/badge/:address" element={<BadgePage />} />

      {/* Catch-all: redirect unknown paths to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
