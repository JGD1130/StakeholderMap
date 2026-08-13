// src/components/CapitalPrioritiesPanel.jsx
//
// Capital Priorities module (Capital Compass integration, Option B).
// Reads building names from the tenant's existing `buildings` config
// (in-memory prop, no Firestore read, never modified) so a user can pick
// a building to score. All reads/writes for scoring go to the new
// `capitalPriorities` collection only — this panel never reads or writes
// any existing rooms/buildings/buildingAssessments/buildingConditions data.
//
// Scoring rubric (7 criteria, 100 pts) and tier thresholds are taken
// verbatim from the Capital Compass reference tool:
//   Tier 1: 80-100  (Short-term, 0-5 yrs)  — fund immediately
//   Tier 2: 60-79   (Mid-term, 5-10 yrs)   — advance planning/funding/grants
//   Tier 3: 40-59   (Long-term, 10-20 yrs) — continue planning, reassess at CIP updates
//   Tier 4: <40     (Deferred / opportunistic) — reevaluate scope/funding/strategic importance
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, auth } from '../firebaseConfig';

const SCORE_FIELDS = [
  {
    key: 'criticalCoreService',
    label: 'Critical Core Service',
    fullName: 'Criticality to mission & safety',
    max: 25,
    levels: [
      { score: 25, label: 'Immediate threat', desc: 'Immediate threat to life safety, regulatory compliance, or continuity of academic/research operations' },
      { score: 20, label: '3-5 yr risk', desc: 'Major degradation of instructional, research, or clinical capacity likely within 3-5 years' },
      { score: 15, label: 'Noticeable', desc: 'Noticeable impacts to academic operations, research productivity, or asset reliability' },
      { score: 8, label: 'Minor', desc: 'Minor or limited impact on core academic or research functions' }
    ]
  },
  {
    key: 'publicBenefit',
    label: 'Public Benefit',
    fullName: 'Student & institutional benefit',
    max: 20,
    levels: [
      { score: 20, label: 'System/institution-wide', desc: 'Benefit spans multiple campuses or the full student/faculty population' },
      { score: 15, label: 'Multi-college', desc: 'Significant benefit to multiple colleges, departments, or large user groups' },
      { score: 10, label: 'Department/program', desc: 'Moderate benefit to a defined department, program, or user group' },
      { score: 5, label: 'Limited', desc: 'Limited benefit to a small or specialized group' }
    ]
  },
  {
    key: 'organizationalCapacity',
    label: 'Organizational Capacity',
    fullName: 'Operational capacity & efficiency',
    max: 15,
    levels: [
      { score: 15, label: 'Transformational', desc: 'Transformational improvement to research capacity, instructional delivery, or operational efficiency' },
      { score: 10, label: 'Significant', desc: 'Significant operational improvement' },
      { score: 7, label: 'Moderate', desc: 'Moderate efficiency gains' },
      { score: 2, label: 'Minor', desc: 'Minor or no measurable institutional benefit' }
    ]
  },
  {
    key: 'financialDelayCost',
    label: 'Financial Delay Cost',
    fullName: 'Financial impact of delay',
    max: 15,
    levels: [
      { score: 15, label: 'Substantial', desc: 'Delay substantially increases costs, deferred maintenance backlog, or risk of asset failure' },
      { score: 10, label: 'Moderate', desc: 'Moderate escalation or increased project complexity expected' },
      { score: 7, label: 'Manageable', desc: 'Manageable cost increases expected' },
      { score: 2, label: 'Minimal', desc: 'Minimal financial consequence if delayed' }
    ]
  },
  {
    key: 'fundingLeverage',
    label: 'Funding Leverage',
    fullName: 'Funding availability & leverage',
    max: 10,
    levels: [
      { score: 10, label: '>50% external', desc: 'More than 50% of project cost potentially funded via grants, gifts, or indirect cost recovery' },
      { score: 8, label: 'Strong leverage', desc: 'Significant grant, philanthropic, or partnership funding opportunity' },
      { score: 5, label: 'Moderate', desc: 'Moderate funding leverage available' },
      { score: 1, label: 'Limited', desc: 'Limited or no outside funding source available' }
    ]
  },
  {
    key: 'politicalReadiness',
    label: 'Political Readiness',
    fullName: 'Board & stakeholder expectations',
    max: 10,
    levels: [
      { score: 10, label: 'High visibility', desc: 'Strong Board of Regents, donor, or legislative visibility and expectation' },
      { score: 8, label: 'Broad support', desc: 'Broad stakeholder support and visibility' },
      { score: 5, label: 'Moderate', desc: 'Moderate stakeholder interest' },
      { score: 1, label: 'Limited', desc: 'Limited stakeholder awareness or support' }
    ]
  },
  {
    key: 'readinessScore',
    label: 'Readiness Score',
    fullName: 'Project readiness',
    max: 5,
    levels: [
      { score: 5, label: 'Ready', desc: 'Design complete, permits secured, funding identified, ready to proceed' },
      { score: 4, label: 'Advanced', desc: 'Advanced planning complete' },
      { score: 3, label: 'Preliminary', desc: 'Preliminary planning complete' },
      { score: 1, label: 'Concept', desc: 'Early-stage concept or undefined project' }
    ]
  }
];

