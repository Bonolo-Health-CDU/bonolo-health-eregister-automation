package ls.gov.health.bonolo;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException;
import ca.uhn.fhir.rest.server.exceptions.PreconditionFailedException;
import ca.uhn.fhir.rest.server.exceptions.UnprocessableEntityException;

/** Give missing Bonolo profile declarations the same 422 contract as invalid content. */
@Interceptor
public class ProfileDeclarationStatusInterceptor {
    @Hook(Pointcut.SERVER_PRE_PROCESS_OUTGOING_EXCEPTION)
    public BaseServerResponseException mapProfileDeclarationFailure(Throwable error) {
        if (error instanceof PreconditionFailedException original) {
            String message = original.getMessage();
            if (message != null && message.startsWith("HAPI-0575:")
                    && message.contains("http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition/")) {
                return new UnprocessableEntityException(message, original.getOperationOutcome());
            }
        }
        // In particular, preserve HTTP 412 for unrelated precondition failures.
        return null;
    }
}
