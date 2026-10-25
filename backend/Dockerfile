# syntax=docker/dockerfile:1
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
# Node does not trust the Amazon RDS CA by default, so the AWS bundle is part of the image and the
# task sets DATABASE_SSL=true and DATABASE_SSL_CA_PATH to this path. The checksum pins the file: if
# AWS publishes a new bundle the build fails loudly; refresh the hash as described in
# infra/terraform/README.md (RDS section). Never disable certificate verification to get around a
# connection error.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=0444 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds/global-bundle.pem
# Never run as root. The `node` user ships with the official image.
USER node
EXPOSE 3000
# No HEALTHCHECK here on purpose: the `api` service is checked by the load balancer
# (GET /health/ready) and the `worker` service has no HTTP port, so each ECS service defines
# its own check. Migrations are a separate pipeline step (npm run migration:run:prod):
#   docker run … dbs-backend node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
CMD ["node", "dist/main.js"]
