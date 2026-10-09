# ─── Stage 1: Install dependencies ─────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Production image ────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove dev files
RUN rm -rf .env .env.example tests/ .github/ .vscode/ *.md

# Upload directories (mounted as volumes in compose). private-uploads holds
# seller invoices and is never served publicly.
RUN mkdir -p /app/uploads /app/private-uploads

# Set ownership
RUN chown -R appuser:appgroup /app
USER appuser

# Expose port (matches Fastify listen port)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1

# Start
CMD ["node", "src/server.js"]
