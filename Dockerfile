FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* .
RUN npm install --omit=dev
COPY . .
RUN mkdir -p .hivemind/data .hivemind/metrics
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "sesi-swarm-server.js"]
