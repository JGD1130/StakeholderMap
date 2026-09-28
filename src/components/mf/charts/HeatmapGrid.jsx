// src/components/mf/charts/HeatmapGrid.jsx
//
// Utilization heat map: row labels on the left, one column per category
// (e.g. weekday), each cell filled with utilColor(pct) and labeled with its
// percentage in utilTextColor(pct). A CSS grid, so the columns share the
// card's measured width exactly and text is always drawn at its real size.
// Hover a cell for its tooltip.
//
// columns: [{ key, label }]
// rows:    [{ key, label, cells: [{ key, pct (0-100), label, tooltip (string) }] }]
//
// HeatmapLegend: the same ramp as a 0% -> 100% gradient strip with a caption.
import React from 'react';
import { MF, utilColor, utilTextColor } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';

const ROW_HEIGHT = 28;
const GAP = 2;
const LEGEND_STOPS = [0, 25, 50, 75, 100];

export default function HeatmapGrid({ columns, rows, ariaLabel }) {
  const tip = useChartTooltip();
  const template = `max-content repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <div ref={tip.containerRef} style={{ position: 'relative', fontFamily: MF.type.family }}>
      <div role="table" aria-label={ariaLabel} style={{ display: 'grid', gridTemplateColumns: template, gap: GAP }}>
        <div role="row" style={{ display: 'contents' }}>
          <span role="columnheader" />
          {columns.map((c) => (
            <span
              key={c.key}
              role="columnheader"
              style={{ fontSize: 12, fontWeight: 600, color: MF.ink.secondary, textAlign: 'center', paddingBottom: 4 }}
            >
              {c.label}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.key} role="row" style={{ display: 'contents' }}>
            <span
              role="rowheader"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, fontSize: 12, color: MF.ink.muted, whiteSpace: 'nowrap' }}
            >
              {row.label}
            </span>
            {row.cells.map((cell) => (
              <span
                key={cell.key}
                role="cell"
                aria-label={cell.tooltip}
                onMouseMove={(e) => tip.show(e, { title: cell.tooltip })}
                onMouseLeave={tip.hide}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: ROW_HEIGHT,
                  borderRadius: 3,
                  background: utilColor(cell.pct),
                  color: utilTextColor(cell.pct),
                  fontSize: 12,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {cell.label}
              </span>
            ))}
          </div>
        ))}
      </div>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}

export function HeatmapLegend({ label, width = 160 }) {
  const gradient = `linear-gradient(to right, ${LEGEND_STOPS.map((p) => `${utilColor(p)} ${p}%`).join(', ')})`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontFamily: MF.type.family, fontSize: 11, color: MF.ink.muted }}>
      <span>0%</span>
      <span aria-hidden="true" style={{ display: 'inline-block', width, height: 10, borderRadius: 3, background: gradient }} />
      <span>100%</span>
      {label ? <span style={{ marginLeft: 4, color: MF.ink.secondary }}>{label}</span> : null}
    </div>
  );
}
