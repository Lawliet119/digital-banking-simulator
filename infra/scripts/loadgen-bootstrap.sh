#!/usr/bin/env bash
# DBS-166: chạy TRÊN máy tải (qua SSM Run Command, root) một lần sau khi `terraform apply` stack loadgen.
# Cài Node 24 và k6 (có kiểm checksum), lấy mã nguồn từ S3 (`git archive` của đúng commit đang đo), cài dependency
# backend (runner cần ts-node, pg và checker bất biến), tải CA bundle của RDS. Idempotent.
#
# Dùng: bash loadgen-bootstrap.sh <bucket> [node-version] [k6-version]
# In ra phiên bản đã cài để ghi vào báo cáo. Không đặt bí mật nào ở đây.
set -euo pipefail

BUCKET="${1:?bucket}"
NODE_VERSION="${2:-v24.22.2}"
K6_VERSION="${3:-v2.3.0}" # bản DBS-165 đã kiểm (review DBS-166 #13)
HOME_DIR=/opt/loadgen
mkdir -p "$HOME_DIR/logs" "$HOME_DIR/results"
cd "$HOME_DIR"

# --- Node ---
if [ ! -x "$HOME_DIR/node/bin/node" ]; then
  base="https://nodejs.org/dist/${NODE_VERSION}"
  file="node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL "$base/$file" -o "$file"
  curl -fsSL "$base/SHASUMS256.txt" -o SHASUMS256.txt
  grep " $file\$" SHASUMS256.txt | sha256sum -c -
  rm -rf node && mkdir node && tar -xJf "$file" -C node --strip-components=1
  rm -f "$file" SHASUMS256.txt
fi
export PATH="$HOME_DIR/node/bin:$PATH"

# --- k6: bản chỉ định (mặc định v2.3.0, bản DBS-165 đã kiểm); "latest" lấy bản mới nhất ---
if [ ! -x "$HOME_DIR/k6/k6" ]; then
  if [ -z "$K6_VERSION" ]; then
    K6_VERSION="$(curl -fsSL https://api.github.com/repos/grafana/k6/releases/latest | grep -m1 '"tag_name"' | sed 's/.*"\(v[^"]*\)".*/\1/')"
  fi
  file="k6-${K6_VERSION}-linux-amd64.tar.gz"
  base="https://github.com/grafana/k6/releases/download/${K6_VERSION}"
  curl -fsSL "$base/$file" -o "$file"
  curl -fsSL "$base/k6-${K6_VERSION}-checksums.txt" -o k6-checksums.txt
  grep " $file\$" k6-checksums.txt | sha256sum -c -
  rm -rf k6 && mkdir k6 && tar -xzf "$file" -C k6 --strip-components=1
  rm -f "$file" k6-checksums.txt
fi

# --- CA bundle của RDS (TLS tới PostgreSQL luôn được xác minh) ---
if [ ! -s "$HOME_DIR/rds-ca.pem" ]; then
  curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$HOME_DIR/rds-ca.pem"
fi

# --- Mã nguồn đúng commit đang đo ---
aws s3 cp "s3://$BUCKET/src.tgz" src.tgz --only-show-errors
rm -rf src && mkdir src && tar -xzf src.tgz -C src
(cd src/backend && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "node=$(node -v) npm=$(npm -v) k6=$("$HOME_DIR/k6/k6" version | head -1)"
echo "source=$(cat src/COMMIT 2>/dev/null || echo unknown)"
