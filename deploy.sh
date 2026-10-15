#!/usr/bin/env bash
# Deploy the PromptCraft BACKEND (API only) to the AWS VM as the "edge-city-mc-univ" Docker container.
# The frontend (public/index.html) is deployed separately to Vercel: vercel deploy --prod (from public/).
# Caddy on the VM proxies https://edge-city-mc-univ.18-207-103-187.nip.io -> 127.0.0.1:18787.
# Only touches ~/edge-city-mc-univ, the edge-city-mc-univ image and the edge-city-mc-univ container.
set -euo pipefail

HOST="${HOST:-ubuntu@18.207.103.187}"
KEY="${KEY:-$HOME/Downloads/AWS-Ubuntu-KP1.pem}"
NAME=edge-city-mc-univ
HOST_PORT=18787
DIR="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes)

echo "→ syncing files"
rsync -az --delete -e "${SSH[*]}" --exclude node_modules --exclude data --exclude .env --exclude public --exclude .vercel "$DIR/" "$HOST:~/$NAME/"
scp -q -i "$KEY" -o BatchMode=yes "$DIR/.env" "$HOST:~/$NAME/.env"

echo "→ building and (re)starting the container"
"${SSH[@]}" "$HOST" bash -s <<EOF
set -euo pipefail
cd ~/$NAME
chmod 600 .env
mkdir -p data
docker build -q -t $NAME . >/dev/null
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME --restart unless-stopped \
  -p 127.0.0.1:$HOST_PORT:8787 --env-file .env -v "\$PWD/data:/app/data" $NAME >/dev/null
sleep 2
docker logs --tail 5 $NAME
EOF
echo "✓ https://$NAME.18-207-103-187.nip.io"
