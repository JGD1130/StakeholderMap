// src/utils/researchSpaceDraft.js
//
// F&A Compass room-editor draft: the draft shape, the per-occupant form
// validation (moved unchanged from ResearchSpaceClassificationPanel.jsx), and
// a tiny external store that holds the one open draft.
//
// The store lives in useResearchSpaceData (mounted once in StakeholderMap.jsx),
// so the draft survives the panel unmounting (collapsed, scrolled away,
// moved). It is an external store rather than React state in the hook on
// purpose: a keystroke in the editor re-renders only components that
// subscribe to it (useResearchSpaceDraft), not all of StakeholderMap.
//
// draft: null, or {
//   roomKey,
//   mode: 'occupants' | 'class_lab' | 'vacant_unassigned' | 'ineligible_non_assignable',
//   occupants: [{ _draftId, id, occupantName, role, footprintWeight,
//                 fundingSources: [{ source, percentage, category }] }],
//   baseline  // draftFingerprint() at open / last save -- drives isDirty
// }
import {
  validateFundingSourcesSumTo100,
  validateInstructionDefaultRule
} from './researchSpaceClassification';

export const ROLE_OPTIONS = ['Faculty', 'Staff', 'Student', 'PI', 'Postdoc', 'Grad Student', 'Other'];

// "Class lab (instruction)": a teaching lab saved as 100% Instruction &
// Departmental Research without listing occupants. Stored as ONE marked
// occupant doc (kind: 'class_lab', footprint 100%, funding 100% IDR), so the
// status, rollup and validation rules need no special case: the room reads
// Classified and its SF lands in IDR.
export const CLASS_LAB_MODE = 'class_lab';
export const CLASS_LAB_KIND = 'class_lab';

export function classLabOccupantFields(roomKey) {
  return {
    roomKey,
    kind: CLASS_LAB_KIND,
    occupantName: 'Class lab (instruction)',
    role: 'Other',
    footprintWeight: 100,
    fundingSources: [{ source: 'Institutional', percentage: 100, category: 'IDR' }]
  };
}

export function isClassLabOccupantDocs(docs) {
  return Array.isArray(docs) && docs.length === 1 && docs[0].data()?.kind === CLASS_LAB_KIND;
}

export function newFundingSourceRow() {
  return { source: '', percentage: '', category: '' };
}

export function newOccupantDraft() {
  return {
    _draftId: `new_${Math.random().toString(36).slice(2)}`,
    id: null, // Firestore doc id -- null until first save
    occupantName: '',
    role: ROLE_OPTIONS[0],
    footprintWeight: '',
    fundingSources: [newFundingSourceRow()]
  };
}

export function occupantDocToDraft(docSnap) {
  const data = docSnap.data() || {};
  return {
    _draftId: docSnap.id,
    id: docSnap.id,
    occupantName: data.occupantName || '',
    role: data.role || 'Other',
    footprintWeight: data.footprintWeight != null ? String(data.footprintWeight) : '',
    fundingSources: Array.isArray(data.fundingSources) && data.fundingSources.length
      ? data.fundingSources.map((row) => ({
        source: row?.source || '',
        percentage: row?.percentage != null ? String(row.percentage) : '',
        category: row?.category || ''
      }))
      : [newFundingSourceRow()]
  };
}

export function draftToFundingSourcesForValidation(occupant) {
  return (occupant.fundingSources || []).map((row) => ({
    source: row.source,
    percentage: Number(row.percentage),
    category: row.category
  }));
}

// Full validation for one occupant draft -- both rules that apply within a
// single occupant. Returns a list of human messages (empty when valid).
export function validateOccupantDraft(occupant) {
  const messages = [];
  if (!String(occupant.occupantName || '').trim()) messages.push('Occupant name is required.');
  const weight = Number(occupant.footprintWeight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) messages.push('Share of room must be more than 0% and at most 100%.');
  const rows = draftToFundingSourcesForValidation(occupant);
  if (!rows.length) messages.push('Add at least one funding row.');
  rows.forEach((row, idx) => {
    if (!row.category) messages.push(`Funding row ${idx + 1}: choose a function.`);
    if (!Number.isFinite(row.percentage) || row.percentage < 0) messages.push(`Funding row ${idx + 1}: enter a percentage of 0 or more.`);
  });
  const sumCheck = validateFundingSourcesSumTo100(rows);
  if (!sumCheck.valid) messages.push(`Funding must add up to 100% (now ${Math.round(sumCheck.total * 100) / 100}%).`);
  const instructionDefault = validateInstructionDefaultRule(rows);
  if (!instructionDefault.valid) instructionDefault.errors.forEach((e) => messages.push(e.message));
  return messages;
}

// What the admin can change, as a string -- ids and draft ids left out, so a
// save that assigns Firestore ids doesn't make the draft look edited.
export function draftFingerprint(draft) {
  if (!draft) return '';
  return JSON.stringify([
    draft.mode,
    draft.mode === 'occupants'
      ? (draft.occupants || []).map((o) => [
        o.occupantName,
        o.role,
        o.footprintWeight,
        (o.fundingSources || []).map((r) => [r.source, r.percentage, r.category])
      ])
      : null
  ]);
}

export function isDraftDirty(draft) {
  return Boolean(draft) && draftFingerprint(draft) !== draft.baseline;
}

// Minimal subscribe/getSnapshot store for useSyncExternalStore.
export function createResearchSpaceDraftStore() {
  let draft = null;
  const listeners = new Set();
  return {
    getSnapshot: () => draft,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // next: a draft, null, or (prev) => draft|null.
    set: (next) => {
      const value = typeof next === 'function' ? next(draft) : next;
      if (value === draft) return;
      draft = value;
      listeners.forEach((listener) => listener());
    }
  };
}
