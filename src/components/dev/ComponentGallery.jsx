// src/components/dev/ComponentGallery.jsx
//
// Dev aid: every shared mf/ component on one page, for checking them in
// isolation before Phase 2 wires them into the real modules. Mounted only on
// the admin page (StakeholderMap.jsx gates it on isAdminMode) and renders
// nothing unless the URL has ?components=1.
import React, { useState } from 'react';
import { MF } from '../../theme/mfTokens';
import { WorkspaceShell, MfGrid, MfCol, KpiCard, ChartCard, Gauge } from '../mf';

const TABS = [
  { id: 'cards', label: 'Cards' },
  { id: 'gauges', label: 'Gauges' },
  { id: 'dialog', label: 'Dialog' }
];

const GAUGE_SAMPLES = [
  { value: 0, subtitle: 'value 0' },
  { value: 0.37, subtitle: 'Fall 2026 · Block 1', pill: 'Current' },
  { value: 0.65, subtitle: 'value 0.65 (on target)' },
  { value: 0.92, subtitle: 'value 0.92' },
  { value: 1, subtitle: 'value 1.0' },
  { value: null, subtitle: 'value null' }
];

function readComponentsParam() {
  try {
    return new URLSearchParams(window.location.search).get('components') === '1';
  } catch {
    return false;
  }
}

// ChartCard demo: fills the measured area and prints its size, so resizing
// the window visibly re-measures. display:block avoids the inline-svg
// baseline gap (a few px of overflow below the chart layer).
function MeasuredBox({ width, height }) {
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <rect x={0.5} y={0.5} width={Math.max(0, width - 1)} height={Math.max(0, height - 1)} fill={MF.surface.page} stroke={MF.line.border} strokeDasharray="4 3" />
      <text x={width / 2} y={height / 2} fontSize={11} fill={MF.ink.secondary} textAnchor="middle" dominantBaseline="middle">
        {`${width} × ${height} px`}
      </text>
    </svg>
  );
}

function CardsTab() {
  return (
    <MfGrid>
      <MfCol span={3}>
        <KpiCard value="$3.4M" label="Total capital need (Tier 1)" context="2 of 2 buildings costed" />
      </MfCol>
      <MfCol span={3}>
        <KpiCard value="+4,200 SF" label="Space gap (2036)" context="Institution-wide" indicator="surplus" />
      </MfCol>
      <MfCol span={3}>
        <KpiCard value="−1,850 SF" label="Space gap (2036)" context="Academic divisions" indicator="deficit" />
      </MfCol>
      <MfCol span={3}>
        <KpiCard value={null} label="Tier 1 need" missing={{ reason: 'Costs not entered' }} />
      </MfCol>
      <MfCol span={6}>
        <ChartCard title="Chart card A" subtitle="Render prop receives the measured size" footnote="Resize the window to see it update." minHeight={180}>
          {(size) => <MeasuredBox {...size} />}
        </ChartCard>
      </MfCol>
      <MfCol span={6}>
        <ChartCard title="Chart card B" subtitle="Same, different content width" minHeight={180}>
          {(size) => <MeasuredBox {...size} />}
        </ChartCard>
      </MfCol>
    </MfGrid>
  );
}

function GaugesTab() {
  return (
    <MfGrid>
      {GAUGE_SAMPLES.map((sample) => (
        <MfCol key={String(sample.value)} span={4}>
          <Gauge value={sample.value} title="Classroom Time Utilization" subtitle={sample.subtitle} pill={sample.pill} />
        </MfCol>
      ))}
    </MfGrid>
  );
}

function DialogTab() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p style={{ marginTop: 0, fontSize: 13, color: MF.ink.secondary }}>
        Opens a second WorkspaceShell at size &quot;dialog&quot; (760px) on top of this one.
      </p>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>Open dialog</button>
      {open ? (
        <WorkspaceShell title="Example dialog" subtitle="size = dialog" size="dialog" onClose={() => setOpen(false)}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: MF.ink.secondary }}>
            This is a dialog-size WorkspaceShell. Esc or Close returns you to the gallery, with focus back on
            the button that opened it. A click on the backdrop does nothing.
          </p>
        </WorkspaceShell>
      ) : null}
    </div>
  );
}

export default function ComponentGallery() {
  const [open, setOpen] = useState(readComponentsParam);
  const [tab, setTab] = useState('cards');
  if (!open) return null;

  return (
    <WorkspaceShell
      title="Component Gallery"
      subtitle="Shared mf/ components (dev only)"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      onClose={() => setOpen(false)}
    >
      {tab === 'cards' ? <CardsTab /> : null}
      {tab === 'gauges' ? <GaugesTab /> : null}
      {tab === 'dialog' ? <DialogTab /> : null}
    </WorkspaceShell>
  );
}