const TIERS = [
  { level: 1, range: '80-100', horizon: 'Short-term (0-5 years)', action: 'Fund immediately or position for immediate implementation', color: '#15803d' },
  { level: 2, range: '60-79', horizon: 'Mid-term (5-10 years)', action: 'Advance planning, design, funding development, and grant pursuit', color: '#b45309' },
  { level: 3, range: '40-59', horizon: 'Long-term (10-20 years)', action: 'Continue planning and reassess during future CIP updates', color: '#b45309' },
  { level: 4, range: 'Below 40', horizon: 'Deferred / opportunistic', action: 'Reevaluate scope, funding, and strategic importance', color: '#b42318' }
];

function getTier(total) {
  if (total >= 80) return TIERS[0];
  if (total >= 60) return TIERS[1];
  if (total >= 40) return TIERS[2];
  return TIERS[3];
}

// Suggestion logic for 2 of the 7 criteria, read-only against the same
// building-resources.json-backed data the "Deferred + Condition" modal
// already displays (passed in via the getBuildingResourceEntry prop).
// These only ever produce a starting-point score for the user to accept
// or override in the <select> below — nothing here writes anywhere.
const FINANCIAL_DELAY_COST_LEVELS_ASC = [...SCORE_FIELDS.find((f) => f.key === 'financialDelayCost').levels].reverse();
const CRITICAL_CORE_SERVICE_LEVELS_ASC = [...SCORE_FIELDS.find((f) => f.key === 'criticalCoreService').levels].reverse();

function formatUsdCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

// Buckets chosen to line up with Hastings' actual deferred-maintenance priority
// labels/dollar amounts (Very High: ~$2.6-2.9M, High: ~$1.2-1.8M, Medium: ~$345-789K,
// Low: ~$18-297K) so the priority label and the dollar amount agree in the common
// case; either signal alone can still drive a suggestion if only one is present.
function suggestFinancialDelayCost(deferred) {
  if (!deferred) return null;
  const cost = [deferred.totalCost, deferred.totalHigh, deferred.totalLow]
    .map(Number)
    .find((n) => Number.isFinite(n));

  const priorityText = String(deferred.priority || '').toLowerCase();
  let priorityTier = null;
  if (priorityText.includes('very high')) priorityTier = 3;
  else if (priorityText.includes('high')) priorityTier = 2;
  else if (priorityText.includes('medium') || priorityText.includes('moderate')) priorityTier = 1;
  else if (priorityText.includes('low')) priorityTier = 0;

  let costTier = null;
  if (Number.isFinite(cost)) {
    if (cost >= 2000000) costTier = 3;
    else if (cost >= 1000000) costTier = 2;
    else if (cost >= 300000) costTier = 1;
    else costTier = 0;
  }

  if (priorityTier == null && costTier == null) return null;
  const tier = Math.max(priorityTier ?? -1, costTier ?? -1);
  const level = FINANCIAL_DELAY_COST_LEVELS_ASC[tier];

  const parts = [];
  if (deferred.priority) parts.push(`${deferred.priority} priority`);
  if (Number.isFinite(cost)) parts.push(`~${formatUsdCompact(cost)} deferred maintenance`);

  return { score: level.score, levelLabel: level.label, rationale: parts.join(', ') || 'deferred maintenance data' };
}

