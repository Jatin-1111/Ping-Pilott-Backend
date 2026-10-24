FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Do not run as root inside the container
RUN mkdir -p logs && chown -R node:node /app
USER node

EXPOSE 5000

CMD ["node", "index.js"]
