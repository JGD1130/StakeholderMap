// src/components/CapitalTiersMapLegend.jsx
//
// Small legend card over the map while the "Capital Compass tiers" map view
// is active (admin-only): one row per tier -- swatch, "Tier 1", horizon --
// plus "Not scored". Colors and labels from capitalCompassView.js, which the
// map's recolor effect uses too, so the legend and the buildings can't
// disagree. Positioned by the caller.
import React from 'react';
import { MF } from '../theme/mfTokens';
import { mfCardStyle } from './mf/mfStyles';
import { MAP_LEGEND_TITLE, mapLegendRows } from './capitalCompassView';

export default function CapitalTiersMapLegend({ style }) {
  return (
    <div
      role="group"
      aria-label={MAP_LEGEND_TITLE}
      style={{ ...mfCardStyle, background: MF.surface.page, padding: '10px 12px', minWidth: 170, ...style }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: MF.ink.primary, marginBottom: 6 }}>{MAP_LEGEND_TITLE}</div>
      {mapLegendRows().map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '20px', color: MF.ink.primary }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: row.color, border: `1px solid ${MF.line.border}` }} />
          <span style={{ fontWeight: 600 }}>{row.label}</span>
          {row.detail ? <span style={{ color: MF.ink.muted }}>{row.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}
