import type { Fhir } from "./fhir.ts";

export interface ReferenceNames {
  organizations: Map<string, string>;
  locations: Map<string, string>;
}

export interface ReferenceData {
  names(portalUser: string): Promise<ReferenceNames>;
}

/**
 * Facility and pickup-point names, cached briefly. They change rarely (only
 * the registry role writes them) and almost every portal page needs them.
 */
export function createReferenceData(fhir: Fhir, ttlSeconds = 300): ReferenceData {
  let cached: { at: number; value: Promise<ReferenceNames> } | null = null;
  const toNames = (resources: Record<string, any>[]) =>
    new Map(resources.map((resource) => [String(resource.id), String(resource.name ?? resource.id)]));

  return {
    names(portalUser) {
      if (!cached || Date.now() - cached.at > ttlSeconds * 1000) {
        const value = Promise.all([
          fhir.searchAll("Organization", { _elements: "name", _count: "500" }, portalUser, 10),
          fhir.searchAll("Location", { _elements: "name", _count: "500" }, portalUser, 10),
        ]).then(([organizations, locations]) => ({
          organizations: toNames(organizations.resources),
          locations: toNames(locations.resources),
        }));
        cached = { at: Date.now(), value };
        value.catch(() => {
          cached = null;
        });
      }
      return cached.value;
    },
  };
}
