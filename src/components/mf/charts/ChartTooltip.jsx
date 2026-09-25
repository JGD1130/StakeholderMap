// src/components/mf/charts/ChartTooltip.jsx
//
// Hover tooltip shared by the mf/ charts: a plain absolutely positioned div
// (ink text on white, hairline border) inside the chart's own
// position:relative wrapper.
//
//   const tip = useChartTooltip();
//   <div ref={tip.containerRef} style={{ position: 'relative' }}>
//     <svg>… onMouseMove={(e) => tip.show(e, content)} onMouseLeave={tip.hide} …</svg>
//     <ChartTooltip tip={tip.state} />
//   </div>
//
// content = { title, rows: [[label, value], …] }.
import React, { useCallback, useRef, useState } from 'react';
import { MF } from '../../../theme/mfTokens';

const OFFSET = 12;
const FLIP_MARGIN = 220; // flip to the cursor's left when this close to the right edge

export function useChartTooltip() {
  const containerRef = useRef(null);
  const [state, setState] = useState(null);

  const show = useCallback((event, content) => {
    const el = containerRef.current;
    if (!el || !content) return;
    const rect = el.getBoundingClientRect();
    setState({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      flip: event.clientX - rect.left > rect.width - FLIP_MARGIN,
      content
    });
  }, []);
  const hide = useCallback(() => setState(null), []);

  return { containerRef, state, show, hide };
}

export function ChartTooltip({ tip }) {
  if (!tip) return null;
  const { x, y, flip, content } = tip;
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left: flip ? x - OFFSET : x + OFFSET,
        top: y + OFFSET,
        transform: flip ? 'translateX(-100%)' : undefined,
        zIndex: 2,
        pointerEvents: 'none',
        background: MF.surface.page,
        border: `1px solid ${MF.line.hairline}`,
        borderRadius: 6,
        padding: '6px 8px',
        fontFamily: MF.type.family,
        fontSize: 12,
        lineHeight: 1.45,
        color: MF.ink.primary,
        whiteSpace: 'nowrap'
      }}
    >
      {content.title ? <div style={{ fontWeight: 600, marginBottom: 2 }}>{content.title}</div> : null}
      {(content.rows || []).map(([label, value]) => (
        <div key={label}>
          <span style={{ color: MF.ink.muted }}>{label}: </span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
