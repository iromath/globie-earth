# The Globie Earth MCP server - the Alexa+ submission.
#
# On Easypanel this is an "App" service with the build context set to infra/mcp
# and the Dockerfile here, mirroring infra/studio/Dockerfile. The platform's
# proxy terminates TLS in front of the container, so the container only speaks
# HTTP.

# Debian (glibc), not Alpine (musl). The default embedding provider runs the
# local model through onnxruntime-node, whose native binary ships for glibc and
# has no musl build - node:22-alpine would install cleanly and then fail on the
# first search with a missing shared library. Node 22 still matches the version
# the service is built and verified with locally.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, so `npm ci` stays cached when only source files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Bake the local model into the image, so a running container never reaches the
# Hugging Face hub. This calls the same embedWithUsage() the server calls, so the
# model id, the dtype and the cache directory are the provider's own rather than
# a copy here that could drift. EMBEDDING_PROVIDER=local pins it to the
# self-hosted model even if the build environment has something else set.
ENV EMBEDDING_PROVIDER=local
ENV EMBEDDING_CACHE_DIR=/app/.cache
RUN node -e "import('file:///app/dist/embed.js').then((m) => m.embedWithUsage('warm up')).then(() => console.log('model cached'))"

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# The directory the build stage cached the weights into. The provider reads this
# (src/embed.ts) instead of the default ./.cache, so the two stages agree.
ENV EMBEDDING_CACHE_DIR=/app/.cache

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
# Owned by node so the cache stays writable without running the server as root.
COPY --chown=node:node --from=build /app/.cache ./.cache

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
