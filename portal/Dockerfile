# Repository portal: React UI built with Vite, served by a small Node API
# that handles the Keycloak login and reads FHIR through OpenHIM.
FROM node:24-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /build/dist ./public
USER node
EXPOSE 3000
# Node 24 runs the TypeScript sources directly (type stripping).
CMD ["node", "src/server.ts"]
