FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS test
RUN npm ci
COPY . .
RUN npm test

FROM base AS runtime
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
