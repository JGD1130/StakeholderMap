// src/utils/useResearchSpaceData.js
//
// F&A Compass data hook (Hastings-only): the Airtable room scope + live
// Firestore listeners on researchSpaceOccupants / researchSpaceRoomStatus,
// with each room's status derived through researchSpaceStatus.js. Called once
// in StakeholderMap.jsx and handed to both ResearchSpaceClassificationPanel
// (list/rollup/editor) and the floorplan color mode, so they read one
// derivation and one set of listeners.
import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebaseConfig';
import { fetchAirtableRoomsForUtilization } from './classroomUtilizationCalc';
import { deriveResearchSpaceRoomsFromAirtable } from './researchSpaceRoomScope';
import { computeRoomFunctionalProfile } from './researchSpaceClassification';
import { RS_STATUS, buildScopeFloorIndex, deriveRoomStatus } from './researchSpaceStatus';

export const HASTINGS_UNIVERSITY_ID = 'hastings';
export const RESEARCH_SPACE_OCCUPANTS_COLLECTION = 'researchSpaceOccupants';
export const RESEARCH_SPACE_ROOM_STATUS_COLLECTION = 'researchSpaceRoomStatus';

export function useResearchSpaceData({ enabled = false, resolveBuildingFolder } = {}) {
  const [airtableRoomsRaw, setAirtableRoomsRaw] = useState(null); // null = not loaded yet
  const [airtableError, setAirtableError] = useState('');
  const [occupantDocs, setOccupantDocs] = useState([]); // raw Firestore docs, all rooms
  const [roomStatusDocs, setRoomStatusDocs] = useState({}); // roomKey -> exclusion status code
  const [loadError, setLoadError] = useState('');

  const occupantsCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, RESEARCH_SPACE_OCCUPANTS_COLLECTION),
    []
  );
  const roomStatusCollection = useMemo(
    () => collection(db, 'universities', HASTINGS_UNIVERSITY_ID, RESEARCH_SPACE_ROOM_STATUS_COLLECTION),
    []
  );

  // Airtable room scope -- fetched once, not live. Room-type assignment
  // doesn't change moment to moment; a manual page refresh is enough to pick
  // up a genuinely new Airtable room, same convention as
  // RoomUtilizationMetaSection's own one-time Airtable fetch.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchAirtableRoomsForUtilization()
      .then((rooms) => {
        if (cancelled) return;
        setAirtableRoomsRaw(Array.isArray(rooms) ? rooms : []);
      })
      .catch((error) => {
        if (cancelled) return;
        setAirtableError(String(error?.message || 'Failed to load Airtable room inventory.'));
        setAirtableRoomsRaw([]);
      });
    return () => { cancelled = true; };
  }, [enabled]);

  // Live listeners -- both collections are small (a few hundred rooms' worth
  // of occupants at most), so a whole-collection listener is simpler and
  // cheaper than per-room subscriptions, and keeps everything in sync
  // immediately after any save (including from another admin tab).
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = onSnapshot(
      occupantsCollection,
      (snap) => setOccupantDocs(snap.docs),
      (error) => setLoadError(String(error?.message || 'Failed to load research space occupants.'))
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
      (error) => setLoadError(String(error?.message || 'Failed to load room exclusion statuses.'))
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
  // detail editor can diff (added/removed/changed) against them on save.
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

  const roomRows = useMemo(() => {
    const rooms = Array.isArray(scopeRooms) ? scopeRooms : [];
    return rooms.map((room) => {
      const occupantDocsForRoom = occupantsByRoomKey.get(room.roomKey) || [];
      const exclusionStatus = roomStatusDocs[room.roomKey] || '';
      const status = deriveRoomStatus({ occupantCount: occupantDocsForRoom.length, exclusionStatus });
      const occupants = occupantDocsForRoom.map((docSnap) => docSnap.data());
      const profile = exclusionStatus ? null : computeRoomFunctionalProfile(occupants);
      return {
        ...room,
        occupantCount: occupantDocsForRoom.length,
        exclusionStatus,
        status,
        isClassified: status !== RS_STATUS.NOT_STARTED,
        profile
      };
    });
  }, [scopeRooms, occupantsByRoomKey, roomStatusDocs]);

  const statusByRoomKey = useMemo(() => {
    const map = new Map();
    roomRows.forEach((row) => map.set(row.roomKey, row.status));
    return map;
  }, [roomRows]);

  const scopeIndex = useMemo(() => buildScopeFloorIndex(scopeRooms), [scopeRooms]);

  return {
    scopeRooms,
    airtableError,
    loadError,
    occupantsByRoomKey,
    roomStatusDocs,
    roomRows,
    statusByRoomKey,
    scopeIndex
  };
}
