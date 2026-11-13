ARG NODE_IMAGE=node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
FROM ${NODE_IMAGE} AS node-toolchain
FROM ${PLAYWRIGHT_IMAGE} AS build
# Browser and OS libraries are prepared together; no APT during app builds.
COPY --from=node-toolchain /usr/local/ /usr/local/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY . .
RUN npm run build && npm run export:editor

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG VCS_REF=unknown
ARG VERSION=development
LABEL org.opencontainers.image.source="https://github.com/yurigarciapardinho/jagunco.io" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/server/data PROTOCOL_OUTPUT_DIR=/app/server/data/protocol
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
RUN install -d -o node -g node -m 0750 /app/server/data /run/jagunco-control
USER node
EXPOSE 3000
CMD ["node", "dist/boot.js"]
