// src/components/presentationMode.js
//
// Client presentation mode (admin only): one switch that turns the admin view
// into a clean, client-facing screen for demos and brochure screenshots.
// Owned by StakeholderMap.jsx; the right-rail panels and their workspaces read
// it through PresentationModeContext (workspaces render in portals, which
// still see the context).
//
// Not the older engagement-mode `presentationMode` / ?presentation=1 in
// StakeholderMap.jsx (which hides the whole right rail for a PNG export) --
// this one keeps the summary cards and workspaces.
//
// On/off: ?present=1 / ?present=0 in the URL win; otherwise the choice made
// in this browser session (sessionStorage). ?capture=1 (with ?present=1)
// also hides the small "Presentation mode" pill, for screenshots.
import { createContext, useContext, useEffect } from 'react';

const STORAGE_KEY = 'mf.clientPresentationMode';

export const PresentationModeContext = createContext(false);

export function usePresentationMode() {
  return useContext(PresentationModeContext);
}

function readParams() {
  try {
    return new URLSearchParams(window.location.search || '');
  } catch {
    return new URLSearchParams('');
  }
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isFalsy(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

export function readInitialPresentationMode() {
  if (typeof window === 'undefined') return false;
  const param = readParams().get('present');
  if (isTruthy(param)) return true;
  if (isFalsy(param)) return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function readCaptureMode() {
  if (typeof window === 'undefined') return false;
  return isTruthy(readParams().get('capture'));
}

// Remember the choice for the session, and keep ?present in the address bar
// in step so a reload lands in the same mode.
export function rememberPresentationMode(on) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {}
  try {
    const url = new URL(window.location.href);
    if (on) url.searchParams.set('present', '1');
    else url.searchParams.delete('present');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

// Panels that own a workspace: close it when presentation mode turns on, so
// the map is what's showing.
export function useCloseWhenPresenting(close) {
  const presenting = usePresentationMode();
  useEffect(() => {
    if (presenting) close();
  }, [presenting]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Workspace tabs without Setup while presenting.
export function presentationTabs(tabs, presenting) {
  return presenting ? tabs.filter((tab) => tab.id !== 'setup') : tabs;
}
