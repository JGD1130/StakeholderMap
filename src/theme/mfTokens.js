// src/theme/mfTokens.js
//
// Design tokens for the admin analytics (Executive Dashboard, Capital Compass,
// Classroom Utilization, Space Growth Projections, F&A Compass). Plain JS
// values -- no CSS variables -- so the same module works in DOM components
// and in @react-pdf/renderer documents.
//
// Phase 1 only introduces this module; existing screens are migrated onto it
// later. Don't change a value here without checking every consumer.

import { CE_ORANGE_HEADER } from '../utils/brandColors';
import { INDUSTRY_TARGET_TIME_UTILIZATION } from '../utils/classroomUtilizationCalc';

export const MF = {
  brand: { headerOrange: CE_ORANGE_HEADER },
  ink: { primary: '#1d2939', secondary: '#344054', muted: '#667085', subtle: '#98a2b3' },
  line: { border: '#d0d7e2', hairline: '#e4e7ec' },
  surface: { page: '#ffffff', card: '#f8fafc', modalBackdrop: 'rgba(0,0,0,0.45)' },
  diverging: { surplus: '#5183ef', deficit: '#c4834f', zero: '#98a2b3' },
  // Ordinal, darkest = Tier 1.
  tier: { 1: '#0f5563', 2: '#2b7a86', 3: '#5a9ea8', 4: '#8bbcc3' },
  project: { renovation: '#3b73ed', site: '#1f9e8a', newConstruction: '#6a4fc4', demolition: '#b07a1a' },
  status: { error: '#b42318', warningText: '#92400e', warningBg: '#fffbeb', warningBorder: '#fde68a' },
  util: { base: '#2563eb', noData: '#f2f4f7', target: INDUSTRY_TARGET_TIME_UTILIZATION },
  type: {
    family: '"Segoe UI","Noto Sans","Helvetica Neue",Arial,sans-serif',
    minScreenPx: 11,
    minPdfPt: 9
  }
};

// Utilization ramp: MF.util.base (#2563eb) at opacity 0.08 + pct/100 * 0.82,
// composited over white into a solid hex. Same formula as the Day/Time heat
// map (ClassroomUtilizationPanel.jsx heatmapCellBackground), so
// 0 -> #eef3fd, 50 -> #94b3f5, 100 -> #3b73ed. Opacity is NOT rounded
// (the heat map rounds it to 2 decimals for its rgba() string), which is what
// reproduces the gauge's original 8 stops exactly; a few heat map percentages
// can differ from this by 1 in one channel.
const UTIL_BASE_RGB = [37, 99, 235];

function toHex(channels) {
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function utilColor(pct) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const alpha = 0.08 + (clamped / 100) * 0.82;
  return toHex(UTIL_BASE_RGB.map((c) => Math.round(255 * (1 - alpha) + c * alpha)));
}

// Readable text over utilColor(pct) -- same threshold the heat map uses.
export function utilTextColor(pct) {
  return Number(pct) > 55 ? '#fff' : MF.ink.secondary;
}

// n solid stops, each utilColor at its band's midpoint. utilBands(8) is the
// Executive Dashboard gauge arc.
export function utilBands(n = 8) {
  const count = Math.max(1, Math.floor(n));
  return Array.from({ length: count }, (_, i) => utilColor(((i + 0.5) * 100) / count));
}
