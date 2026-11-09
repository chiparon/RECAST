FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS browser
WORKDIR /opt/browser
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=optional --no-audit --no-fund
FROM recast-bench-django:py312-qjs194-v1
COPY --from=browser /usr/local/bin/node /usr/local/bin/node
COPY --from=browser /opt/browser /opt/browser
COPY bridge.cjs /opt/browser/bridge.cjs
WORKDIR /project
