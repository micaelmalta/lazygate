FROM node:24-slim AS build
# Pin to the patched 24.x line; rebuild regularly to pick up Node security releases.
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production HOME=/home/node
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
USER node
EXPOSE 8787
ENTRYPOINT ["node", "dist/index.js"]
# Loopback inside the container by default (safe for a bare `docker run`; unreachable from outside).
# docker-compose.yml passes --host 0.0.0.0 --allow-remote together with a loopback-only port publish.
CMD ["serve"]
