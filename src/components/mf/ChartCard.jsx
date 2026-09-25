// src/components/mf/ChartCard.jsx
//
// Card that measures its chart area and hands the chart real pixel sizes:
//   <ChartCard title="…">{({ width, height }) => <svg width={width} … />}</ChartCard>
// Charts should draw in those pixels (viewBox equal to width/height), never a
// fixed viewBox scaled to fit -- scaling is what shrank chart text to ~6px.
// Nothing renders in the body until the first measurement.
//
// The card fills its grid cell (height 100%), so ChartCards in the same
// MfGrid row are equal height: the chart body flexes to take the spare room
// and the footnote stays pinned to the bottom. The chart itself sits in an
// absolutely positioned layer, so it never affects the card's height -- the
// body is `minHeight` tall, or taller when the row stretches it, and the
// chart gets exactly that size. Set `minHeight` to the height the chart needs.
//
// `autoHeight` is for content whose height comes from the content itself
// (a list, a row of Gauges, a chart that derives its height from `width`):
// the body is sized by its children instead, and `height` is just the
// current measurement -- size such content from `width` only. Cards in the
// same row still match heights; shorter content sits at the top.
import React from 'react';
import { MF } from '../../theme/mfTokens';
import { mfCardStyle } from './mfStyles';
import { useElementSize } from './useElementSize';

export default function ChartCard({ title, subtitle, footnote, actions, minHeight = 160, autoHeight = false, children }) {
  const [bodyRef, size] = useElementSize();
  const canRender = size && size.width > 0 && (autoHeight || size.height > 0) && typeof children === 'function';

  return (
    <div style={{ ...mfCardStyle, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {title || subtitle || actions ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            {title ? <div style={{ fontSize: 14, fontWeight: 600, color: MF.ink.primary }}>{title}</div> : null}
            {subtitle ? <div style={{ marginTop: 2, fontSize: 12, color: MF.ink.muted }}>{subtitle}</div> : null}
          </div>
          {actions ? <div style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>{actions}</div> : null}
        </div>
      ) : null}

      {autoHeight ? (
        <div ref={bodyRef} style={{ flex: '1 1 auto', minWidth: 0 }}>
          {canRender ? children(size) : null}
        </div>
      ) : (
        <div ref={bodyRef} style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, minHeight }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            {canRender ? children(size) : null}
          </div>
        </div>
      )}

      {footnote ? (
        <div style={{ flex: '0 0 auto', marginTop: 10, fontSize: 11, color: MF.ink.muted }}>{footnote}</div>
      ) : null}
    </div>
  );
}
