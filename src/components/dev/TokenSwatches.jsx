// src/components/dev/TokenSwatches.jsx
//
// Dev aid: a swatch sheet of every design token in src/theme/mfTokens.js.
// Mounted only on the admin page (StakeholderMap.jsx gates it on isAdminMode)
// and renders nothing unless the URL has ?tokens=1.
import React, { useState } from 'react';
import { MF, utilColor, utilTextColor, utilBands } from '../../theme/mfTokens';

function readTokensParam() {
  try {
    return new URLSearchParams(window.location.search).get('tokens') === '1';
  } catch {
    return false;
  }
}

function Swatch({ name, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span
        style={{
          flex: '0 0 auto',
          width: 28,
          height: 28,
          borderRadius: 4,
          background: value,
          border: `1px solid ${MF.line.border}`
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: MF.ink.primary }}>{name}</div>
        <div style={{ fontSize: 11, color: MF.ink.muted, fontFamily: 'monospace' }}>{value}</div>
      </div>
    </div>
  );
}

function Strip({ title, items }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: MF.ink.secondary, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {items.map(({ label, color, textColor }) => (
          <div
            key={label}
            style={{
              flex: '1 0 52px',
              padding: '10px 2px',
              textAlign: 'center',
              fontSize: 11,
              background: color,
              color: textColor
            }}
          >
            <div style={{ fontWeight: 700 }}>{label}</div>
            <div style={{ fontFamily: 'monospace' }}>{color}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TokenSwatches() {
  const [open, setOpen] = useState(readTokensParam);
  if (!open) return null;

  // Color tokens only (strings that look like colors); non-color values
  // (util.target, type.*) are listed as text below.
  const groups = Object.entries(MF).map(([group, values]) => ({
    group,
    entries: Object.entries(values)
  }));
  const isColor = (v) => typeof v === 'string' && /^(#|rgba?\()/.test(v);

  const rampItems = Array.from({ length: 11 }, (_, i) => {
    const pct = i * 10;
    return { label: `${pct}%`, color: utilColor(pct), textColor: utilTextColor(pct) };
  });
  const bandItems = utilBands(8).map((color, i) => {
    const mid = ((i + 0.5) * 100) / 8;
    return { label: `band ${i + 1}`, color, textColor: utilTextColor(mid) };
  });

  return (
    <div
      role="dialog"
      aria-label="Design tokens"
      style={{ position: 'fixed', inset: 0, zIndex: 20000, background: MF.surface.modalBackdrop, display: 'grid', placeItems: 'center' }}
    >
      <div
        style={{
          width: 'min(900px, 94vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 16,
          borderRadius: 10,
          background: MF.surface.page,
          fontFamily: MF.type.family,
          color: MF.ink.primary
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Mapfluence design tokens (mfTokens.js)</div>
          <button className="btn" type="button" onClick={() => setOpen(false)}>Close</button>
        </div>

        {groups.map(({ group, entries }) => (
          <div key={group} style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: MF.ink.secondary, marginBottom: 6 }}>MF.{group}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
              {entries.map(([key, value]) => (
                isColor(value) ? (
                  <Swatch key={key} name={`${group}.${key}`} value={value} />
                ) : (
                  <div key={key} style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <span style={{ fontWeight: 600 }}>{`${group}.${key}`}</span>
                    <span style={{ color: MF.ink.muted, fontFamily: 'monospace' }}>{` = ${String(value)}`}</span>
                  </div>
                )
              ))}
            </div>
          </div>
        ))}

        <Strip title="utilColor(0, 10, … 100)" items={rampItems} />
        <Strip title="utilBands(8) — Executive Dashboard gauge arc" items={bandItems} />
      </div>
    </div>
  );
}
