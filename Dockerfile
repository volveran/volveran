# syntax=docker/dockerfile:1
# Volverán: one Node process serving the web app and the JSON API.
# Runs as the non-root "node" user and writes nothing outside mounted
# volumes, so it works with `docker run --read-only`.
#
# Solo Mode (the default) listens on 127.0.0.1 only and refuses any other
# address, so run it with the host's network:
#   docker run --rm --read-only --network host \
#     -v ./profiles.yaml:/config/profiles.yaml:ro \
#     -e VOLVERAN_OPERATOR=$USER -e VOLVERAN_DEV_PASSWORD \
#     volveran
# Team Mode (VOLVERAN_AUTH=oidc, #11) is the only mode allowed to set
# VOLVERAN_HOST=0.0.0.0 and use a published port (-p 8080:8080).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    VOLVERAN_PROFILES_FILE=/config/profiles.yaml \
    VOLVERAN_HOST=127.0.0.1 \
    VOLVERAN_PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
