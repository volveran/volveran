# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Volverán: one Node process serving the web app and the JSON API.
# Runs as the non-root numeric user 1000:1000 (the image's "node" user, numeric
# so Kubernetes can verify runAsNonRoot) and writes only to the /data volume
# (the audit store), so it works with `docker run --read-only`. GET /healthz
# and GET /readyz answer probes without a session.
#
# Solo Mode (the default) listens on 127.0.0.1 only and refuses any other
# address, so run it with the host's network:
#   docker run --rm --read-only --network host \
#     -v ./profiles.yaml:/config/profiles.yaml:ro -v volveran-data:/data \
#     -e VOLVERAN_OPERATOR=$USER -e VOLVERAN_DEV_PASSWORD \
#     volveran
# Team Mode (VOLVERAN_AUTH=oidc, see README "Team Mode") is the
# only mode allowed to listen on the network:
#   docker run --rm --read-only -p 8080:8080 -v volveran-data:/data -e VOLVERAN_HOST=0.0.0.0 \
#     -e VOLVERAN_AUTH=oidc -e VOLVERAN_OIDC_ISSUER=... -e VOLVERAN_OIDC_CLIENT_ID=... \
#     -e VOLVERAN_OIDC_CLIENT_SECRET -e VOLVERAN_OIDC_REDIRECT_URL=... \
#     -e VOLVERAN_SESSION_SECRET ... volveran

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
ENV NODE_ENV=production \
    VOLVERAN_PROFILES_FILE=/config/profiles.yaml \
    VOLVERAN_HOST=127.0.0.1 \
    VOLVERAN_PORT=8080 \
    VOLVERAN_DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The base image's package managers are not used at runtime, and npm's bundled
# packages are where the image scan's findings come from (security.yml).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# Owned by 1000:1000 (node), so a new named volume mounted here is writable by it.
RUN mkdir /data && chown 1000:1000 /data
VOLUME /data
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