// Lower Life Safety and/or lower overall average condition (1=very poor, 5=excellent,
// per building-resources.json's own scale) suggest higher criticality. Either signal
// alone can drive a suggestion; the worse of the two wins.
function suggestCriticalCoreService(lifeSafetyScore, averageScore) {
  let lsTier = null;
  if (Number.isFinite(lifeSafetyScore)) {
    if (lifeSafetyScore <= 2) lsTier = 3;
    else if (lifeSafetyScore <= 3) lsTier = 2;
    else if (lifeSafetyScore <= 4) lsTier = 1;
    else lsTier = 0;
  }
  let avgTier = null;
  if (Number.isFinite(averageScore)) {
    if (averageScore <= 2.5) avgTier = 3;
    else if (averageScore <= 3.25) avgTier = 2;
    else if (averageScore <= 4) avgTier = 1;
    else avgTier = 0;
  }

  if (lsTier == null && avgTier == null) return null;
  const tier = Math.max(lsTier ?? -1, avgTier ?? -1);
  const level = CRITICAL_CORE_SERVICE_LEVELS_ASC[tier];

  const parts = [];
  if (Number.isFinite(lifeSafetyScore)) parts.push(`Life Safety ${lifeSafetyScore}/5`);
  if (Number.isFinite(averageScore)) parts.push(`avg condition ${averageScore.toFixed(1)}/5`);

  return { score: level.score, levelLabel: level.label, rationale: parts.join(', ') || 'condition data' };
}

