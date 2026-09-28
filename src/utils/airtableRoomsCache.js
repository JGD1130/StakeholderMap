// src/utils/airtableRoomsCache.js
//
// One shared, module-level cache for the Airtable rooms list (ai-server
// GET /api/rooms). Every page-load caller -- StakeholderMap's campus rooms
// load, the building-popup utilization, Classroom Utilization, Space Growth,
// room tagging, F&A Compass, the Executive Dashboard -- asks for the same
// ~3,000 records, and each /api/rooms call is ~30 Airtable pages. Fired
// together they tripped Airtable's rate limit (5 requests/second/base), which
// ai-server reports as a 500 whose message carries Airtable's
// "429 ... RATE_LIMIT_REACHED".
//
//   - Concurrent callers share one in-flight request.
//   - A successful result is kept for the session; `force: true` (Recalculate,
//     Refresh Airtable Data) fetches again -- or joins a request already in
//     flight, which is just as fresh.
//   - A rate-limited request is retried after 1s, 2s and 4s. If it still
//     fails, the error carries a friendly message (AIRTABLE_BUSY_MESSAGE); the
//     raw error is logged once as a warning.
//   - Failures aren't cached: the next call tries again.
//   - Each caller keeps its own timeout (`timeoutMs`): a short-timeout caller
//     gives up on time while the shared request carries on for the others.
//     A caller timeout rejects with name 'AbortError', which both
//     fetchWithTimeout's isAbortError and StakeholderMap's isAbortLikeError
//     already treat as "the AI server is slow / waking up".
//
// Callers each get their own shallow copies of the room objects, so one
// caller mutating a room can't affect another -- the same isolation separate
// fetches gave them.

export const AIRTABLE_BUSY_MESSAGE = 'Airtable is busy right now — try again in a minute.';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const entries = new Map(); // cacheKey -> { rooms: Array | null, promise: Promise | null }

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Airtable's 429 reaches the browser either as a 429 or, via ai-server, as a
// 500 whose message contains "429" / "RATE_LIMIT_REACHED".
export function isAirtableRateLimitError(error) {
  if (error?.code === 'AIRTABLE_RATE_LIMITED') return true;
  if (error?.status === 429) return true;
  return /RATE_LIMIT|\b429\b/i.test(String(error?.message || ''));
}

// Cache key for a rooms request: the resolved /api/rooms URL (query string
// dropped -- ai-server reads only `view`) plus the Airtable view.
export function airtableRoomsCacheKey(url, view = '') {
  return `${String(url || '').split('?')[0]}|view=${view || ''}`;
}

async function loadWithRetry(load) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (!isAirtableRateLimitError(error)) throw error;
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.warn('Airtable rooms: still rate-limited after retries.', error);
        const friendly = new Error(AIRTABLE_BUSY_MESSAGE);
        friendly.code = 'AIRTABLE_RATE_LIMITED';
        friendly.cause = error;
        throw friendly;
      }
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function withCallerTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`AI server did not respond within ${Math.round(timeoutMs / 1000)}s (it may be waking up).`);
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function copyRooms(rooms) {
  return rooms.map((room) => (room && typeof room === 'object' ? { ...room } : room));
}

// load: () => Promise<rooms[]> -- one raw request; throw an Error (with
// `status` when known) on failure. Only the first caller's `load` runs for a
// given in-flight request.
export async function getSharedAirtableRooms({ cacheKey, load, force = false, timeoutMs } = {}) {
  let entry = entries.get(cacheKey);
  if (!entry) {
    entry = { rooms: null, promise: null };
    entries.set(cacheKey, entry);
  }
  if (!force && entry.rooms) return copyRooms(entry.rooms);

  if (!entry.promise) {
    const promise = loadWithRetry(load).then(
      (rooms) => {
        if (entry.promise === promise) {
          entry.rooms = Array.isArray(rooms) ? rooms : [];
          entry.promise = null;
        }
        return rooms;
      },
      (error) => {
        if (entry.promise === promise) entry.promise = null;
        throw error;
      }
    );
    entry.promise = promise;
  }

  const rooms = await withCallerTimeout(entry.promise, timeoutMs);
  return copyRooms(Array.isArray(rooms) ? rooms : []);
}
