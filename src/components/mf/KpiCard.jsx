// src/components/mf/KpiCard.jsx
//
// Headline number card. A null value or a `missing` prop shows "—" with the
// missing reason as the context line, so "no data" never reads as a real 0.
// `indicator` adds a 4px left accent bar (surplus / deficit); the text itself
// never takes the accent color and the card background is never tinted.
import React from 'react';
import { MF } from '../../theme/mfTokens';
import { mfCardStyle } from './mfStyles';

const INDICATOR_COLORS = {
  surplus: MF.diverging.surplus,
  deficit: MF.diverging.deficit
};

export default function KpiCard({ value, label, context, missing, indicator }) {
  const isMissing = value === null || value === undefined || Boolean(missing);
  const shownValue = isMissing ? '—' : String(value);
  const shownContext = isMissing && missing?.reason ? missing.reason : context;
  const accent = INDICATOR_COLORS[indicator];

  return (
    // With an accent bar, the 4px bar sits inside the 16px left padding plus 4px.
    <div style={{ ...mfCardStyle, overflow: 'hidden', paddingLeft: accent ? 20 : 16 }}>
      {accent ? (
        <span
          aria-hidden="true"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }}
        />
      ) : null}
      <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.15, color: MF.ink.primary, overflowWrap: 'anywhere' }}>
        {shownValue}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: MF.ink.muted }}>
        {label}
      </div>
      {shownContext ? (
        <div style={{ marginTop: 4, fontSize: 12, color: MF.ink.secondary }}>{shownContext}</div>
      ) : null}
    </div>
  );
}
