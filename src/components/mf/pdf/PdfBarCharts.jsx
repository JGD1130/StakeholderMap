// src/components/mf/pdf/PdfBarCharts.jsx
//
// react-pdf versions of HBarChart (utilization by room size) and
// DivergingBars (space gap by division). Same layout rules and the same
// drawing helpers (chartUtils.js) as the screen charts, drawn 1:1 at `width`
// points with print font sizes. Rows arrive already built and sorted by
// executiveDashboardView.js.
import React from 'react';
import { Svg, G, Line, Path, Text as SvgText } from '@react-pdf/renderer';
import { MF } from '../../../theme/mfTokens';
import { barPath, estimateTextWidth, wrapText } from '../charts/chartUtils';
import { PDF_FONT_BOLD, pdfSafe } from './PdfPrimitives';

const FONT = 9;

// --- Horizontal % bars (room size) -----------------------------------------
const H_ROW = 16;
const H_BAR = 9;
const H_TOP = 14; // target label row
const AXIS_TICKS = [0, 25, 50, 75, 100];

export function PdfHBarChart({ width, rows, target, color = MF.util.base }) {
  const labelCol = Math.min(Math.max(...rows.map((r) => estimateTextWidth(r.label, FONT)), 30) + 8, width * 0.32);
  const countCol = Math.max(...rows.map((r) => estimateTextWidth(r.countLabel, FONT)), 24) + 6;
  const valueRoom = estimateTextWidth('100%', FONT) + 8;
  const x0 = labelCol;
  const x1 = Math.max(x0 + 40, width - countCol - valueRoom);
  const xFor = (pct) => x0 + (Math.max(0, Math.min(100, pct)) / 100) * (x1 - x0);
  const axisY = H_TOP + rows.length * H_ROW + 3;
  const height = axisY + FONT + 6;

  const hasTarget = Number.isFinite(target);
  const targetX = hasTarget ? xFor(target * 100) : null;
  const targetLabel = hasTarget ? `${Math.round(target * 100)}% target` : '';
  const half = estimateTextWidth(targetLabel, FONT) / 2;
  const targetLabelX = hasTarget ? Math.min(Math.max(targetX, half), width - half) : null;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Line x1={x0} y1={axisY} x2={x1} y2={axisY} stroke={MF.line.hairline} strokeWidth={0.75} />
      {AXIS_TICKS.map((t) => (
        <G key={t}>
          <Line x1={xFor(t)} y1={H_TOP - 3} x2={xFor(t)} y2={axisY} stroke={MF.line.hairline} strokeWidth={0.75} />
          <SvgText x={xFor(t)} y={axisY + FONT + 2} fontSize={FONT} fill={MF.ink.muted} textAnchor="middle">{`${t}%`}</SvgText>
        </G>
      ))}
      {rows.map((row, i) => {
        const rowY = H_TOP + i * H_ROW;
        const barY = rowY + (H_ROW - H_BAR) / 2;
        const textY = rowY + H_ROW / 2 + FONT * 0.35;
        const hasValue = Number.isFinite(row.value);
        const end = hasValue ? xFor(row.value) : x0;
        return (
          <G key={row.key}>
            <SvgText x={0} y={textY} fontSize={FONT} fill={MF.ink.secondary}>{row.label}</SvgText>
            {hasValue && end > x0 ? <Path d={barPath(x0, barY, end - x0, H_BAR, 2, 'right')} fill={color} /> : null}
            <SvgText x={end + 4} y={textY} fontSize={FONT} fill={hasValue ? MF.ink.primary : MF.ink.muted} style={{ fontFamily: PDF_FONT_BOLD }}>
              {hasValue ? row.valueLabel : '—'}
            </SvgText>
            <SvgText x={width} y={textY} fontSize={FONT} fill={MF.ink.muted} textAnchor="end">{row.countLabel}</SvgText>
          </G>
        );
      })}
      {hasTarget ? (
        <G>
          <Line x1={targetX} y1={H_TOP - 3} x2={targetX} y2={axisY} stroke={MF.ink.primary} strokeWidth={1} strokeDasharray="3,2" />
          <SvgText x={targetLabelX} y={H_TOP - 5} fontSize={FONT} fill={MF.ink.primary} textAnchor="middle">{targetLabel}</SvgText>
        </G>
      ) : null}
    </Svg>
  );
}

// --- Diverging bars (space gap) --------------------------------------------
const D_LINE = 11;
const D_BAR = 10;
const D_MIN_ROW = 22;
const D_GAP = 4;

export function PdfDivergingBars({ width, rows, formatValue }) {
  const fmt = (v) => pdfSafe(formatValue(v));
  const labelCol = Math.max(90, Math.min(150, width * 0.3));
  const valueRoom = Math.max(...rows.map((r) => estimateTextWidth(Number.isFinite(r.value) ? fmt(r.value) : 'No data', FONT)), 30) + 8;
  const x0 = labelCol + valueRoom;
  const x1 = Math.max(x0 + 40, width - valueRoom);
  const zeroX = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  const maxAbs = Math.max(...rows.filter((r) => Number.isFinite(r.value)).map((r) => Math.abs(r.value)), 1);

  let cursor = 0;
  const laidOut = rows.map((row) => {
    const lines = wrapText(row.label, labelCol - 8, FONT);
    const rowHeight = Math.max(D_MIN_ROW, lines.length * D_LINE + 6);
    const y = cursor;
    cursor += rowHeight + D_GAP;
    return { row, lines, y, rowHeight };
  });
  const height = Math.max(cursor - D_GAP, 1);

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {laidOut.map(({ row, lines, y, rowHeight }) => {
        const midY = y + rowHeight / 2;
        const barY = midY - D_BAR / 2;
        const textY = midY + FONT * 0.35;
        const firstLineY = midY - ((lines.length - 1) * D_LINE) / 2 + FONT * 0.35;
        const hasValue = Number.isFinite(row.value);
        const magnitude = hasValue ? Math.max((Math.abs(row.value) / maxAbs) * half, row.value === 0 ? 0 : 1.5) : 0;
        const negative = hasValue && row.value < 0;
        return (
          <G key={row.key}>
            {lines.map((line, li) => (
              // eslint-disable-next-line react/no-array-index-key -- wrapped lines of one label
              <SvgText key={li} x={0} y={firstLineY + li * D_LINE} fontSize={FONT} fill={MF.ink.secondary}>{line}</SvgText>
            ))}
            {hasValue && magnitude > 0 ? (
              <Path
                d={negative
                  ? barPath(zeroX - magnitude, barY, magnitude, D_BAR, 3, 'left')
                  : barPath(zeroX, barY, magnitude, D_BAR, 3, 'right')}
                fill={negative ? MF.diverging.deficit : MF.diverging.surplus}
              />
            ) : null}
            {hasValue ? (
              <SvgText
                x={negative ? zeroX - magnitude - 4 : zeroX + magnitude + 4}
                y={textY}
                fontSize={FONT}
                fill={MF.ink.primary}
                textAnchor={negative ? 'end' : 'start'}
                style={{ fontFamily: PDF_FONT_BOLD }}
              >
                {fmt(row.value)}
              </SvgText>
            ) : (
              <SvgText x={zeroX + 4} y={textY} fontSize={FONT} fill={MF.ink.muted}>No data</SvgText>
            )}
          </G>
        );
      })}
      <Line x1={zeroX} y1={0} x2={zeroX} y2={height} stroke={MF.diverging.zero} strokeWidth={0.75} />
    </Svg>
  );
}
