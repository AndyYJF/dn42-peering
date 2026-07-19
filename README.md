# dn42-peering — PEERING/DESK

DN42 自助 peering 系统（全栈）。外部 AS 在网页上验证身份 → 选节点 → 填隧道参数，
系统自动在对应节点上下发 **WireGuard + BIRD2** 配置，BGP 会话几分钟内建立，全程无人值守。

适用拓扑：你自己的多个节点之间已用 WireGuard + iBGP full mesh 互联，本系统只管理
**外部 peer ↔ 你的节点** 的 eBGP 会话。

```
┌───────────┐   HTTPS    ┌────────────────┐   HTTP+token   ┌──────────────┐
│  浏览器    │ ────────▶ │ server (Node)   │ ─────────────▶ │ agent (节点1) │ wg-quick / birdc
│  React SPA│            │ Express+SQLite  │ ─────────────▶ │ agent (节点2) │
└───────────┘            │ registry 验证    │ ─────────────▶ │ agent (...)   │
                         └────────────────┘                └──────────────┘
```

## 组成

| 目录 | 技术 | 职责 |
|---|---|---|
| `frontend/` | React + Vite | 门户：首页 / peering 向导 / 我的会话 / 管理后台 |
| `server/` | Node ≥22.5 + Express + `node:sqlite` | 控制面：DN42 registry 身份验证（SSH/PGP 挑战签名）、会话管理、向 agent 下发 |
| `agent/` | Python 3 纯标准库（单文件） | 跑在每个节点：渲染并应用 wg-quick + BIRD2 配置、回报 BGP/WG 状态 |
| `config/` | JSON | 站点配置与 4 个节点定义 |
| `network/` | JSON + Python | Git 管理的四节点 OSPF/iBGP Full Mesh 清单、渲染与只读审计 |

## 身份验证原理

不设密码。用户输入 ASN 后：

1. server 从 DN42 registry（本地 clone 或 burble explorer API）读取 `aut-num` → `mnt-by` → `mntner` 的 `auth:` 行；
2. 生成一次性 challenge，用户用注册过的 key 签名：
   - SSH：`echo -n "<challenge>" | ssh-keygen -Y sign -n dn42-peering -f ~/.ssh/key`
   - PGP：`echo "<challenge>" | gpg --clearsign`（公钥从 keyserver 按指纹拉取）
3. server 用 `ssh-keygen -Y verify` / `gpg --verify` 校验，签发 24h JWT。

> server 所在机器需要有 `ssh-keygen`（OpenSSH ≥ 8.0），如启用 PGP 还需 `gpg`。

## 快速体验（demo 模式）

```bash
cd frontend && npm install && npm run build
cd ../server && npm install && npm run demo     # PEERING_DEMO=1
# 打开 http://localhost:8042 — 签名处输入 demo 即可登录，admin token 为 demo
```

demo 模式：registry 查询是真的，但签名校验和 agent 调用均为模拟，方便先看完整流程。

## 正式部署

### 1. server（任选一台机器，建议套反代 + HTTPS）

```bash
cp config/config.example.json config/config.json    # 改 ourAsn / jwtSecret / adminToken
cp config/nodes.example.json  config/nodes.json     # 填 4 个节点的真实信息
cd frontend && npm install && npm run build
cd ../server && npm install && npm start            # 监听 :8042，直接托管前端
```

`config.json` 关键项：
- `autoApprove`：`true` 提交即下发；`false` 进入 pending，管理后台批准后下发
- `registry.localPath`：本地 registry clone 路径（留空则用 burble API）
- `allowedAsnRanges`：接受的 ASN 区间

systemd 单元见 `deploy/dn42-peering-server.service`，或 `deploy/docker-compose.yml`。

### 2. agent（每个节点）

```bash
scp agent/agent.py root@node:/opt/dn42-peering/
scp agent/agent.example.json root@node:/etc/dn42-peering-agent.json   # 改 token / our_asn
scp agent/dn42-peering-agent.service root@node:/etc/systemd/system/
ssh root@node systemctl enable --now dn42-peering-agent
```

agent 前提：
- 节点已装 `wireguard-tools`、BIRD2，`birdc` 可用；
- 节点 WireGuard 私钥放在 `wg_private_key_file`（默认 `/etc/wireguard/dn42-node.key`）；
- BIRD 主配置里 `include "/etc/bird/peers/*.conf";`，并已定义 `dn42_import` / `dn42_export` 过滤器
  （如你的过滤器名不同，把模板写到文件并在 agent 配置里指定 `bird_template`）；
- `nodes.json` 里该节点的 `agentUrl`/`agentToken` 与 agent 配置一致。agent 端口（默认 8643）
  只应对 server 可达（走你的 mesh 内网或防火墙白名单），不要暴露公网。

先用 `DRY_RUN=1 python3 agent.py` 验证：配置写入 `./dryrun/`，不碰系统。

### 命名与端口约定

- WireGuard 接口 / BIRD protocol：`dn42-<完整ASN>` / `dn42_<完整ASN>`；例如 `dn42-4242422229` / `dn42_4242422229`
- 本侧监听端口：`2XXXX`（冲突时自动从 21000-29999 顺延）

## API 速览

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/info` · `/api/nodes` | 公开 |
| POST | `/api/auth/lookup` · `/challenge` · `/verify` | 公开（限速） |
| GET/POST/PATCH/DELETE | `/api/peerings[...]` | peer JWT |
| GET | `/api/peerings/:id/status` | peer JWT（实时 BGP/WG 状态） |
| * | `/api/admin/...` | `X-Admin-Token` |

## 安全要点

- agent token / admin token 都是裸 Bearer——务必走内网或 HTTPS；
- server 不存任何私钥；节点 WG 私钥只在节点本地；
- 输入校验：WG 公钥格式、fe80::/64、DN42 地址段（172.20/14、172.31/16、10/8、fd00::/8）；
- auth 接口有每 IP 限速；challenge 一次性且 15 分钟过期。
