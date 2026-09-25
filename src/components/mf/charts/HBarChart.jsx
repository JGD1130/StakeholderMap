// src/components/mf/charts/HBarChart.jsx
//
// Horizontal percentage bars on a 0-100% axis: label column on the left, one
// bar per row in a single color, the value label just past each bar's end,
// and a muted count column on the right. Optional dashed target line
// ("65% target"), labeled once above the plot. Drawn 1:1 at `width`; height
// follows from the row count. Hover a row for its tooltip.
//
// rows: [{ key, label, value (0-100 or null), valueLabel, countLabel, tooltip: { title, rows } }]
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { barPath, estimateTextWidth } from './chartUtils';

const LABEL_FONT = 12;
const SMALL_FONT = 11;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 14;
const TOP = 22; // room for the target label
const AXIS_TICKS = [0, 25, 50, 75, 100];

export default function HBarChart({ width, rows, target, color = MF.util.base, ariaLabel }) {
  const tip = useChartTooltip();

  const labelCol = Math.min(
    Math.max(...rows.map((r) => estimateTextWidth(r.label, LABEL_FONT)), 40) + 12,
    width * 0.32
  );
  const countCol = Math.max(...rows.map((r) => estimateTextWidth(r.countLabel, SMALL_FONT)), 30) + 10;
  const valueRoom = estimateTextWidth('100%', LABEL_FONT) + 10;
  const x0 = labelCol;
  const x1 = Math.max(x0 + 40, width - countCol - valueRoom);
  const plotWidth = x1 - x0;
  const xFor = (pct) => x0 + (Math.max(0, Math.min(100, pct)) / 100) * plotWidth;

  const axisY = TOP + rows.length * ROW_HEIGHT + 4;
  const height = axisY + SMALL_FONT + 10;

  const hasTarget = Number.isFinite(target);
  const targetX = hasTarget ? xFor(target * 100) : null;
  const targetLabel = hasTarget ? `${Math.round(target * 100)}% target` : '';
  // Keep the target label inside the drawing near either end.
  const targetLabelHalf = estimateTextWidth(targetLabel, SMALL_FONT) / 2;
  const targetLabelX = hasTarget ? Math.min(Math.max(targetX, targetLabelHalf), width - targetLabelHalf) : null;

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {/* Axis and ticks */}
        <line x1={x0} y1={axisY} x2={x1} y2={axisY} stroke={MF.line.hairline} strokeWidth={1} />
        {AXIS_TICKS.map((t) => (
          <g key={t}>
            <line x1={xFor(t)} y1={TOP - 4} x2={xFor(t)} y2={axisY} stroke={MF.line.hairline} strokeWidth={1} />
            <text x={xFor(t)} y={axisY + SMALL_FONT + 4} fontSize={SMALL_FONT} fill={MF.ink.muted} textAnchor="middle">{`${t}%`}</text>
          </g>
        ))}

        {rows.map((row, i) => {
          const rowY = TOP + i * ROW_HEIGHT;
          const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
          const textY = rowY + ROW_HEIGHT / 2 + LABEL_FONT * 0.35;
          const hasValue = Number.isFinite(row.value);
          const barEnd = hasValue ? xFor(row.value) : x0;
          return (
            <g key={row.key}>
              <text x={0} y={textY} fontSize={LABEL_FONT} fill={MF.ink.secondary}>{row.label}</text>
              {hasValue && barEnd > x0 ? (
                <path d={barPath(x0, barY, barEnd - x0, BAR_HEIGHT, 3, 'right')} fill={color} />
              ) : null}
              <text
                x={barEnd + 6}
                y={textY}
                fontSize={LABEL_FONT}
                fontWeight={600}
                fill={hasValue ? MF.ink.primary : MF.ink.muted}
              >
                {hasValue ? row.valueLabel : '—'}
              </text>
              <text x={width} y={textY} fontSize={SMALL_FONT} fill={MF.ink.muted} textAnchor="end">{row.countLabel}</text>
              {/* Full-row hover target */}
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

        {hasTarget ? (
          <g pointerEvents="none">
            <line x1={targetX} y1={TOP - 4} x2={targetX} y2={axisY} stroke={MF.ink.primary} strokeWidth={1.25} strokeDasharray="4 3" />
            <text x={targetLabelX} y={TOP - 8} fontSize={SMALL_FONT} fill={MF.ink.primary} textAnchor="middle">{targetLabel}</text>
          </g>
        ) : null}
      </svg>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
