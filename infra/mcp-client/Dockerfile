# Static build of the demo MCP client, served by nginx.
#
# On Easypanel this is an "App" service with the build context set to
# infra/mcp-client and the Dockerfile here, mirroring infra/web. Easypanel's
# proxy terminates TLS in front of the container, so the container only speaks
# HTTP on port 80.

# Node 22 matches the version the bundle is built and verified with locally.
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so `npm ci` stays cached when only source files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# Runs `tsc -p tsconfig.json && vite build` (see package.json). Unlike the web
# bundle there are no VITE_* build args: the client resolves its MCP endpoint at
# runtime from its own location (localhost -> :8092, anywhere else ->
# mcp.globie.earth), so there is nothing that has to be inlined at build time.
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
