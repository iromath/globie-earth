# Serves the compiled Globie Earth web payload exactly as it ships inside the
# Android shell (android/app/src/main/assets/public), plus the long-form guided
# meditations that live outside the app bundle (public/voice/guides, ~217 MB).
# Build context must be the repository root:
# docker build -f infra/web/Dockerfile -t <tag> .
FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf && cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_types text/css application/javascript application/json application/svg+xml image/svg+xml font/woff2 text/plain;

  # Content-hashed bundles never change for a given build.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # index.html is unhashed and names the hashed bundles, so revalidate it.
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  # .well-known must never fall through to the SPA shell.
  location /.well-known/ {
    try_files $uri =404;
  }

  # Pretty path for the policy page that the footer and store listings link to.
  # Keep the single source file privacy-policy.html rather than duplicating it.
  location = /privacy {
    try_files /privacy-policy.html =404;
  }

  location = /terms {
    try_files /terms-policy.html =404;
  }

  # Guided meditations: large immutable files, safe to cache at the edge.
  location /voice/guides/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=604800";
  }

  # Client-side routing: unknown paths return the shell.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
EOF

# The Capacitor web payload.
COPY android/app/src/main/assets/public/ /usr/share/nginx/html/

# The long-form guided meditations, served at /voice/guides/<name>.mp3.
COPY public/voice/guides/ /usr/share/nginx/html/voice/guides/

EXPOSE 80
