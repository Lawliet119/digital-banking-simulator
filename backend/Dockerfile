# One image, two ECS services: the same image runs as `api` or `worker` depending on APP_ROLE.
#   docker build -t dbs-backend backend
#   docker run -e APP_ROLE=api    -e DATABASE_URL=… dbs-backend
#   docker run -e APP_ROLE=worker -e DATABASE_URL=… dbs-backend

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Never run as root. The `node` user ships with the official image.
USER node
EXPOSE 3000
# No HEALTHCHECK here on purpose: the `api` service is checked by the load balancer
# (GET /health/ready) and the `worker` service has no HTTP port, so each ECS service defines
# its own check. Migrations are a separate pipeline step:
#   docker run … dbs-backend node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
CMD ["node", "dist/main.js"]
