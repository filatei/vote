# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Install all deps (incl. dev) for the TypeScript build.
RUN npm install
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Compiles TS and copies EJS views + static assets into dist/.
RUN npm run build

# ---- production deps ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as non-root.
USER node

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=deps  /app/node_modules ./node_modules
# dist/ already contains compiled JS plus copied views/ and public/ assets.
COPY --chown=node:node --from=build /app/dist ./dist

EXPOSE 8090

# Lightweight healthcheck hitting the app's /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.APP_PORT||8090)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
