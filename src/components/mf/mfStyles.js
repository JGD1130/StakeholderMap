// src/components/mf/mfStyles.js
//
// Inline-style fragments shared by the mf/ components. Every value comes from
// src/theme/mfTokens.js.
import { MF } from '../../theme/mfTokens';

// Card surface used by KpiCard and ChartCard.
export const mfCardStyle = {
  position: 'relative',
  boxSizing: 'border-box',
  minWidth: 0,
  background: MF.surface.card,
  border: `1px solid ${MF.line.border}`,
  borderRadius: 10,
  padding: '14px 16px',
  fontFamily: MF.type.family,
  color: MF.ink.primary
};

// Outline button for WorkspaceShell's orange title bar (Close, and any
// actions such as Recalculate / Export to PDF). Pair with
// className="mf-shell-button" for the keyboard focus ring.
export const mfOnBarButtonStyle = {
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px solid currentColor',
  background: 'transparent',
  color: MF.surface.page,
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  '--mf-focus-color': MF.surface.page
};

// Small rounded label, e.g. the Gauge's "Current" pill.
export const mfPillStyle = {
  display: 'inline-block',
  padding: '1px 7px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: '16px',
  whiteSpace: 'nowrap'
};
