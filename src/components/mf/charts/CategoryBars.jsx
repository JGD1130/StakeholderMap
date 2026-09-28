// src/components/mf/charts/CategoryBars.jsx
//
// Horizontal bars for a few categories on a 0-to-max scale (counts or
// dollars): label column on the left with an optional muted sublabel
// ("Tier 1  0–5 yrs"), one bar per row in the row's own color, and the value
// label just past each bar's end. Drawn 1:1 at `width`; height follows from
// the row count. Hover a row for its tooltip.
//
// rows: [{ key, label, sublabel?, value (>= 0), valueLabel, color, tooltip: { title, rows } }]
// A row { key, header } instead draws a small group sub-header (e.g. "Direct")
// across the chart, with no bar; bars keep one shared scale across groups.
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { barPath, estimateTextWidth } from './chartUtils';

const LABEL_FONT = 12;
const SUB_FONT = 11;
const ROW_HEIGHT = 32;
const BAR_HEIGHT = 16;
const HEADER_FONT = 11;
const HEADER_HEIGHT = 24;

export default function CategoryBars({ width, rows, ariaLabel }) {
  const tip = useChartTooltip();
  const barRows = rows.filter((r) => !r.header);

  const labelCol = Math.min(
    Math.max(...barRows.map((r) => (
      estimateTextWidth(r.label, LABEL_FONT) + (r.sublabel ? estimateTextWidth(r.sublabel, SUB_FONT) + 8 : 0)
    )), 40) + 14,
    width * 0.4
  );
  const valueRoom = Math.max(...barRows.map((r) => estimateTextWidth(r.valueLabel, LABEL_FONT)), 24) + 10;
  const x0 = labelCol;
  const plotWidth = Math.max(40, width - x0 - valueRoom);
  const maxValue = Math.max(...barRows.map((r) => (Number.isFinite(r.value) ? r.value : 0)), 0);
  const xFor = (v) => x0 + (maxValue > 0 ? (Math.max(0, v) / maxValue) * plotWidth : 0);
  let cursor = 0;
  const laidOut = rows.map((row) => {
    const y = cursor;
    cursor += row.header ? HEADER_HEIGHT : ROW_HEIGHT;
    return { row, y };
  });
  const height = cursor;

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {laidOut.filter(({ row }) => !row.header).map(({ row, y }) => (
          <line key={`axis-${row.key}`} x1={x0} y1={y} x2={x0} y2={y + ROW_HEIGHT} stroke={MF.line.hairline} strokeWidth={1} />
        ))}
        {laidOut.map(({ row, y: rowY }) => {
          if (row.header) {
            return (
              <text
                key={row.key}
                x={0}
                y={rowY + HEADER_HEIGHT - 7}
                fontSize={HEADER_FONT}
                fontWeight={600}
                letterSpacing="0.04em"
                fill={MF.ink.muted}
                style={{ textTransform: 'uppercase' }}
              >
                {row.header}
              </text>
            );
          }
          const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
          const textY = rowY + ROW_HEIGHT / 2 + LABEL_FONT * 0.35;
          const barEnd = xFor(row.value);
          return (
            <g key={row.key}>
              <text x={0} y={textY} fontSize={LABEL_FONT} fill={MF.ink.secondary}>
                {row.label}
                {row.sublabel ? (
                  <tspan dx={8} fontSize={SUB_FONT} fill={MF.ink.muted}>{row.sublabel}</tspan>
                ) : null}
              </text>
              {barEnd > x0 ? (
                <path d={barPath(x0, barY, barEnd - x0, BAR_HEIGHT, 3, 'right')} fill={row.color} />
              ) : null}
              <text x={barEnd + 6} y={textY} fontSize={LABEL_FONT} fontWeight={600} fill={MF.ink.primary}>
                {row.valueLabel}
              </text>
              <rect
                x={0}
                y={rowY}
                width={width}
                height={ROW_HEIGHT}
                fill="transparent"
                onMouseMove={(e) => tip.show(e, row.tooltip)}
                onMouseLeave={tip.hide}
              />
            </g>
          );
        })}
      </svg>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
