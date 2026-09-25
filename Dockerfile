# The hosted game: server/game.js serves web/ and the game WebSocket on one port.
# bridge/ and motion/ are not here on purpose: they read the AirPod and always run on each player's own Mac.
FROM node:24.11-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV PORT=8080
EXPOSE 8080
# node:sqlite (player stats) is still marked experimental in Node 24: its one-time warning is silenced, nothing else changes
CMD ["node", "--disable-warning=ExperimentalWarning", "server/game.js"]
