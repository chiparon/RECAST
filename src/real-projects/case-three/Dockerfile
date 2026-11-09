FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS node
FROM redis:7.2.5-bookworm@sha256:3aaec283e6e593bde528077d60280ac1589887067a39273348860837c9346d7e
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /project
