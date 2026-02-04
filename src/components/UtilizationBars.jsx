import React from 'react';

const clampPct = (value) => {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(value, 100));
};

const formatPct = (value) => {
  if (!Number.isFinite(value)) return '--';
  return `${Math.round(value)}%`;
};

const BarRow = ({ label, value, color, compact }) => {
  if (!Number.isFinite(value)) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
        <div style={{ fontSize: compact ? 11 : 12, color: '#344054' }}>{label}</div>
        <div style={{ fontSize: compact ? 11 : 12, color: '#667085' }}>--</div>
      </div>
    );
  }

  const width = clampPct(value);
  const barHeight = compact ? 6 : 8;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
      <div>
        <div style={{ fontSize: compact ? 11 : 12, color: '#344054', marginBottom: 3 }}>
          {label}
        </div>
        <div
          style={{
            height: barHeight,
            background: '#e4e7ec',
            borderRadius: 999,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              width: `${width}%`,
              height: '100%',
              background: color
            }}
          />
        </div>
      </div>
      <div style={{ fontSize: compact ? 11 : 12, color: '#475467', fontWeight: 600 }}>
        {formatPct(value)}
      </div>
    </div>
  );
};

export default function UtilizationBars({ timePct, seatPct, compact = false }) {
  const hasValues = Number.isFinite(timePct) || Number.isFinite(seatPct);
  if (!hasValues) return null;

  return (
    <div style={{ display: 'grid', gap: compact ? 6 : 10 }}>
      <BarRow label="Time Utilization" value={timePct} color="#3b82f6" compact={compact} />
      <BarRow label="Seat Utilization" value={seatPct} color="#f59e0b" compact={compact} />
    </div>
  );
}
