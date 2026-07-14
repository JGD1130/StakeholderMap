import React, { useEffect, useMemo, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import PublicMapPage from './pages/PublicMapPage.jsx';
import AdminMapPage from './pages/AdminMapPage.jsx';
import ClientMapPage from './pages/ClientMapPage.jsx';
import { getConfig } from './configLoader';
import { db } from './firebaseConfig';
import { getTenantConfigId, resolveTenant } from './tenants/registry';
import './App.css';

function SecureWorkspaceGate({ universityId, title = 'Secure Workspace', requiredRoles = ['viewer', 'editor', 'admin'], children }) {
  const requiredRolesKey = useMemo(
    () => (Array.isArray(requiredRoles) ? requiredRoles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean).join('|') : ''),
    [requiredRoles]
  );
  const [accessState, setAccessState] = useState({ status: 'loading', user: null, role: '' });

  useEffect(() => {
    let active = true;
    const auth = getAuth();
    const allowedRoles = new Set((requiredRolesKey || '').split('|').filter(Boolean));

    getRedirectResult(auth).catch(() => {});

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!active) return;
      if (!user) {
        setAccessState({ status: 'signed_out', user: null, role: '' });
        return;
      }

      let resolvedRole = '';
      try {
        const roleSnap = await getDoc(doc(db, 'universities', universityId, 'roles', user.uid));
        resolvedRole = String(roleSnap.data()?.role || '').trim().toLowerCase();
      } catch {}

      if (!resolvedRole) {
        try {
          const tokenResult = await user.getIdTokenResult();
          if (tokenResult?.claims?.admin === true) {
            resolvedRole = 'admin';
          }
        } catch {}
      }

      if (!active) return;

      if (resolvedRole && allowedRoles.has(resolvedRole)) {
        setAccessState({ status: 'ready', user, role: resolvedRole });
      } else {
        setAccessState({ status: 'unauthorized', user, role: resolvedRole });
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, [requiredRolesKey, universityId]);

  const handleSignIn = async () => {
    try {
      const auth = getAuth();
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(auth, provider);
      } catch {
        await signInWithRedirect(auth, provider);
      }
    } catch {}
  };

  const handleSignOut = async () => {
    try {
      await signOut(getAuth());
    } catch {}
  };

  if (accessState.status === 'loading') {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>{title}</h2>
        <div>Checking access...</div>
      </div>
    );
  }

  if (accessState.status === 'signed_out') {
    return (
      <div style={{ padding: 24, maxWidth: 560 }}>
        <h2 style={{ marginBottom: 8 }}>{title}</h2>
        <p style={{ marginTop: 0 }}>Sign in to continue.</p>
        <button onClick={handleSignIn}>Sign in with Google</button>
      </div>
    );
  }

  if (accessState.status === 'unauthorized') {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h2 style={{ marginBottom: 8 }}>{title}</h2>
        <p style={{ marginTop: 0 }}>
          {accessState.user?.email || 'This account'} does not currently have access to this workspace.
        </p>
        <p style={{ color: '#555', marginTop: 0 }}>
          Ask an admin to assign the correct Hastings role (`viewer`, `editor`, or `admin`).
        </p>
        <button onClick={handleSignOut}>Sign out</button>
      </div>
    );
  }

  return children;
}

function UniversityMapLoader({ engagementMode = false, technicalMode = false }) {
  const { universityId, persona } = useParams();
  const location = useLocation();
  const tenant = resolveTenant(universityId);
  const configId = getTenantConfigId(universityId);
  const config = getConfig(configId);

  if (!config) {
    if (tenant?.status === 'planned') {
      return <div>Tenant "{universityId}" is scaffolded but not configured yet.</div>;
    }
    return <div>Error: Configuration not found for "{universityId}".</div>;
  }

  const pathname = String(location?.pathname || '').toLowerCase();
  const isAdminPath = pathname.includes('/admin');
  const isClientPath = pathname.includes('/client');
  const clientAuthRequired = (tenant?.features?.requireClientAuth ?? config?.requireClientAuth ?? false) === true;

  if (isAdminPath) {
    return (
      <SecureWorkspaceGate universityId={universityId} title="Internal Admin Workspace" requiredRoles={['admin']}>
        <AdminMapPage
          config={config}
          universityId={universityId}
          tenant={tenant}
          engagementMode={engagementMode}
          technicalMode={technicalMode}
        />
      </SecureWorkspaceGate>
    );
  }

  if (isClientPath) {
    const clientPage = (
      <ClientMapPage
        config={config}
        universityId={universityId}
        tenant={tenant}
        engagementMode={engagementMode}
        technicalMode={technicalMode}
      />
    );
    if (!clientAuthRequired) return clientPage;
    return (
      <SecureWorkspaceGate universityId={universityId} title="Client Workspace" requiredRoles={['viewer', 'editor', 'admin']}>
        {clientPage}
      </SecureWorkspaceGate>
    );
  }

  return (
    <PublicMapPage
      config={config}
      universityId={universityId}
      persona={persona}
      engagementMode={engagementMode}
      technicalMode={technicalMode}
      tenant={tenant}
    />
  );
}

function LegacyAdminWorkflowRedirect() {
  const { universityId } = useParams();
  const location = useLocation();
  const suffix = `${location?.search || ''}${location?.hash || ''}`;
  return <Navigate to={`/${universityId}/admin${suffix}`} replace />;
}

function App() {
  return (
    <Router basename="/StakeholderMap">
      <Routes>
        <Route path="/:universityId/admin" element={<UniversityMapLoader />} />
        <Route path="/:universityId/client" element={<UniversityMapLoader />} />
        <Route path="/:universityId/admin/engagement" element={<LegacyAdminWorkflowRedirect />} />
        <Route path="/:universityId/admin/technical" element={<LegacyAdminWorkflowRedirect />} />
        <Route path="/:universityId/engagement" element={<UniversityMapLoader engagementMode />} />
        <Route path="/:universityId/technical" element={<UniversityMapLoader technicalMode />} />
        <Route path="/:universityId/:persona" element={<UniversityMapLoader />} />
        <Route path="/:universityId/survey" element={<UniversityMapLoader />} />
        <Route path="/:universityId" element={<UniversityMapLoader />} />
        <Route path="/" element={<div>Please select a university by navigating to its URL (e.g., /hastings)</div>} />
      </Routes>
    </Router>
  );
}

export default App;