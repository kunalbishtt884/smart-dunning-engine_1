FROM node:20-slim AS build

WORKDIR /app/frontend
COPY frontend/package.json .
RUN npm install
COPY frontend/ .
RUN npm run build

FROM node:20-slim
WORKDIR /app/frontend
RUN npm install -g serve
COPY --from=build /app/frontend/dist ./dist

EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
