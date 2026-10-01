// Mirrors server/src/roles.ts. The server enforces access; this only decides
// what to show.
export type PortalRole = "repo-admin" | "programme-manager" | "support";
export type Feature = "dashboard" | "prescriptions" | "integrations" | "users";

export const ACCESS: Record<Feature, PortalRole[]> = {
  dashboard: ["repo-admin", "programme-manager", "support"],
  prescriptions: ["repo-admin", "support"],
  integrations: ["repo-admin", "support"],
  users: ["repo-admin"],
};

export const ROLE_LABELS: Record<PortalRole, string> = {
  "repo-admin": "Administrator",
  "programme-manager": "Programme manager",
  support: "Support",
};

export const canUse = (roles: PortalRole[], feature: Feature) =>
  roles.some((role) => ACCESS[feature].includes(role));

export const ROLE_DESCRIPTIONS: Record<PortalRole, string> = {
  "repo-admin": "Everything, including managing portal users",
  "programme-manager": "Dashboard only: aggregate figures, no patient details",
  support: "Dashboard, prescription search and integration health",
};

export const ALL_ROLES: PortalRole[] = ["repo-admin", "support", "programme-manager"];
