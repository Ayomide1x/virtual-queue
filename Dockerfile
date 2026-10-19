# ---- build: compile the React app and the server ----
FROM node:22-alpine AS build
WORKDIR /app
# The browser tests' Chrome isn't needed to build the image.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production deps + compiled output only ----
FROM node:22-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
# Shown by /health and attached to error reports (CI passes the git SHA).
ARG APP_VERSION=""
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
EXPOSE 3000
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server/dist/index.js"]
