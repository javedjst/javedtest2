FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root
COPY apps/api apps/api
COPY db db
RUN npm run build -w apps/api

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db db
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
