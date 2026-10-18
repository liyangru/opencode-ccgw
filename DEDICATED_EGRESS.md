# 独享出口评估（2026-10-19）

## 为什么需要

当前 ccgw 的后台上游走 Cloudflare WARP 的**本机 proxy 模式**（`127.0.0.1:41700`），只影响 ccgw 自己，不改变整机路由。它的三个硬限制：

1. **不能选国家**：消费版 `warp-cli` 只有 `tunnel endpoint set`，本机反复重拨始终落在新加坡边缘（`colo=SIN`）。
2. **出口 IP 与他人共享**：同一个 Cloudflare 出口可能被其他用户的行为连累；403 的 `Detect Abuse Traffic` 是 IP 维度。
3. **免费、无 SLA**：WARP 掉线要靠 `warp-guard` / `ccgw-warp-rotate` 兜。

目标不是"绕过限制"，而是拿到一个**稳定、可控、只属于自己**的出口，让 403 与延迟波动不再随别人的行为变化。

## 硬约束（来自 `AGENTS.md`）

- **不得为了网关改变整机 VPN/代理**，不能影响 OpenCode 桌面端等官方客户端的原生连接。
- 因此 WireGuard **不能装默认路由**。只允许"仅到目标主机的路由 + 进程级代理"。
- 出口只服务 ccgw 的上游请求；其他程序保持直连。

## 方案对比

| 方案 | 成本 | 出口 IP | 选国家 | 对整机路由的影响 | 复杂度 |
|---|---|---|---|---|---|
| **A. Oracle Cloud Always Free + WireGuard(受限 AllowedIPs) + 远端 HTTP CONNECT 代理** | 0（Always Free） | 固定 | ✅ | 无（只加一条 /32 主机路由） | 中 |
| **B. Oracle Cloud Always Free + SSH 动态转发(`ssh -D`) + 本机 HTTP→SOCKS 桥** | 0 | 固定 | ✅ | 无（只有 ssh 进程） | 低 |
| C. 低价 VPS（Hetzner / Contabo / RackNerd） | ~€4–6/月 | 固定 | ✅ | 同 A/B | 低 |
| D. 继续 WARP | 0 | 共享、不可选 | ❌ | 无 | 最低 |

**推荐顺序：B → A → C。** 理由：B 不改任何网络栈、不装驱动、不碰路由表，出问题只需杀掉 `ssh` 进程；A 吞吐更好但引入 WireGuard 适配器与一条路由；C 只在 Always Free 开不出来时考虑。

## 方案 B（推荐先做，桥接器已内置）

```text
ccgw ──CONNECT──> 127.0.0.1:41800 (egress-ssh.mjs, HTTP CONNECT)
                        │
                        └──SOCKS5──> 127.0.0.1:1080 (ssh -D)
                                          │
                                          └──> Oracle VM ──> opencode.ai:443
```

1. 在 Oracle Cloud 创建 Always Free 实例（`VM.Standard.A1.Flex`，1–4 OCPU / 6–24 GB，Ubuntu 24.04）。
2. 安全列表只放行 SSH（22），**不要**对公网开放代理端口。
3. 本机一条命令同时起 `ssh -D` 和 HTTP CONNECT 桥（无需 `gost`，无第三方二进制）：

   ```powershell
   node .\ccgw\zero-window\egress-ssh.mjs --target ubuntu@<vm-ip> --listen-port 41800
   ```

   它会：`ssh -N -D 127.0.0.1:1080`（`ExitOnForwardFailure=yes`）→ 等 SOCKS 端口就绪 → 在 `127.0.0.1:41800` 提供 HTTP CONNECT。只接受回环客户端，默认只放行 `opencode.ai:443`。

4. 先做一次连通性自检（不经过 ccgw，不消耗模型额度）：

   ```powershell
   node .\ccgw\zero-window\egress-ssh.mjs --target ubuntu@<vm-ip> --check
   ```

   期望输出 `{"event":"check","target":"opencode.ai:443","ok":true,"status":200}`。

5. 让 ccgw 走它（与 WARP 同一个入口，不需要改代码）：

   ```powershell
   $env:CCGW_EGRESS_UPSTREAM = "http://127.0.0.1:41800"
   ```

   常驻时把这一行写进 `zero-window\gateway.vbs` 的 `CCGW_EGRESS_UPSTREAM`，再重启 `ccgw-gateway`。

6. 验证（必须走真实客户端，不能裸 curl）：用 Claude Code / Codex 发一次真实请求，确认 ccgw 日志有 `modelSource=slot:*` 且成功，并确认出口 IP 是 VM 的 IP。

7. 回退：停掉桥与 ssh，把 `CCGW_EGRESS_UPSTREAM` 改回 `http://127.0.0.1:41700`（WARP）。桥进程退出时不会改动整机路由。

