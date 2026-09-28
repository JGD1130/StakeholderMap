// src/utils/useResearchSpaceData.js
//
// F&A Compass data hook: the Airtable room scope + live Firestore listeners on
// researchSpaceOccupants / researchSpaceRoomStatus, with each room's status
// derived through researchSpaceStatus.js. Called once in StakeholderMap.jsx
// and handed to both ResearchSpaceClassificationPanel (list/rollup/editor) and
// the floorplan color mode, so they read one derivation and one set of
// listeners. Reads and writes go to universities/{universityId} (the one
// StakeholderMap passes in; 'hastings' when none).
//
// Computed once here: each room's functional profile (roomRows[].profile) and
// the campus rollup, which reuses those profiles.
//
// The room editor's draft also lives here (an external store, see
// researchSpaceDraft.js), so unmounting the panel doesn't lose unsaved edits.
// Components read it with useResearchSpaceDraft(data).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { fetchAirtableRoomsForUtilization } from './classroomUtilizationCalc';
import { isAbortError } from './fetchWithTimeout';
import { deriveResearchSpaceRoomsFromAirtable } from './researchSpaceRoomScope';
import {
  ROOM_EXCLUSION_STATUSES,
  computeRoomFunctionalProfile,
  computeResearchSpaceRollup,
  validateFootprintWeightsSumTo100
} from './researchSpaceClassification';
import { RS_STATUS, buildScopeFloorIndex, deriveRoomStatus } from './researchSpaceStatus';
import {
  CLASS_LAB_MODE,
  classLabOccupantFields,
  createResearchSpaceDraftStore,
  draftFingerprint,
  isClassLabOccupantDocs,
  isDraftDirty,
  newOccupantDraft,
  occupantDocToDraft,
  validateOccupantDraft
} from './researchSpaceDraft';

const DEFAULT_UNIVERSITY_ID = 'hastings';
export const RESEARCH_SPACE_OCCUPANTS_COLLECTION = 'researchSpaceOccupants';
export const RESEARCH_SPACE_ROOM_STATUS_COLLECTION = 'researchSpaceRoomStatus';

const BATCH_CHUNK_SIZE = 400; // Firestore's cap is 500 ops per batch

const AIRTABLE_LOAD_ERROR_MESSAGE = "Couldn't load research space data.";
const FIRESTORE_LOAD_ERROR_MESSAGE = "Couldn't load saved classifications — refresh the page to retry.";

