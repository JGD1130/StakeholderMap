import React from 'react';

const clampPct = (value) => {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(value, 100));
};

const formatPct = (value) => {
  if (!Number.isFinite(value)) return '--';
  return `${Math.round(value)}%`;
};

const BarRow = ({ label, value, color, compact, statusText }) => {
  if (!Number.isFinite(value)) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
        <div style={{ fontSize: compact ? 11 : 12, color: '#344054' }}>{label}</div>
        <div style={{ fontSize: compact ? 11 : 12, color: '#667085', textAlign: 'right' }}>
          {statusText || '--'}
        </div>
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

export default function UtilizationBars({
  timePct,
  seatPct,
  compact = false,
  // Optional, additive: shown in place of the numeric bar for the
  // corresponding row when that row's value isn't a finite percent (e.g.
  // "pending enrollment data", "no current term configured"). Falls back to
  // the original bare "--" when omitted, so every pre-existing call site
  // (there is exactly one, BuildingPanel.jsx) keeps its old behavior
  // unchanged unless it opts in.
  timeStatusText,
  seatStatusText,
  // Optional single line rendered above both rows (e.g. a term label/status
  // note). Also additive -- omitted entirely when not passed.
  note
}) {
  const hasValues = Number.isFinite(timePct) || Number.isFinite(seatPct)
    || Boolean(timeStatusText) || Boolean(seatStatusText) || Boolean(note);
  if (!hasValues) return null;

  return (
    <div style={{ display: 'grid', gap: compact ? 6 : 10 }}>
      {note ? (
        <div style={{ fontSize: compact ? 10.5 : 11.5, color: '#667085', fontStyle: 'italic' }}>{note}</div>
      ) : null}
      <BarRow label="Time Utilization" value={timePct} color="#3b82f6" compact={compact} statusText={timeStatusText} />
      <BarRow label="Seat Utilization" value={seatPct} color="#f59e0b" compact={compact} statusText={seatStatusText} />
    </div>
  );
}
