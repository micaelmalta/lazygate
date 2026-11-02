FROM node:24-slim AS build
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
CMD ["serve", "--host", "0.0.0.0", "--allow-remote", "--allowed-host", "127.0.0.1:8787,localhost:8787"]
