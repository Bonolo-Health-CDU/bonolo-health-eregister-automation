// Realm roles defined in keycloak/bonolo-repository-realm.json.
export const PORTAL_ROLES = ["repo-admin", "programme-manager", "support"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

// Who may use each part of the portal. Programme managers only ever see
// aggregates, never patient-level data.
export const ACCESS = {
  dashboard: ["repo-admin", "programme-manager", "support"],
  prescriptions: ["repo-admin", "support"],
  integrations: ["repo-admin", "support"],
  users: ["repo-admin"],
} as const satisfies Record<string, readonly PortalRole[]>;

export type Feature = keyof typeof ACCESS;

export function portalRoles(claim: unknown): PortalRole[] {
  if (!Array.isArray(claim)) return [];
  return PORTAL_ROLES.filter((role) => claim.includes(role));
}

export function canUse(roles: readonly PortalRole[], feature: Feature): boolean {
  return roles.some((role) => (ACCESS[feature] as readonly PortalRole[]).includes(role));
}
