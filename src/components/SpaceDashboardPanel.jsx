import React from 'react';
import UtilizationBars from './UtilizationBars';

const fmtSF = (val) => {
  const n = Number(val || 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
};

const fmtCount = (val) => {
  const n = Number(val || 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
};

const fmtSigned = (val) => {
  const n = Number(val || 0);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n);
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString()}`;
};

const StatCard = ({ label, value, sublabel, valueColor }) => (
  <div
    style={{
      background: '#f9fafb',
      border: '1px solid #e4e7ec',
      borderRadius: 8,
      padding: 5
    }}
  >
    <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.3, color: '#667085' }}>
      {label}
    </div>
    <div style={{ fontSize: 14, fontWeight: 800, color: valueColor || '#1d2939' }}>{value}</div>
    {sublabel ? <div style={{ fontSize: 10, color: '#667085' }}>{sublabel}</div> : null}
  </div>
);

const PanelCard = ({ children, style }) => (
  <div
    style={{
      background: '#f9fafb',
      border: '1px solid #e4e7ec',
      borderRadius: 8,
      padding: 5,
      ...style
    }}
  >
    {children}
  </div>
);

const ChartShell = ({ title, children }) => (
  <PanelCard style={{ marginTop: 4 }}>
    <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 5 }}>{title}</div>
    {children}
  </PanelCard>
);

const CollapsibleSection = ({ title, children, defaultOpen = false, open = defaultOpen, onToggle }) => (
  <details
    open={open}
    onToggle={(event) => onToggle?.(event.currentTarget.open)}
    style={{
      marginTop: 6,
      border: '1px solid #e4e7ec',
      borderRadius: 8,
      background: '#ffffff',
      padding: '3px 5px'
    }}
  >
    <summary style={{ fontWeight: 700, fontSize: 11, cursor: 'pointer', color: '#1d2939' }}>
      {title}
    </summary>
    <div style={{ marginTop: 4 }}>{children}</div>
  </details>
);

const EnrollmentTrendChart = ({ rows = [] }) => {
  if (!rows.length) return <div style={{ fontSize: 12, color: '#667085' }}>No enrollment data.</div>;

  const width = 280;
  const height = 100;
  const left = 10;
  const right = 8;
  const top = 8;
  const bottom = 18;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const maxVal = Math.max(...rows.map((r) => Number(r.enrollment || 0)), 1);

  const xFor = (idx) => {
    if (rows.length === 1) return left + innerW / 2;
    return left + (idx / (rows.length - 1)) * innerW;
  };
  const yFor = (val) => top + (1 - val / maxVal) * innerH;
  const points = rows.map((r, idx) => `${xFor(idx)},${yFor(Number(r.enrollment || 0))}`).join(' ');

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Enrollment trend chart">
      <line x1={left} y1={top + innerH} x2={width - right} y2={top + innerH} stroke="#d0d5dd" strokeWidth="1" />
      <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={points} />
      {rows.map((r, idx) => (
        <g key={r.year}>
          <circle cx={xFor(idx)} cy={yFor(Number(r.enrollment || 0))} r="2.6" fill="#2563eb" />
          <text x={xFor(idx)} y={height - 6} textAnchor="middle" fontSize="9" fill="#667085">
            {r.year}
          </text>
        </g>
      ))}
    </svg>
  );
};

const RequiredVsAvailableChart = ({ rows = [] }) => {
  if (!rows.length) return <div style={{ fontSize: 12, color: '#667085' }}>No seat demand data.</div>;

  const width = 280;
  const height = 108;
  const left = 10;
  const right = 8;
  const top = 8;
  const bottom = 18;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const maxVal = Math.max(
    ...rows.map((r) => Math.max(Number(r.planningRequiredSeats || 0), Number(r.availableSeats || 0))),
    1
  );
  const groupW = innerW / rows.length;
  const barW = Math.max(4, Math.min(12, groupW * 0.34));
  const yFor = (val) => top + innerH - (val / maxVal) * innerH;

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Required versus available seats chart">
      <line x1={left} y1={top + innerH} x2={width - right} y2={top + innerH} stroke="#d0d5dd" strokeWidth="1" />
      {rows.map((r, idx) => {
        const xCenter = left + groupW * idx + groupW / 2;
        const required = Number(r.planningRequiredSeats || 0);
        const available = Number(r.availableSeats || 0);
        const requiredY = yFor(required);
        const availableY = yFor(available);
        return (
          <g key={r.year}>
            <rect x={xCenter - barW - 1} y={requiredY} width={barW} height={top + innerH - requiredY} fill="#f97316" />
            <rect x={xCenter + 1} y={availableY} width={barW} height={top + innerH - availableY} fill="#16a34a" />
            <text x={xCenter} y={height - 6} textAnchor="middle" fontSize="9" fill="#667085">
              {r.year}
            </text>
          </g>
        );
      })}
      <text x={left + 2} y={12} fontSize="9" fill="#f97316">Planning Required</text>
      <text x={left + 56} y={12} fontSize="9" fill="#16a34a">Available</text>
    </svg>
  );
};

const SeatGapChart = ({ rows = [] }) => {
  if (!rows.length) return <div style={{ fontSize: 12, color: '#667085' }}>No seat gap data.</div>;

  const width = 280;
  const height = 108;
  const left = 10;
  const right = 8;
  const top = 8;
  const bottom = 18;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const zeroY = top + innerH / 2;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(Number(r.seatGap || 0))), 1);
  const groupW = innerW / rows.length;
  const barW = Math.max(5, Math.min(14, groupW * 0.5));
  const hFor = (val) => (Math.abs(val) / maxAbs) * (innerH / 2 - 4);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Seat gap over time chart">
      <line x1={left} y1={zeroY} x2={width - right} y2={zeroY} stroke="#98a2b3" strokeWidth="1" />
      {rows.map((r, idx) => {
        const xCenter = left + groupW * idx + groupW / 2;
        const gap = Number(r.seatGap || 0);
        const h = hFor(gap);
        const y = gap >= 0 ? zeroY - h : zeroY;
        return (
          <g key={r.year}>
            <rect
              x={xCenter - barW / 2}
              y={y}
              width={barW}
              height={Math.max(1, h)}
              fill={gap >= 0 ? '#16a34a' : '#dc2626'}
            />
            <text x={xCenter} y={height - 6} textAnchor="middle" fontSize="9" fill="#667085">
              {r.year}
            </text>
          </g>
        );
      })}
      <text x={left + 2} y={top + 8} fontSize="9" fill="#16a34a">Surplus</text>
      <text x={left + 48} y={height - bottom - 2} fontSize="9" fill="#dc2626">Deficit</text>
    </svg>
  );
};

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
      <svg width="124" height="82" viewBox="0 0 200 130" aria-label="Office Occupancy">
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

const DeptList = ({ entries = [], maxRows = 6 }) => {
  const rows = (Array.isArray(entries) ? entries : []).slice(0, maxRows);
  return (
    <div className="mf-pie">
      <div className="mf-section-title">Departments (SF)</div>
      <div style={{ width: '100%', minWidth: 0, display: 'grid', gap: 2 }}>
        {rows.map((row, idx) => (
          <div
            key={`${row?.name || 'dept'}-${idx}`}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 6,
              fontSize: 10
            }}
          >
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: '#1f2937'
              }}
              title={row?.name || 'Unknown'}
            >
              {row?.name || 'Unknown'}
            </span>
            <span style={{ color: '#4b5563', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(Number(row?.sf || 0)).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const StrategicDashboardSection = ({ strategic, onExpandedStateChange, hideTitle = false }) => {
  if (!strategic) return null;
  const [trendOpen, setTrendOpen] = React.useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = React.useState(false);
  const rows = strategic.yearRows || [];
  const selected = strategic.selectedMetrics || null;
  const enrollmentSeries = strategic.enrollmentSeries || [];
  const selectedYear = Number(strategic.selectedYear);
  const gapValue = Number(selected?.seatGap || 0);
  const gapColor = gapValue >= 0 ? '#166534' : '#b42318';

  React.useEffect(() => {
    onExpandedStateChange?.({
      trendOpen,
      enrollmentOpen,
      needsScroll: trendOpen || enrollmentOpen
    });
  }, [trendOpen, enrollmentOpen, onExpandedStateChange]);

  return (
    <PanelCard>
      {!hideTitle ? (
        <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 8 }}>Strategic Space Dashboard</div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
        <div>
          <div style={{ fontSize: 10, color: '#667085', marginBottom: 2 }}>Year</div>
          <select
            value={Number.isFinite(selectedYear) ? selectedYear : ''}
            onChange={(e) => strategic.onSelectedYearChange?.(Number(e.target.value))}
            style={{ width: '100%', height: 26 }}
          >
            {rows.map((row) => (
              <option key={row.year} value={row.year}>{row.year}</option>
            ))}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#667085', marginBottom: 2 }}>Seat Ratio</div>
          <input
            type="number"
            min="0.5"
            step="0.1"
            value={Number(strategic.seatRatio || 0)}
            onChange={(e) => strategic.onSeatRatioChange?.(e.target.value)}
            style={{ width: '100%', height: 26 }}
          />
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#667085', marginBottom: 2 }}>Target Utilization</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={Math.round(Number(strategic.targetUtilization || 0) * 100)}
              onChange={(e) => strategic.onTargetUtilizationChange?.(e.target.value)}
              style={{ width: '100%', height: 26 }}
            />
            <span style={{ fontSize: 12, color: '#667085' }}>%</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#667085', marginTop: 4 }}>
        Represents the planning goal for instructional seat utilization.
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 11, color: '#344054' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked readOnly />
          100 Classrooms
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={Boolean(strategic.includeLabs)}
            onChange={(e) => strategic.onIncludeLabsChange?.(e.target.checked)}
          />
          200 Labs
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, marginTop: 6 }}>
        <StatCard label="Enrollment" value={fmtCount(selected?.enrollment)} sublabel={`${selected?.year || '--'}`} />
        <StatCard
          label="Available Seats"
          value={fmtCount(selected?.availableSeats ?? strategic.capacityMetrics?.availableSeats)}
          sublabel={`${fmtCount(strategic.capacityMetrics?.instructionalRooms)} instructional rooms`}
        />
        <StatCard
          label="Seats Required (Planning)"
          value={fmtCount(selected?.planningRequiredSeats)}
          sublabel="Based on seat ratio + target utilization"
        />
        <StatCard
          label="Seat Gap"
          value={fmtSigned(selected?.seatGap)}
          valueColor={gapColor}
          sublabel={selected?.gapStatus || ''}
        />
      </div>

      <CollapsibleSection
        title="Enrollment by Year (Editable)"
        open={enrollmentOpen}
        onToggle={setEnrollmentOpen}
      >
        <div style={{ paddingRight: 4 }}>
          {enrollmentSeries.map((row) => (
            <div key={row.year} style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: 6, marginBottom: 4 }}>
              <div style={{ alignSelf: 'center', fontSize: 10, color: '#475467' }}>{row.year}</div>
              <input
                type="number"
                min="0"
                step="1"
                value={Number(row.enrollment || 0)}
                onChange={(e) => strategic.onEnrollmentChange?.(row.year, e.target.value)}
                style={{ height: 24 }}
              />
            </div>
          ))}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Trend Charts" open={trendOpen} onToggle={setTrendOpen}>
        <ChartShell title="Enrollment Trend">
          <EnrollmentTrendChart rows={rows} />
        </ChartShell>
        <ChartShell title="Required vs Available Seats">
          <RequiredVsAvailableChart rows={rows} />
        </ChartShell>
        <ChartShell title="Seat Gap Over Time">
          <SeatGapChart rows={rows} />
        </ChartShell>
      </CollapsibleSection>
    </PanelCard>
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
  onToggleHeatmap,
  strategic
}) {
  const [strategicOpen, setStrategicOpen] = React.useState(false);
  React.useEffect(() => {
    if (strategic) return;
    setStrategicOpen(false);
  }, [strategic]);
  const officeOcc = metrics?.officeOccupancy || {};
  const showUtilization = utilization && (Number.isFinite(utilization.timeUtilization) || Number.isFinite(utilization.seatUtilization));

  return (
    <div style={{ padding: 3, width: '100%', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 3 }}>{title}</div>

      {loading && <div style={{ fontSize: 12, color: '#667085' }}>Loading dashboard...</div>}
      {error && <div style={{ fontSize: 12, color: '#b00020' }}>{String(error)}</div>}

      {!loading && !error && (
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingRight: 3
          }}
        >
          {metrics ? (
            <PanelCard>
              <div className="mf-section-title">Campus Space Context</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)',
                  gap: 6,
                  marginTop: 4,
                  alignItems: 'stretch'
                }}
              >
                <StatCard label="Total SF" value={fmtSF(metrics.totalSf)} />
                <PanelCard style={{ gridRow: '1 / span 2' }}>
                  <OfficeOccupancyGauge
                    pct={officeOcc.pct}
                    occupied={officeOcc.occupied}
                    vacant={officeOcc.vacant}
                    unknown={officeOcc.unknown}
                    scopeLabel={scopeLabel}
                  />
                </PanelCard>
                <PanelCard>
                  <DeptList entries={metrics.byDept || []} />
                </PanelCard>
              </div>
            </PanelCard>
          ) : null}

          <PanelCard style={{ marginTop: 6 }}>
            <div className="mf-section-title">Actual Classroom Utilization</div>
            {utilizationScopeLabel ? (
              <div style={{ fontSize: 10, color: '#667085', marginTop: -2, marginBottom: 4 }}>
                {utilizationScopeLabel}
              </div>
            ) : null}
            {showUtilization ? (
              <>
                <UtilizationBars
                  timePct={utilization.timeUtilization}
                  seatPct={utilization.seatUtilization}
                  compact
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(heatmapOn)}
                    onChange={(event) => onToggleHeatmap?.(event.target.checked)}
                  />
                  Classroom Utilization Heat Map
                </label>
              </>
            ) : (
              <div style={{ fontSize: 11, color: '#667085' }}>
                No classroom utilization data.
              </div>
            )}
          </PanelCard>

          {strategic ? (
            <CollapsibleSection
              title="Strategic Space Dashboard"
              open={strategicOpen}
              onToggle={setStrategicOpen}
            >
              <div
                style={{
                  maxHeight: strategicOpen ? '34vh' : 0,
                  overflowY: strategicOpen ? 'scroll' : 'hidden',
                  overflowX: 'hidden',
                  paddingRight: strategicOpen ? 6 : 0
                }}
              >
                <StrategicDashboardSection
                  strategic={strategic}
                  hideTitle
                />
              </div>
            </CollapsibleSection>
          ) : null}
        </div>
      )}
    </div>
  );
}
