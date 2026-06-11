# Dispatch — single-container image for Cloud Run.
# Serves the built SPA + API from one Express process on $PORT.
FROM node:20-bookworm-slim

# better-sqlite3 is a native module — needs a toolchain to compile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching (dev deps included: tsx runs the server,
# vite builds the web bundle).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Cloud Run sets PORT; bind all interfaces (a container can't bind localhost).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ALLOW_NONLOCAL=1 \
    DISPATCH_DB_PATH=/data/dispatch.db

EXPOSE 8080
CMD ["npm", "run", "start"]
