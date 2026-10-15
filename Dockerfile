FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js prompt.md ./
RUN mkdir -p data && chown node:node data
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
