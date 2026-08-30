FROM node:20-slim

WORKDIR /app/backend

COPY backend/package.json .
RUN npm install --omit=dev

COPY backend/ .

EXPOSE 4000

CMD ["node", "server.js"]
