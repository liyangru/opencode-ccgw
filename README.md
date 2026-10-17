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
- **全池限流自动切出口**:所有账户同时被限流(IP 级限流信号)时,`net-guard` 自动把机器出口切到 NordVPN(官方 CLI 通道,零窗口、约 2 秒);一键 `net-back` 回切(需已安装登录 NordVPN,见下文)。
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

免费层额度按账户计算,单个账户容易被打满。ccgw 支持把请求分摊到多个 OpenCode 账户:每个账户跑**一个独立实例**(独立 profile + 独立端口 + 独立计划任务,互不共享登录态与会话库),网关侧做**轮询 + 冷却 + 自动重试**。

```powershell
# 1) 开通一个新账户实例(自动分配端口,创建隔离 profile 与计划任务)
powershell -ExecutionPolicy Bypass -File zero-window\add-account.ps1 -Name acct2

# 2) 浏览器登录该账户(一次性;--standalone 保证凭据写进它的隔离 profile)
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
- `GET /health` 的 `accounts` 数组显示每个账户的连接状态、冷却倒计时、最近错误与**登录身份**(`identity` / `credentialId`);日志每行带 `account` 字段;
- **识别"是不是新账号"**:登录会写入该账户的隔离 profile,`login-account.ps1` 会把身份(如 `OpenCode Console / Personal`)与 credential id 记入 `accounts.json`;同一账号重复登录 credential id 不变,新账号则不同。`zero-window\accounts-status.ps1` 查看全部账户(加 `-Live` 可从各隔离 profile 实时重读并刷新);
- 没有 `accounts.json` 时行为与单账户完全一致(向后兼容);删除该文件即可退回单账户;
- 限流究竟按账户还是按 IP/设备判定取决于上游:若按 IP,多账户收益有限——加好第二个账户后观察 `/health` 中的冷却记录即可验证。

## 全池限流 → 自动切换出口(NordVPN)

若免费层限额按 IP 判定,加账户救不回;**所有账户同时因限流冷却**就是这个信号。ccgw 把它暴露为 `/health` 的 `pool` 对象(`total` / `cooling` / `quotaExhausted`),`zero-window\net-guard.ps1` 常驻监听并自动切换:

- `quotaExhausted:true` 且 Nord 未连接 → 自动连上 NordVPN(调用 NordVPN.exe 官方 CLI,参数经应用单实例管道转发)→ 等待隧道就绪 → 客户端重试即恢复出量;
- **全程静默**:首选官方 CLI 通道——不创建窗口、不弹前台、不抢焦点;仅当应用进程被完全退出时回退旧的 UIA 引擎(窗口在屏幕外材料化后立即隐藏,可能闪现 <1 秒);守卫进程本身也无窗口(net-guard.vbs 启动);
- 已在 Nord 上仍显示全池限流 → 日志提醒"Nord 出口可能也被限,可换个节点"(不自动换节点,避免频繁换 IP);
- 平时零动作。暂停:`zero-window` 下建 `net-guard.pause`;日志:`zero-window\net-guard.log`(每 ~10 分钟一行 heartbeat,可判断守卫存活);切换时弹系统通知:建文件 `net-guard.toast`(默认关);自启:`setup.ps1` 检测到 NordVPN 时注册 `net-guard.vbs`(计划任务;无管理员权限时退回注册表 Run 键)。

配套命令(均在 `zero-window\`):

```powershell
.\nord-cli.ps1 status|connect|disconnect   # 手动控制 NordVPN(官方 CLI,零窗口秒级;冷启动自动回退 UIA)
.\nord-ctl.ps1 status|connect|disconnect   # 旧 UIA 引擎(备用/冷启动兜底)
.\net-back.ps1                             # 一键回切:断开 Nord → 探测家宽 → 不通自动连回
.\ip-check.ps1 [-Probe] [-Rebase]          # 出口 IP 体检(对比基线 / 经网关真请求)
```

设计取舍:**固定使用同一个 Nord 出口**作为应急通道,回切保持手动(`net-back.ps1` 带防呆);不做节点自动轮换,避免频繁换 IP 招风控。

## 与 CC Switch 配合

在 CC Switch 里添加**自定义供应商**(无需本地路由转换,直连三协议)。

### Claude Code

| 字段 | 值 |
|---|---|
| API 端点 (base_url) | `http://127.0.0.1:8317`(不要带 `/v1`) |
| 上游格式 | **Anthropic Messages(原生)** |
| API Key | 任意非空值(网关默认不校验) |
| 模型 | 任意名字(如 `claude-sonnet-5`);不匹配免费模型 ID 时自动路由到默认模型 |

手工配置等价于:`ANTHROPIC_BASE_URL=http://127.0.0.1:8317`、`ANTHROPIC_AUTH_TOKEN=local`。

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

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages(含 `?beta=true`、流式、工具) |
| POST | `/v1/messages/count_tokens` | 本地估算(Claude Code 会用) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions(流式、工具) |
| POST | `/v1/responses` | OpenAI Responses / Codex(流式、函数调用) |
| GET | `/v1/models` | 免费模型列表(带 `anthropic-version` 头返回 Anthropic 形状,否则 OpenAI 形状) |
| GET | `/health` | 状态 + 账户池(连接/冷却/登录身份)+ `pool` 全池限流信号 + 模型列表 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCGW_PORT` | `8317` | 监听端口 |
| `CCGW_HOST` | `127.0.0.1` | 监听地址(仅本机) |
| `CCGW_MODEL` | `deepseek-v4.1-flash-free` | 默认模型(不匹配已知免费模型时使用) |
| `CCGW_TOKEN` | 空 | 设置后要求 `Authorization: Bearer <token>` 或 `x-api-key` |
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
- `node verify-live.mjs` — 对运行中的网关做健康 + 文本 + 工具往返快速验证。
- `ccgw.log` — 每请求一行 JSON,路由证明 = `sessionID`(可在 OpenCode 桌面版里打开对应会话)。

## 工作原理

1. 解析客户端请求 → 规范化(canonical)消息 + 工具定义。
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
| 频繁 429 / 额度打满 | 加账户分摊:`zero-window\add-account.ps1 -Name acct2` → `login-account.ps1 -Name acct2` → 重启网关;`/health` 里看 `accounts` |
| 全池限流但出口没自动切 Nord | 查 `zero-window\net-guard.log`(每 ~10 分钟应有 heartbeat,没有说明守卫没在跑);确认 NordVPN 已安装并登录、没有 `net-guard.pause`、`/health` 里有 `pool` 字段 |
| 修改配置后不生效 | 重启网关进程;客户端会话也要重开 |
| 想看执行细节 | 置 `CCGW_KEEP_SESSIONS=1` 后用 OpenCode 桌面版打开对应 `sessionID` |

## License

MIT © 2026 liyangru
