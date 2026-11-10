#!/usr/bin/env bash
set -Eeuo pipefail
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  docker version --format '{{.Server.Version}}'
  docker compose version
  exit 0
fi
if [[ $(id -u) -ne 0 ]]; then echo 'Execute o bootstrap do host com sudo.' >&2; exit 1; fi
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then
  echo 'Este bootstrap atende Ubuntu 24.04; use o procedimento oficial na sua distribuição.' >&2
  exit 1
fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl python3
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
TASK_ARCH=$(dpkg --print-architecture)
cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $TASK_ARCH
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get update
TASK_DOCKER_VERSION=$(apt-cache madison docker-ce | awk '$3 ~ /^5:29\./ {print $3;exit}')
if [[ -z "$TASK_DOCKER_VERSION" ]]; then echo 'Docker 29 não encontrado no repositório oficial.' >&2; exit 1; fi
apt-get install -y --no-install-recommends "docker-ce=$TASK_DOCKER_VERSION" "docker-ce-cli=$TASK_DOCKER_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version --format '{{.Server.Version}}'
docker compose version
