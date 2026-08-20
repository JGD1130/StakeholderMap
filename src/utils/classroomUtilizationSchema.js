// src/utils/classroomUtilizationSchema.js
//
// Schema definitions for the Classroom Utilization module (Hastings-only,
// gated by config.enableClassroomUtilization -- off by default, same
// convention as enableCapitalPriorities). This file defines the shape of
// four new Firestore collections under universities/{universityId}/ but
// does NOT read or write any of them yet -- no import logic, no calc
// engine, no Airtable reads exist yet. This is schema-only groundwork for
// a future build step.
//
// None of these collections are populated by anything in this codebase
// today. firestore.rules has intentionally not been touched for these --
// add rules for them when the step that actually reads/writes them lands
// (a rules change needs its own `firebase deploy --only firestore:rules`,
// separate from the app deploy pipeline).

export const SPACE_CONFIG_COLLECTION = 'spaceConfig';
export const TERMS_COLLECTION = 'terms';
export const ROOM_UTILIZATION_META_COLLECTION = 'roomUtilizationMeta';
export const COURSE_MEETINGS_COLLECTION = 'courseMeetings';
export const ENROLLMENT_PROJECTIONS_COLLECTION = 'enrollmentProjections';

/**
 * universities/{universityId}/spaceConfig/{spaceCategory}
 * Target space/utilization standards per space category (e.g. "Classroom",
 * "Lab"), used by the future calc engine to compare actual vs. target use.
 *
 * @typedef {Object} SpaceConfigDoc
 * @property {number} sfPerStationTarget - Target square feet per station.
 * @property {number} targetUtilizationRate - Target utilization, 0-1.
 * @property {import('firebase/firestore').Timestamp} effectiveDate - When this target took effect.
 */

/**
 * universities/{universityId}/terms/{termId}
 * One row per academic term/block (mirrors the workbook's "Year / Term /
 * Session" concept -- see ai-server's class-schedule parsing), needed so
 * the future calc engine knows each term's date range and expected weekly
 * teaching hours rather than inferring it from the current wall-clock date
 * the way getPreferredRoomScheduleSession's month-cutoff heuristic does.
 *
 * @typedef {Object} TermDoc
 * @property {number} academicYear - e.g. 2026. Inferred type -- not specified in the source task, matches the workbook's leading year component.
 * @property {string} term - e.g. "FALL". Inferred type -- matches the workbook's term component.
 * @property {number} sessionNumber - e.g. 1 or 2 (Block 1 / Block 2). Inferred type -- matches the workbook's session component.
 * @property {import('firebase/firestore').Timestamp} startDate - Inferred type -- a date range needs Timestamps, consistent with effectiveDate's convention.
 * @property {import('firebase/firestore').Timestamp} endDate - Inferred type, same reasoning as startDate.
 * @property {number} standardWeeklyHours - Expected/standard weekly teaching hours for this term.
 * @property {boolean} isHistorical - True once this term has ended and is used for historical comparison rather than current/upcoming planning.
 */

/**
 * universities/{universityId}/roomUtilizationMeta/{roomKey}
 * Per-room metadata for the utilization module, keyed by the SAME RoomKey
 * convention already used to join class-schedule entries to rooms
 * elsewhere in this codebase: normalizeClassScheduleRoomKey(buildingName,
 * roomLabel) in src/components/StakeholderMap.jsx, i.e.
 * `${normalizeDashboardKey(buildingName)}||${normalizeUtilizationRoomKey(roomLabel)}`.
 * Not imported here -- that function is not currently exported, and this
 * step does not touch StakeholderMap.jsx. A future step that actually
 * writes roomUtilizationMeta docs should reuse that exact function (via a
 * minimal, explicit export) rather than re-deriving the key format.
 *
 * @typedef {Object} RoomUtilizationMetaDoc
 * @property {string} building - Denormalized for Firestore-console readability, same convention as CourseMeetingDoc.building.
 * @property {string} room - Denormalized for Firestore-console readability, same convention as CourseMeetingDoc.room.
 * @property {string} spaceCategory - Matches a spaceConfig/{spaceCategory} document id, or '' if this room is intentionally untagged.
 * @property {string} primaryDepartment - Matches an enrollmentProjections/{deptId} doc's `department` field (excluding the institution-wide "Overall" division record -- that's not a real department a room can belong to), or '' if not yet assigned. Optional and independent of spaceCategory -- a room can carry a space category with no department yet; existing tagged rooms are not backfilled retroactively. Added 2026-08-20 for the department-level Space Growth breakdown (see spaceGrowthCalc.js's computeDepartmentSpaceGrowth).
 * @property {string} notes - Free-text admin notes about this room.
 */

