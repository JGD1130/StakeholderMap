// src/components/mf/charts/ChartLegend.jsx
//
// Small swatch legend ("■ Renovation ■ Demolition …") placed above a chart.
// items: [{ key, label, color }]
import React from 'react';
import { MF } from '../../../theme/mfTokens';

export default function ChartLegend({ items }) {
  if (!items?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, color: MF.ink.muted, fontFamily: MF.type.family, marginBottom: 8 }}>
      {items.map((item) => (
        <span key={item.key}>
          <span
            aria-hidden="true"
            style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: item.color, marginRight: 5, verticalAlign: '-1px' }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
