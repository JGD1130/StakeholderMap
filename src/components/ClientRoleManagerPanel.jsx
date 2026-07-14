import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebaseConfig';

const CLIENT_ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' }
];

const ROLE_ORDER = {
  admin: 0,
  editor: 1,
  viewer: 2
};

function formatRoleError(error) {
  const raw = String(error?.message || error?.details || '').trim();
  if (!raw) return 'Role update failed.';
  const cleaned = raw.replace(/^functions\/[a-z-]+:\s*/i, '').trim();
  return cleaned || 'Role update failed.';
}

function sortRoleRows(rows = []) {
  return [...rows].sort((a, b) => {
    const roleDiff = (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
    if (roleDiff !== 0) return roleDiff;
    return String(a.email || a.uid || '').localeCompare(String(b.email || b.uid || ''));
  });
}

export default function ClientRoleManagerPanel({
  universityId,
  enabled = false,
  title = 'Client Access',
  clientRoleOptions = CLIENT_ROLE_OPTIONS
}) {
  const normalizedUniversityId = String(universityId || '').trim();
  const roleChoices = Array.isArray(clientRoleOptions) && clientRoleOptions.length
    ? clientRoleOptions
    : CLIENT_ROLE_OPTIONS;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roleChoices[0]?.value || 'viewer');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [removingUid, setRemovingUid] = useState('');
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    setRole(roleChoices[0]?.value || 'viewer');
  }, [roleChoices]);

  const firebaseFunctions = useMemo(() => getFunctions(undefined, 'us-central1'), []);
  const setUniversityUserRole = useMemo(
    () => httpsCallable(firebaseFunctions, 'setUniversityUserRole'),
    [firebaseFunctions]
  );
  const removeUniversityUserRole = useMemo(
    () => httpsCallable(firebaseFunctions, 'removeUniversityUserRole'),
    [firebaseFunctions]
  );

  const refreshRoles = useCallback(async () => {
    if (!enabled || !normalizedUniversityId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setErrorMessage('');
    try {
      const snap = await getDocs(collection(db, 'universities', normalizedUniversityId, 'roles'));
      const nextRows = snap.docs.map((roleDoc) => {
        const data = roleDoc.data() || {};
        return {
          uid: roleDoc.id,
          role: String(data.role || '').trim().toLowerCase(),
          email: String(data.email || '').trim(),
          displayName: String(data.displayName || '').trim(),
          updatedByEmail: String(data.updatedByEmail || '').trim()
        };
      });
      setRows(sortRoleRows(nextRows));
    } catch (error) {
      setErrorMessage(formatRoleError(error));
    } finally {
      setLoading(false);
    }
  }, [enabled, normalizedUniversityId]);

  useEffect(() => {
    void refreshRoles();
  }, [refreshRoles]);

  const handleAssignRole = useCallback(async (event) => {
    event.preventDefault();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    if (!trimmedEmail) {
      setErrorMessage('Enter a Google account email first.');
      return;
    }
    setSubmitting(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await setUniversityUserRole({
        universityId: normalizedUniversityId,
        email: trimmedEmail,
        role
      });
      const payload = response?.data || {};
      setMessage(String(payload.message || 'Role updated.'));
      setEmail('');
      await refreshRoles();
    } catch (error) {
      setErrorMessage(formatRoleError(error));
    } finally {
      setSubmitting(false);
    }
  }, [email, normalizedUniversityId, refreshRoles, role, setUniversityUserRole]);

  const handleRemoveRole = useCallback(async (row) => {
    if (!row?.uid) return;
    const label = row.email || row.uid;
    if (typeof window !== 'undefined') {
      const shouldContinue = window.confirm(`Remove ${label} from ${normalizedUniversityId} client access?`);
      if (!shouldContinue) return;
    }
    setRemovingUid(row.uid);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await removeUniversityUserRole({
        universityId: normalizedUniversityId,
        uid: row.uid
      });
      const payload = response?.data || {};
      setMessage(String(payload.message || 'Role removed.'));
      await refreshRoles();
    } catch (error) {
      setErrorMessage(formatRoleError(error));
    } finally {
      setRemovingUid('');
    }
  }, [normalizedUniversityId, refreshRoles, removeUniversityUserRole]);

  if (!enabled) return null;

  return (
    <div className="control-section" style={{ background: '#fff', padding: 8, border: '1px solid #d8e0ea', borderRadius: 6, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12.5 }}>{title}</h4>
        <button className="btn" type="button" onClick={() => void refreshRoles()} disabled={loading || submitting || !!removingUid}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: '#465569', lineHeight: 1.35 }}>
        Assign Hastings client <strong>`viewer`</strong> or <strong>`editor`</strong> access.
        Users must sign in with Google at least once before you can provision them.
      </div>

      <form onSubmit={handleAssignRole} style={{ marginTop: 8, display: 'grid', gap: 6 }}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="user@hastings.edu"
          autoComplete="off"
          style={{ width: '100%' }}
        />
        <select value={role} onChange={(event) => setRole(event.target.value)} style={{ width: '100%' }}>
          {roleChoices.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button className="btn" type="submit" disabled={submitting || !normalizedUniversityId} style={{ width: '100%' }}>
          {submitting ? 'Saving access...' : 'Grant / Update Access'}
        </button>
      </form>

      {message ? (
        <div style={{ marginTop: 6, fontSize: 11, color: '#0f5132' }}>{message}</div>
      ) : null}
      {errorMessage ? (
        <div style={{ marginTop: 6, fontSize: 11, color: '#b42318' }}>{errorMessage}</div>
      ) : null}

      <div style={{ marginTop: 8, borderTop: '1px solid #edf2f7', paddingTop: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>Current roles</div>
        {rows.length ? (
          <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((row) => {
              const label = row.email || row.uid;
              const subtitle = row.displayName ? `${row.displayName} | ${row.uid}` : row.uid;
              const removable = row.role !== 'admin';
              return (
                <div key={row.uid} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 6, background: '#f8fafc' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{label}</div>
                      <div style={{ fontSize: 10.5, color: '#667085', overflowWrap: 'anywhere' }}>{subtitle}</div>
                      {row.updatedByEmail ? (
                        <div style={{ fontSize: 10.5, color: '#667085', overflowWrap: 'anywhere' }}>
                          Last updated by {row.updatedByEmail}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>{row.role || 'unknown'}</span>
                      {removable ? (
                        <button
                          className="btn"
                          type="button"
                          onClick={() => void handleRemoveRole(row)}
                          disabled={removingUid === row.uid}
                        >
                          {removingUid === row.uid ? 'Removing...' : 'Remove'}
                        </button>
                      ) : (
                        <span style={{ fontSize: 10.5, color: '#667085' }}>Internal role</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#667085' }}>
            {loading ? 'Loading roles...' : 'No Hastings role documents yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
