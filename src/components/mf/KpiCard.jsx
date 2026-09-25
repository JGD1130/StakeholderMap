// src/components/mf/KpiCard.jsx
//
// Headline number card. A null value or a `missing` prop shows "—" with the
// missing reason as the context line, so "no data" never reads as a real 0.
// `indicator` adds a 4px left accent bar (surplus / deficit); the text itself
// never takes the accent color and the card background is never tinted.
// `compact` is the small version for narrow spots like the side-panel card
// (18px value, tighter padding); the default size is unchanged.
import React from 'react';
import { MF } from '../../theme/mfTokens';
import { mfCardStyle } from './mfStyles';

const INDICATOR_COLORS = {
  surplus: MF.diverging.surplus,
  deficit: MF.diverging.deficit
};

export default function KpiCard({ value, label, context, missing, indicator, compact = false }) {
  const isMissing = value === null || value === undefined || Boolean(missing);
  const shownValue = isMissing ? '—' : String(value);
  const shownContext = isMissing && missing?.reason ? missing.reason : context;
  const accent = INDICATOR_COLORS[indicator];

  return (
    // With an accent bar, the 4px bar sits inside the left padding plus 4px.
    <div
      style={{
        ...mfCardStyle,
        overflow: 'hidden',
        ...(compact ? { padding: '8px 10px' } : null),
        paddingLeft: (compact ? 10 : 16) + (accent ? 4 : 0)
      }}
    >
      {accent ? (
        <span
          aria-hidden="true"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }}
        />
      ) : null}
      <div style={{ fontSize: compact ? 18 : 26, fontWeight: 600, lineHeight: 1.15, color: MF.ink.primary, overflowWrap: 'anywhere' }}>
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
