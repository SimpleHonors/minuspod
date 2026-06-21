#!/usr/bin/env bash
set -e

# Durable deploy script for MinusPod in production
# Pins the network, assigns fixed IP,
# and aligns internal/external port to prevent UI lockouts.

cd "$(dirname "$0")/.."

export MINUSPOD_PORT=${MINUSPOD_PORT:-8080}
export MINUSPOD_IP=${MINUSPOD_IP:-192.168.1.100}
export MINUSPOD_NETWORK=${MINUSPOD_NETWORK:-production_net}

docker compose -f docker-compose.yml -f docker-compose.prod.yml down || true
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
