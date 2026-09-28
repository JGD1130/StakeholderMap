// src/components/mf/charts/StackedBars.jsx
//
// Horizontal stacked bars, one row per item: label column on the left, the
// row's segments laid end to end in their own colors, and the row total just
// past the bar. Shared 0-to-max scale with a dollar/number axis under the
// plot (hairline ticks, 11px ink.muted labels). Drawn 1:1 at `width`; height
// follows from the row count. Hover a row for its tooltip.
//
// rows: [{ key, label, segments: [{ key, value (>= 0), color }], total, totalLabel, tooltip: { title, rows } }]
// formatTick: (value) => axis label.
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { barPath, estimateTextWidth, niceTicks, wrapText } from './chartUtils';

const LABEL_FONT = 12;
const AXIS_FONT = 11;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 14;

export default function StackedBars({ width, rows, formatTick = String, ariaLabel }) {
  const tip = useChartTooltip();

  const labelCol = Math.min(Math.max(...rows.map((r) => estimateTextWidth(r.label, LABEL_FONT)), 60) + 12, width * 0.34);
  const valueRoom = Math.max(...rows.map((r) => estimateTextWidth(r.totalLabel, LABEL_FONT)), 30) + 10;
  const x0 = labelCol;
  const plotWidth = Math.max(60, width - x0 - valueRoom);
  const maxTotal = Math.max(...rows.map((r) => r.total), 0);
  const ticks = niceTicks(maxTotal);
  const axisMax = Math.max(maxTotal, ticks[ticks.length - 1] || 0, 1);
  const xFor = (v) => x0 + (Math.max(0, v) / axisMax) * plotWidth;

  const plotHeight = rows.length * ROW_HEIGHT;
  const height = plotHeight + AXIS_FONT + 14;

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xFor(t)} y1={0} x2={xFor(t)} y2={plotHeight + 4} stroke={MF.line.hairline} strokeWidth={1} />
            <text x={xFor(t)} y={plotHeight + AXIS_FONT + 8} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor="middle">{formatTick(t)}</text>
          </g>
        ))}

        {rows.map((row, i) => {
          const rowY = i * ROW_HEIGHT;
          const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
          const textY = rowY + ROW_HEIGHT / 2 + LABEL_FONT * 0.35;
          // One line of label; long names are shortened with an ellipsis and
          // shown in full in the tooltip.
          const [firstLine, ...rest] = wrapText(row.label, labelCol - 10, LABEL_FONT);
          const label = rest.length ? `${firstLine}…` : firstLine;
          let cursor = 0;
          const visible = row.segments.filter((s) => s.value > 0);
          return (
            <g key={row.key}>
              <text x={0} y={textY} fontSize={LABEL_FONT} fill={MF.ink.secondary}>{label}</text>
              {visible.map((s, si) => {
                const xa = xFor(cursor);
                cursor += s.value;
                const xb = xFor(cursor);
                const isLast = si === visible.length - 1;
                return isLast
                  ? <path key={s.key} d={barPath(xa, barY, xb - xa, BAR_HEIGHT, 3, 'right')} fill={s.color} />
                  : <rect key={s.key} x={xa} y={barY} width={Math.max(0, xb - xa)} height={BAR_HEIGHT} fill={s.color} />;
              })}
              <text x={xFor(row.total) + 6} y={textY} fontSize={LABEL_FONT} fontWeight={600} fill={MF.ink.primary}>{row.totalLabel}</text>
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