/**
 * universities/{universityId}/courseMeetings/{meetingId}
 * Imported snapshot of class-schedule meetings, field-for-field matching
 * the /class-schedule endpoint's payload shape (see
 * ai-server/server.js:parseClassScheduleSheet and the classScheduleRows
 * shape it produces), plus an importedAt stamp. courseCode may contain
 * multiple cross-tallied catalog codes joined with "/" (e.g.
 * "EDUC630/EDUC430"), matching the merge already applied to the AI
 * payload in StakeholderMap.jsx.
 *
 * @typedef {Object} CourseMeetingDoc
 * @property {string} building
 * @property {string} room
 * @property {string} courseCode - May be multiple codes joined with "/" for cross-tallied sections.
 * @property {string} section
 * @property {string} title
 * @property {string} instructor
 * @property {string} sessionLabel - e.g. "Fall 2026 Block 1".
 * @property {string} sessionRaw - e.g. "2026 / FALL / 1".
 * @property {string[]} dayTokens - e.g. ["M", "W", "R"].
 * @property {number|null} startMinutes - Minutes since midnight, or null if unparseable.
 * @property {number|null} endMinutes - Minutes since midnight, or null if unparseable.
 * @property {number|''} enrollment
 * @property {number|''} capacity
 * @property {import('firebase/firestore').Timestamp} importedAt - When this snapshot was imported.
 */

/**
 * universities/{universityId}/enrollmentProjections/{deptId}
 * One doc per department PLUS one institution-wide overall doc, imported
 * from an admin-uploaded Enrollment & FTE Projections workbook (see
 * enrollmentProjectionsImport.js for the parser -- this is the data layer
 * the future growth/right-sizing module (roadmap item beyond the original
 * 6) will read from). deptId is deterministic: canon(`${division}_${department}`)
 * (src/utils/idUtils.js), same slugification convention used everywhere
 * else in this codebase (buildRoomUtilizationMetaKey, bId/fId/rId) -- so
 * re-uploading a newer version of the same workbook overwrites the same
 * docs rather than accumulating duplicates.
 *
 * @typedef {Object} EnrollmentProjectionDoc
 * @property {string} division - e.g. "Arts & Humanities", or "Overall" for the institution-wide record.
 * @property {string} department - e.g. "Art", or "Hastings College Overall" for the institution-wide record.
 * @property {Object.<string, EnrollmentProjectionYearMetrics>} years - Keyed by year as a string (Firestore map keys are always strings), e.g. "2026".
 * @property {import('firebase/firestore').Timestamp} importedAt - When this snapshot was imported.
 */

/**
 * @typedef {Object} EnrollmentProjectionYearMetrics
 * @property {number} [studentHeadcount] - Net Student Headcount.
 * @property {number} [nttFacultyFte] - NTT Faculty FTE.
 * @property {number} [tenureTtFacultyFte] - Tenure/TT Faculty FTE.
 * @property {number} [adminStaffFte] - Admin/Staff FTE.
 * @property {number} [totalFte] - Total FTE (all three FTE lines summed in the source workbook).
 */
