FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM bitnami/kubectl:latest AS kubectl
FROM docker:latest AS docker-cli

FROM node:20-alpine AS runner
WORKDIR /app

# Copy binaries from official images — no apk needed
COPY --from=kubectl /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production
ENV PORT=3847
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3847
CMD ["node", "server.js"]



