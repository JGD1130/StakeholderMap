const TENANT_DEFS = [
  {
    id: 'hastings',
    configId: 'hastings',
    aliases: ['hastings', 'hastings-demo'],
    status: 'active',
    features: {
      // Hook: can be enabled per tenant later without touching shared logic.
      enableEngagementTechnicalAssessment: false
    }
  },
  {
    id: 'sarpy-county',
    configId: 'sarpy-county',
    aliases: ['sarpy-county', 'sarpy', 'sarpy-ne'],
    status: 'planned',
    features: {
      enableEngagementTechnicalAssessment: false
    }
  }
];

const ALIAS_TO_TENANT = TENANT_DEFS.reduce((acc, tenant) => {
  (tenant.aliases || []).forEach((alias) => {
    acc[String(alias || '').trim().toLowerCase()] = tenant;
  });
  return acc;
}, {});

export function resolveTenant(universityId) {
  const key = String(universityId || '').trim().toLowerCase();
  return ALIAS_TO_TENANT[key] || null;
}

export function getTenantConfigId(universityId) {
  const tenant = resolveTenant(universityId);
  return tenant?.configId || universityId;
}

export function getTenantFeatures(universityId) {
  return resolveTenant(universityId)?.features || {};
}

export const TENANTS = TENANT_DEFS;
