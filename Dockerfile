# One image: builds the React app, then serves it and the API from one Node process.
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 needs a toolchain if no prebuilt binary matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json ./
COPY server/package.json server/package-lock.json ./server/
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix server ci && npm --prefix client ci

COPY . .
RUN npm --prefix client run build

# Drop the client's dev dependencies — the runtime only needs the built dist/.
RUN rm -rf client/node_modules

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Two ways to persist data, in order of preference:
#   1. Set DATABASE_URL to a hosted Postgres. Nothing else needed.
#   2. Mount a volume here and set DATABASE_PATH=/data/anvil.db.
# With neither, the demo data re-seeds on every boot — fine for a demo.
RUN mkdir -p /data

COPY --from=build /app /app

EXPOSE 8080
CMD ["node", "server/index.js"]
