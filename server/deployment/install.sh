#!/usr/bin/env bash
set -euo pipefail
archive=${1:?Usage: install.sh archive.tar.gz}
release_id=$(sha256sum "$archive" | cut -c1-20)
release="/opt/journai/releases/$release_id"
staging=$(mktemp -d /tmp/journai-install.XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
tar -xzf "$archive" -C "$staging"
cd "$staging"
npm ci --omit=dev --ignore-scripts
npm test
sudo install -d -m 755 /opt/journai/releases
if ! sudo test -d "$release"; then
  sudo mkdir "$release"
  sudo cp -a "$staging/." "$release/"
  sudo chown -R root:root "$release"
  sudo chmod -R go-w "$release"
fi
sudo install -d -m 700 /etc/journai
if ! sudo test -f /etc/journai/server.env; then
  sudo install -m 600 deployment/server.env.example /etc/journai/server.env
fi
sudo install -m 644 deployment/journai.service /etc/systemd/system/journai.service
sudo install -m 644 deployment/journai-backup.service /etc/systemd/system/journai-backup.service
sudo install -m 644 deployment/journai-backup.timer /etc/systemd/system/journai-backup.timer
previous=$(readlink -f /opt/journai/current || true)
sudo ln -sfn "$release" /opt/journai/next
sudo mv -Tf /opt/journai/next /opt/journai/current
sudo systemctl daemon-reload
sudo systemctl enable journai.service journai-backup.timer
sudo systemctl restart journai.service
sudo systemctl start journai-backup.timer
for attempt in $(seq 1 20); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:4391/health; then
    printf '\nJournAi release %s is healthy.\n' "$release_id"
    exit 0
  fi
  sleep 1
done
if [[ -n "$previous" && -d "$previous" ]]; then
  sudo ln -sfn "$previous" /opt/journai/next
  sudo mv -Tf /opt/journai/next /opt/journai/current
  sudo systemctl restart journai.service
else
  sudo systemctl stop journai.service
fi
echo 'JournAi health check failed; activation rolled back.' >&2
exit 1
