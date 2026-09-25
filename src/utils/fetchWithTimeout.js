// src/utils/fetchWithTimeout.js
//
// Shared request helper for AI-server calls. Moved here from
// classroomUtilizationCalc.js, which still re-exports both functions so
// existing imports keep working.
//
// A timeout abort surfaces from fetch() as a DOMException whose message is
// the browser's raw "signal is aborted without reason" -- never user-facing
// copy. isAbortError() lets callers recognize it; fetchWithTimeout rethrows
// timeouts as an Error with name 'TimeoutError' and a readable message.
export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 60000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort('timeout'), timeoutMs) : null;
  try {
    return await fetch(url, { ...init, signal: controller ? controller.signal : undefined });
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error(`AI server did not respond within ${Math.round(timeoutMs / 1000)}s (it may be waking up).`);
      timeoutError.name = 'TimeoutError';
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
