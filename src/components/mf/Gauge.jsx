// src/components/mf/Gauge.jsx
//
// 180° utilization gauge. The arc is utilBands(8, { from: 30, to: 100 })
// filled up to `value`; the rest of the arc is the util.noData track. Needle
// and target tick are ink.primary; the target is labeled from `target`
// ("65% target"). Layout math and arc colors live in gaugeGeometry.js
// (shared with the Phase 2 PDF gauge).
//
// Drawn in real pixels: the svg's viewBox equals its rendered size, so every
// font size here is the size on screen. Width fits the container (max 240px)
// unless `size` is given.
//
// The whole gauge is one role="img" with a spoken summary, e.g.
// "Classroom Time Utilization, Fall 2026 Block 1: 37%, target 65%".
import React from 'react';
import { MF, utilColor } from '../../theme/mfTokens';
import { mfPillStyle } from './mfStyles';
import { useElementSize } from './useElementSize';
import { computeGaugeGeometry, formatGaugePct } from './gaugeGeometry';

const MAX_SIZE = 240;

function GaugeSvg({ width, value, target }) {
  const g = computeGaugeGeometry({ width, value, target });
  return (
    <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true" focusable="false" style={{ display: 'block', overflow: 'visible' }}>
      {g.segments.map((s) => (
        <path key={`${s.from}-${s.to}`} d={s.d} fill="none" stroke={s.color} strokeWidth={g.stroke} strokeLinecap="butt" />
      ))}
      {g.tick ? (
        <g>
          <line x1={g.tick.x1} y1={g.tick.y1} x2={g.tick.x2} y2={g.tick.y2} stroke={MF.ink.primary} strokeWidth={2.5} strokeLinecap="round" />
          <text x={g.tick.label.x} y={g.tick.label.y} fontSize={g.labelFont} fill={MF.ink.primary} textAnchor={g.tick.label.anchor}>
            {g.tick.label.text}
          </text>
        </g>
      ) : null}
      {g.needle ? (
        <g>
          <line x1={g.needle.x1} y1={g.needle.y1} x2={g.needle.x2} y2={g.needle.y2} stroke={MF.ink.primary} strokeWidth={3} strokeLinecap="round" />
          <circle cx={g.cx} cy={g.cy} r={g.needle.pivotR} fill={MF.ink.primary} />
        </g>
      ) : null}
      {g.endLabels.map((l) => (
        <text key={l.text} x={l.x} y={l.y} fontSize={g.labelFont} fill={MF.ink.muted} textAnchor={l.anchor}>{l.text}</text>
      ))}
      <text x={g.valueLabel.x} y={g.valueLabel.y} fontSize={g.valueFont} fontWeight={600} fill={MF.ink.primary} textAnchor={g.valueLabel.anchor}>
        {g.valueLabel.text}
      </text>
    </svg>
  );
}

// "Classroom Time Utilization, Fall 2026 Block 1: 37%, target 65%". The
// subtitle's "·" separator is dropped so it isn't read aloud as "dot".
function spokenLabel({ title, subtitle, value, target }) {
  const name = [title, subtitle ? String(subtitle).replace(/\s*·\s*/g, ' ') : null].filter(Boolean).join(', ');
  const reading = Number.isFinite(value) ? formatGaugePct(Math.max(0, Math.min(1, value))) : 'no data';
  const targetText = Number.isFinite(target) ? `, target ${formatGaugePct(Math.max(0, Math.min(1, target)))}` : '';
  return `${name ? `${name}: ` : ''}${reading}${targetText}`;
}

export default function Gauge({ value, target = MF.util.target, title, subtitle, pill, size }) {
  const [wrapRef, measured] = useElementSize();
  const fixed = Number.isFinite(size) && size > 0 ? size : null;
  const width = fixed ?? (measured ? Math.min(measured.width, MAX_SIZE) : null);
  const pillEl = pill ? <span style={{ ...mfPillStyle, color: MF.util.base, background: utilColor(10) }}>{pill}</span> : null;

  return (
    <div
      role="img"
      aria-label={spokenLabel({ title, subtitle, value, target })}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, fontFamily: MF.type.family }}
    >
      {/* The pill follows the subtitle; with no subtitle it sits on the title
          line, so gauges side by side (some with a pill, some without) keep
          their arcs level. */}
      {title ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: MF.ink.primary, textAlign: 'center' }}>{title}</span>
          {pill && !subtitle ? pillEl : null}
        </div>
      ) : null}
      {subtitle || (pill && !title) ? (
        <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
          {subtitle ? <span style={{ fontSize: 12, color: MF.ink.muted }}>{subtitle}</span> : null}
          {pill ? pillEl : null}
        </div>
      ) : null}
      <div ref={wrapRef} style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'center', marginTop: 6, minWidth: 0 }}>
        {width ? <GaugeSvg width={width} value={value} target={target} /> : null}
      </div>
    </div>
  );
}
