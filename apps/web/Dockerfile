FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "apps/web"]
