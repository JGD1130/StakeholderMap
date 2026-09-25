// src/components/mf/charts/projectTypes.js
//
// Display helpers for capital phasing projects. Pure functions, no React.
// Project names come straight from the master plan phasing workbook, e.g.
//   "McCormick Hall - Full Renovation (11,500 sf)"
//   "Taylor Hall - Demolition & Site Upgrades"
//   "New Residence Hall - New Construction"
import { MF } from '../../../theme/mfTokens';

export const PROJECT_TYPES = {
  renovation: { label: 'Renovation', color: MF.project.renovation },
  site: { label: 'Site', color: MF.project.site },
  newConstruction: { label: 'New construction', color: MF.project.newConstruction },
  demolition: { label: 'Demolition', color: MF.project.demolition }
};

// The one rule for a project's type, checked in this order (first match
// wins, case-insensitive, anywhere in the name):
//   "New Construction" -> newConstruction
//   "Demolition"       -> demolition   (so "Demolition & Site Upgrades" is demolition)
//   "Renovation"       -> renovation
//   "Site" / "Parking" -> site
//   anything else      -> renovation   (e.g. "Acoustic Upgrades", "Partial Renov.")
export function classifyProjectType(name) {
  const text = String(name || '').toLowerCase();
  if (text.includes('new construction')) return 'newConstruction';
  if (text.includes('demolition')) return 'demolition';
  if (text.includes('renovation')) return 'renovation';
  if (/\bsite\b/.test(text) || text.includes('parking')) return 'site';
  return 'renovation';
}

// "McCormick Hall - Full Renovation (11,500 sf)"
//   -> { building: 'McCormick Hall', project: 'Full Renovation', sf: 11500 }
// Splits on the first spaced dash only, so "Hurley-McDonald - …" keeps its
// hyphenated building name. A name with no spaced dash is all building.
export function splitProjectName(name) {
  const text = String(name || '').trim();
  const sfMatch = text.match(/\(\s*([\d,]+)\s*sf\s*\)/i);
  const sf = sfMatch ? Number(sfMatch[1].replace(/,/g, '')) : null;
  const withoutSf = sfMatch ? text.replace(sfMatch[0], '').trim() : text;
  const dash = withoutSf.match(/\s[-–—]\s/);
  if (!dash) return { building: withoutSf, project: '', sf: Number.isFinite(sf) ? sf : null };
  return {
    building: withoutSf.slice(0, dash.index).trim(),
    project: withoutSf.slice(dash.index + dash[0].length).trim(),
    sf: Number.isFinite(sf) ? sf : null
  };
}
