// src/components/mf/WorkspaceShell.jsx
//
// Full-screen-over-the-map container for admin analytics views: orange title
// bar (title, subtitle, actions, Close), optional tab row, and a body that
// scrolls on its own while the header and tabs stay put.
//
// Behavior: rendered in a portal over the map; Esc closes; a backdrop click
// does NOT close (data views shouldn't vanish on a stray click); focus moves
// in on open, is trapped while open, and returns to the opener on close;
// page scroll is locked while open.
//
// Also exports MfGrid / MfCol: a 12-column grid (16px gap) that collapses to
// a single column when the grid itself is narrower than 900px.
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MF } from '../../theme/mfTokens';
import { mfOnBarButtonStyle } from './mfStyles';
import './mf.css';

const SIZE_STYLES = {
  workspace: { width: 'min(1200px, 94vw)', height: '88vh' },
  dialog: { width: 'min(760px, 92vw)', maxHeight: '90vh' }
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusable(root) {
  if (!root) return [];
  // tabIndex < 0 drops elements that are focusable but not Tab stops, e.g.
  // the inactive tabs (roving tabindex: only the active tab is a Tab stop).
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement)
  );
}

// Tabs share this one text style; only color and underline change.
function tabStyle(active) {
  return {
    padding: '10px 2px 8px',
    marginRight: 20,
    fontSize: 13,
    fontWeight: 600,
    color: active ? MF.ink.primary : MF.ink.muted,
    borderBottom: `2px solid ${active ? MF.brand.headerOrange : 'transparent'}`,
    '--mf-focus-color': MF.util.base
  };
}


export default function WorkspaceShell({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  actions,
  onClose,
  size = 'workspace',
  children
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    // Focus the dialog itself (not its first button) so it's announced by
    // name; the first Tab then lands on the first control.
    const opener = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // Lock page scroll while open.
  useEffect(() => {
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = previous; };
  }, []);

  const handleKeyDown = (event) => {
    // A shell opened from inside this one is a React child (its portal events
    // bubble up here) but not a DOM child -- leave its keys to it.
    if (!panelRef.current?.contains(event.target)) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCloseRef.current?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusable(panelRef.current);
    if (!focusable.length) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleTabKeyDown = (event, index) => {
    if (!tabs?.length || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    onTabChange?.(next.id);
    const buttons = panelRef.current?.querySelectorAll('[role="tab"]');
    buttons?.[(index + step + tabs.length) % tabs.length]?.focus();
  };

  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const sizeStyle = SIZE_STYLES[size] || SIZE_STYLES.workspace;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10020,
        display: 'grid',
        placeItems: 'center',
        background: MF.surface.modalBackdrop
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          ...sizeStyle,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 10,
          background: MF.surface.page,
          fontFamily: MF.type.family,
          color: MF.ink.primary,
          outline: 'none'
        }}
      >
        {/* Title bar */}
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 16px',
            background: MF.brand.headerOrange,
            color: MF.surface.page
          }}
        >
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div id={titleId} style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>
            {subtitle ? <div style={{ fontSize: 12, opacity: 0.85, marginTop: 1 }}>{subtitle}</div> : null}
          </div>
          {actions ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>{actions}</div> : null}
          <button type="button" className="mf-shell-button" style={mfOnBarButtonStyle} onClick={() => onCloseRef.current?.()}>
            Close
          </button>
        </div>

        {/* Tabs */}
        {hasTabs ? (
          <div
            role="tablist"
            aria-label={typeof title === 'string' ? `${title} sections` : undefined}
            style={{ flex: '0 0 auto', display: 'flex', padding: '0 16px', borderBottom: `1px solid ${MF.line.hairline}`, overflowX: 'auto' }}
          >
            {tabs.map((tab, index) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className="mf-shell-tab"
                  style={tabStyle(active)}
                  onClick={() => onTabChange?.(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Body */}
        <div
          role={hasTabs ? 'tabpanel' : undefined}
          style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 16, background: MF.surface.page }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function MfGrid({ children, style }) {
  return (
    <div className="mf-grid-container">
      <div className="mf-grid" style={style}>{children}</div>
    </div>
  );
}

export function MfCol({ span = 12, children, style }) {
  const clamped = Math.max(1, Math.min(12, Math.round(Number(span) || 12)));
  return (
    <div className="mf-col" style={{ '--mf-span': clamped, ...style }}>
      {children}
    </div>
  );
}
