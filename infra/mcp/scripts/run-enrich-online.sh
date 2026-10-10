#!/bin/sh
# Entrypoint for the one-shot DNP media enrichment image (infra/mcp/enrich.Dockerfile).
#
# This is the "run it on the online server" half: the image runs on the VPS,
# whose own egress IP reaches GBIF without the HTTP 429 penalty the dev machine's
# VPN earns, and writes the photos straight into the live database.
#
# What the Easypanel app service needs:
#
#   DATABASE_URL   the migration-role connection string (anon cannot write -
#                  130/140/150 revoke insert/update/delete from anon). Inside
#                  the same Compose stack that is
#                    postgres://globietree:<PASSWORD>@db:5432/globietree
#                  and from a separate app it is the external address
#                    postgres://globietree:<PASSWORD>@51.159.81.116:5433/api_globie_db
#   a volume mounted at /app/scripts/.cache
#                  holds dnp-media-enrich.json, the lookup cache. Optional but
#                  strongly wanted: without it every restart refetches all
#                  ~11.8k taxa; with it a restart resumes where it stopped.
#
# Optional knobs, same names the importer itself reads:
#   DNP_MEDIA_INTERVAL_MS   spacing between occurrence/search requests (default
#                           400). Raise it if the log prints 429s.
#   DNP_MEDIA_CONCURRENCY   pool size for the species/match pass (default 4).
#
# The importer is idempotent and resumable, so re-running or restarting the
# service is always safe.
set -u

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[dnp-enrich] DATABASE_URL is not set; refusing to start." >&2
  exit 3
fi

echo "[dnp-enrich] waiting for the database"
n=0
until psql "$DATABASE_URL" -At -c 'select 1' >/dev/null 2>&1; do
  n=$((n + 1))
  if [ "$n" -ge 30 ]; then
    echo "[dnp-enrich] database unreachable after $n attempts" >&2
    exit 1
  fi
  sleep 5
done

echo "[dnp-enrich] starting the enrichment (interval ${DNP_MEDIA_INTERVAL_MS:-400}ms)"

# The importer retries throttling and 5xx internally and only exits non-zero on a
# fatal error, so a retry here is the outer safety net: the cache carries every
# settled lookup across, so each attempt picks up where the last one stopped.
attempt=0
while true; do
  if node /app/scripts/enrich-dnp-media.mjs; then
    echo "[dnp-enrich] enrichment complete"
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 5 ]; then
    echo "[dnp-enrich] giving up after $attempt attempts" >&2
    exit 1
  fi
  echo "[dnp-enrich] attempt $attempt failed; retrying in 60s (progress is cached)" >&2
  sleep 60
done

# Keep the process alive so the platform does not restart-loop a job that is
# already done - a restart would re-run the whole pass. The final counts are in
# the log above; delete this app service once they read final.
while true; do sleep 3600; done
