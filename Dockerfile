FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=4173
EXPOSE 4173

# Run the server directly; auto-restart on crash is handled by the orchestrator's
# restart policy (docker-compose `restart: always`, Fly machine restart). The
# scripts/start.js supervisor (npm start) is the fallback for non-container hosts.
CMD ["node", "server/index.js"]