function sanitizeBuildingDocId(buildingId) {
  return String(buildingId || '').trim().replace(/\//g, '__');
}

function emptyScores() {
  return SCORE_FIELDS.reduce((acc, field) => ({ ...acc, [field.key]: null }), {});
}

function formatUpdatedAt(value) {
  try {
    if (value?.toDate) return value.toDate().toLocaleString();
    if (value) return new Date(value).toLocaleString();
  } catch {}
  return '';
}

// Small stat tile for the Portfolio summary dashboard. Presentational only.
function PortfolioStat({ label, value, color }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: '#f8fafc' }}>
      <div style={{ fontSize: 9.5, color: '#667085', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: color || '#1f2937', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function CapitalPrioritiesPanel({
  universityId,
  enabled = false,
  title = 'Capital Priorities',
  buildingFeatures = [],
  getBuildingResourceEntry = null
}) {
  const normalizedUniversityId = String(universityId || '').trim();
  // Collapsed by default -- this only gates the <details> disclosure below;
  // refreshRows() (data load) already runs unconditionally via its own
  // useEffect regardless of open/collapsed state, so expanding never has to
  // trigger a load itself, it just reveals data that's already there.
  const [panelOpen, setPanelOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [scores, setScores] = useState(emptyScores);
  const [notes, setNotes] = useState('');
  const [loadingSelection, setLoadingSelection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  // Portfolio view state. Purely client-side — no Firestore reads/writes beyond the
  // existing `rows` (capitalPriorities collection, already read-only above). Manual
  // cost overrides live only in this component's state (session-only, not persisted)
  // for buildings with no deferred-maintenance cost data to draw from.
  const [manualCosts, setManualCosts] = useState({});
  const [budgetCap, setBudgetCap] = useState(0);
  const [budgetCapTouched, setBudgetCapTouched] = useState(false);

  // Read-only: names come from the tenant's existing buildings config, never written back to it.
  const buildingOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    (Array.isArray(buildingFeatures) ? buildingFeatures : []).forEach((feature) => {
      const rawId = String(feature?.properties?.id || feature?.properties?.name || '').trim();
      if (!rawId || seen.has(rawId)) return;
      seen.add(rawId);
      options.push({ buildingId: rawId, docId: sanitizeBuildingDocId(rawId) });
    });
    return options.sort((a, b) => a.buildingId.localeCompare(b.buildingId));
  }, [buildingFeatures]);

  // Read-only: same building-resources.json data the "Deferred + Condition" modal
  // renders from. No Firestore read, no write, ever, to deferred maintenance or
  // condition data through this panel.
  const resourceEntry = useMemo(() => {
    if (typeof getBuildingResourceEntry !== 'function' || !selectedBuildingId) return null;
    return getBuildingResourceEntry(selectedBuildingId) || null;
  }, [getBuildingResourceEntry, selectedBuildingId]);

  const financialDelayCostSuggestion = useMemo(
    () => suggestFinancialDelayCost(resourceEntry?.deferredMaintenance || null),
    [resourceEntry]
  );

  const criticalCoreServiceSuggestion = useMemo(() => {
    const lifeSafety = Number(resourceEntry?.conditionAssessment?.architecture?.lifeSafety);
    const avg = Number(resourceEntry?.conditionAssessment?.averageScore);
    return suggestCriticalCoreService(
      Number.isFinite(lifeSafety) ? lifeSafety : null,
      Number.isFinite(avg) ? avg : null
    );
  }, [resourceEntry]);

  const SUGGESTIONS_BY_KEY = {
    financialDelayCost: financialDelayCostSuggestion,
    criticalCoreService: criticalCoreServiceSuggestion
  };

  const refreshRows = useCallback(async () => {
    if (!enabled || !normalizedUniversityId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setErrorMessage('');
    try {
      const snap = await getDocs(collection(db, 'universities', normalizedUniversityId, 'capitalPriorities'));
      const nextRows = snap.docs.map((docSnap) => ({ buildingId: docSnap.id, ...(docSnap.data() || {}) }));
      setRows(nextRows);
    } catch (error) {
      setErrorMessage(String(error?.message || 'Failed to load capital priorities.'));
    } finally {
      setLoading(false);
    }
  }, [enabled, normalizedUniversityId]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  // Pre-fill the form if this building already has a capitalPriorities doc.
  useEffect(() => {
    if (!enabled || !normalizedUniversityId || !selectedBuildingId) {
      setScores(emptyScores());
      setNotes('');
      return;
    }
    let cancelled = false;
    setLoadingSelection(true);
    setSaveMessage('');
    setSaveError('');
    const docId = sanitizeBuildingDocId(selectedBuildingId);
    getDoc(doc(db, 'universities', normalizedUniversityId, 'capitalPriorities', docId))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.exists() ? snap.data() : null;
        const nextScores = emptyScores();
        if (data) {
          SCORE_FIELDS.forEach((field) => {
            if (typeof data[field.key] === 'number') nextScores[field.key] = data[field.key];
          });
        }
        setScores(nextScores);
        setNotes(String(data?.notes || ''));
      })
      .catch((error) => {
        if (!cancelled) setSaveError(String(error?.message || 'Failed to load existing score.'));
      })
      .finally(() => {
        if (!cancelled) setLoadingSelection(false);
      });
    return () => { cancelled = true; };
  }, [enabled, normalizedUniversityId, selectedBuildingId]);

  const allScored = SCORE_FIELDS.every((field) => typeof scores[field.key] === 'number');
  const total = SCORE_FIELDS.reduce((sum, field) => sum + (Number(scores[field.key]) || 0), 0);
  const currentTier = allScored ? getTier(total) : null;

  const handleScoreChange = useCallback((key, value) => {
    setScores((prev) => ({ ...prev, [key]: value === '' ? null : Number(value) }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!enabled || !normalizedUniversityId || !selectedBuildingId) return;
    setSaving(true);
    setSaveError('');
    setSaveMessage('');
    try {
      const docId = sanitizeBuildingDocId(selectedBuildingId);
      const payload = {
        originalId: selectedBuildingId,
        notes: String(notes || '').trim(),
        total: allScored ? total : null,
        tier: allScored ? currentTier.level : null,
        tierHorizon: allScored ? currentTier.horizon : null,
        tierAction: allScored ? currentTier.action : null,
        updatedAt: serverTimestamp(),
        updatedByEmail: String(auth.currentUser?.email || '').toLowerCase()
      };
      SCORE_FIELDS.forEach((field) => {
        payload[field.key] = typeof scores[field.key] === 'number' ? scores[field.key] : null;
      });
      // Writes ONLY to universities/{universityId}/capitalPriorities/{docId} — no other collection is touched.
      await setDoc(doc(db, 'universities', normalizedUniversityId, 'capitalPriorities', docId), payload, { merge: true });
      setSaveMessage('Saved.');
      await refreshRows();
    } catch (error) {
      setSaveError(String(error?.message || 'Failed to save.'));
    } finally {
      setSaving(false);
    }
  }, [enabled, normalizedUniversityId, selectedBuildingId, notes, scores, allScored, total, currentTier, refreshRows]);

  // Portfolio Prioritizer — read-only across all scored buildings (`rows`, already
  // loaded above). Cost per building prefers deferred-maintenance data (same
  // building-resources.json-backed source used elsewhere in this panel) and falls
  // back to a manual per-building estimate when no such data exists. No writes.
  const getResolvedBuildingCost = useCallback((row) => {
    const entry = typeof getBuildingResourceEntry === 'function'
      ? getBuildingResourceEntry(row.originalId || row.buildingId)
      : null;
    const deferred = entry?.deferredMaintenance;
    const auto = deferred
      ? [deferred.totalCost, deferred.totalHigh, deferred.totalLow].map(Number).find((n) => Number.isFinite(n))
      : undefined;
    if (Number.isFinite(auto)) return { cost: auto, source: 'auto' };
    const manual = Number(manualCosts[row.buildingId]);
    if (Number.isFinite(manual) && manual > 0) return { cost: manual, source: 'manual' };
    return { cost: null, source: null };
  }, [getBuildingResourceEntry, manualCosts]);

  const portfolioRows = useMemo(() => {
    const scored = rows.filter((row) => typeof row.total === 'number');
    const withCost = scored.map((row) => {
      const { cost, source } = getResolvedBuildingCost(row);
      const tierInfo = TIERS.find((t) => t.level === row.tier) || getTier(row.total);
      return {
        ...row,
        resolvedCost: cost,
        costSource: source,
        tierLevel: tierInfo.level,
        tierHorizon: tierInfo.horizon,
        tierColor: tierInfo.color
      };
    });
    withCost.sort((a, b) => (
      (b.total - a.total) ||
      String(a.originalId || a.buildingId).localeCompare(String(b.originalId || b.buildingId))
    ));
    return withCost;
  }, [rows, getResolvedBuildingCost]);

  const totalKnownCost = useMemo(
    () => portfolioRows.reduce((sum, row) => sum + (Number.isFinite(row.resolvedCost) ? row.resolvedCost : 0), 0),
    [portfolioRows]
  );

  // Budget cap tracks total known cost until the user explicitly adjusts it, so it
  // starts "everything funded" and stays sensible as costs are filled in.
  useEffect(() => {
    if (!budgetCapTouched) setBudgetCap(totalKnownCost);
  }, [totalKnownCost, budgetCapTouched]);

  const handleBudgetCapChange = useCallback((value) => {
    setBudgetCapTouched(true);
    setBudgetCap(Math.max(0, Number(value) || 0));
  }, []);

  const handleManualCostChange = useCallback((buildingId, rawValue) => {
    setManualCosts((prev) => {
      const next = { ...prev };
      const n = Number(rawValue);
      if (rawValue === '' || !Number.isFinite(n) || n <= 0) {
        delete next[buildingId];
      } else {
        next[buildingId] = n;
      }
      return next;
    });
  }, []);

  // Funding line: walk buildings highest-score-first, funding each while the
  // running cost stays within budget; once one doesn't fit, it and everything
  // after it (by priority order) is Deferred. Buildings with no resolved cost
  // can't be placed on either side of the line yet.
  const { fundedRows, deferredRows, needsCostRows } = useMemo(() => {
    const funded = [];
    const deferred = [];
    const needsCost = [];
    let cumulative = 0;
    let cutoff = false;
    portfolioRows.forEach((row) => {
      if (row.resolvedCost == null) {
        needsCost.push(row);
        return;
      }
      if (!cutoff) {
        const next = cumulative + row.resolvedCost;
        if (next <= budgetCap) {
          cumulative = next;
          funded.push(row);
          return;
        }
        cutoff = true;
      }
      deferred.push(row);
    });
    return { fundedRows: funded, deferredRows: deferred, needsCostRows: needsCost };
  }, [portfolioRows, budgetCap]);

  const fundedIds = useMemo(() => new Set(fundedRows.map((r) => r.buildingId)), [fundedRows]);
  const deferredIds = useMemo(() => new Set(deferredRows.map((r) => r.buildingId)), [deferredRows]);
  const fundedCost = useMemo(() => fundedRows.reduce((sum, r) => sum + r.resolvedCost, 0), [fundedRows]);
  const deferredCost = useMemo(() => deferredRows.reduce((sum, r) => sum + r.resolvedCost, 0), [deferredRows]);

  const tierStats = useMemo(() => TIERS.map((tier) => {
    const inTier = portfolioRows.filter((r) => r.tierLevel === tier.level);
    const cost = inTier.reduce((sum, r) => sum + (Number.isFinite(r.resolvedCost) ? r.resolvedCost : 0), 0);
    const knownCostCount = inTier.filter((r) => r.resolvedCost != null).length;
    return { ...tier, count: inTier.length, cost, knownCostCount };
  }), [portfolioRows]);

  const budgetSliderMax = totalKnownCost > 0 ? totalKnownCost : 1;
  const budgetSliderStep = Math.max(1000, Math.round(budgetSliderMax / 500));

  if (!enabled) return null;

  return (
    <div
      className="control-section"
      style={{
        background: '#fff',
        padding: 8,
        border: '1px solid #d8e0ea',
        borderRadius: 6,
        marginTop: 6,
        display: 'flex',
        flexDirection: 'column',
        height: '100%'
      }}
    >
      {/* Collapsed by default -- same native <details>/<summary> disclosure
          pattern SpaceDashboardPanel's CollapsibleSection already uses
          elsewhere in this codebase (title text as the summary, everything
          else as children), replicated locally here since this file doesn't
          import from SpaceDashboardPanel.jsx. */}
      <details
        open={panelOpen}
        onToggle={(event) => setPanelOpen(event.currentTarget.open)}
      >
        <summary style={{ fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: '#1d2939' }}>
          {title}
        </summary>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <button className="btn" type="button" onClick={() => void refreshRows()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: '#465569', lineHeight: 1.35 }}>
        Capital Compass-style capital prioritization. Scores are entered manually below and saved per building.
      </div>

      {errorMessage ? (
        <div style={{ marginTop: 6, fontSize: 11, color: '#b42318' }}>{errorMessage}</div>
      ) : null}

      {/* Scrollable body: scoring form + read-only summary */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingRight: 3 }}>
      {/* Scoring form */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 3 }}>
          Building
        </label>
        <select
          value={selectedBuildingId}
          onChange={(e) => setSelectedBuildingId(e.target.value)}
          style={{ width: '100%', fontSize: 11.5, padding: '4px 6px' }}
        >
          <option value="">Select a building…</option>
          {buildingOptions.map((opt) => (
            <option key={opt.docId} value={opt.buildingId}>{opt.buildingId}</option>
          ))}
        </select>

        {selectedBuildingId ? (
          <div style={{ marginTop: 8 }}>
            {loadingSelection ? (
              <div style={{ fontSize: 11, color: '#667085' }}>Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '3px 4px', borderBottom: '1px solid #e5e7eb' }}>Criterion</th>
                      <th style={{ textAlign: 'right', padding: '3px 4px', borderBottom: '1px solid #e5e7eb', width: 44 }}>Max</th>
                      <th style={{ textAlign: 'left', padding: '3px 4px', borderBottom: '1px solid #e5e7eb', width: '46%' }}>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SCORE_FIELDS.map((field) => {
                      const currentLevel = field.levels.find((lvl) => lvl.score === scores[field.key]);
                      const suggestion = SUGGESTIONS_BY_KEY[field.key] || null;
                      return (
                        <tr key={field.key}>
                          <td style={{ padding: '4px', verticalAlign: 'top' }}>
                            <div style={{ fontWeight: 600 }}>{field.label}</div>
                            <div style={{ color: '#667085', fontSize: 10 }}>{field.fullName}</div>
                          </td>
                          <td style={{ padding: '4px', textAlign: 'right', verticalAlign: 'top', color: '#667085' }}>
                            {field.max}
                          </td>
                          <td style={{ padding: '4px', verticalAlign: 'top' }}>
                            <select
                              value={scores[field.key] ?? ''}
                              onChange={(e) => handleScoreChange(field.key, e.target.value)}
                              style={{ width: '100%', fontSize: 11, padding: '3px 4px' }}
                            >
                              <option value="">Not scored</option>
                              {field.levels.map((lvl) => (
                                <option key={lvl.score} value={lvl.score}>
                                  {lvl.score} — {lvl.label}
                                </option>
                              ))}
                            </select>
                            {currentLevel ? (
                              <div style={{ color: '#667085', fontSize: 10, marginTop: 2 }}>{currentLevel.desc}</div>
                            ) : null}
                            {suggestion ? (
                              <div
                                style={{
                                  marginTop: 4,
                                  padding: '4px 6px',
                                  background: '#eff6ff',
                                  border: '1px solid #bfdbfe',
                                  borderRadius: 4,
                                  fontSize: 10,
                                  color: '#1e3a5f'
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => handleScoreChange(field.key, suggestion.score)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    color: '#1d4ed8',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    textDecoration: 'underline',
                                    fontSize: 10
                                  }}
                                >
                                  Suggested: {suggestion.score}/{field.max} ({suggestion.levelLabel})
                                </button>
                                {' '}based on {suggestion.rationale} — click to apply, then review before saving.
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div style={{ marginTop: 8, padding: 8, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#465569' }}>
                    Total: <strong>{total}</strong> / 100
                  </div>
                  {currentTier ? (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: currentTier.color }}>
                        Tier {currentTier.level} — {currentTier.horizon}
                      </div>
                      <div style={{ fontSize: 10.5, color: '#667085', marginTop: 2 }}>{currentTier.action}</div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: '#667085', marginTop: 4 }}>
                      Score all criteria to see priority tier.
                    </div>
                  )}
                </div>

                <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#344054', marginTop: 8, marginBottom: 3 }}>
                  Notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  style={{ width: '100%', fontSize: 11, padding: '4px 6px', resize: 'vertical' }}
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <button className="btn" type="button" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? 'Saving...' : 'Save Score'}
                  </button>
                  {saveMessage ? <span style={{ fontSize: 10.5, color: '#15803d' }}>{saveMessage}</span> : null}
                  {saveError ? <span style={{ fontSize: 10.5, color: '#b42318' }}>{saveError}</span> : null}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Read-only summary of all scored buildings */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        {rows.length ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((row) => (
              <div key={row.buildingId} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: '#f8fafc' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{row.originalId || row.buildingId}</div>
                    {row.tier ? <div style={{ fontSize: 10.5, color: '#667085' }}>Tier {row.tier}{row.tierHorizon ? ` — ${row.tierHorizon}` : ''}</div> : null}
                  </div>
                  {row.updatedAt ? (
                    <div style={{ fontSize: 10.5, color: '#667085', textAlign: 'right' }}>
                      {formatUpdatedAt(row.updatedAt)}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 11, marginTop: 4 }}>
                  {SCORE_FIELDS.map((field) => (
                    row[field.key] != null ? (
                      <React.Fragment key={field.key}>
                        <span>{field.label}</span>
                        <span>{row[field.key]} / {field.max}</span>
                      </React.Fragment>
                    ) : null
                  ))}
                  {row.total != null ? (
                    <React.Fragment>
                      <span style={{ fontWeight: 600 }}>Total</span>
                      <span style={{ fontWeight: 600 }}>{row.total} / 100</span>
                    </React.Fragment>
                  ) : null}
                </div>
                {row.notes ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#465569' }}>{row.notes}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#667085' }}>
            {loading ? 'Loading...' : 'No buildings scored yet.'}
          </div>
        )}
      </div>

      {/* Portfolio Prioritizer — all scored buildings together as a capital plan.
          Read-only against `rows` (capitalPriorities collection, loaded above) plus
          getBuildingResourceEntry (also read-only). No Firestore writes here — the
          budget cap and any manual cost entries are client-side-only computation. */}
      <div style={{ marginTop: 10, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <h4 style={{ margin: '0 0 4px', fontSize: 12.5 }}>Portfolio Prioritizer</h4>
        <div style={{ fontSize: 10.5, color: '#667085', marginBottom: 6, lineHeight: 1.35 }}>
          All scored buildings ranked by total score. Adjust the budget cap to see which
          projects are funded (highest scores first, cumulative cost) versus deferred.
        </div>

        {portfolioRows.length ? (
          <>
            <div style={{ padding: 8, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <label style={{ fontSize: 10.5, fontWeight: 600, color: '#344054' }}>Budget Cap</label>
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>{formatUsdCompact(budgetCap)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={budgetSliderMax}
                step={budgetSliderStep}
                value={Math.min(budgetCap, budgetSliderMax)}
                onChange={(e) => handleBudgetCapChange(e.target.value)}
                disabled={totalKnownCost <= 0}
                style={{ width: '100%', marginTop: 4 }}
              />
              <input
                type="number"
                min={0}
                value={budgetCap}
                onChange={(e) => handleBudgetCapChange(e.target.value)}
                style={{ width: '100%', fontSize: 11, padding: '3px 6px', marginTop: 4 }}
              />
              {totalKnownCost <= 0 ? (
                <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>
                  No building costs yet — enter a manual cost below to enable the budget slider.
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 8 }}>
              <PortfolioStat label="Buildings Scored" value={portfolioRows.length} />
              <PortfolioStat label="Needs Cost" value={needsCostRows.length} color={needsCostRows.length ? '#b45309' : undefined} />
              <PortfolioStat label="Funded" value={`${fundedRows.length} · ${formatUsdCompact(fundedCost)}`} color="#15803d" />
              <PortfolioStat label="Deferred" value={`${deferredRows.length} · ${formatUsdCompact(deferredCost)}`} color="#b42318" />
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 4 }}>Cost by Tier</div>
              <div style={{ display: 'grid', gap: 3 }}>
                {tierStats.map((tier) => (
                  <div
                    key={tier.level}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 10.5,
                      padding: '3px 6px',
                      background: '#f8fafc',
                      border: '1px solid #e5e7eb',
                      borderRadius: 4
                    }}
                  >
                    <span style={{ color: tier.color, fontWeight: 600 }}>
                      Tier {tier.level} ({tier.range})
                    </span>
                    <span style={{ color: '#465569' }}>
                      {tier.count} building{tier.count === 1 ? '' : 's'}
                      {tier.count ? ` — ${formatUsdCompact(tier.cost)}` : ''}
                      {tier.count && tier.knownCostCount < tier.count ? ` (${tier.count - tier.knownCostCount} missing cost)` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ fontSize: 10.5, fontWeight: 600, color: '#344054', marginBottom: 4 }}>
              Funding Order
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {portfolioRows.map((row) => {
                const status = fundedIds.has(row.buildingId)
                  ? 'funded'
                  : deferredIds.has(row.buildingId)
                    ? 'deferred'
                    : 'needsCost';
                const cardBackground = status === 'funded' ? '#f0fdf4' : status === 'deferred' ? '#fef2f2' : '#fffbeb';
                const statusLabel = status === 'funded' ? 'Funded' : status === 'deferred' ? 'Deferred' : 'Cost needed';
                const statusColor = status === 'funded' ? '#15803d' : status === 'deferred' ? '#b42318' : '#b45309';
                return (
                  <div
                    key={row.buildingId}
                    style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: cardBackground }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, overflowWrap: 'anywhere' }}>
                          {row.originalId || row.buildingId}
                        </div>
                        <div style={{ fontSize: 10, color: '#667085' }}>
                          Score {row.total}/100 · <span style={{ color: row.tierColor }}>Tier {row.tierLevel}</span>
                          {row.tierHorizon ? ` — ${row.tierHorizon}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700 }}>
                          {row.resolvedCost != null ? formatUsdCompact(row.resolvedCost) : '—'}
                        </div>
                        {row.costSource ? (
                          <div style={{ fontSize: 9.5, color: '#94a3b8' }}>
                            {row.costSource === 'auto' ? 'from deferred maint.' : 'manual entry'}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {row.costSource !== 'auto' ? (
                      <div style={{ marginTop: 4 }}>
                        <label style={{ fontSize: 10, color: '#667085' }}>Manual cost estimate ($, not saved)</label>
                        <input
                          type="number"
                          min={0}
                          value={manualCosts[row.buildingId] ?? ''}
                          onChange={(e) => handleManualCostChange(row.buildingId, e.target.value)}
                          placeholder="e.g. 1500000"
                          style={{ width: '100%', fontSize: 11, padding: '3px 6px', marginTop: 2 }}
                        />
                      </div>
                    ) : null}

                    <div style={{ marginTop: 4, fontSize: 10.5, fontWeight: 700, color: statusColor }}>
                      {statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: '#667085' }}>
            {loading ? 'Loading...' : 'Score at least one building above to build the portfolio view.'}
          </div>
        )}
      </div>
      </div>
      </details>
    </div>
  );
}
