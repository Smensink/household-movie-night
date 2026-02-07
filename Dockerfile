FROM node:22-alpine AS base

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

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/generated ./src/generated

# Install curl for startup scripts (busybox wget doesn't support all HTTP methods)
RUN apk add --no-cache curl

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
  curl -s -X POST http://localhost:3000/api/movies/prefill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Upgrading movie posters...' && \
  curl -s -X PATCH http://localhost:3000/api/movies/prefill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Running studio backfill...' && \
  curl -s -X POST http://localhost:3000/api/studios/backfill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Running people backfill...' && \
  curl -s -X POST http://localhost:3000/api/people/backfill 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] Checking/training recommendation model...' && \
  curl -s -X PATCH http://localhost:3000/api/mf/train 2>&1 | head -c 500 && echo '' && \
  echo '[Startup] All startup tasks complete.' && \
  while true; do \
    sleep 300; \
    echo '[Background] Checking if model retraining needed...' && \
    curl -s -X PATCH http://localhost:3000/api/mf/train 2>&1 | head -c 200 && echo ''; \
  done & \
  wait $SERVER_PID \
"]
