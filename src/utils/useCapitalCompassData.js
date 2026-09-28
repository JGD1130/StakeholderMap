// src/utils/useCapitalCompassData.js
//
// Capital Compass data hook (admin-only, flag-gated): ONE read each of
// capitalPriorities, capitalPhasingProjects, deferredMaintenanceBuildings and
// the saved budget (capitalCompassSettings/budget). Called once in
// StakeholderMap.jsx and handed to CapitalPrioritiesPanel and the Executive
// Dashboard, so both show the same scores, tiers, costs and budget.
//
// Every building gets its tier live from its total (capitalCompassCalc.js
// getTier) and its cost from the one cost rule (resolveBuildingCost).
//
// Saved budget: { budgetCap, manualCosts: { [building]: amount }, updatedAt,
// updatedBy }, written ~800ms after the last change. No saved budgetCap means
// today's default: the cap follows the total known cost. If the settings doc
// can't be read or written (e.g. the capitalCompassSettings rule isn't
// deployed yet), the hook keeps working on in-memory values and logs one
// console.warn.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebaseConfig';
import { SCORE_FIELDS, getTier, resolveBuildingCost, sanitizeBuildingDocId, totalKnownCost } from './capitalCompassCalc';

const PRIORITIES_COLLECTION = 'capitalPriorities';
const PHASING_COLLECTION = 'capitalPhasingProjects';
const DEFERRED_MAINTENANCE_COLLECTION = 'deferredMaintenanceBuildings';
const SETTINGS_COLLECTION = 'capitalCompassSettings';
const BUDGET_DOC_ID = 'budget';
const SETTINGS_SAVE_DELAY_MS = 800;
const BATCH_CHUNK_SIZE = 400; // Firestore's cap is 500 ops per batch

function cleanManualCosts(raw) {
  const out = {};
  Object.entries(raw && typeof raw === 'object' ? raw : {}).forEach(([name, value]) => {
    const n = Number(value);
    if (name && Number.isFinite(n) && n > 0) out[name] = n;
  });
  return out;
}

