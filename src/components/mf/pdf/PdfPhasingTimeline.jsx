// src/components/mf/pdf/PdfPhasingTimeline.jsx
//
// react-pdf version of PhasingTimeline, same layout: two-line labels in a
// left column (sized so they're never truncated and never overlap the bars),
// bars colored by project type, year labels along the top with hairline
// gridlines through every row, and a dashed Today marker labeled in its own
// row above the year labels. Rows arrive built and sorted by
// executiveDashboardView.js phasingRows(); `range` is the same
// getPhasingAxisRange the screen uses.
//
// Row height shrinks (30pt down to 20pt) only if needed to fit `maxHeight`.
import React from 'react';
import { Svg, G, Line, Rect, Text as SvgText } from '@react-pdf/renderer';
import { MF } from '../../../theme/mfTokens';
import { estimateTextWidth } from '../charts/chartUtils';
import { PDF_FONT_BOLD } from './PdfPrimitives';

const LINE1_FONT = 10;
const LINE2_FONT = 9;
const AXIS_FONT = 9;
const BAR_HEIGHT = 11;
const TODAY_Y = 10;
const YEAR_Y = 24;
const PLOT_TOP = 32;
const LABEL_GAP = 12;

export default function PdfPhasingTimeline({ width, rows, range, now = Date.now(), maxHeight = Infinity }) {
  const rowHeight = Math.max(20, Math.min(30, (maxHeight - PLOT_TOP - 4) / Math.max(rows.length, 1)));
  const longest = Math.max(
    ...rows.map((r) => Math.max(estimateTextWidth(r.line1, LINE1_FONT) * 1.05, estimateTextWidth(r.line2, LINE2_FONT))),
    0
  );
  const labelCol = Math.min(Math.max(165, width * 0.28, longest + 4), width * 0.5);
  const x0 = labelCol + LABEL_GAP;
  const x1 = Math.max(x0 + 60, width - 6);
  const { minTime, maxTime } = range;
  const span = Math.max(maxTime - minTime, 1);
  const xFor = (ms) => x0 + ((Math.max(minTime, Math.min(maxTime, ms)) - minTime) / span) * (x1 - x0);
  const plotBottom = PLOT_TOP + rows.length * rowHeight;
  const height = plotBottom + 4;

  const yearTicks = [];
  for (let yr = new Date(minTime).getUTCFullYear(); yr <= new Date(maxTime).getUTCFullYear(); yr += 1) {
    const t = Date.UTC(yr, 0, 1);
    if (t >= minTime && t <= maxTime) yearTicks.push({ t, label: String(yr) });
  }
  const endLabels = yearTicks.length ? [] : [
    { t: minTime, label: new Date(minTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), anchor: 'start' },
    { t: maxTime, label: new Date(maxTime).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), anchor: 'end' }
  ];
  const clampX = (x, half) => Math.min(Math.max(x, x0 + half), x1 - half);
  const showToday = now >= minTime && now <= maxTime;
  const todayX = showToday ? xFor(now) : null;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {yearTicks.map(({ t, label }) => {
        const x = xFor(t);
        return (
          <G key={t}>
            <Line x1={x} y1={PLOT_TOP - 3} x2={x} y2={plotBottom} stroke={MF.line.hairline} strokeWidth={0.75} />
            <SvgText x={clampX(x, estimateTextWidth(label, AXIS_FONT) / 2)} y={YEAR_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor="middle">{label}</SvgText>
          </G>
        );
      })}
      {endLabels.map(({ t, label, anchor }) => (
        <SvgText key={label} x={xFor(t)} y={YEAR_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor={anchor}>{label}</SvgText>
      ))}
      <Line x1={x0} y1={PLOT_TOP - 3} x2={x1} y2={PLOT_TOP - 3} stroke={MF.line.hairline} strokeWidth={0.75} />

      {rows.map((row, i) => {
        const midY = PLOT_TOP + i * rowHeight + rowHeight / 2;
        const bx0 = xFor(row.start);
        const bx1 = xFor(row.end);
        return (
          <G key={row.key}>
            <SvgText x={0} y={row.line2 ? midY - 1.5 : midY + 3.5} fontSize={LINE1_FONT} fill={MF.ink.primary} style={{ fontFamily: PDF_FONT_BOLD }}>{row.line1}</SvgText>
            {row.line2 ? <SvgText x={0} y={midY + 9} fontSize={LINE2_FONT} fill={MF.ink.muted}>{row.line2}</SvgText> : null}
            <Rect x={Math.min(bx0, bx1)} y={midY - BAR_HEIGHT / 2} width={Math.max(Math.abs(bx1 - bx0), 4)} height={BAR_HEIGHT} rx={3} ry={3} fill={row.color} />
          </G>
        );
      })}

      {showToday ? (
        <G>
          <Line x1={todayX} y1={YEAR_Y + 4} x2={todayX} y2={plotBottom} stroke={MF.ink.muted} strokeWidth={0.75} strokeDasharray="3,2" />
          <SvgText x={clampX(todayX, estimateTextWidth('Today', AXIS_FONT) / 2)} y={TODAY_Y} fontSize={AXIS_FONT} fill={MF.ink.muted} textAnchor="middle">Today</SvgText>
        </G>
      ) : null}
    </Svg>
  );
}
