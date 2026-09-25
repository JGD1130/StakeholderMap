// src/components/mf/charts/ScoreTable.jsx
//
// Ranked table: Rank · Name · Score (small 0-100 bar + number) · Cost
// (right-aligned). Rows highlight on hover and show a tooltip. Rows render
// in the order given (callers pass them ranked).
//
// rows: [{ key, rank, name, score (0-100), costLabel, tooltip: { title, rows } }]
import React, { useState } from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';

const SCORE_BAR_WIDTH = 64;

const headerCell = {
  padding: '6px 8px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: MF.ink.muted,
  borderBottom: `1px solid ${MF.line.hairline}`,
  textAlign: 'left',
  whiteSpace: 'nowrap'
};
const bodyCell = {
  padding: '8px',
  fontSize: 12,
  color: MF.ink.primary,
  borderBottom: `1px solid ${MF.line.hairline}`,
  verticalAlign: 'middle'
};

export default function ScoreTable({
  rows,
  nameHeader = 'Building',
  scoreHeader = 'Score',
  costHeader = 'Est. cost',
  barColor = MF.tier[1]
}) {
  const tip = useChartTooltip();
  const [hoverKey, setHoverKey] = useState(null);

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      {/* White table on the gray card, so the surface.card hover highlight shows. */}
      <table style={{ width: '100%', borderCollapse: 'collapse', background: MF.surface.page, fontFamily: MF.type.family }}>
        <thead>
          <tr>
            <th style={{ ...headerCell, width: 44 }}>Rank</th>
            <th style={headerCell}>{nameHeader}</th>
            <th style={{ ...headerCell, width: SCORE_BAR_WIDTH + 44 }}>{scoreHeader}</th>
            <th style={{ ...headerCell, textAlign: 'right', width: 80 }}>{costHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const score = Math.max(0, Math.min(100, Number(row.score) || 0));
            return (
              <tr
                key={row.key}
                style={{ background: hoverKey === row.key ? MF.surface.card : undefined }}
                onMouseMove={(e) => { setHoverKey(row.key); tip.show(e, row.tooltip); }}
                onMouseLeave={() => { setHoverKey(null); tip.hide(); }}
              >
                <td style={{ ...bodyCell, color: MF.ink.muted }}>{row.rank}</td>
                <td style={{ ...bodyCell, fontWeight: 600 }}>{row.name}</td>
                <td style={bodyCell}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span
                      aria-hidden="true"
                      style={{ position: 'relative', display: 'inline-block', width: SCORE_BAR_WIDTH, height: 6, borderRadius: 3, background: MF.line.hairline, overflow: 'hidden' }}
                    >
                      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${score}%`, background: barColor }} />
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.score}</span>
                  </span>
                </td>
                <td style={{ ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.costLabel}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
