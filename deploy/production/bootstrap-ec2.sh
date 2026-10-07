#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root or with sudo."
  exit 1
fi

ADMIN_USER="${ADMIN_USER:-bakalooops}"
SOURCE_USER="${SOURCE_USER:-ubuntu}"
TRUSTED_SSH_CIDR="${TRUSTED_SSH_CIDR:-}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  fail2ban \
  jq \
  ufw \
  unattended-upgrades

systemctl enable --now docker
systemctl enable --now fail2ban
systemctl enable --now unattended-upgrades

if ! id -u "${ADMIN_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${ADMIN_USER}"
fi

usermod -aG sudo "${ADMIN_USER}"
usermod -aG docker "${ADMIN_USER}"

install -d -m 700 -o "${ADMIN_USER}" -g "${ADMIN_USER}" "/home/${ADMIN_USER}/.ssh"
if [ -f "/home/${SOURCE_USER}/.ssh/authorized_keys" ]; then
  install -m 600 -o "${ADMIN_USER}" -g "${ADMIN_USER}" \
    "/home/${SOURCE_USER}/.ssh/authorized_keys" \
    "/home/${ADMIN_USER}/.ssh/authorized_keys"
fi

install -d -m 750 -o "${ADMIN_USER}" -g "${ADMIN_USER}" /opt/bakaloo/app
install -d -m 700 -o "${ADMIN_USER}" -g "${ADMIN_USER}" /srv/bakaloo/postgres
install -d -m 700 -o "${ADMIN_USER}" -g "${ADMIN_USER}" /srv/bakaloo/redis
install -d -m 700 -o "${ADMIN_USER}" -g "${ADMIN_USER}" /srv/bakaloo/backups

cat >/etc/ssh/sshd_config.d/60-bakaloo-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM yes
EOF
systemctl reload ssh || systemctl reload sshd

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
if [ -n "${TRUSTED_SSH_CIDR}" ]; then
  ufw allow from "${TRUSTED_SSH_CIDR}" to any port 22 proto tcp
else
  ufw allow OpenSSH
fi
ufw --force enable

echo "Bootstrap complete. Verify SSH access as ${ADMIN_USER} before removing fallback access."
