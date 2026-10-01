package ls.gov.health.bonolo;

import ca.uhn.fhir.rest.server.exceptions.PreconditionFailedException;
import org.hl7.fhir.r4.model.OperationOutcome;

/** Run with -ea during image build; no extra testing dependencies. */
public class ProfileDeclarationStatusInterceptorTest {
    public static void main(String[] args) {
        var interceptor = new ProfileDeclarationStatusInterceptor();
        String message = "HAPI-0575: Resource of type \"MedicationRequest\" does not declare "
                + "conformance to profile from: [http://fhir.health.gov.ls/bonolo-cdu/"
                + "StructureDefinition/bonolo-medication-request]";
        var outcome = new OperationOutcome();
        outcome.addIssue().setDiagnostics(message);
        var original = new PreconditionFailedException(message);
        original.setOperationOutcome(outcome);
        var mapped = interceptor.mapProfileDeclarationFailure(original);
        assert mapped != null && mapped.getStatusCode() == 422;
        assert mapped.getMessage().equals(message);
        assert mapped.getOperationOutcome() == outcome;
        assert interceptor.mapProfileDeclarationFailure(
                new PreconditionFailedException("ETag does not match")) == null;
        assert interceptor.mapProfileDeclarationFailure(
                new PreconditionFailedException("HAPI-0575: another contract")) == null;
        assert interceptor.mapProfileDeclarationFailure(new IllegalStateException(message)) == null;
        System.out.println("PASS: Bonolo declaration failures map to 422; other errors stay unchanged");
    }
}
