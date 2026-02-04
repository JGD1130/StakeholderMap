import React from 'react';
import UtilizationBars from './UtilizationBars';
import { getDeptColor } from '../style/roomColors';

const fmtSF = (val) => {
  const n = Number(val || 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
};

const StatCard = ({ label, value }) => (
  <div
    style={{
      background: '#f9fafb',
      border: '1px solid #e4e7ec',
      borderRadius: 8,
      padding: 8
    }}
  >
    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: '#667085' }}>
      {label}
    </div>
    <div style={{ fontSize: 16, fontWeight: 800, color: '#1d2939' }}>{value}</div>
  </div>
);

const PanelCard = ({ children, style }) => (
  <div
    style={{
      background: '#f9fafb',
      border: '1px solid #e4e7ec',
      borderRadius: 8,
      padding: 8,
      ...style
    }}
  >
    {children}
  </div>
);

const OfficeOccupancyGauge = ({ pct, occupied = 0, vacant = 0, unknown = 0, scopeLabel = '' }) => {
  const value = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : null;
  const angle = -90 + (value || 0) * 180;
  const display = value == null ? '--' : `${Math.round(value * 100)}%`;

  return (
    <div className="mf-gauge">
      <div className="mf-gauge-title">OFFICE OCCUPANCY</div>
      {scopeLabel ? (
        <div style={{ fontSize: 11, color: '#667085', marginTop: -2, marginBottom: 6 }}>
          {scopeLabel}
        </div>
      ) : null}
      <svg width="170" height="110" viewBox="0 0 200 130" aria-label="Office Occupancy">
        <path d="M 20 110 A 80 80 0 0 1 80 30" fill="none" stroke="#d64545" strokeWidth="16" strokeLinecap="round" />
        <path d="M 80 30 A 80 80 0 0 1 120 30" fill="none" stroke="#f0a23b" strokeWidth="16" strokeLinecap="round" />
        <path d="M 120 30 A 80 80 0 0 1 180 110" fill="none" stroke="#2aa84a" strokeWidth="16" strokeLinecap="round" />

        <g transform={`translate(100 110) rotate(${angle})`}>
          <line x1="0" y1="0" x2="0" y2="-70" stroke="#222" strokeWidth="3" />
          <circle cx="0" cy="0" r="6" fill="#222" />
        </g>

        <text x="20" y="125" fontSize="11" fill="#666">low</text>
        <text x="92" y="20" fontSize="11" fill="#666">mid</text>
        <text x="168" y="125" fontSize="11" fill="#666">high</text>
        <text x="100" y="90" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1d2939">
          {display}
        </text>
      </svg>
      <div className="mf-gauge-meta">
        {value == null ? (
          <div className="muted">No occupancy data</div>
        ) : (
          <div><b>{display}</b> occupied</div>
        )}
        <div className="muted">
          Occ: {occupied} | Vac: {vacant} | Unk: {unknown}
        </div>
      </div>
    </div>
  );
};

const DeptPie = ({ entries = [], maxSlices = 8 }) => {
  const top = entries.slice(0, maxSlices);
  const other = entries
    .slice(maxSlices)
    .reduce((sum, item) => sum + Number(item?.sf || 0), 0);
  const slices = other > 0
    ? [...top, { name: 'Other', sf: other }]
    : top;

  const total = slices.reduce((sum, item) => sum + Number(item?.sf || 0), 0) || 1;
  const fallbackOther = '#94a3b8';

  let start = 0;
  const cx = 60;
  const cy = 60;
  const r = 50;

  const paths = slices.map((item, i) => {
    const name = item?.name || 'Unknown';
    const sf = Number(item?.sf || 0);
    const frac = sf / total;
    const end = start + frac * Math.PI * 2;

    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = frac > 0.5 ? 1 : 0;

    const d = [
      `M ${cx} ${cy}`,
      `L ${x1} ${y1}`,
      `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
      'Z'
    ].join(' ');

    const color = name === 'Other' ? fallbackOther : getDeptColor(name);
    start = end;
    return { d, name, sf, color };
  });

  return (
    <div className="mf-pie">
      <div className="mf-section-title">Departments (SF)</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <svg width="120" height="120" viewBox="0 0 120 120" aria-label="Department share by SF">
          {paths.map((p, idx) => (
            <path key={idx} d={p.d} fill={p.color} stroke="#fff" strokeWidth="1" />
          ))}
        </svg>
        <div className="mf-pie-legend">
          {paths.slice(0, 6).map((p, idx) => (
            <div key={idx} className="mf-legend-row">
              <span className="mf-swatch" style={{ background: p.color }} />
              <span className="mf-legend-name" title={p.name}>{p.name}</span>
              <span className="mf-legend-sf">{Math.round(p.sf).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function SpaceDashboardPanel({
  title,
  metrics,
  loading,
  error,
  scopeLabel,
  utilization,
  utilizationScopeLabel,
  heatmapOn,
  onToggleHeatmap
}) {
  const officeOcc = metrics?.officeOccupancy || {};
  const showUtilization = utilization && (Number.isFinite(utilization.timeUtilization) || Number.isFinite(utilization.seatUtilization));

  return (
    <div style={{ padding: 6, width: '100%', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{title}</div>

      {loading && <div style={{ fontSize: 12, color: '#667085' }}>Loading dashboard...</div>}
      {error && <div style={{ fontSize: 12, color: '#b00020' }}>{String(error)}</div>}

      {!loading && !error && metrics && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1.3fr', gap: 6 }}>
            <StatCard label="Total SF" value={fmtSF(metrics.totalSf)} />
            <PanelCard>
              <OfficeOccupancyGauge
                pct={officeOcc.pct}
                occupied={officeOcc.occupied}
                vacant={officeOcc.vacant}
                unknown={officeOcc.unknown}
                scopeLabel={scopeLabel}
              />
            </PanelCard>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4, marginTop: 8 }}>
            <PanelCard>
              <DeptPie entries={metrics.byDept || []} />
            </PanelCard>

            {showUtilization ? (
              <PanelCard style={{ marginTop: 8 }}>
                <div className="mf-section-title">Classroom Utilization</div>
                {utilizationScopeLabel ? (
                  <div style={{ fontSize: 11, color: '#667085', marginTop: -2, marginBottom: 6 }}>
                    {utilizationScopeLabel}
                  </div>
                ) : null}
                <UtilizationBars
                  timePct={utilization.timeUtilization}
                  seatPct={utilization.seatUtilization}
                  compact
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(heatmapOn)}
                    onChange={(event) => onToggleHeatmap?.(event.target.checked)}
                  />
                  Classroom Utilization Heat Map
                </label>
              </PanelCard>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
