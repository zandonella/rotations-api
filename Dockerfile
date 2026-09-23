FROM node:24-alpine
WORKDIR /app
RUN mkdir /app/data && chown node:node /app/data
COPY --chown=node:node package.json ./
COPY --chown=node:node openapi.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