export function useResearchSpaceData({ enabled = false, universityId, resolveBuildingFolder } = {}) {
  const resolvedUniversityId = String(universityId || '').trim() || DEFAULT_UNIVERSITY_ID;
  const [airtableRoomsRaw, setAirtableRoomsRaw] = useState(null); // null = not loaded yet
  const [airtableError, setAirtableError] = useState('');
  const [occupantDocs, setOccupantDocs] = useState([]); // raw Firestore docs, all rooms
  const [roomStatusDocs, setRoomStatusDocs] = useState({}); // roomKey -> exclusion status code
  const [loadError, setLoadError] = useState('');

  const occupantsCollection = useMemo(
    () => collection(db, 'universities', resolvedUniversityId, RESEARCH_SPACE_OCCUPANTS_COLLECTION),
    [resolvedUniversityId]
  );
  const roomStatusCollection = useMemo(
    () => collection(db, 'universities', resolvedUniversityId, RESEARCH_SPACE_ROOM_STATUS_COLLECTION),
    [resolvedUniversityId]
  );

  // Airtable room scope -- fetched once, not live. Room-type assignment
  // doesn't change moment to moment; a manual page refresh is enough to pick
  // up a genuinely new Airtable room.
  //
  // A timeout (cold AI server) retries once automatically -- by then the
  // server is usually awake. `reloadNonce` lets the panel's Retry re-run it.
  // Raw error text is logged, never rendered.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setAirtableError('');
    const load = async () => {
      try {
        return await fetchAirtableRoomsForUtilization();
      } catch (error) {
        if (cancelled || !isAbortError(error)) throw error;
        console.warn('F&A Compass: Airtable rooms fetch timed out, retrying once.', error);
        return fetchAirtableRoomsForUtilization();
      }
    };
    load()
      .then((rooms) => {
        if (cancelled) return;
        setAirtableRoomsRaw(Array.isArray(rooms) ? rooms : []);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('F&A Compass: failed to load Airtable room inventory.', error);
        setAirtableError(AIRTABLE_LOAD_ERROR_MESSAGE);
        setAirtableRoomsRaw((prev) => prev ?? []);
      });
    return () => { cancelled = true; };
  }, [enabled, reloadNonce]);

  // Live listeners -- both collections are small (a few hundred rooms' worth
  // of occupants at most), so a whole-collection listener is simpler and
  // cheaper than per-room subscriptions, and keeps everything in sync
  // immediately after any save (including from another admin tab).
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = onSnapshot(
      occupantsCollection,
      (snap) => setOccupantDocs(snap.docs),
      (error) => {
        console.error('F&A Compass: occupants listener failed.', error);
        setLoadError(FIRESTORE_LOAD_ERROR_MESSAGE);
      }
    );
    return () => unsubscribe();
  }, [enabled, occupantsCollection]);

  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = onSnapshot(
      roomStatusCollection,
      (snap) => {
        const next = {};
        snap.docs.forEach((docSnap) => { next[docSnap.id] = docSnap.data()?.status || ''; });
        setRoomStatusDocs(next);
      },
      (error) => {
        console.error('F&A Compass: room status listener failed.', error);
        setLoadError(FIRESTORE_LOAD_ERROR_MESSAGE);
      }
    );
    return () => unsubscribe();
  }, [enabled, roomStatusCollection]);

  // Scope derived from the raw pull so a new resolveBuildingFolder identity
  // re-derives (cheap) instead of refetching.
  const scopeRooms = useMemo(
    () => (airtableRoomsRaw === null
      ? null
      : deriveResearchSpaceRoomsFromAirtable(airtableRoomsRaw, { resolveBuildingFolder })),
    [airtableRoomsRaw, resolveBuildingFolder]
  );

  // occupantDocs grouped by roomKey, kept as raw docSnap references so the
  // draft editor can diff (added/removed/changed) against them on save.
  const occupantsByRoomKey = useMemo(() => {
    const map = new Map();
    occupantDocs.forEach((docSnap) => {
      const roomKey = docSnap.data()?.roomKey;
      if (!roomKey) return;
      if (!map.has(roomKey)) map.set(roomKey, []);
      map.get(roomKey).push(docSnap);
    });
    return map;
  }, [occupantDocs]);

  // One row per scope room, with its status and (unless excluded) its
  // functional profile -- the only place a room's profile is computed.
  const roomRows = useMemo(() => {
    const rooms = Array.isArray(scopeRooms) ? scopeRooms : [];
    return rooms.map((room) => {
      const occupantDocsForRoom = occupantsByRoomKey.get(room.roomKey) || [];
      const exclusionStatus = roomStatusDocs[room.roomKey] || '';
      const status = deriveRoomStatus({ occupantCount: occupantDocsForRoom.length, exclusionStatus });
      const profile = exclusionStatus ? null : computeRoomFunctionalProfile(occupantDocsForRoom.map((docSnap) => docSnap.data()));
      return {
        ...room,
        occupantCount: occupantDocsForRoom.length,
        isClassLab: !exclusionStatus && isClassLabOccupantDocs(occupantDocsForRoom),
        exclusionStatus,
        status,
        isClassified: status !== RS_STATUS.NOT_STARTED,
        profile
      };
    });
  }, [scopeRooms, occupantsByRoomKey, roomStatusDocs]);

  // Campus rollup over the same rows (reuses their profiles).
  const rollup = useMemo(() => computeResearchSpaceRollup(roomRows), [roomRows]);

  const statusByRoomKey = useMemo(() => {
    const map = new Map();
    roomRows.forEach((row) => map.set(row.roomKey, row.status));
    return map;
  }, [roomRows]);

  const scopeIndex = useMemo(() => buildScopeFloorIndex(scopeRooms), [scopeRooms]);

  // --- Room editor draft --------------------------------------------------
  // The store and every function below keep one identity for the life of the
  // hook, so the draft changing never re-renders StakeholderMap; they read the
  // latest Firestore state through latestRef.
  const draftStoreRef = useRef(null);
  if (!draftStoreRef.current) draftStoreRef.current = createResearchSpaceDraftStore();
  const draftStore = draftStoreRef.current;
  const latestRef = useRef(null);
  latestRef.current = { occupantsByRoomKey, roomStatusDocs, occupantsCollection, roomStatusCollection };

  // A draft belongs to one university's data.
  useEffect(() => () => draftStore.set(null), [draftStore, resolvedUniversityId]);

  // Opens (replaces) the draft for a room from what's saved for it.
  const openDraft = useCallback((roomKey) => {
    if (!roomKey) { draftStore.set(null); return; }
    const { occupantsByRoomKey: byRoom, roomStatusDocs: statuses } = latestRef.current;
    const existingDocs = byRoom.get(roomKey) || [];
    // A saved class lab opens in that mode; its placeholder occupant is not
    // shown for editing (switching to Occupants starts a fresh list).
    const classLab = !statuses[roomKey] && isClassLabOccupantDocs(existingDocs);
    const next = {
      roomKey,
      mode: statuses[roomKey] || (classLab ? CLASS_LAB_MODE : 'occupants'),
      occupants: existingDocs.length && !classLab ? existingDocs.map(occupantDocToDraft) : [newOccupantDraft()]
    };
    draftStore.set({ ...next, baseline: draftFingerprint(next) });
  }, [draftStore]);

  // setDraft(patch | (draft) => patch): merges into the open draft.
  const setDraft = useCallback((patch) => {
    draftStore.set((prev) => {
      if (!prev) return prev;
      const value = typeof patch === 'function' ? patch(prev) : patch;
      return value ? { ...prev, ...value } : prev;
    });
  }, [draftStore]);

  const discardDraft = useCallback(() => draftStore.set(null), [draftStore]);

  // Saves the open draft; resolves to a confirmation message, throws on a
  // validation or Firestore error.
  //   - Vacant / Ineligible: write the status doc, delete the room's occupants.
  //   - Class lab: clear any status doc, write the one class-lab occupant
  //     (reusing its doc id), delete any other occupants.
  //   - Occupants: clear any status doc, then set / delete occupant docs in
  //     one batch. New occupants' Firestore ids go back into the draft, so the
  //     next save updates them instead of deleting and rewriting.
  const saveDraft = useCallback(async () => {
    const draft = draftStore.getSnapshot();
    if (!draft) throw new Error('No room is open.');
    const { occupantsByRoomKey: byRoom, occupantsCollection: occRef, roomStatusCollection: statusRef } = latestRef.current;
    const { roomKey, mode, occupants } = draft;
    const roomStatusDoc = doc(statusRef, roomKey);
    const existingDocs = byRoom.get(roomKey) || [];

    let message;
    let savedIds = null; // _draftId -> Firestore id, after an occupants save
    if (mode === CLASS_LAB_MODE) {
      await deleteDoc(roomStatusDoc).catch(() => {}); // no-op if none exists
      const reuse = existingDocs.find((d) => d.data()?.kind === classLabOccupantFields(roomKey).kind);
      const batch = writeBatch(db);
      batch.set(reuse ? reuse.ref : doc(occRef), {
        ...classLabOccupantFields(roomKey),
        updatedAt: serverTimestamp(),
        ...(reuse ? {} : { createdAt: serverTimestamp() })
      }, { merge: true });
      existingDocs.filter((d) => d !== reuse).forEach((d) => batch.delete(d.ref));
      await batch.commit();
      message = 'Saved as a class lab (100% Instruction and Departmental Research).';
    } else if (mode !== 'occupants') {
      await setDoc(roomStatusDoc, { status: mode, updatedAt: serverTimestamp() });
      for (let i = 0; i < existingDocs.length; i += BATCH_CHUNK_SIZE) {
        const chunk = existingDocs.slice(i, i + BATCH_CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();
      }
      message = `Saved as ${ROOM_EXCLUSION_STATUSES.find((s) => s.code === mode)?.label || mode}.`;
    } else {
      const valid = occupants.length > 0
        && occupants.every((o) => validateOccupantDraft(o).length === 0)
        && validateFootprintWeightsSumTo100(occupants.map((o) => ({ footprintWeight: Number(o.footprintWeight) }))).valid;
      if (!valid) throw new Error('Fix the highlighted fields before saving.');
      await deleteDoc(roomStatusDoc).catch(() => {}); // clears any prior exclusion status; no-op if none exists

      const existingIds = new Set(existingDocs.map((d) => d.id));
      const keptIds = new Set(occupants.filter((o) => o.id).map((o) => o.id));
      const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

      savedIds = new Map();
      const batch = writeBatch(db);
      occupants.forEach((o) => {
        const ref = o.id ? doc(occRef, o.id) : doc(occRef);
        savedIds.set(o._draftId, ref.id);
        batch.set(ref, {
          roomKey,
          occupantName: o.occupantName.trim(),
          role: o.role,
          footprintWeight: Number(o.footprintWeight),
          fundingSources: o.fundingSources.map((row) => ({
            source: row.source.trim(),
            percentage: Number(row.percentage),
            category: row.category
          })),
          updatedAt: serverTimestamp(),
          ...(o.id ? {} : { createdAt: serverTimestamp() })
        }, { merge: true });
      });
      removedIds.forEach((id) => batch.delete(doc(occRef, id)));
      await batch.commit();
      message = `Saved ${occupants.length} occupant${occupants.length === 1 ? '' : 's'}.`;
    }

    // What was just saved is the new clean state (if this room is still open).
    // After an occupants save the draft carries the Firestore ids; after any
    // other mode the listed occupants were deleted, so their ids are dropped.
    draftStore.set((prev) => {
      if (!prev || prev.roomKey !== roomKey) return prev;
      const nextOccupants = (prev.occupants || []).map((o) => (
        savedIds ? (savedIds.has(o._draftId) ? { ...o, id: savedIds.get(o._draftId) } : o) : { ...o, id: null }
      ));
      // Baseline = what was saved (ids aren't part of it), so an edit typed
      // while the save was in flight still counts as unsaved.
      return { ...prev, occupants: nextOccupants, baseline: draftFingerprint(draft) };
    });
    return message;
  }, [draftStore]);

  return {
    universityId: resolvedUniversityId,
    scopeRooms,
    airtableError,
    loadError,
    reload,
    occupantsByRoomKey,
    roomStatusDocs,
    roomRows,
    rollup,
    statusByRoomKey,
    scopeIndex,
    draftStore,
    openDraft,
    setDraft,
    discardDraft,
    saveDraft
  };
}

// The open draft for a useResearchSpaceData result: { draft, isDirty,
// openDraft, setDraft, discardDraft, saveDraft }. Only components calling this
// re-render as the draft changes.
export function useResearchSpaceDraft(data) {
  const { draftStore } = data;
  const draft = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot, draftStore.getSnapshot);
  return {
    draft,
    isDirty: isDraftDirty(draft),
    openDraft: data.openDraft,
    setDraft: data.setDraft,
    discardDraft: data.discardDraft,
    saveDraft: data.saveDraft
  };
}
