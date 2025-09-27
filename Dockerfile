FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .
RUN bash dev/guard-entry.sh
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
