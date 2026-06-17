import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './AssessmentPanel.css';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../firebaseConfig';

const scoreOptions = [
  { value: 5, label: '5 - Excellent' },
  { value: 4, label: '4 - Good' },
  { value: 3, label: '3 - Adequate' },
  { value: 2, label: '2 - Poor' },
  { value: 1, label: '1 - Very Poor' },
  { value: 0, label: '0 - Not Set' },
];

const assessmentTemplate = {
  buildingName: '',
  notes: '',
  scores: {
    architecture: { exterior: 0, entrances: 0, interiorFinishes: 0, lifeSafety: 0, codesAndAccessibility: 0 },
    engineering: { superstructure: 0, conveyingSystems: 0, fireProtection: 0, plumbing: 0, mechanical: 0, power: 0, lighting: 0 },
    functionality: { telecomm: 0, fireAlarm: 0, spaceSize: 0, technology: 0 },
  },
};
const TECHNICAL_FIELD_ALIASES = {
  exterior: ['buildingExterior'],
  entrances: ['entry', 'entrys', 'entries'],
  interiorFinishes: ['interior', 'interiorFinish', 'interior_finish'],
  lifeSafety: ['lifesafety', 'life_safety'],
  codesAndAccessibility: ['codesAccessibility', 'codes_accessibility', 'accessibility'],
  superstructure: ['structure', 'structural'],
  conveyingSystems: ['conveying', 'conveyance', 'verticalTransportation'],
  fireProtection: ['fireProtectionSystems', 'fireSuppression'],
  plumbing: [],
  mechanical: ['hvac'],
  power: ['electricalPower', 'electrical'],
  lighting: ['lights'],
  telecomm: ['telecom', 'telecommunications'],
  fireAlarm: ['fireAlarms'],
  spaceSize: ['space', 'size'],
  technology: ['it', 'av']
};
const readTechnicalScoreValue = (sectionScores, fieldKey) => {
  const source = sectionScores && typeof sectionScores === 'object' ? sectionScores : {};
  const candidates = [fieldKey, ...(TECHNICAL_FIELD_ALIASES[fieldKey] || [])];
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = Number(source[key] ?? 0);
    if (Number.isFinite(value)) return value;
  }
  return 0;
};
const normalizeScoreSection = (sectionScores, templateSection) => {
  const normalized = {};
  Object.keys(templateSection || {}).forEach((fieldKey) => {
    normalized[fieldKey] = readTechnicalScoreValue(sectionScores, fieldKey);
  });
  return normalized;
};

const DRAFT_AUTOSAVE_MS = 900;
const CATEGORY_LABELS = {
  architecture: 'Codes',
  engineering: 'Engineering',
  functionality: 'Functionality'
};
const FIELD_LABELS = {
  telecomm: 'Telecomm',
  fireAlarm: 'Fire Alarm',
  spaceSize: 'Space Size',
  codesAndAccessibility: 'Codes and Accessibility',
  lifeSafety: 'Life Safety',
  interiorFinishes: 'Interior Finishes',
  conveyingSystems: 'Conveying Systems'
};
const formatCategoryLabel = (key) => CATEGORY_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');
const formatFieldLabel = (key) => FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').trim();

const cloneAssessment = (source, buildingNameFallback = '') => {
  const base = source && typeof source === 'object' ? source : {};
  const scores = base.scores && typeof base.scores === 'object' ? base.scores : {};
  const architecture = scores.architecture && typeof scores.architecture === 'object' ? scores.architecture : {};
  const engineering = scores.engineering && typeof scores.engineering === 'object' ? scores.engineering : {};
  const functionality = scores.functionality && typeof scores.functionality === 'object' ? scores.functionality : {};
  return {
    ...assessmentTemplate,
    ...base,
    buildingName: String(base.buildingName || buildingNameFallback || '').trim(),
    notes: String(base.notes || ''),
    photoUrls: Array.isArray(base.photoUrls) ? base.photoUrls : [],
    scores: {
      architecture: normalizeScoreSection(architecture, assessmentTemplate.scores.architecture),
      engineering: normalizeScoreSection(engineering, assessmentTemplate.scores.engineering),
      functionality: normalizeScoreSection(functionality, assessmentTemplate.scores.functionality)
    }
  };
};

const buildDraftStorageKey = (universityId, buildingId, ownerKey = '') => {
  const uni = String(universityId || '').trim();
  const bld = String(buildingId || '').trim();
  if (!uni || !bld) return '';
  const baseKey = `mf:technical-assessment-draft:${uni}:${bld.replace(/\//g, '__')}`;
  const owner = String(ownerKey || '').trim();
  return owner ? `${baseKey}:${owner}` : baseKey;
};

