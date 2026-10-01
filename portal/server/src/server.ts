import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createFhirClient } from "./fhir.ts";
import { createKeycloakOidc } from "./oidc.ts";

const config = loadConfig();
const app = buildApp({
  config,
  oidc: createKeycloakOidc(config),
  fhir: createFhirClient(config),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}

await app.listen({ host: "0.0.0.0", port: config.port });
