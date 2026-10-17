# ccgw — OpenCode 本机转接网关

把 [OpenCode](https://opencode.ai)(桌面版后台服务,或无头 `opencode-cli serve`)变成一个 **Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三协议兼容**的本机 API 网关。

每个请求都作为一次**真实的 OpenCode 会话**执行(日志中可查 `sessionID`),客户端自带的工具(Read/Bash/Edit/...)通过**临时 MCP 桥接**获得**真实工具往返**——与 Claude Code / Codex / Claude Desktop 原生体验一致(含单回合多工具调用)。

适用场景:配合供应商切换器(如 [CC Switch](https://cc-switch.org))把 OpenCode 里已配置的模型——尤其是**免费模型**——接给 Claude Code、Codex、Claude Desktop 等客户端使用。

> 灵感来自 [opencode-llm-proxy](https://github.com/KochC/opencode-llm-proxy)(OpenCode 插件形态)。ccgw 采用**独立进程**形态,直接对话 OpenCode V2 HTTP API,因此支持**无头 / 零窗口**运行、可在桌面版关闭时继续服务。

## 特性

- **三协议**:Anthropic Messages、OpenAI Chat Completions、OpenAI Responses(含流式与工具)。
- **真实工具往返**:动态注册 stdio MCP 桥接 → 捕获模型发起的工具调用 → 中断回合 → 把调用按客户端方言返回;工具结果随下一次请求回到模型。支持**并行工具调用**。
- **真实会话**:每次请求 = 一次真实 OpenCode 会话;空闲会话按 `sessionID` 定时清扫。
- **免费模型路由**:不匹配已知免费模型 ID 的模型名自动路由到默认模型(可用 `CCGW_MODEL` 配置)。
- **零窗口模式**:登录自动启动(两个计划任务),无任何窗口;可完全不开桌面版使用。
- **多账户账户池**:一账户一隔离实例(独立 profile / 端口 / 计划任务),网关轮询分摊请求,命中限流自动冷却并换户重试(见下文)。
- **可选自动切出口**:所有已知免费模型在全池均进入限流冷却时,`net-guard` 按已有配置处理备用 VPN;此信号本身不能确定上游按 IP 限流。可通过 `net-guard.pause` 暂停自动切换,一键 `net-back` 回切(见下文)。
- **备用出口保活**:接上备用出口后,`warp-guard`(计划任务 `ccgw-warp-guard`,登录时 + 每 ~10 分钟)只在 WARP 掉线时自动重连——永远不会主动断开;回切家宽仍是手动动作。
- **CC Switch 深链生成**:一条命令生成 Claude Code / Codex 的一键导入链接。
- **最小权限会话**:`[deny *, allow read, allow <bridge>_*]`——只保留 `read`(免费层要求请求包含 `read` 工具,否则 403)与桥接工具。
- **JSONL 日志**:每请求一行:`reqId, dialect, requestedModel, model, bridge, sessionID, toolCalls, usage, durationMs`。

## 架构

```
Claude Code / Codex / Claude Desktop / 任意 Anthropic|OpenAI SDK
        │  Anthropic / OpenAI Chat / OpenAI Responses
        ▼
  CC Switch(可选,127.0.0.1:15721)
        ▼
    ccgw(127.0.0.1:8317)
        │  OpenCode V2 HTTP API(/api/...)
        ▼
OpenCode 服务(桌面版后台服务,或无头 opencode-cli serve × N 账户池)
        ▼
   免费模型 / 任意已配置模型
```

## 快速开始

前置要求:**Node.js 18+**;**OpenCode V2**(桌面版已安装,或有可用的 `opencode-cli`)。

```powershell
node server.mjs        # 或双击 start.cmd
curl http://127.0.0.1:8317/health   # 自检
```

服务发现顺序:`CCGW_OPENCODE_URL` 环境变量 → `opencode-cli service status` → `http://127.0.0.1:49374`;
密码读取自 `~/.config/opencode/service.json`。桌面版重启导致端口变化时,网关自动重新发现。

## 零窗口模式(推荐)

不开桌面版、无窗口常驻运行:一个无头 OpenCode 服务器(默认 `127.0.0.1:4096`,固定随机密码)+ 网关(默认 `127.0.0.1:8317`),注册为**登录自启计划任务**。

```powershell
powershell -ExecutionPolicy Bypass -File zero-window\setup.ps1
zero-window\start.cmd      # 立即启动(下次登录自动启动)
zero-window\stop.cmd       # 停止(并禁用自启)
```

`setup.ps1` 自动:探测 `opencode-cli.exe`(桌面版内置)与 `node` → 生成 `headless-service.json`(随机密码)+ `serve.vbs` / `gateway.vbs`(隐藏窗口启动器)→ 注册任务 `ccgw-serve-headless`、`ccgw-gateway`(失败自动重启 ×3)。

- 桌面版与零窗口链**完全独立**:桌面版可随时开/关,互不影响。重新运行 `setup.ps1` 会重置密码并覆盖启动器。
- 卸载:`Unregister-ScheduledTask ccgw-serve-headless,ccgw-gateway -Confirm:$false`,删除 `headless-service.json` 与两个 `.vbs` 即可。

## 多账户(账户池)

ccgw 支持把请求分摊到多个 OpenCode 账户:每个账户跑**一个独立实例**(独立 profile + 独立端口 + 独立计划任务,互不共享登录态与会话库),网关侧做**轮询 + 冷却 + 自动重试**。具体额度统计范围由上游决定;本地将 429 保守记录到“账户 + 模型”,不把它直接认定为账户全部额度或 IP 额度耗尽。

```powershell
# 1) 开通一个新账户实例(自动分配端口,创建隔离 profile 与计划任务)
powershell -ExecutionPolicy Bypass -File zero-window\add-account.ps1 -Name acct2

# 2) 浏览器登录该账户(一次性;--standalone 保证凭据写进它的隔离 profile)
#    无交互终端时加 -Method device(打印设备码+链接,浏览器确认即可;key 则贴 API key)
powershell -ExecutionPolicy Bypass -File zero-window\login-account.ps1 -Name acct2

# 3) 重启网关,加载账户池
Stop-ScheduledTask ccgw-gateway -ErrorAction SilentlyContinue; Start-ScheduledTask ccgw-gateway
```

配置在 `zero-window\accounts.json`(机器本地文件,含端口与密码文件路径,已 gitignore;`setup.ps1` 会自动生成含默认账户的版本):

```json
{ "accounts": [
  { "name": "main",  "url": "http://127.0.0.1:4096", "serviceFile": "headless-service.json", "task": "ccgw-serve-headless" },
  { "name": "acct2", "url": "http://127.0.0.1:4097", "serviceFile": "accounts/acct2/service.json", "task": "ccgw-serve-acct2" }
] }
```

行为:

- 请求在账户间**轮询**;某账户命中限流(429 / quota / usage limit 等)或实例失联时进入**冷却**(默认 300s / 30s,可用 `CCGW_COOLDOWN_SECONDS`、`CCGW_DOWN_COOLDOWN_SECONDS` 调整;连续失败按指数延长,上限 30 分钟),且该回合会在**尚未向客户端输出任何内容**时自动换账户重试(已开始流式输出则不重试,避免重复内容);
- `GET /health` 的 `accounts` 数组显示每个实例的连接状态、冷却倒计时、最近错误与**登录身份**(`identity` / `credentialId` / `email` / `accountID`;未登录的匿名实例为 `null`);`pool` 里 `distinctAccounts` = 不同邮箱的**账号数**(摊薄看这个),`total` / `loggedIn` / `anonymous` 都是**实例数**;日志每行带 `account` 字段;
- **识别"是不是新账号"**:登录会写入该账户的隔离 profile,`login-account.ps1` 会把身份(如 `OpenCode Console / Personal`)与 credential id 记入 `accounts.json`;**额度只跟登录的账号绑定——同一账号登进多个实例不会增加总额度**(credential id 每次登录都可能变化,不能单独用它断定是不是同一账号——以 `accountID` / `email` 为准)。`zero-window\accounts-status.ps1` 可查看全部实例(Name / Port / Email / Identity / CredId / 冷却;加 `-Live` 从各隔离 profile 实时重读并刷新;未登录的显示 `(anonymous / not logged in)`);
- 没有 `accounts.json` 时行为与单账户完全一致(向后兼容);删除该文件即可退回单账户;
- 限流究竟按账户还是按 IP/设备判定取决于上游:**当前观察证据是"出口 IP 是主开关"**——同一出口 IP 被点名时,池内各实例 25 秒内接连被拒(实测 2026-10;当时本机只有 1 个账号的登录、其余为匿名实例——**不论实例/凭据/是否登录,同一 IP 一律被拒**),换回干净 IP 立即恢复。所以多账户的价值是"干净 IP 上的负载分摊",救不了 IP 级封禁;封禁靠下面的出口切换解决。
- **实例 ≠ 账号**:`pool.total` / `pool.loggedIn` / `pool.anonymous` 分别是"实例数 / 已登录实例数 / 匿名实例数"——一个账号可以登录多个实例,**额度不会叠加**;未登录实例(如某个还没登录的新实例)以匿名身份承接请求,能分担并发但没有独立额度。要真正的多账户摊薄,每个实例必须登录**不同的账号**——看 `pool.distinctAccounts`(按 `email` 去重的账号数)。

## 免费模型:自动发现 + 排名 + 选优(模型槽位按需填充)

### 限流与重试

- 429 按“账户 + 模型”记录冷却；一个模型限流不阻止同一账户使用其他模型，也不会因其他模型成功而清除冷却。
- 优先遵守上游 `Retry-After`；没有提示时使用本地退避（默认 300 秒，连续失败递增，默认上限 1800 秒）。这是网关的重试间隔，不是官方额度重置时间。
- 所有候选都在冷却时，返回 429 / 503 和 `Retry-After`，不会继续请求冷却中的实例。网络故障的冷却仍适用于该实例的所有模型。
- 并发请求中，迟到的成功不能清除新产生的冷却，较短的限流提示不能缩短已有截止时间。
- 流式响应在首个非空内容到达后才发送 SSE 头；此前的错误保留真实 HTTP 状态。已经开始输出的请求不会换账户重放。
- `/health` 的 `pool.limitedModels` 和账户的 `modelCooldowns` 提供分模型状态；只有所有已知免费模型在全池均被限流时才发出全池信号。这不能证明限制按 IP 统计。

回归验证：`node --test test-errors.mjs`（本地 HTTP/SSE 模拟，不消耗上游额度）。

网关自动从账户实例的实时目录里识别**免费模型**——判据取自上游元数据本身(`cost = 0/0`,或名字带 `-free` 后缀;`big-pickle` 这类无后缀的免费模型也能自动认出),按仓库根目录的 `model-ranks.json` 从强到弱排序,新出现的免费模型自动补到列表尾部(无需改代码;该文件热生效,约一分钟内刷新)。

**默认排名(2026-10-17:好 → 差;多模态不落榜——前 5 里有 4 个能看图/视频):**

| # | 模型 | 输入能力 | 优点 / 适合 |
|---|---|---|---|
| 1 | `deepseek-v4.1-flash-free` | 文本 + 图片 | 综合首选,编码/代理任务最稳;能看图(截图/OCR);200k 上下文 |
| 2 | `glm-5.3-flash-free` | 文本 + 图片 + **视频** + **PDF** | 多模态首选:唯一能读 **PDF**;图片/视频理解;200k 上下文;实测**响应最快**(2–3 秒) |
| 3 | `nemotron-3.5-super-vl-free` | 文本 + 图片 | 最新视觉语言模型(2026-10-15);**1M 上下文** |
| 4 | `beam-free` | 文本 | 501B 大模型(23B 激活):复杂推理/深度思考;1M 上下文 |
| 5 | `longcat-2.5-preview-free` | 文本 + 图片 | 1M 上下文 + 图像理解:长文档/大代码库通读 |
| 6 | `space-bunny-free` | 文本 + 图片 + **视频** | 匿名预览模型:1M 上下文、**54 万输出上限**(超长产出);稳定性不如正式模型 |
| 7 | `mimo-v2.6-flash-free` | 文本 + 图片 + **音频** + **视频** | 唯一支持**音频**;闪速系列;200k 上下文 |
| 8 | `nemotron-3-ultra-free` | 文本 | 550B 参数;1M 上下文(较老,2026-06) |
| 9 | `nemotron-3.5-lightning-free` | 文本 | 速度命名款,但实测反而**最慢**(单请求 13 秒~3 分钟,可超时):别当快模型用;262k 上下文 |
| 10 | `big-pickle` | 文本 | 经典隐形免费模型;200k 上下文 |

按需速查:**看图** → #1/#2/#3/#5/#6/#7 任意;**看视频** → #2(glm)/#6/#7;**读 PDF** → 只有 #2(glm);**听音频** → 只有 #7(mimo);**超长上下文** → #3 起(1M);**要最快** → #2(glm,实测 2–3 秒)。

**模型槽位(Claude Code 这类"多个模型槽"的客户端)**:`model-ranks.json` 的 `slots` 把槽位名映射到免费模型——客户端即使发来硬编码名(如 `claude-haiku-4-5-20251001`)也会被路由到对应槽位的模型:

| 槽位 | 请求名匹配 | 当前指向 | 含义 |
|---|---|---|---|
| `opus` | 含 `opus` / `fable` | #1 `deepseek-v4.1-flash-free` | 最强档 → 排名第一 |
| `sonnet` | 含 `sonnet` | #2 `glm-5.3-flash-free` | 日常主力 → 排名第二(顺带多模态:视频/PDF 都能看) |
| `haiku` | 含 `haiku` | #2 `glm-5.3-flash-free` | 小/快模型 + 后台任务(标题、摘要)→ 实测最快(2–3 秒) |
| `vision` | 恰为 `vision` / `image` / `vl` | #2 `glm-5.3-flash-free` | 图片/视频/PDF 专用入口 |

槽位目标必须是免费模型;指向的模型当前不可用时自动落回排名第一。改排名或槽位都只改 `model-ranks.json`(热生效)。

**Claude Code 把各槽位直接按排名填好**(环境变量;填好后 `/model` 的 opus/sonnet/haiku 与后台任务各就各位):

```bash
export ANTHROPIC_BASE_URL="https://bronco-rewrap-january.ngrok-free.dev"   # 本机直连改成 http://127.0.0.1:8317
export ANTHROPIC_AUTH_TOKEN="<口令>"                                       # 本机直连可填任意非空值
export ANTHROPIC_MODEL="deepseek-v4.1-flash-free"                  # 默认会话 → 排名 #1
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4.1-flash-free"     # opus 槽 → 排名 #1(最强)
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.3-flash-free"         # sonnet 槽 → 排名 #2(多模态主力)
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5.3-flash-free"          # haiku 槽 + 后台任务 → 实测最快
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4.1-flash-free"       # 子代理 → 排名 #1
export API_TIMEOUT_MS=600000                                       # 大模型首字较慢,放宽超时
```

> Windows 上 `export X="v"` 换成 PowerShell 的 `$env:X="v"`(或 cmd 的 `set X=v`)。这些变量**不设也照样能用**:网关的槽位兜底会把 Claude 硬编码的模型名按上表自动路由;若版本还有 `ANTHROPIC_DEFAULT_FABLE_MODEL` 槽位,fable 默认归入 opus 槽。

- **自动选优**:请求名只要是免费模型就直接用;**槽位名**按上表对齐;**未知 / 付费目录 / 占位名**(如 `claude-sonnet-5-5`、空)落到排名第一——不会再出现"付费名透传 → 免费号必然报错 → 账号误冷却"的连锁;别名 `auto` / `best` / `best-free` / `ccgw-auto` / `free-auto` 等价于"用第一"。
- `GET /v1/models` 只列**免费模型**(按排名顺序),每条带 `ccgw_rank`(排名)与 `ccgw_input`(输入能力),客户端模型选择器里不再混入用不了的付费目录。
- `GET /health` 的 `freeRanked` = 当前完整排名(每条含 `rank` / `id` / `name` / `input` / `context`),另有 `modelSlots`(槽位映射)/ `defaultModel` / `modelPin`;每次请求日志带 `model` + `modelSource`(`requested` / `slot:<槽位>` / `alias` / `not-free` / `top-free` / `default` / `static`)。
- 想固定模型:`CCGW_MODEL=glm-5.3-flash-free`(须在免费列表内;它只影响"兜底用哪个",槽位匹配优先);自检:`node test-ranking.mjs`。

## 全池限流 → 自动切换出口(备用 VPN:WARP / Nord / VPN Gate)

若免费层限额按 IP 判定,加账户救不回;**所有实例同时因限流冷却**就是这个信号。ccgw 把它暴露为 `/health` 的 `pool` 对象(`total`=实例数、`loggedIn`=已登录实例数、`anonymous`=匿名实例数、`distinctAccounts`=不同账号数、`cooling`、`quotaExhausted`),`zero-window\net-guard.ps1` 常驻监听并自动切换备用出口。

**出口后端**(`net-guard.ps1 -Backend` 参数,或一行文件 `zero-window\net-guard.backend` 写 `warp` / `nord` / `vpngate` / `none`;默认 `auto`:装了并注册过 WARP 用 WARP(免费免登录),否则装了 NordVPN 用 Nord,**都没有则不自动切换**——公共 VPN(VPN Gate)出口已被免费层按 IP 拉黑,自动切过去只会把"限流"升级成 403):

| 后端 | 账号 / 安装 | 说明 |
|---|---|---|
| `warp` | **零账号、零登录**(匿名设备注册) | [Cloudflare WARP](https://1.1.1.1/):`winget install Cloudflare.Warp` + `warp-cli --accept-tos registration new`;✅ 实测免费层放行(2026-10-17,经网关真请求正常返回;共享出口 IP 偶发软限流,交给账户池消化;见 `egress-warp.ps1`) |
| `nord` | 需已登录的 NordVPN | 官方 CLI 通道,零窗口秒级(见 `nord-cli.ps1`) |
| `vpngate` | **零账号、零安装** | [VPN Gate](https://www.vpngate.net/)(筑波大学公共 VPN):Windows 原生 L2TP/IPsec,凭据公开(vpn/vpn),无需管理员;⚠ 实测共享出口已被上游按 IP 标记,仅建议作普通 VPN 手动使用 |
| `none` | 无 | 只监听并写日志提示(WARP / Nord 都没装时 `auto` 的默认值) |

- `quotaExhausted:true` 且备用出口未连接 → 自动连接并等隧道就绪 → 客户端重试即可继续;
- **全程静默**:Nord 走官方 CLI(仅当应用进程被完全退出时回退 UIA 冷启动);WARP 走 `warp-cli`;VPN Gate 走系统拨号——都不创建窗口、不弹前台;守卫进程本身也无窗口(net-guard.vbs 启动);
- 已在备用出口上仍显示全池限流(**超过约 6 分钟冷却排水期**)→ 日志提醒"该出口可能也被限"(不自动换节点/换服务器,避免频繁换 IP);
- 平时零动作。暂停:`zero-window` 下建 `net-guard.pause`;日志:`zero-window\net-guard.log`(每 ~10 分钟一行 heartbeat,可判断守卫存活);切换时弹系统通知:建文件 `net-guard.toast`(默认关);自启:`setup.ps1` 检测到 NordVPN 时注册 `net-guard.vbs`(计划任务;无管理员权限时退回注册表 Run 键)。WARP / Nord 都没装时 `auto` 不切换(VPN Gate 仍可显式 `-Backend vpngate`,注意上方警示)。
- **残留自愈**:守卫每轮都检查 `ccgw-vpngate`——当前后端不是 `vpngate` 时,若发现它仍连着,判定为测试/手动残留,自动断开并记日志(`stale egress cleanup`);**`net-guard.pause` 暂停期间同样生效**,机器不会被静默留在公共出口上。
- **备用出口保活(2026-10-18)**:连上备用出口后由 `zero-window\warp-guard.ps1`(+ 计划任务 `ccgw-warp-guard`,登录时与每 ~10 分钟)看护——WARP 掉线就重连,已连接则什么都不做;日志 `zero-window\warp-guard.log`,暂停建 `warp-guard.pause`。它补的是 `ccgw-warp-login`(只在登录后连一次)的空档:睡眠唤醒 / WARP 服务重启 / 误断之后都能自动补连。它**只连不断**,回切家宽依旧手动。

> ⚠️ 实测警示(2026-10):**公共 VPN 的共享出口对"刷新免费额度"基本无效**——VPN Gate 的中继 IP 被全球用户共用,免费层很可能早已按其限流(实测连上后第一个请求即被拒:"free tier can only be used from within OpenCode",池内实例全部被连坐——当时本机只有 1 个账号、其余为匿名实例,证明按 IP 判定、与账户无关;换回干净出口立即恢复)。后续复测(2026-10-17):经 VPN Gate 出口时**即使重新登录授权,免费层请求仍全部 403,断开 VPN 立即恢复**——该拦截按出口 IP 判定,与账户/授权无关。想用出口切换刷新配额,需要**独享 IP**(自己的 Nord 账号,或自建 WireGuard 出口);VPN Gate 后端的定位是"零门槛的免费出口",适合普通 VPN 用途。

配套命令(均在 `zero-window\`):

```powershell
.\nord-cli.ps1 status|connect|disconnect              # 手动控制 NordVPN(官方 CLI,零窗口秒级;冷启动自动回退 UIA)
.\nord-ctl.ps1 status|connect|disconnect              # 旧 UIA 引擎(备用/冷启动兜底)
.\egress-vpngate.ps1 status|connect|disconnect|list  # VPN Gate 免费出口(零账号零安装;list 看服务器;重连自动优先上次成功服务器)
.\net-back.ps1                                        # 一键回切:断开备用出口 → 探测家宽 → 不通自动连回
.\ip-check.ps1 [-Probe] [-Rebase]                     # 出口 IP 体检(对比基线 / 经网关真请求)
```

设计取舍:**固定使用同一个备用出口**作为应急通道,回切保持手动(`net-back.ps1` 带防呆);不做节点自动轮换,避免频繁换 IP 招风控。

## 与 CC Switch 配合

在 CC Switch 里添加**自定义供应商**(无需本地路由转换,直连三协议)。

### Claude Code

| 字段 | 值 |
|---|---|
| API 端点 (base_url) | `http://127.0.0.1:8317`(不要带 `/v1`) |
| 上游格式 | **Anthropic Messages(原生)** |
| API Key | 本机直连:任意非空值(不校验);从隧道/局域网访问时必须填口令(见「共享给朋友」) |
| 模型 | 任意(如 `claude-sonnet-5`):免费模型名直用,`haiku` / `sonnet` / `opus` 等按「免费模型」章节的槽位表对齐,其余落排名第一 |

手工配置等价于:`ANTHROPIC_BASE_URL=http://127.0.0.1:8317`、`ANTHROPIC_AUTH_TOKEN=local`;想让 `/model` 的 sonnet/opus/haiku 与后台任务分别落到排名靠前的不同模型,把「免费模型」章节的槽位环境变量片段填上(不填也能用,网关有槽位兜底)。

### Codex

| 字段 | 值 |
|---|---|
| base_url | `http://127.0.0.1:8317/v1` |
| 上游格式 | **Responses(native)** |
| Model | 任意(如 `gpt-5.6-sol`),实际由网关路由到默认模型 |

手工配置等价于 `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "ccgw"

[model_providers.ccgw]
name = "ccgw"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
```

### Claude Desktop

同 Claude Code:指向 `http://127.0.0.1:8317` 的 Anthropic Messages 兼容端点。

### 一键导入深链

```powershell
node make-ccswitch-links.mjs   # 生成 ccswitch-links.txt(Claude Code / Codex 导入深链)
```

### 其他 OpenAI SDK 客户端

`base_url = http://127.0.0.1:8317/v1`,key 任意。

### 共享给朋友(零客户端安装 + 免费公网地址)

网关可同时给多台设备/朋友使用,他们不需要安装任何东西——在任意支持自定义 API 地址的工具(或纯 curl / SDK)里填 **地址 + 口令** 即可。账户轮换、全池限流自动切出口(WARP)等机制对所有请求一视同仁。

- 公网入口 = 两条免费隧道并存(都转发本地 `http://127.0.0.1:8317`,同一口令):

  | 隧道 | 地址 | 说明 |
  |---|---|---|
  | **ngrok 固定域名**(推荐发给朋友) | **`https://bronco-rewrap-january.ngrok-free.dev`** | 永久不变;计划任务 `ccgw-tunnel-ngrok`(随登录自启);免费额度 2 万请求/月、1 GB 流量/月 |
  | cloudflared 快速隧道(备用) | `zero-window\tunnel.log` 里的 `https://<随机名>.trycloudflare.com` | 免账号但重启后会换址;计划任务 `ccgw-tunnel` |

  ngrok 固定域名的等价命令(运行器是 `zero-window\tunnel-ngrok.vbs`,机器本地生成、不入库):

  ```powershell
  ngrok http 8317 --url https://bronco-rewrap-january.ngrok-free.dev --log zero-window\ngrok-tunnel.log
  ```

  > ngrok 免费版的域名注册时由系统分配(`*.ngrok-free.dev`,不可自定义);浏览器直接访问会先看到 ngrok 提示页,API/SDK/curl 客户端不受影响。
- 口令:随机串写在 `zero-window\gateway.vbs` 的 `CCGW_TOKEN`(见「环境变量」;本机客户端不受影响)。
- 朋友端示例(把 `<url>`、`<token>` 换成实际值):

  ```bash
  curl <url>/v1/messages \
    -H "content-type: application/json" -H "x-api-key: <token>" \
    -d '{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
  ```

  OpenAI 风格把路径换成 `/v1/chat/completions`(或 `/v1/responses`);认证支持 `x-api-key: <token>`、`Authorization: Bearer <token>`、Basic `opencode:<token>`。
- 额度共享:所有人吃同一个免费账户池;单账户限流自动绕开,全池限流时守卫自动切出口(WARP);任意模型名自动解析——`haiku` / `sonnet` / `opus` 等槽位名按槽位表对齐,其余(含付费名/占位名)落排名第一——见「免费模型:自动发现 + 排名 + 选优(模型槽位按需填充)」;建议朋友照着该章节把 Claude Code 各模型槽位填好。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages(含 `?beta=true`、流式、工具) |
| POST | `/v1/messages/count_tokens` | 本地估算(Claude Code 会用) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions(流式、工具) |
| POST | `/v1/responses` | OpenAI Responses / Codex(流式、函数调用) |
| GET | `/v1/models` | 免费模型列表,按排名顺序;每条带 `ccgw_rank` 排名与 `ccgw_input` 输入能力(带 `anthropic-version` 头返回 Anthropic 形状,否则 OpenAI 形状) |
| GET | `/health` | 状态 + 账户池(连接/冷却/登录身份)+ `pool` 全池限流信号 + 模型目录 + `freeRanked` 免费模型排名(每条含 rank/输入能力/上下文)+ `modelSlots` 槽位映射 + `defaultModel` / `modelPin` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCGW_PORT` | `8317` | 监听端口 |
| `CCGW_HOST` | `127.0.0.1` | 监听地址(仅本机) |
| `CCGW_MODEL` | 空(自动) | 固定模型 pin(可选,须在免费列表内)。空 = 自动:槽位名走槽位映射、其余用排名第一的免费模型;设置后作为"兜底默认"(槽位匹配仍优先) |
| `CCGW_TOKEN` | 空 | 访问口令。本机直连(回环、无转发头)免校验;隧道/局域网等远端来源必须带 `Authorization: Bearer <token>` 或 `x-api-key: <token>`(或 Basic `opencode:<token>`) |
| `CCGW_SCRATCH` | `%TEMP%\ccgw-scratch` | 会话 location / 桥接注册目录(被清理后自动重建) |
| `CCGW_MAX_CONCURRENCY` | `3` | 并发回合上限(排队) |
| `CCGW_TURN_TIMEOUT` | `180000` | 单回合超时(ms) |
| `CCGW_LOG` | `ccgw/ccgw.log` | JSONL 日志路径 |
| `CCGW_KEEP_SESSIONS` | 空 | `1` = 不删除 OpenCode 会话(调试用) |
| `CCGW_OPENCODE_URL` | 自动发现 | 强制指定 OpenCode 服务地址 |
| `CCGW_SERVICE_FILE` | `~/.config/opencode/service.json` | 密码文件路径(配 `CCGW_OPENCODE_URL` 可固定指向任意服务) |
| `CCGW_ACCOUNTS_FILE` | 空 | 账户池配置(accounts.json);文件存在时启用多账户轮询 | 
| `CCGW_COOLDOWN_SECONDS` | `300` | 命中限流后该账户的冷却时长(秒) |
| `CCGW_DOWN_COOLDOWN_SECONDS` | `30` | 账户实例失联后的冷却时长(秒) |

## 验证与日志

- `node smoke1.mjs` — 引擎冒烟(文本回合 + 工具捕获/中断)。
- `node test-formats.mjs [anthropic|openai|responses|real]` — 全链路验收:三协议 ×(非流式 / 流式 / 工具往返),外加 `real` 组:模拟客户端**真实读取文件、真实执行命令**(输出含一次性 token,最终回答必须包含它们)。
- `node test-ranking.mjs` — 免费模型识别 / 排名 / 自动选优自检。
- `node verify-live.mjs` — 对运行中的网关做健康 + 文本 + 工具往返快速验证。
- `ccgw.log` — 每请求一行 JSON,路由证明 = `sessionID`(可在 OpenCode 桌面版里打开对应会话)。

## 工作原理

1. 解析客户端请求 → 规范化(canonical)消息 + 工具定义;模型名解析:免费模型直用,未知 / 付费 / `auto` → 排名第一的免费模型。
2. 若有工具:生成唯一桥接名 `gw<随机>` 与清单文件,`PUT /api/experimental/mcp/<name>` 注册 stdio MCP 桥接(`codemode:false`,工具直接暴露);等待其 `connected` 且位置工具目录完成重建(`command.updated` 事件)——这是"工具找不到"问题的根因修复。
3. 创建一次性 OpenCode 会话:权限 `[deny *, allow read, allow <bridge>_*]`。
4. 把系统提示 + 历史(含既往工具调用/结果,工具名改写为当前桥接名)渲染为单个提示,`POST /api/session/<id>/prompt`。
5. 订阅 `/api/event`:文本增量实时转发;捕获 `tool.input.started/ended` + `tool.called`(按 `id` 关联工具名);模型流完该步后宽限 350ms 再 `POST /interrupt`,把工具调用按客户端方言回给客户端。桥接进程对 `tools/call` 永远挂起,直到回合被中断。
6. 客户端执行工具 → 结果在下次请求的历史中回到模型(新会话、重新注册桥接)。
7. 清理:注销桥接、删清单临时目录;会话按空闲时间定时清扫。

## 已知限制

- 依赖 OpenCode 的 `/api/experimental/*` 内部 API;OpenCode 大版本升级后接口可能变化,需跟进适配(已在 V2.0.30 桌面版与 `opencode-cli` v2.0.30 实测)。
- 推理内容可能混入文本;工具回合的 usage 常为 0。
- 免费层有速率限制,偶发 429/403 属正常。
- 最大输出 token 等采样控制由上游决定;网关按客户端兼容接受参数。

## 故障排查

| 症状 | 处理 |
|---|---|
| `/health` 显示 `eventStream:false` | OpenCode 服务未运行或刚重启;网关每秒自动重连,持续异常运行 `zero-window\start.cmd`(零窗口模式) |
| 工具调用失败/模型说工具不存在 | 多为桥接目录重建竞态;网关已等待 `command.updated`。若仍出现,查看日志中 `putBridge` 行 |
| 免费层 403 (fingerprint) | 不要 deny `read`;会话权限必须保留 `allow read` |
| 免费层 403 "can only be used from within OpenCode"(已登录也报) | 出口 IP 被上游标记(常见诱因:公共 VPN 出口);断开该 VPN / 回切家宽即恢复(`zero-window\net-back.ps1`;守卫也会自动清理残留的 `ccgw-vpngate` 连接)。与账户和授权无关 |
| **家宽 IP 本身被标记**(2026-10-18 实测) | 症状:WARP 断开、走家宽时,连**桌面版 OpenCode 自己**都报同一句 403;重连 WARP 后同一账号立即恢复 → 判定按 IP、与账户无关。本机家宽(曼谷 AIS)已被标记。**处置(应急)**:`zero-window\net-guard.backend` 写 `warp`,并让两个计划任务在跑——`ccgw-warp-guard`(每 10 分钟检查,掉线自动重连、永不主动断开)与 `ccgw-warp-login`(登录后 25 秒连一次)。**这只是止血**:WARP 是共享出口,可能偶发软限流,指纹迟早也会被刷出来;根治要独享出口(见上「出口后端」),并减少共享指纹(公网转发按需开、账户池按需扩) |
| 池里 3 个实例,但只登录了 1 个账号 | 正常:`total` 是实例数不是账号数;`accounts-status.ps1 -Live` 看每个实例的真实身份,未登录显示 `(anonymous / not logged in)`;`/health` 的 `pool.loggedIn` / `pool.anonymous` 是计数;同一账号登多个实例额度不叠加 |
| 频繁 429 / 额度打满 | 加账户分摊:`zero-window\add-account.ps1 -Name acct2` → `login-account.ps1 -Name acct2` → 重启网关;`/health` 里看 `accounts` |
| 全池限流但出口没自动切 | 查 `zero-window\net-guard.log`(每 ~10 分钟应有 heartbeat,没有说明守卫没在跑);确认没有 `net-guard.pause`、`/health` 里有 `pool` 字段;后端:装了 Nord 需已登录;没装 Nord 时 `auto` 默认不切换(需要免费出口就显式 `-Backend vpngate`,注意上方警示) |
| 修改配置后不生效 | 重启网关进程;客户端会话也要重开 |
| 想看执行细节 | 置 `CCGW_KEEP_SESSIONS=1` 后用 OpenCode 桌面版打开对应 `sessionID` |

## 2026-10-18：403 与限流分开处理

- `403 FreeTierError` 表示上游准入拒绝，不能据此认定账户额度耗尽。网关保留 403；不进行同一请求的账户轮换，也不设置 `pool.quotaExhausted`。
- `401`、`429`、`503` 保留原始状态；流式请求在已经发送的 HTTP 200 内使用协议错误事件。日志增加 `upstreamStatus`、`errorKind`、`errorCode`，不记录认证信息。
- 自动切换出口只影响网络，不等于修复上游准入。需要保持全机网络稳定时，在私有配置 `zero-window/net-guard.backend` 写入 `none`，并重启守卫。账户授权和网关密钥均不随此设置改变。
- 离线回归：`node --test test-errors.mjs`；排名回归：`node test-ranking.mjs`。`test-formats.mjs` 是真实上游验收；上游 403 时验收失败，不能把离线通过写成模型服务恢复。

## License

MIT © 2026 liyangru
