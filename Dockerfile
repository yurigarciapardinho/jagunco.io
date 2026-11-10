ARG NODE_IMAGE=node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
COPY . .
RUN npm run build && npm run export:editor

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/server/data PROTOCOL_OUTPUT_DIR=/app/server/data/protocol
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
RUN install -d -o node -g node -m 0750 /app/server/data /run/jagunco-control
USER node
EXPOSE 3000
CMD ["node", "dist/boot.js"]
