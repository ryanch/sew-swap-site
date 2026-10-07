# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---- dev: Vite dev server with HMR (src/ is bind-mounted by compose) ----
FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]

# ---- build: static bundle ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod: nginx serving the bundle on $PORT (Cloud Run) ----
FROM nginx:alpine AS prod
ENV PORT=8080
ENV API_UPSTREAM=http://api:8080
ENV NGINX_ENVSUBST_FILTER="^(PORT|API_UPSTREAM)$"
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
