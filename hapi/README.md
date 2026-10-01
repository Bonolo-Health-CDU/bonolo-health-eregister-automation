# Bonolo CDU contract validation

The pinned image `hapiproject/hapi:v8.12.0-1` reports OCI revision `a01027b91ed07f41194524fd0dd59623905cbe2d`, matching tag `image/v8.12.0-1`. The release application.yaml and Java configuration were inspected before selecting these properties.

Compose mounts the package and additional configuration read-only. `SPRING_CONFIG_ADDITIONAL_LOCATION=file:/app/config/application-bonolo.yaml` preserves the starter defaults and existing database settings.

| Property | Setting | Exact release source |
|---|---|---|
| `hapi.fhir.implementationguides.bonolo.name` | `ls.moh.bonolo.cdu` | [application.yaml:200](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L200) |
| `hapi.fhir.implementationguides.bonolo.version` | `0.2.0` | [application.yaml:201](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L201) |
| `hapi.fhir.implementationguides.bonolo.packageUrl` | `file:/app/igs/ls.moh.bonolo.cdu-0.2.0.tgz` | [application.yaml:205](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L205) |
| `hapi.fhir.implementationguides.bonolo.installMode` | `STORE_AND_INSTALL` | [application.yaml:203](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L203) |
| `hapi.fhir.implementationguides.bonolo.reloadExisting` | `false` | [application.yaml:202](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L202) |
| `hapi.fhir.validation.requests_enabled` | `true` | [application.yaml:335](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L335) |
| `hapi.fhir.validation.responses_enabled` | `false` | [application.yaml:336](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L336) |
| `hapi.fhir.enable_repository_validating_interceptor` | `true` | [IRepositoryValidationInterceptorFactory.java:7](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/java/ca/uhn/fhir/jpa/starter/common/validation/IRepositoryValidationInterceptorFactory.java#L7) |
| `hapi.fhir.validate_resource_status_for_package_upload` | `false` (allow this draft contract) | [application.yaml:196](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L196) |
| `hapi.fhir.custom-bean-packages` | `ls.gov.health.bonolo` | [application.yaml:426](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L426) |
| `hapi.fhir.custom-interceptor-classes` | `ls.gov.health.bonolo.ProfileDeclarationStatusInterceptor` | [application.yaml:427](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L427) |
| `hapi.fhir.remote_terminology_service` | Not configured (disabled) | [application.yaml:464](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L464) |
| `additionalResourceFolders` | Not configured; never import `example` | [application.yaml:209](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/resources/application.yaml#L209) |

The repository interceptor switch is not listed in this release’s application.yaml; its exact name is defined by the Java constant linked above. The R4 factory searches stored StructureDefinitions of kind `resource`, groups them by resource type, and requires a declared profile from each group plus validation against the declared profiles. The package contains exactly one resource profile for each of Patient, MedicationRequest, and Task. Its four extensions have kind `complex-type`.

See [the R4 rule builder](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/java/ca/uhn/fhir/jpa/starter/common/validation/RepositoryValidationInterceptorFactoryR4.java#L48) and [request validation severity](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/a01027b91ed07f41194524fd0dd59623905cbe2d/src/main/java/ca/uhn/fhir/jpa/starter/common/StarterJpaConfig.java#L495).

## Fresh-database startup ordering

The stock 8.12.0-1 image builds `repositoryValidatingInterceptor` before `packageInstaller` on an empty database. Observed result: its startup log says `RepositoryValidatingInterceptor has rules:` with an empty list, even though installation follows. Configuration alone does not close this gap.

`PackageBeforeValidation` is a Spring BeanFactoryPostProcessor that adds `packageInstaller` to the existing interceptor bean's `dependsOn`. It preserves existing dependencies and fails startup if either bean is absent after a future starter upgrade. It does not replace the validator or implement clinical rules. The small derived image retains `hapiproject/hapi:v8.12.0-1` and compiles this hook against that image's exact dependencies; the runtime remains distroless. Build with `docker compose build hapi-fhir` after changing Java source.

The package remains draft. `validate_resource_status_for_package_upload: false` is necessary because this release otherwise skips all draft conformance resources, despite reporting a finished package installation.

## Missing-profile response status

The stock repository declaration rule rejects an absent required profile with HTTP 412 and diagnostic `HAPI-0575`. The contract tests require 400 or 422. `ProfileDeclarationStatusInterceptor` uses HAPI's `SERVER_PRE_PROCESS_OUTGOING_EXCEPTION` hook to map only that Bonolo declaration error to 422, preserving its message and OperationOutcome. Other precondition failures remain 412. The Docker build runs a focused test of that mapping and preservation of unrelated errors.

Hook source: [HAPI 8.12.0 Pointcut.java](https://github.com/hapifhir/hapi-fhir/blob/v8.12.0/hapi-fhir-base/src/main/java/ca/uhn/fhir/interceptor/api/Pointcut.java). This hook changes response status after the write has already been rejected; it never accepts or replays a write.

## Package and examples

Build the contract in the sibling IG repository with `./scripts/package.sh`, then copy its versioned tgz into `igs/`. The committed tgz is the contract pin. It contains 17 conformance resources at package root and eight examples in `package/example/`. Do not configure `additionalResourceFolders: [example]`: these fixtures must never be installed into the repository.

## Request body changes

- All existing Patient, MedicationRequest and Task instances now declare their Bonolo profile, including the replay, cancellation and access-control publication bundles.
- Existing eRegister-created Tasks already omitted businessStatus; they remain requested without it. IG 0.2.0 permits this and adds an accepted/received example.
- The two CodeSystem PUTs were removed from folder 01 because package installation supplies them.
- Folder 08 starts each negative case with fresh synthetic identifiers and changes one condition: missing pickup-point, regimen ZZ, missing eRegister identifier, or missing MedicationRequest profile.
- A separate valid publication in folder 08 supplies a requested Task for the positive accepted/received PATCH, avoiding changes to the completed/cancelled scenarios.

## Run

```sh
docker compose down -v && docker compose up -d
./scripts/setup-openhim.sh
npx newman run postman/Bonolo_CDU_eRegister_FHIR_Repository.postman_collection.json --insecure
```

The setup script first waits for HAPI metadata to return 200; timeout is fatal. Folder 06 expects authorization refusals. Folder 08 expects four contract rejections with problem-specific OperationOutcome diagnostics, then a successful publication and claim.

## Verified on fresh volumes

- SUSHI 3.20.1: 0 Errors, 1 Warning (unused IG-site settings with FSHOnly).
- Startup: `Finished installation of package ls.moh.bonolo.cdu#0.2.0`, with 7 StructureDefinitions, 5 CodeSystems and 5 ValueSets created, followed by three validation and three profile-declaration rules.
- Every conformance canonical search returns exactly one result, including `bonolo-medication-request`.
- All eight example IDs are absent. Patient, MedicationRequest and Task counts are zero before Newman, and three each after its three valid synthetic publications. Verification GETs use `Cache-Control: no-cache` to avoid HAPI's cached search results.
- Newman: 37 requests, 37 test scripts, 13 prerequest scripts, 55 assertions; zero failures. Folder 06 returns five 401s; folder 08's four negative cases return 422 with matching diagnostics; its fresh publication and claimed Task PATCH succeed.
- Additional direct HAPI probes reject missing profiles for Patient, MedicationRequest and Task using POST, PUT and PATCH (nine 422s), preserving stored resource versions. Invalid required codes in MedicationRequest and Task PATCH results are rejected with the repository validator's native 412 and OperationOutcome diagnostics. The status mapper intentionally only changes missing-profile errors; it does not rewrite other repository errors.
- Existing request bodies changed only by adding profile declarations. No extra clinical payload corrections were needed, and the allergy payloads/design, naming and .env/OpenHIM channels are unchanged.