// Clear the collection, then write `docs` ({ id, data }). Stops before
// writing if clearing fails. onPhase('clearing' | 'writing').
async function replaceCollection(collectionRef, docs, onPhase) {
  onPhase?.('clearing');
  const existingRefs = (await getDocs(collectionRef)).docs.map((docSnap) => docSnap.ref);
  for (let i = 0; i < existingRefs.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    existingRefs.slice(i, i + BATCH_CHUNK_SIZE).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  onPhase?.('writing');
  for (let i = 0; i < docs.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    docs.slice(i, i + BATCH_CHUNK_SIZE).forEach((entry) => {
      batch.set(doc(collectionRef, entry.id), { ...entry.data, importedAt: serverTimestamp() }, { merge: true });
    });
    await batch.commit();
  }
  return { clearedCount: existingRefs.length, writtenCount: docs.length };
}

export function useCapitalCompassData({ enabled = false, universityId, getBuildingResourceEntry = null } = {}) {
  const uid = String(universityId || '').trim();

  // 'idle' | 'loading' | 'ready' | 'error'
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [priorityDocs, setPriorityDocs] = useState([]);
  const [phasingDocs, setPhasingDocs] = useState([]);
  const [deferredMaintenanceDocs, setDeferredMaintenanceDocs] = useState([]);
  const [savedBudgetCap, setSavedBudgetCap] = useState(null); // null = follow total known cost
  const [manualCosts, setManualCosts] = useState({});

  const requestIdRef = useRef(0);
  const settingsBlockedRef = useRef(false); // read or write denied: stop trying, warn once
  const saveTimerRef = useRef(null);
  const pendingSettingsRef = useRef(null);

  const warnSettingsBlocked = useCallback((what, err) => {
    if (settingsBlockedRef.current) return;
    settingsBlockedRef.current = true;
    console.warn(
      `Capital Compass: couldn't ${what} saved budget settings (${err?.code || err?.message || 'unknown error'}) — `
      + 'using defaults; budget and manual cost changes will not be saved. Is the capitalCompassSettings rule deployed?'
    );
  }, []);

  const load = useCallback(async () => {
    if (!uid) return;
    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError('');
    try {
      const base = ['universities', uid];
      const settingsPromise = getDoc(doc(db, ...base, SETTINGS_COLLECTION, BUDGET_DOC_ID)).catch((err) => {
        warnSettingsBlocked('read', err);
        return null;
      });
      const [prioritiesSnap, phasingSnap, dmSnap, settingsSnap] = await Promise.all([
        getDocs(collection(db, ...base, PRIORITIES_COLLECTION)),
        getDocs(collection(db, ...base, PHASING_COLLECTION)),
        getDocs(collection(db, ...base, DEFERRED_MAINTENANCE_COLLECTION)),
        settingsPromise
      ]);
      if (requestId !== requestIdRef.current) return;
      setPriorityDocs(prioritiesSnap.docs.map((d) => ({ docId: d.id, ...(d.data() || {}) })));
      setPhasingDocs(
        phasingSnap.docs
          .map((d) => ({ projectId: d.id, ...(d.data() || {}) }))
          // completionDate is an ISO "YYYY-MM-01" string: sorts chronologically.
          .sort((a, b) => String(a.completionDate || '').localeCompare(String(b.completionDate || '')))
      );
      setDeferredMaintenanceDocs(
        dmSnap.docs
          .map((d) => ({ docId: d.id, ...(d.data() || {}) }))
          .sort((a, b) => String(a.rawBuildingName || '').localeCompare(String(b.rawBuildingName || '')))
      );
      // Don't clobber a change the user made while this load was in flight.
      if (settingsSnap && !pendingSettingsRef.current) {
        const saved = settingsSnap.exists() ? settingsSnap.data() : null;
        const cap = Number(saved?.budgetCap);
        setSavedBudgetCap(saved && Number.isFinite(cap) && cap >= 0 ? cap : null);
        setManualCosts(cleanManualCosts(saved?.manualCosts));
      }
      setStatus('ready');
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error('Capital Compass: load failed.', err);
      setError("Couldn't load Capital Compass data — try Refresh.");
      setStatus('error');
    }
  }, [uid, warnSettingsBlocked]);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    if (!enabled || !uid) return undefined;
    void load();
    return () => { requestIdRef.current += 1; };
  }, [enabled, uid, load]);

  // --- Saved budget -----------------------------------------------------------------
  const flushSettings = useCallback(async () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSettingsRef.current;
    pendingSettingsRef.current = null;
    if (!pending || !uid || settingsBlockedRef.current) return;
    try {
      // Full overwrite (no merge): a removed manual cost must disappear from
      // the saved map, which a merge would keep.
      await setDoc(doc(db, 'universities', uid, SETTINGS_COLLECTION, BUDGET_DOC_ID), {
        budgetCap: pending.budgetCap,
        manualCosts: pending.manualCosts,
        updatedAt: serverTimestamp(),
        updatedBy: String(auth.currentUser?.email || '').toLowerCase()
      });
    } catch (err) {
      warnSettingsBlocked('save', err);
    }
  }, [uid, warnSettingsBlocked]);

  const scheduleSettingsSave = useCallback((next) => {
    pendingSettingsRef.current = next;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void flushSettings(); }, SETTINGS_SAVE_DELAY_MS);
  }, [flushSettings]);

  // Best-effort save of a change still waiting on the debounce at unmount.
  useEffect(() => () => { if (pendingSettingsRef.current) void flushSettings(); }, [flushSettings]);

  const setBudgetCap = useCallback((value) => {
    const cap = Math.max(0, Number(value) || 0);
    setSavedBudgetCap(cap);
    scheduleSettingsSave({ budgetCap: cap, manualCosts });
  }, [manualCosts, scheduleSettingsSave]);

  // amount: a positive number, or ''/null/0 to clear the manual cost.
  const setManualCost = useCallback((buildingName, amount) => {
    const n = Number(amount);
    const next = { ...manualCosts };
    if (amount === '' || amount == null || !Number.isFinite(n) || n <= 0) delete next[buildingName];
    else next[buildingName] = n;
    setManualCosts(next);
    scheduleSettingsSave({ budgetCap: savedBudgetCap, manualCosts: next });
  }, [manualCosts, savedBudgetCap, scheduleSettingsSave]);

  // --- Derived ---------------------------------------------------------------------
  const deferredMaintenanceByDocId = useMemo(
    () => Object.fromEntries(deferredMaintenanceDocs.map((d) => [d.docId, d])),
    [deferredMaintenanceDocs]
  );

  // One per capitalPriorities doc: live tier, resolved cost.
  const buildings = useMemo(() => priorityDocs.map((d) => {
    const name = String(d.originalId || d.docId);
    const total = typeof d.total === 'number' ? d.total : null;
    return {
      docId: d.docId,
      name,
      total,
      tier: getTier(total),
      cost: resolveBuildingCost(name, {
        manualCosts,
        deferredMaintenance: deferredMaintenanceByDocId,
        staticResources: getBuildingResourceEntry
      }),
      scores: Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, typeof d[f.key] === 'number' ? d[f.key] : null])),
      notes: String(d.notes || ''),
      updatedAt: d.updatedAt || null
    };
  }), [priorityDocs, manualCosts, deferredMaintenanceByDocId, getBuildingResourceEntry]);

  const knownCostTotal = useMemo(() => totalKnownCost(buildings), [buildings]);
  const budgetCap = savedBudgetCap ?? knownCostTotal;

  // Cost for any building (scored or not), same rule.
  const costFor = useCallback((buildingName) => resolveBuildingCost(buildingName, {
    manualCosts,
    deferredMaintenance: deferredMaintenanceByDocId,
    staticResources: getBuildingResourceEntry
  }), [manualCosts, deferredMaintenanceByDocId, getBuildingResourceEntry]);

  // --- Writes ----------------------------------------------------------------------
  // scores: { [criterionKey]: number | null }. Writes only capitalPriorities/{docId}.
  const saveScore = useCallback(async (buildingName, { scores, notes }) => {
    const allScored = SCORE_FIELDS.every((f) => typeof scores[f.key] === 'number');
    const total = SCORE_FIELDS.reduce((sum, f) => sum + (Number(scores[f.key]) || 0), 0);
    const tier = allScored ? getTier(total) : null;
    const payload = {
      originalId: buildingName,
      notes: String(notes || '').trim(),
      total: allScored ? total : null,
      // Kept for older readers; display always recomputes the tier from total.
      tier: tier ? tier.level : null,
      tierHorizon: tier ? tier.horizon : null,
      tierAction: tier ? tier.action : null,
      updatedAt: serverTimestamp(),
      updatedByEmail: String(auth.currentUser?.email || '').toLowerCase()
    };
    SCORE_FIELDS.forEach((f) => { payload[f.key] = typeof scores[f.key] === 'number' ? scores[f.key] : null; });
    await setDoc(doc(db, 'universities', uid, PRIORITIES_COLLECTION, sanitizeBuildingDocId(buildingName)), payload, { merge: true });
    await load();
  }, [uid, load]);

  // docs: toCapitalPhasingDocs output. Replaces every saved project.
  const replacePhasingProjects = useCallback(async (docs, onPhase) => {
    const result = await replaceCollection(
      collection(db, 'universities', uid, PHASING_COLLECTION),
      docs.map((p) => ({
        id: p.projectId,
        data: {
          projectName: p.projectName,
          completionDate: p.completionDate,
          projectCost2026: p.projectCost2026,
          escalatedCost: p.escalatedCost,
          phases: p.phases,
          notes: p.notes
        }
      })),
      onPhase
    );
    await load();
    return result;
  }, [uid, load]);

  // docs: toDeferredMaintenanceDocs output. Replaces every saved building.
  const replaceDeferredMaintenance = useCallback(async (docs, { sourceFileName, sheetName } = {}, onPhase) => {
    const result = await replaceCollection(
      collection(db, 'universities', uid, DEFERRED_MAINTENANCE_COLLECTION),
      docs.map((b) => ({
        id: b.docId,
        data: {
          rawBuildingName: b.rawBuildingName,
          matchedBuildingId: b.matchedBuildingId,
          matchMethod: b.matchMethod,
          demolitionProjectCost: b.demolitionProjectCost,
          deferredMaint0to5: b.deferredMaint0to5,
          deferredMaint0to5ConstructionCost: b.deferredMaint0to5ConstructionCost,
          deferredMaint6to10: b.deferredMaint6to10,
          deferredMaint6to10ConstructionCost: b.deferredMaint6to10ConstructionCost,
          renovationCostPerSf: b.renovationCostPerSf,
          renovationConstructionCost: b.renovationConstructionCost,
          sourceFileName: sourceFileName || null,
          sourceSheetName: sheetName || null
        }
      })),
      onPhase
    );
    await load();
    return result;
  }, [uid, load]);

  return {
    status,
    error,
    buildings,
    phasingDocs,
    deferredMaintenanceDocs,
    budgetCap,
    budgetCapIsSaved: savedBudgetCap != null,
    manualCosts,
    knownCostTotal,
    costFor,
    setBudgetCap,
    setManualCost,
    saveScore,
    replacePhasingProjects,
    replaceDeferredMaintenance,
    reload
  };
}
