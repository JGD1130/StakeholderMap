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

export default function CapitalPrioritiesPanel({
  universityId,
  enabled = false,
  title = 'Capital Priorities',
  buildingFeatures = []
}) {
  const normalizedUniversityId = String(universityId || '').trim();
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>{title}</h4>
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
      </div>
    </div>
  );
}
