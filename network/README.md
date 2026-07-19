# Network configuration moved

四节点 OSPF/iBGP Full Mesh 的配置源已经迁移到独立仓库：

<https://github.com/AndyYJF/dn42-network-config>

请在新仓库修改拓扑清单、BIRD2 模板，并运行渲染、审计和事务部署工具。
本仓库只维护 Auto Peer 服务和 `/etc/bird/peers/*` 中的外部 Peer 生命周期，
不再保存或部署 OSPF/iBGP 核心配置。
