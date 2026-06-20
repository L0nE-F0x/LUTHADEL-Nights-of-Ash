# Image for the Luthadel relay server (used by Fly.io; Render can use this too).
# The relay only needs `ws`, but we install all prod deps so the same image works once the
# server goes authoritative in Phase 2 (it will import the shared sim).
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
COPY src ./src
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server/index.mjs"]
