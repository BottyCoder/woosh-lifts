FROM node:20-alpine
WORKDIR /app
# install deps (no dev)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
# app source
COPY . .
# guard step removed — alpine doesn't ship bash and we don't need it
EXPOSE 8080
CMD ["node","server.js"]
