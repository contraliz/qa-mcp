# syntax=docker/dockerfile:1

# Build once with the toolchain, then run on the image that pins the browser.
# The Playwright tag must match the `playwright` version in package.json,
# otherwise pixels drift between this image and a developer machine.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production \
    QA_HOME=/artifacts \
    QA_HEADLESS=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /artifacts
VOLUME ["/artifacts"]
ENTRYPOINT ["node", "dist/server.js"]
