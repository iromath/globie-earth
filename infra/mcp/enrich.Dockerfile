# One-shot job image for the DNP media enrichment (scripts/enrich-dnp-media.mjs),
# built to run on the production server rather than on a dev machine.
#
# Why it exists: occurrence/search is GBIF's rate-sensitive endpoint, and it
# throttles this project's dev-machine egress IP (a VPN) so hard that HTTP 429
# comes back every few requests - which turns an ~11.8k-key run into 10-22
# hours. The production VPS has its own, unthrottled egress IP, so the very same
# importer, pointed at the very same database, finishes there in a fraction of
# the time. Nothing about the data changes with the host; only the client IP
# GBIF sees.
#
# Easypanel exposes no "exec into a container" or "run a job" primitive, so this
# is packaged as its own image and run once as an ordinary app service - the same
# pattern as infra/maintenance/. It is deliberately NOT in infra/docker-compose.yml
# or docker-push.sh: like the maintenance image, it is built and pushed by hand.
#
# Build context is infra/mcp, where the importer lives:
#
#   docker build -f infra/mcp/enrich.Dockerfile -t tradex367/globie-dnp-enrich:latest infra/mcp
#   docker push tradex367/globie-dnp-enrich:latest
#
# Then, in the Easypanel panel, add it as an app service in the `relays` project
# with the DATABASE_URL and the cache volume documented in
# scripts/run-enrich-online.sh. No published port and no domain: it is a job, not
# a server.
#
# Node 22 matches the version infra/mcp/Dockerfile is built and verified with,
# and the importer uses only Node built-ins (fetch, node:child_process, node:fs,
# node:url), so there is no npm install and no node_modules here.
#
# postgresql-client is the write path, not the read path: 130/140/150 revoke
# insert/update/delete from anon, so only the migration role may write, and the
# importer shells out to psql with DATABASE_URL exactly as enrich-dnp-plants.mjs
# does. Debian bookworm's client (v15) is fine against the server's PostgreSQL 18.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the importer and its entrypoint. The .cache directory the importer writes
# is created here so the volume mount target exists on first boot; the file
# inside it (dnp-media-enrich.json) is what makes a restart resume instead of
# refetching every taxon.
COPY scripts/enrich-dnp-media.mjs /app/scripts/enrich-dnp-media.mjs
COPY scripts/run-enrich-online.sh /app/run-enrich-online.sh
RUN chmod +x /app/run-enrich-online.sh && mkdir -p /app/scripts/.cache

CMD ["/app/run-enrich-online.sh"]
