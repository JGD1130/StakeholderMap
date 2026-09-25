// src/components/mf/charts/PhasingTimeline.jsx
//
// One bar per project on a shared date axis. Two-line labels in a left
// column sized so they're never truncated and never overlap the bars; the
// year axis runs along the TOP of the plot with hairline gridlines through
// every row; a dashed "Today" marker is labeled in its own row above the
// year labels so the two can't collide. Drawn 1:1 at `width`; height follows
// from the rows. Hover a row for its tooltip.
//
// rows:  [{ key, line1, line2, start (ms), end (ms), color, tooltip: { title, rows } }]
// range: { minTime, maxTime } (ms) -- the axis span, decided by the caller.
// now:   ms for the Today marker (defaults to the current time).
import React from 'react';
import { MF } from '../../../theme/mfTokens';
import { ChartTooltip, useChartTooltip } from './ChartTooltip';
import { estimateTextWidth } from './chartUtils';

const ROW_HEIGHT = 36;
const BAR_HEIGHT = 14;
const LINE1_FONT = 12;
const LINE2_FONT = 11;
const AXIS_FONT = 11;
const TODAY_ROW_Y = 12; // baseline of "Today"
const YEAR_ROW_Y = 30; // baseline of the year labels
const PLOT_TOP = 40;
const PLOT_BOTTOM_PAD = 4;
const LABEL_GAP = 16;

export default function PhasingTimeline({ width, rows, range, now = Date.now(), ariaLabel }) {
  const tip = useChartTooltip();

  // At least 28% of the width (min 220px), wider if a label needs it --
  // labels are never truncated -- but never more than half the chart.
  const longestLabel = Math.max(
    ...rows.map((r) => Math.max(estimateTextWidth(r.line1, LINE1_FONT) * 1.05, estimateTextWidth(r.line2, LINE2_FONT))),
    0
  );
  const labelCol = Math.min(Math.max(220, width * 0.28, longestLabel + 4), width * 0.5);
  const x0 = labelCol + LABEL_GAP;
  const x1 = Math.max(x0 + 60, width - 8);
  const { minTime, maxTime } = range;
  const span = Math.max(maxTime - minTime, 1);
  const xFor = (ms) => x0 + ((Math.max(minTime, Math.min(maxTime, ms)) - minTime) / span) * (x1 - x0);

  const plotBottom = PLOT_TOP + rows.length * ROW_HEIGHT;
  const height = plotBottom + PLOT_BOTTOM_PAD;

  // Jan 1 of every year inside the axis range.
  const yearTicks = [];
  for (let yr = new Date(minTime).getUTCFullYear(); yr <= new Date(maxTime).getUTCFullYear(); yr += 1) {
    const t = Date.UTC(yr, 0, 1);
    if (t >= minTime && t <= maxTime) yearTicks.push({ t, label: String(yr) });
  }
  // A range inside a single calendar year has no Jan 1 to mark; label its ends instead.
  const endLabels = yearTicks.length ? [] : [
    { t: minTime, label: new Date(minTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), anchor: 'start' },
    { t: maxTime, label: new Date(maxTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), anchor: 'end' }
  ];

  const showToday = now >= minTime && now <= maxTime;
  const todayX = showToday ? xFor(now) : null;
  const todayHalf = estimateTextWidth('Today', AXIS_FONT) / 2;
  const clampLabelX = (x, half) => Math.min(Math.max(x, x0 + half), x1 - half);

  return (
    <div ref={tip.containerRef} style={{ position: 'relative' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} style={{ display: 'block', fontFamily: MF.type.family }}>
        {/* Year gridlines + labels (top axis) */}
        {yearTicks.map(({ t, label }) => {
          const x = xFor(t);
          const half = estimateTextWidth(label, AXIS_FONT) / 2;
          return (
            <g key={t}>
              <line x1={x} y1={PLOT_TOP - 4} x2={x} y2={plotBottom} stroke={MF.line.hairline} strokeWidth={1} />
              <text x={clampLabelX(x, half)} y={YEAR_ROW_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor="middle">{label}</text>
            </g>
          );
        })}
        {endLabels.map(({ t, label, anchor }) => (
          <text key={label} x={xFor(t)} y={YEAR_ROW_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor={anchor}>{label}</text>
        ))}
        <line x1={x0} y1={PLOT_TOP - 4} x2={x1} y2={PLOT_TOP - 4} stroke={MF.line.hairline} strokeWidth={1} />

        {/* Rows */}
        {rows.map((row, i) => {
          const rowY = PLOT_TOP + i * ROW_HEIGHT;
          const midY = rowY + ROW_HEIGHT / 2;
          const bx0 = xFor(row.start);
          const bx1 = xFor(row.end);
          const barX = Math.min(bx0, bx1);
          const barW = Math.max(Math.abs(bx1 - bx0), 6);
          return (
            <g key={row.key}>
              <text x={0} y={row.line2 ? midY - 3 : midY + 4} fontSize={LINE1_FONT} fontWeight={600} fill={MF.ink.primary}>{row.line1}</text>
              {row.line2 ? (
                <text x={0} y={midY + 12} fontSize={LINE2_FONT} fill={MF.ink.muted}>{row.line2}</text>
              ) : null}
              <rect x={barX} y={midY - BAR_HEIGHT / 2} width={barW} height={BAR_HEIGHT} rx={4} ry={4} fill={row.color} />
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

        {/* Today marker: own label row above the year labels */}
        {showToday ? (
          <g pointerEvents="none">
            <line x1={todayX} y1={YEAR_ROW_Y + 5} x2={todayX} y2={plotBottom} stroke={MF.ink.muted} strokeWidth={1} strokeDasharray="4 3" />
            <text x={clampLabelX(todayX, todayHalf)} y={TODAY_ROW_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor="middle">Today</text>
          </g>
        ) : null}
      </svg>
      <ChartTooltip tip={tip.state} />
    </div>
  );
}
