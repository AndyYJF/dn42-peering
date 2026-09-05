#!/usr/bin/env bash
# dn42-config-sync — 把本节点的 WireGuard + BIRD 配置推送到 dn42-config 仓库
#
# 每 30 分钟由 dn42-config-sync.timer 触发。整个 /etc/wireguard 与 /etc/bird
# 原样拷贝（含 WG 私钥，目标仓库必须是私有仓库）到 <NODE_NAME>/ 下，
# 有变化才提交推送。多节点并发推送冲突时自动重试。
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/dn42-config-sync.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

NODE_NAME="${NODE_NAME:-$(hostname -s)}"
REPO_URL="${REPO_URL:-git@github.com:AndyYJF/dn42-config.git}"
BRANCH="${BRANCH:-main}"
WORK_DIR="${WORK_DIR:-/var/lib/dn42-config-sync}"
WG_DIR="${WG_DIR:-/etc/wireguard}"
BIRD_DIR="${BIRD_DIR:-/etc/bird}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"

LOCK="/run/dn42-config-sync.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "another sync is running, skip"; exit 0; }

if [ ! -d "$WORK_DIR/.git" ]; then
    rm -rf "$WORK_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORK_DIR"
fi

attempt_push() {
    cd "$WORK_DIR"
    git remote set-url origin "$REPO_URL"
    git fetch --depth 1 origin "$BRANCH"
    git reset --hard -q "origin/$BRANCH"

    local dest="$WORK_DIR/$NODE_NAME"
    rm -rf "${dest:?}/wireguard" "${dest:?}/bird"
    mkdir -p "$dest/wireguard" "$dest/bird"
    if [ -d "$WG_DIR" ]; then
        cp -a "$WG_DIR/." "$dest/wireguard/"
    fi
    if [ -d "$BIRD_DIR" ]; then
        cp -a "$BIRD_DIR/." "$dest/bird/"
    fi

    git add -A -- "$NODE_NAME"
    if git diff --cached --quiet -- "$NODE_NAME"; then
        echo "[$NODE_NAME] no changes"
        return 0
    fi
    git -c user.name="dn42-sync ($NODE_NAME)" \
        -c user.email="dn42-sync@${NODE_NAME}.local" \
        commit -q -m "sync($NODE_NAME): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    git push -q origin "HEAD:$BRANCH"
    echo "[$NODE_NAME] pushed"
}

for try in 1 2 3; do
    # 子 shell 里重新启用 set -e：if 条件上下文会抑制主 shell 的 -e，
    # 不包一层的话 fetch/push 失败会被误当成功
    if (set -e; attempt_push); then
        exit 0
    fi
    echo "[$NODE_NAME] push failed (attempt $try), retrying after rebase..."
    sleep $((try * 5))
done

echo "[$NODE_NAME] push failed after 3 attempts" >&2
exit 1
