// src/components/mf/charts/UtilBar.jsx
//
// Inline utilization bar for table cells: hairline track, util.base fill (capped
// at 100%), an ink tick at the target (default MF.util.target, 65%), and the
// number beside it. A null value shows "—" with an empty track.
//
//   <UtilBar value={37} />   // value is a percentage, 0-100 (may exceed 100)
import React from 'react';
import { MF } from '../../../theme/mfTokens';

export default function UtilBar({ value, target = MF.util.target, width = 88 }) {
  const hasValue = Number.isFinite(value);
  const fill = hasValue ? Math.max(0, Math.min(100, value)) : 0;
  const hasTarget = Number.isFinite(target);
  const label = hasValue ? `${Math.round(value)}%` : '—';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        aria-hidden="true"
        style={{ position: 'relative', display: 'inline-block', width, height: 6, borderRadius: 3, background: MF.line.hairline }}
      >
        {fill > 0 ? (
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fill}%`, borderRadius: 3, background: MF.util.base }} />
        ) : null}
        {hasTarget ? (
          <span
            style={{
              position: 'absolute',
              left: `${Math.max(0, Math.min(1, target)) * 100}%`,
              top: -3,
              bottom: -3,
              width: 2,
              marginLeft: -1,
              background: MF.ink.primary
            }}
          />
        ) : null}
      </span>
      <span style={{ minWidth: 34, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: hasValue ? MF.ink.primary : MF.ink.muted }}>
        {label}
      </span>
    </span>
  );
}
