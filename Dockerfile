FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-docx python3-reportlab ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-documents.txt ./
RUN python3 -m venv --system-site-packages /opt/research-python && /opt/research-python/bin/pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes -r requirements-documents.txt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts
RUN mkdir -p /data/sources /data/projects && chown -R node:node /data
# The app listens on all container interfaces; publish the port on 127.0.0.1 only (see docker-compose.yml).
ENV HOST=0.0.0.0 ALLOW_NONLOOPBACK_BIND=1 PORT=3080 ARTIFACT_PYTHON=/opt/research-python/bin/python SOURCE_STORAGE_ROOT=/data/sources PROJECT_STORAGE_ROOT=/data/projects
EXPOSE 3080
USER node
CMD ["node", "src/server.js"]
