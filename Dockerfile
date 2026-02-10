FROM node:22 AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production image with CUDA support
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install CUDA 11.8 runtime libraries for tfjs-node-gpu (requires CUDA 11 + cuDNN 8)
# Use Ubuntu 22.04 NVIDIA repo (debian12 repo only has CUDA 12+)
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget gnupg && \
    wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && \
    dpkg -i cuda-keyring_1.1-1_all.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      cuda-cudart-11-8 \
      libcublas-11-8 \
      libcufft-11-8 \
      libcurand-11-8 \
      libcusolver-11-8 \
      libcusparse-11-8 \
      libcudnn8 && \
    rm -rf /var/lib/apt/lists/* cuda-keyring_*.deb && \
    apt-get purge -y --auto-remove wget gnupg

# Set CUDA library path
ENV LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/generated ./src/generated

# Create and own the cache directory for image optimization
RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Startup script: run migrations, start server, prefill data, and run background retraining loop
CMD ["sh", "-c", "\
  if [ -d prisma/migrations ] && [ \"$(ls -A prisma/migrations 2>/dev/null)\" ]; then \
    ./node_modules/.bin/prisma migrate deploy; \
  else \
    ./node_modules/.bin/prisma db push; \
  fi && \
  node server.js & \
  SERVER_PID=$! && \
  sleep 10 && \
  echo '[Startup] Running movie prefill...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/prefill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Upgrading movie posters...' && \
  curl -s -X PATCH -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/prefill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Running studio backfill...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/studios/backfill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Running people backfill...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/people/backfill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Importing Radarr library...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/radarr/import 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Backfilling vote counts from TMDB/OMDB...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/backfill-votes 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Backfilling language/country data...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/backfill-language 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Cleaning up obscure movies...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/cleanup 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Importing MovieLens tag genome...' && \
  curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movielens/import 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Checking/training recommendation model...' && \
  curl -s -X PATCH -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/mf/train 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] All startup tasks complete.' && \
  while true; do \
    sleep 300; \
    echo '[Background] Backfilling vote counts...' && \
    curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/backfill-votes 2>&1 | head -c 200 && echo '' && \
    echo '[Background] Backfilling language/country data...' && \
    curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/backfill-language 2>&1 | head -c 200 && echo '' && \
    echo '[Background] Cleaning up obscure movies...' && \
    curl -s -X POST -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/movies/cleanup 2>&1 | head -c 200 && echo '' && \
    echo '[Background] Checking if model retraining needed...' && \
    curl -s -X PATCH -H \"x-internal-key: $INTERNAL_API_KEY\" http://localhost:3000/api/mf/train 2>&1 | head -c 200 && echo ''; \
  done & \
  wait $SERVER_PID \
"]
