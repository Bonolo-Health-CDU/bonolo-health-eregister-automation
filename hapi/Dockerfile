# Preserve the pinned starter and compile against its exact Spring dependencies.
FROM hapiproject/hapi:v8.12.0-1 AS upstream
FROM eclipse-temurin:21-jdk AS compile
WORKDIR /build
COPY --from=upstream /app/main.war ./main.war
RUN jar xf main.war WEB-INF/lib
COPY src/ ./src/
RUN javac --release 17 -cp 'WEB-INF/lib/*' -d classes src/ls/gov/health/bonolo/*.java
COPY test/ ./test/
RUN javac --release 17 -cp 'WEB-INF/lib/*:classes' -d test-classes test/ls/gov/health/bonolo/*.java \
    && java -ea -cp 'WEB-INF/lib/*:classes:test-classes' ls.gov.health.bonolo.ProfileDeclarationStatusInterceptorTest

FROM upstream
COPY --from=compile --chown=65532:65532 /build/classes/ /app/extra-classes/
