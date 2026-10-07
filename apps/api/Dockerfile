# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app

# ---- deps: all dependencies (dev + prod) ----
FROM base AS deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- dev: hot reload via tsx (src/ is bind-mounted by compose) ----
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 8080
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ---- build: compile TypeScript ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod: what Cloud Run runs ----
FROM base AS prod
ENV NODE_ENV=production
ENV PORT=8080
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
