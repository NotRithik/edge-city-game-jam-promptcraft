# anvil (Foundry) runs the game's local EVM chain: a fork of Base mainnet holding the mock-token economy
FROM ghcr.io/foundry-rs/foundry:stable AS foundry

FROM node:22-bookworm-slim
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
# Chromium renders the AI sandboxes (sandbox.js); emoji fonts so creature sprites and name tags draw
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js sandbox.js chain.js nation.js chain-artifacts.json prompt.md ./
# the game page itself: sandboxes load it from this server
COPY public/index.html ./public/index.html
RUN mkdir -p data && chown node:node data
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
