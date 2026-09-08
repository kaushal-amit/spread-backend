# 6.5 · the backend image. Node 22, production deps, migrations run at boot.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
# migrate is advisory-locked, so many replicas starting at once is safe.
CMD ["sh", "-c", "npm run migrate && node src/index.js"]
