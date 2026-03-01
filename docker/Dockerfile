FROM node:20-alpine

WORKDIR /app

COPY --chmod=755 package*.json ./

RUN npm install --production

COPY --chmod=755 src /app

EXPOSE 3000

CMD ["node", "/app/server.js"]