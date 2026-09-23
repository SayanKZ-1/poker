# Deployment template; building/publishing was not performed for this prototype.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production AUTH_MODE=telegram HOST=0.0.0.0 PORT=3000
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
