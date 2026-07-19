# 部署记录 — 2026-06-10

## 拓扑

| 节点 | 公网 IP | mesh IP | 角色 |
|---|---|---|---|
| tyo | 156.231.116.81 | 172.21.118.161 | agent |
| fra | 156.226.175.73 | 172.21.118.162 | agent |
| lax | 45.202.243.95 | 172.21.118.165 | agent |
| hkt | 154.37.219.205 | 172.21.118.164 | **server + 面板** + agent |

- 面板: **http://154.37.219.205:8042**(hkt 的 80/443 被 1Panel/openresty 占用;如需域名+HTTPS,在 1Panel 里加一个反代到 127.0.0.1:8042 的站点即可)
- AS4242422921 / ANDY-MNT,身份验证方式:PGP(指纹 48B5…441F),登录时用 `gpg --clearsign` 签 challenge
- `autoApprove: true` —— 提交即自动开通

## 各节点组件

- agent: `/opt/dn42-peering/agent.py` + `/etc/dn42-peering-agent.json`(0600)+ systemd `dn42-peering-agent`
  - 监听 8643;tyo/fra/lax 监听 0.0.0.0 但 `allow_from` 限制 127.0.0.1/32 + 172.21.118.160/28,外加 Bearer token
  - hkt 只监听 127.0.0.1
  - WG 私钥统一在 `/etc/wireguard/privatekey`(lax/hkt 原来没有该文件,部署时从现有 conf 提取生成)
- server(仅 hkt): `/opt/dn42-peering/server`,用户 `dn42peering`,systemd `dn42-peering-server`,SQLite 在 `server/data/`
- hkt 资源调整: 新建 2G `/swapfile`(已写 fstab)+ `vm.swappiness=10`(`/etc/sysctl.d/99-swappiness.conf`)
- hkt 装了 Node.js 24(NodeSource apt)

## 凭据

config.json(jwtSecret/adminToken)与各节点 agent token 都在 hkt `/opt/dn42-peering/config/` 及各节点 `/etc/dn42-peering-agent.json`;本机副本在 `config/config.json`、`deploy/.work/tokens.json`(均已 gitignore)。
管理后台入口:面板 `/admin`,token 见 `config/config.json` 的 `adminToken`。

部署用 SSH 密钥 `deploy/.work/deploy_key(.pub)` 已加入 4 台的 authorized_keys。

## 生成的配置风格(与现网手工 peer 一致)

- wg: `/etc/wireguard/dn42-<完整ASN>.conf`,`Address = fe80::2921/64` + `autoconf=0` + `Table=off`
- bird: `/etc/bird/peers/dn42_<完整ASN>.conf`,`protocol bgp dn42_<完整ASN> from dnpeers { ... }`,ENH 可选
- 端口 `2XXXX`(被占自动顺延);文件头部有 `managed by dn42-peering agent` 标记,**agent 只会动带标记的文件**,不会碰手工 peer;bird 配置被拒绝时自动回滚

## E2E 验证结论(2026-06-10)

- 门户 API 创建 → tyo 实际起 wg + bird → lax 模拟 peer 握手成功(handshake 11s 前,rx/tx 有流量,隧道内 ping 101ms)→ BGP Active(模拟端无 BGP,符合预期)→ 删除后节点无残留 ✅
- 防覆盖:接管手工 peer(dn42-0253)与端口冲突均被 409 拒绝 ✅
- 4 节点 agent 健康检查全部 reachable ✅

## ⚠️ 发现的既有网络问题(与本系统无关)

**fra → tyo 公网 UDP 全被丢弃**(fra 出网抓到包,tyo 进网抓不到;lax→tyo 同端口正常)。
你现有的 fra↔tyo 直连隧道(fra 上的 `jp-iij`)最后一次握手已是 ~28 小时前,目前 fra-tyo 流量在绕行。怀疑两家运营商之间 UDP 被过滤,可考虑换端口段/换协议(udp2raw 等)或换线路。

## 常用运维

```bash
# 看 server 日志
ssh -i deploy/.work/deploy_key root@154.37.219.205 journalctl -u dn42-peering-server -f
# 看某节点 agent 日志
ssh -i deploy/.work/deploy_key root@156.231.116.81 journalctl -u dn42-peering-agent -f
# 更新 agent:改 agent/agent.py 后
cd deploy/.work && node update-agents.js
# 更新 server/前端:本机 frontend npm run build 后
cd .. && tar czf deploy/.work/bundle.tar.gz server/package.json server/src config/*.json frontend/dist deploy/dn42-peering-server.service
cd deploy/.work && node deploy-server.js   # 幂等
```
