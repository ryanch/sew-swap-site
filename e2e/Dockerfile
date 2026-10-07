# Keep the image tag in sync with @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /e2e
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
CMD ["npx", "playwright", "test"]