> 桥接器有离线回归：`node ccgw\test-egress-ssh.mjs`（9 条断言：ssh 参数、允许目标 200、载荷透传、非白名单 403、SOCKS 不可达 502）。

常驻/自检也可以走包装脚本（写入目标后无需每次带参数）：

```powershell
Set-Content .\ccgw\zero-window\egress-ssh.target 'ubuntu@<vm-ip>'
.\ccgw\zero-window\egress-ssh.ps1 -Action check    # 端到端 CONNECT 自检
.\ccgw\zero-window\egress-ssh.ps1 -Action start    # 后台起 ssh + 桥，写 pid 文件
.\ccgw\zero-window\egress-ssh.ps1 -Action status
.\ccgw\zero-window\egress-ssh.ps1 -Action stop     # 同时清理孤儿 ssh

# 非 22 端口 / 指定私钥（云主机常见）
.\ccgw\zero-window\egress-ssh.ps1 -Action check -IdentityFile C:\Users\me\.ssh\oracle -SshPort 2222
.\ccgw\zero-window\egress-ssh.ps1 -Action start -IdentityFile C:\Users\me\.ssh\oracle -SshPort 2222
```

一条命令接线/回退（会改 `gateway.vbs` 并重启网关，失败自动回滚）：

```powershell
.\ccgw\zero-window\egress-ssh-wire.ps1 -Action wire -Target ubuntu@<vm-ip>
# 1 自检桥 → 2 起桥 → 3 改 CCGW_EGRESS_UPSTREAM → 4 重启网关 → 5 真实回合
# 任何一步失败：恢复 WARP、重启网关、停桥

# 非 22 端口 / 指定私钥
.\ccgw\zero-window\egress-ssh-wire.ps1 -Action wire -Target ubuntu@<vm-ip> -SshPort 2222 -IdentityFile C:\Users\me\.ssh\oracle

.\ccgw\zero-window\egress-ssh-wire.ps1 -Action status   # 看当前 upstream / 桥 / egress
.\ccgw\zero-window\egress-ssh-wire.ps1 -Action unwire   # 恢复原 upstream、重启、停桥、再跑一轮验证
```

`wire` 的通过条件不是“端口通了”，而是真实回合成功且 `/health.egress.lastFamily === "proxy"`、`connections >= 1`；否则判定为没走桥并回滚。

> **本机 SSH 服务不能替代云主机。** 已用本机 `ssh2` 服务实测：`check` 返回 `200`、SSH 认证与 `direct-tcpip` 全部正常，但真实回合仍被上游 **403**——因为出口 IP 还是本机 IP。`wire` 正确识别失败并回滚到 WARP。独享出口的价值在于**换 IP**，必须用云主机；传输层本身已经验证过。


## 方案 A（吞吐更好）

1. 本机装 WireGuard，配置里 **`AllowedIPs = 10.66.66.2/32`**（只路由到 VM 的隧道地址，不写 `0.0.0.0/0`）。
2. VM 上跑 HTTP CONNECT 代理（`gost -L http://10.66.66.2:41800` 或 3proxy），只监听隧道地址。
3. `CCGW_EGRESS_UPSTREAM=http://10.66.66.2:41800`。
4. 自检：`Get-NetRoute` 里不应出现新的 `0.0.0.0/0`；`tracert` 普通目标仍走家宽。

## 验证清单

- [ ] `CCGW_EGRESS_UPSTREAM` 生效后，ccgw `/health.egress.lastFamily` 显示 `proxy`。
- [ ] 真实客户端请求成功（`ccgw.log` 有 `served`，不是只有 `/health` 可达）。
- [ ] 出口 IP = 云主机 IP（在 VM 上 `curl ifconfig.me` 与网关侧观测一致）。
- [ ] 整机默认路由未改变（`Get-NetRoute -DestinationPrefix 0.0.0.0/0` 仍指向家宽）。
- [ ] 断掉隧道后 ccgw 有明确失败日志，且**不会**自动改整机网络。
- [ ] OpenCode 桌面端仍走原生连接（不经过新出口）。

## 需要用户提供

- 云账号（Oracle Always Free 或任意 VPS）与实例的 SSH 访问方式。
- 期望的出口国家/地区（决定 VM 区域）。

> 不再需要安装 `gost`：HTTP CONNECT → SOCKS5 桥已内置为 `zero-window/egress-ssh.mjs`，只依赖 Node 与系统 `ssh`。WireGuard 仅在需要更高吞吐时才考虑（方案 A）。

在拿到这些之前，本机继续用 WARP；`ccgw-warp-rotate` 保持每 30 分钟轮换，`ccgw-netguard` 保持待命。