const formatSavedTime = (timestampMs) => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  try {
    return new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

const AssessmentPanel = ({
  buildingId,
  assessments,
  onClose,
  onSave,
  universityId,
  panelPos,
  panelRef,
  dragHandleProps,
  isAdminRole,
  canWriteCloud,
  assessmentSaveMode = 'building',
  assessorName = '',
  assessorKey = '',
  draftOwnerKey = '',
  onAssessorNameChange,
  allowAssessorEdit = true,
  enablePhotoUpload = false
}) => {
  const [localAssessment, setLocalAssessment] = useState(assessmentTemplate);
  const [saveState, setSaveState] = useState({ kind: 'idle', timestamp: 0, message: '' });
  const [isDraftDirty, setIsDraftDirty] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const autosaveTimerRef = useRef(null);
  const initializedRef = useRef(false);
  const fileInputRef = useRef(null);
  const isPerAssessorSaveMode = String(assessmentSaveMode || '').trim().toLowerCase() === 'per-assessor';
  const normalizedAssessorName = String(assessorName || '').trim();
  const normalizedAssessorKey = String(assessorKey || '').trim();
  const normalizedDraftOwnerKey = String(draftOwnerKey || '').trim();
  const draftStorageKey = useMemo(
    () => buildDraftStorageKey(universityId, buildingId, normalizedDraftOwnerKey),
    [universityId, buildingId, normalizedDraftOwnerKey]
  );
  const canSaveToCloud = useMemo(
    () => (typeof canWriteCloud === 'boolean' ? canWriteCloud : Boolean(isAdminRole)),
    [canWriteCloud, isAdminRole]
  );
  const canSaveAssessment = useMemo(
    () => canSaveToCloud && (!isPerAssessorSaveMode || (normalizedAssessorName && normalizedAssessorKey)),
    [canSaveToCloud, isPerAssessorSaveMode, normalizedAssessorName, normalizedAssessorKey]
  );

  const clearAutosaveTimer = useCallback(() => {
    if (!autosaveTimerRef.current) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!buildingId) return;
    const baseAssessment = cloneAssessment(assessments?.[buildingId], buildingId);
    let restoredDraft = null;
    if (draftStorageKey) {
      try {
        const raw = window.localStorage?.getItem(draftStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.assessment) {
            restoredDraft = {
              assessment: cloneAssessment(parsed.assessment, buildingId),
              savedAt: Number(parsed.savedAt) || 0
            };
          }
        }
      } catch {}
    }
    const nextAssessment = restoredDraft?.assessment || baseAssessment;
    setLocalAssessment(nextAssessment);
    setIsDraftDirty(false);
    initializedRef.current = true;
    setSaveState(
      restoredDraft
        ? { kind: 'draft-restored', timestamp: restoredDraft.savedAt, message: '' }
        : { kind: 'idle', timestamp: 0, message: '' }
    );
    clearAutosaveTimer();
    return () => {
      clearAutosaveTimer();
      initializedRef.current = false;
    };
  }, [buildingId, assessments, draftStorageKey, clearAutosaveTimer]);

  useEffect(() => {
    if (!initializedRef.current || !isDraftDirty || !draftStorageKey) return;
    clearAutosaveTimer();
    setSaveState((prev) => (
      prev.kind === 'saving-draft'
        ? prev
        : { kind: 'saving-draft', timestamp: prev.timestamp || 0, message: '' }
    ));
    autosaveTimerRef.current = setTimeout(() => {
      try {
        const savedAt = Date.now();
        window.localStorage?.setItem(
          draftStorageKey,
          JSON.stringify({
            savedAt,
            assessment: localAssessment
          })
        );
        setIsDraftDirty(false);
        setSaveState({ kind: 'draft-saved', timestamp: savedAt, message: '' });
      } catch {
        setSaveState({ kind: 'error', timestamp: Date.now(), message: 'Could not save local draft.' });
      }
    }, DRAFT_AUTOSAVE_MS);
    return () => clearAutosaveTimer();
  }, [localAssessment, isDraftDirty, draftStorageKey, clearAutosaveTimer]);

  useEffect(() => () => clearAutosaveTimer(), [clearAutosaveTimer]);

  const markDraftDirty = useCallback(() => {
    setIsDraftDirty(true);
    setSaveState({ kind: 'unsaved', timestamp: 0, message: '' });
  }, []);

  const onAssessmentChange = useCallback((updater) => {
    setLocalAssessment((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return cloneAssessment(next, buildingId);
    });
    markDraftDirty();
  }, [markDraftDirty, buildingId]);

  const handleScoreChange = (category, subCategory, value) => {
    onAssessmentChange((prev) => ({
      ...prev,
      scores: { ...prev.scores, [category]: { ...prev.scores[category], [subCategory]: Number(value) } },
    }));
  };

  const handleNotesChange = (e) => {
    const nextValue = e?.target?.value ?? '';
    onAssessmentChange((prev) => ({ ...prev, notes: nextValue }));
  };

  const handlePhotoSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setPhotoUploading(true);
    try {
      const sanitizedBuilding = (localAssessment.buildingName || buildingId)
        .replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_');
      const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `cherokee-mental-health/buildings/${sanitizedBuilding}/photos/${Date.now()}_${sanitizedFilename}`;
      const storageRef = ref(storage, storagePath);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      onAssessmentChange((prev) => ({
        ...prev,
        photoUrls: [...(Array.isArray(prev.photoUrls) ? prev.photoUrls : []), url]
      }));
    } catch (err) {
      console.error('Photo upload failed:', err);
      alert('Photo upload failed. Please try again.');
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleSaveChanges = async () => {
    if (!canSaveToCloud) {
      alert('Cloud save is disabled in this mode. Local draft autosave remains active.');
      return;
    }
    if (isPerAssessorSaveMode && (!normalizedAssessorName || !normalizedAssessorKey)) {
      setSaveState({ kind: 'error', timestamp: Date.now(), message: 'Enter your name or initials before saving.' });
      alert('Enter your name or initials before saving this assessment.');
      return;
    }
    if (!buildingId || !universityId) return;
    const sanitizedId = buildingId.replace(/\//g, '__');
    const docId = isPerAssessorSaveMode
      ? `${sanitizedId}__${normalizedAssessorKey}`
      : sanitizedId;
    const ref = doc(db, 'universities', universityId, 'buildingAssessments', docId);
    clearAutosaveTimer();
    const updatedAtClientMs = Date.now();
    const dataToSave = {
      ...localAssessment,
      originalId: buildingId,
      buildingName: localAssessment.buildingName || buildingId,
      updatedAt: serverTimestamp(),
      updatedAtClientMs,
      assessmentSaveMode: isPerAssessorSaveMode ? 'per-assessor' : 'building',
      assessorName: isPerAssessorSaveMode ? normalizedAssessorName : '',
      assessorKey: isPerAssessorSaveMode ? normalizedAssessorKey : '',
      isAssessorScoped: isPerAssessorSaveMode
    };
    setSaveState({ kind: 'saving-cloud', timestamp: 0, message: '' });
    try {
      await setDoc(ref, dataToSave, { merge: true });
      if (typeof onSave === 'function') {
        onSave({
          ...dataToSave,
          __docId: docId
        });
      }
      if (draftStorageKey) {
        try { window.localStorage?.removeItem(draftStorageKey); } catch {}
      }
      setIsDraftDirty(false);
      setSaveState({ kind: 'cloud-saved', timestamp: Date.now(), message: '' });
    } catch (err) {
      console.error('Error saving assessment:', err);
      if (draftStorageKey) {
        try {
          const savedAt = Date.now();
          window.localStorage?.setItem(
            draftStorageKey,
            JSON.stringify({
              savedAt,
              assessment: localAssessment
            })
          );
        } catch {}
      }
      setIsDraftDirty(true);
      setSaveState({ kind: 'error', timestamp: Date.now(), message: 'Cloud save failed. Draft kept locally.' });
      alert('Failed to save assessment to cloud. Local draft is still stored in this browser.');
    }
  };

  const saveStatus = useMemo(() => {
    const timeLabel = formatSavedTime(saveState.timestamp);
    switch (saveState.kind) {
      case 'unsaved':
        return { tone: 'warning', text: 'Unsaved changes' };
      case 'saving-draft':
        return { tone: 'info', text: 'Saving local draft...' };
      case 'draft-saved':
        return { tone: 'success', text: timeLabel ? `Draft autosaved at ${timeLabel}` : 'Draft autosaved' };
      case 'draft-restored':
        return { tone: 'info', text: timeLabel ? `Draft restored from ${timeLabel}` : 'Draft restored' };
      case 'saving-cloud':
        return { tone: 'info', text: 'Saving to cloud...' };
      case 'cloud-saved':
        return { tone: 'success', text: timeLabel ? `Saved to cloud at ${timeLabel}` : 'Saved to cloud' };
      case 'error':
        return { tone: 'error', text: saveState.message || 'Save failed' };
      default:
        if (isPerAssessorSaveMode && !normalizedAssessorName) {
          return { tone: 'warning', text: 'Enter your name or initials to enable cloud save' };
        }
        return { tone: 'muted', text: canSaveToCloud ? 'No unsaved changes' : 'Local draft autosave enabled' };
    }
  }, [saveState, canSaveToCloud, isPerAssessorSaveMode, normalizedAssessorName]);
  const assessmentProgress = useMemo(() => {
    const scores = localAssessment?.scores && typeof localAssessment.scores === 'object'
      ? localAssessment.scores
      : {};
    const sections = [
      { key: 'architecture', fields: Object.keys(assessmentTemplate.scores.architecture || {}) },
      { key: 'engineering', fields: Object.keys(assessmentTemplate.scores.engineering || {}) },
      { key: 'functionality', fields: Object.keys(assessmentTemplate.scores.functionality || {}) }
    ];
    let total = 0;
    let answered = 0;
    let started = 0;
    const missingSections = [];
    sections.forEach((section) => {
      const sectionScores = scores?.[section.key] && typeof scores[section.key] === 'object'
        ? scores[section.key]
        : {};
      let sectionAnswered = 0;
      section.fields.forEach((fieldKey) => {
        total += 1;
        const value = Number(sectionScores?.[fieldKey] ?? 0);
        if (Number.isFinite(value) && value > 0) {
          answered += 1;
          sectionAnswered += 1;
        }
      });
      if (sectionAnswered > 0) started += 1;
      else missingSections.push(formatCategoryLabel(section.key));
    });
    const pct = total ? Math.round((answered / total) * 100) : 0;
    return { total, answered, started, missingSections, pct };
  }, [localAssessment]);

  if (!buildingId) return null;

  const containerStyle = panelPos
    ? { position: 'absolute', left: (panelPos.x ?? 80), top: (panelPos.y ?? 160), zIndex: 500 }
    : undefined;

  return (
    <div ref={panelRef} className="assessment-panel" style={containerStyle}>
      <div className="panel-header panel-header--draggable" {...(dragHandleProps || {})}>
        <h3>Technical Assessment</h3>
        <button onClick={onClose} className="close-button">x</button>
      </div>
      <div className="panel-content">
        <h4>{localAssessment.buildingName || buildingId}</h4>
        <div className={`save-status save-status--${saveStatus.tone}`}>
          <span>{saveStatus.text}</span>
        </div>
        {isPerAssessorSaveMode && (
          <div className="assessment-identity">
            <h5>Assessor</h5>
            <input
              type="text"
              value={normalizedAssessorName}
              onChange={(e) => {
                if (typeof onAssessorNameChange === 'function') onAssessorNameChange(e?.target?.value ?? '');
              }}
              placeholder="Name or initials"
              disabled={!allowAssessorEdit}
            />
            <div className="save-hint">
              Each assessor saves a separate record for this building, so teammates will not overwrite one another.
            </div>
          </div>
        )}
        <div className="assessment-progress">
          <div>
            <b>{assessmentProgress.answered}</b> / {assessmentProgress.total} scored
            {' '}({assessmentProgress.pct}%)
          </div>
          <div>
            <b>{assessmentProgress.started}</b> / 3 sections started
          </div>
          {assessmentProgress.missingSections.length > 0 && (
            <div className="assessment-progress-missing">
              Missing section starts: {assessmentProgress.missingSections.join(', ')}
            </div>
          )}
        </div>
        {!canSaveToCloud && (
          <div className="save-hint">
            Cloud save requires admin sign-in. Drafts autosave locally in this browser.
          </div>
        )}

        {localAssessment.scores && Object.entries(localAssessment.scores).map(([category, subScores]) => (
          <div key={category} className="category-section">
            <h5>{formatCategoryLabel(category)}</h5>
            {Object.entries(subScores).map(([subCategory, score]) => (
              <div key={subCategory} className="score-item">
                <label>{formatFieldLabel(subCategory)}</label>
                <select value={score} onChange={(e) => handleScoreChange(category, subCategory, e.target.value)}>
                  {scoreOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        ))}

        <div className="notes-section">
          <h5>Notes</h5>
          <textarea value={localAssessment.notes || ''} onChange={handleNotesChange} rows="4" />
        </div>

        {enablePhotoUpload && (
          <div className="photos-section">
            <h5>Photos</h5>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handlePhotoSelect}
            />
            <button
              type="button"
              className="photo-upload-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={photoUploading}
            >
              {photoUploading ? 'Uploading...' : '+ Add Photo'}
            </button>
            {Array.isArray(localAssessment.photoUrls) && localAssessment.photoUrls.length > 0 && (
              <div className="photo-thumbnails">
                {localAssessment.photoUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={`Photo ${i + 1}`} className="photo-thumb" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          className="save-button"
          onClick={handleSaveChanges}
          disabled={!canSaveAssessment || saveState.kind === 'saving-cloud'}
          title={
            !canSaveToCloud
              ? 'Cloud save disabled in this mode.'
              : (isPerAssessorSaveMode && !normalizedAssessorName)
                ? 'Enter your name or initials first.'
                : 'Save assessment to cloud'
          }
        >
          {saveState.kind === 'saving-cloud' ? 'Saving...' : 'Save to Cloud'}
        </button>
      </div>
    </div>
  );
};

export default AssessmentPanel;

