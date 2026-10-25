FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Do not run as root inside the container
RUN mkdir -p logs && chown -R node:node /app
USER node

# Hostnames are resolved on libuv's thread pool (4 threads by default). Checks run 50 at a time, and a lookup for a dead
# name holds a thread until the resolver gives up, so a bigger pool keeps healthy lookups from waiting behind it.
# This has to be set in the process environment: .env is read too late to change the pool size.
ENV UV_THREADPOOL_SIZE=16

EXPOSE 5000

CMD ["node", "index.js"]
