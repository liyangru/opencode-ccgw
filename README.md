> 本机当前用途（2026-10-18）：ccgw 用于 Claude/Codex；OpenCode 桌面端保持官方原生连接，不接入本机 ccgw。详见 [客户端分离记录](CLIENT_BOUNDARIES.md)。

# ccgw — OpenCode 本机转接网关

把 [OpenCode](https://opencode.ai)(桌面版后台服务,或无头 `opencode-cli serve`)变成一个 **Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三协议兼容**的本机 API 网关。

每个请求都作为一次**真实的 OpenCode 会话**执行(日志中可查 `sessionID`),客户端自带的工具(Read/Bash/Edit/...)通过**临时 MCP 桥接**获得**真实工具往返**——与 Claude Code / Codex / Claude Desktop 原生体验一致(含单回合多工具调用)。

适用场景:配合供应商切换器(如 [CC Switch](https://cc-switch.org))把 OpenCode 原生 provider 中的**免费模型**接给 Claude Code、Codex、Claude Desktop 等客户端使用。其他已配置 provider 的模型不会混入此网关目录。

> 灵感来自 [opencode-llm-proxy](https://github.com/KochC/opencode-llm-proxy)(OpenCode 插件形态)。ccgw 采用**独立进程**形态,直接对话 OpenCode V2 HTTP API,因此支持**无头 / 零窗口**运行、可在桌面版关闭时继续服务。

## 特性

- **三协议**:Anthropic Messages、OpenAI Chat Completions、OpenAI Responses(含流式与工具)。
- **真实工具往返**:动态注册 stdio MCP 桥接 → 捕获模型发起的工具调用 → 中断回合 → 把调用按客户端方言返回;工具结果随下一次请求回到模型。支持**并行工具调用**。
- **真实会话**:每次请求 = 一次真实 OpenCode 会话;空闲会话按 `sessionID` 定时清扫。
- **请求输出预算**:三种协议的输出 token 上限传入受管会话,由网关专用 `budget-plugin` 的 OpenCode 原生 hook 设置模型调用上限;插件未激活时返回 503,不静默忽略预算。
- **输入边界**:支持文本、工具调用与**内嵌图片**(PNG/JPEG/WebP/GIF,上限 20 张且解码后合计 15MB;仅 `data:` 内嵌)。音频、视频、PDF 与远程图片网址/本地路径明确返回 400,不静默丢弃。
- **免费模型路由**:不匹配已知免费模型 ID 的模型名自动路由到默认模型(可用 `CCGW_MODEL` 配置)。
- **零窗口模式**:登录自动启动(两个计划任务),无任何窗口;可完全不开桌面版使用。
- **多账户账户池**:一账户一隔离实例(独立 profile / 端口 / 计划任务),网关轮询分摊请求,命中限流自动冷却并换户重试(见下文)。
- **全池限流 / 整链国家限制自动换 Nord 节点(2026-10-19 用户授权)**:某模型在全部账户上同时 429、403 准入拒绝在 10 分钟内重复 3 次,或**整条模型降级链都被 `This model is not available in your country` 拒绝**时,网关按 `zero-window\nord-rotate.groups` 的顺序换 Nord 国家节点,清空本地限流冷却,并在同一请求内用新出口重试一次(整链重放)。单个模型被国家限制只降到下一个模型、不换节点;链尾是认证/参数错误也不换。实测换节点后同一账户同一模型立即 200(原冷却未到期),说明限流与出口 IP 绑定。护栏:最短 120 秒、每小时最多 6 次,状态写 `nord-rotate.state.json`;`CCGW_NORD_ROTATE=off` 关闭。
- **net-guard 兜底**:`net-guard`(backend=nord)在全池限流持续超过 6 分钟时也换节点,但网关 5 分钟内刚换过就让路;其它后端按已有配置处理。可通过 `net-guard.pause` 暂停自动切换,一键 `net-back` 回切(见下文)。
- **备用出口保活**:`warp-guard`(计划任务 `ccgw-warp-guard`,登录时 + 每 ~10 分钟,`wscript` 无窗口)只在 WARP 掉线时自动重连,**永不主动断开**;暂停:`warp-guard.pause`。回切家宽仍是手动动作。网络切换只是止血,不等同于额度恢复。
- **上游出口优选 IPv6**:原生 OpenCode 后端的上游连接优先走本机原生 IPv6(失败自动回退 IPv4),仅作用于 `opencode.ai:443`、仅限本机回环且带认证;运行状态见 `/health.egress`。
- **CC Switch 深链生成**:一条命令生成 Claude Code / Codex 的一键导入链接。
- **最小权限会话**:`[deny *, allow read, allow <bridge>_*]`——只保留 `read` 与桥接工具。该权限配置不代表能通过上游免费层准入,也不能单独解释 403。
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
   OpenCode 原生 provider 的免费模型
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
- 多个实例在同一模型上都返回 429,只证实当前该模型的账户池受到限流,不证明上游按 IP、设备或账户中的哪一项统计。403 另按准入或权限拒绝处理,不据此判定额度耗尽。
- **实例 ≠ 账号**:`pool.total` / `pool.loggedIn` / `pool.anonymous` 分别是"实例数 / 已登录实例数 / 匿名实例数"——一个账号可以登录多个实例,**额度不会叠加**;未登录实例(如某个还没登录的新实例)以匿名身份承接请求,能分担并发但没有独立额度。要真正的多账户摊薄,每个实例必须登录**不同的账号**——看 `pool.distinctAccounts`(按 `email` 去重的账号数)。

## 免费模型:自动发现 + 排名 + 选优(模型槽位按需填充)

### 限流与重试

- 429 按“账户 + 模型”记录冷却；一个模型限流不阻止同一账户使用其他模型，也不会因其他模型成功而清除冷却。
- 优先遵守上游 `Retry-After`；没有提示时使用本地退避（默认 300 秒，连续失败递增，默认上限 1800 秒）。这是网关的重试间隔，不是官方额度重置时间。
- 所有候选都在冷却时，返回 429 / 503 和 `Retry-After`，不会继续请求冷却中的实例。网络故障的冷却仍适用于该实例的所有模型。
- 并发请求中，迟到的成功不能清除新产生的冷却，较短的限流提示不能缩短已有截止时间。
- 冷却截止时间与失败次数保存到 `CCGW_STATE_FILE`（默认仓库目录的 `.ccgw-state.json`）；重启后恢复尚未过期且账户作用域匹配的记录，重启不会清空冷却。状态文件不包含凭据、提示词或上游响应正文，不应复制到其他部署。
- 网关专用插件通过原生 `retry` hook 关闭受管会话的 OpenCode 重复重试，由网关控制有界重试；普通 OpenCode 会话不受影响。
- 流式响应在首个非空内容到达后才发送 SSE 头；此前的错误保留真实 HTTP 状态。已经开始输出的请求不会换账户重放。
- `/health` 的 `pool.limitedModels` 和账户的 `modelCooldowns` 提供分模型状态；只有所有已知免费模型在全池均被限流时才发出全池信号。这不能证明限制按 IP 统计。
- `/health` 可达、事件流已连接或 `quotaExhausted:false` 均不代表模型调用成功或额度充足；额度与准入须以实际请求结果确认。

回归验证：`node --test test-errors.mjs`（本地 HTTP/SSE 模拟，不消耗上游额度）。

#### 出口 IP 与 Nord 节点轮换(2026-10-19 实测)

- 触发条件:某模型在**全部账户**上同时 429(池内该模型已无可用账户),或准入拒绝(`FreeTierError` / `not available in your country`)在 10 分钟内出现 3 次。单账户限流不触发。
- 动作:调用 `node zero-window\nord-cli.ps1 rotate` → 断开当前 Nord 节点 → 按 `zero-window\nord-rotate.groups` 的顺序连接下一个国家(实测每组约 7–25 秒)→ 输出 `rotate: OK group=<国家> ip=<出口 IP>`。
- 换节点成功后清空**模型级**限流冷却(它们记录在旧出口 IP 上),保留实例失联类的冷却;当前请求会用新出口对同一模型重试一次(先等 2 秒让隧道稳定),客户端看到的是成功而不是 429。
- 护栏:最短间隔 `CCGW_NORD_MIN_INTERVAL_SEC`(默认 120 秒);`CCGW_NORD_MAX_PER_HOUR`(默认 6 次/小时,只统计成功轮换);`CCGW_NORD_ROTATE=off` 整体关闭;`=stub` 为测试模式(只记录、不动网络)。审计状态在 `ccgw\nord-rotate.state.json`,事件日志 `phase:"nord-rotate"`。
- 不打断进行中的回合:换节点前先等**其他正在跑的请求**结束(最多 `CCGW_NORD_DRAIN_MS`,默认 15 秒)。Nord 一断开会连带掐断所有复用隧道的连接,所以超时就先不换(当前请求按 429/降级继续),等下一个请求再试;新请求遇到正在轮换也会等它落定再连上游。
- 国家可用性(同一免费池实测):韩国、美国四槽全通;香港对部分模型返回 `This model is not available in your country`;荷兰曾遇 `Endpoint is unavailable`(上游瞬时)。默认顺序已把实测可用的国家排在前面,可直接编辑 `nord-rotate.groups` 调整。
- 手动操作:`node nord-rotate.mjs`(遵守护栏)、`node nord-rotate.mjs --dry-run`(只看决策)、`node nord-rotate.mjs --force`(忽略护栏)、`.\zero-window\nord-cli.ps1 status|rotate`。

网关仅从账户实例实时目录的 **`providerID = opencode` 原生 provider** 中识别已启用的免费模型——判据取自上游元数据本身(`cost = 0/0`,或名字带 `-free` 后缀;`big-pickle` 这类无后缀的免费模型也能自动认出)。本次原生免费目录为 10 个模型;其他本地 provider（包括指回网关的 provider）不参与发现与路由。免费列表按仓库根目录的 `model-ranks.json` 从强到弱排序,新出现的免费模型自动补到列表尾部(无需改代码;该文件热生效,约一分钟内刷新)。目录条目和免费标记不保证当前账户能成功调用。

**默认排名(2026-10-18 逐模型实测修订:**按能力分档,同档按速度**;前四即全部可用槽位):**

| # | 模型 | 识图 | 实测延迟 | 说明 |
|---|---|---|---|---|
| 1 | `glm-5.3-flash-free` | ✅ 3/3 正确 | ~1.65s | **识图最快且最准**;上游间歇(`Endpoint is unavailable`),网关沿排名自动降级 |
| 2 | `nemotron-3.5-super-vl-free` | ✅ 3/3 正确 | ~1–18s 波动大 | 视觉语言模型;1M 上下文;延迟不稳(同模型实测 1.1s / 18.4s) |
| 3 | `mimo-v2.6-flash-free` | ✅ 能收图 | ~3.2s | 目录唯一标音频的模型 |
| 4 | `deepseek-v4.1-flash-free` | ⚠️ 收图但答错 | ~2.2–7.3s | 纯红图答成 Orange/White/White,识图不可信;编码/代理任务仍稳 → 因此占 `sonnet` 槽而非视觉槽 |
| 5 | `beam-free` | ❌ 明确拒绝 | **~0.69s** | 纯文本最快;复杂推理/工具调用正确 |
| 6 | `space-bunny-free` | ❌ 明确拒绝 | ~1.09s | 1M 上下文;限流较敏感 |
| 7 | `jev-1.13-free` | ❌ 明确拒绝 | ~2.26s | — |
| 8 | `nemotron-3-ultra-free` | ❌ 明确拒绝 | ~2.22s | 550B;1M 上下文 |
| 9 | `longcat-2.5-preview-free` | ❌ 明确拒绝 | ~3.56s | 目录称图像理解,实测不收 |
| 10 | `big-pickle` | ❌ 明确拒绝 | ~7.20s | 经典隐形免费模型 |
| 11 | `nemotron-3.5-lightning-free` | ❌ 明确拒绝 | ~12.29s | 名字带 lightning 却实测最慢之一 |

> **前四名 = 四个槽位的来源**(见下节)。排名口径是"按能力":能识图的模型排前,纯文本的排后;延迟只作同档内的次序依据。理由是前四名若全是不收图的纯文本模型,视觉类请求就没有合格落点。
>
> **识图能力是实测出来的,不是目录说的**。目录不提供输入型元数据;2026-10-18 给每个模型发了一张真实 4×4 纯红 PNG(用 1×1 PNG 会被上游判"无法解码",别用它当样本):
> - `glm` / `nemotron-3.5-super-vl` / `mimo` 收图且答对(Red);
> - `beam` / `space-bunny` / `jev` / `nemotron-3-ultra` / `longcat` / `big-pickle` / `nemotron-3.5-lightning` 明确拒绝;
> - **`deepseek` 收图但答错**:同一张红图三次答 Orange / White / White。它仍按"能收图"排在第 4(排名看输入能力),但**绝不能当视觉模型用**——这是它占 `sonnet` 槽而不是视觉槽的原因。
>
> 同日实测不可用并已移出排名:`muse-spark-1.3-contributor-free`、`cat-jam-free`(`Model unavailable`)、`ll-alpha-free`(`deprecated`)。它们仍会被自动发现追加在末尾,但不应被显式指定。

表中"输入能力"来自上游目录元数据。本桥接当前已转发**内嵌图片**(PNG/JPEG/WebP/GIF,见「已知限制」);视频、PDF、音频与远程图片网址仍未接入,发来会得到 400。不能把文本回答当作模型已读取附件。表中的速度为既有观测,不承诺当前延迟。

**模型槽位(Claude Code 这类"多个模型槽"的客户端)**:`model-ranks.json` 的 `slots` 把槽位名映射到免费模型——客户端即使发来硬编码名(如 `claude-haiku-4-5-20251001`)也会被路由到对应槽位的模型:

| 槽位 | 请求名匹配 | 当前指向 | 含义 |
|---|---|---|---|
| `opus` | 含 `opus` / `fable` | #1 `glm-5.3-flash-free` | 最强档 → 识图最准最快 |
| `sonnet` | 含 `sonnet` | #4 `deepseek-v4.1-flash-free` | 编码/代理主力 → 任务最稳;识图不可信所以不占视觉槽 |
| `haiku` | 含 `haiku` | #3 `mimo-v2.6-flash-free` | 小/快槽 + 后台任务(标题、摘要)→ ~3.2 秒 |
| `vision` | 恰为 `vision` / `image` / `vl` | #2 `nemotron-3.5-super-vl-free` | 视觉入口 → 识图 3/3 正确;1M 上下文 |

> **四个槽位全部取自"按能力"排定的前四名**(#1–#4),不再为了延迟把纯文本模型塞进某槽。代价说清楚:`haiku` 槽由 `space-bunny`(~1.09s)换成 `mimo`(~3.2s),后台任务(标题、摘要)会慢约 3 倍。若后台延迟优先,可把 `haiku` 指回 `space-bunny`,代价是该槽不再是识图模型。
>
> `deepseek` 占 `sonnet` 而非视觉槽:它确实能收图,但同一张纯红图三次答 Orange / White / White,识图不可信。任务是它的强项(编码/代理最稳),所以放主力槽。
>
> 2026-10-18 修订:`sonnet` / `haiku` / `vision` 原先全部指向 `glm-5.3-flash-free`,该模型上游持续不可用,三个槽位因此同时失效。

槽位目标必须是免费模型。槽位指向的模型上游拒绝时会**沿着排名依次降级**,最多试到链尾(见下节),不再直接落回排名第一。改排名或槽位都只改 `model-ranks.json`(热生效)。

**带图请求的槽位改道(2026-10-19 新增)**:请求里带内嵌图片、而槽位解析到的模型**识图不可信**时(目前只有 `sonnet` → `deepseek`),网关自动改用 `vision` 槽;显式指名具体模型的请求仍然照用不替换。可信识图模型写在 `model-ranks.json` 的 `visionTrusted`(当前 `glm` / `nemotron-3.5-super-vl` / `mimo`)。实测:真实 Claude Code 用 `--model sonnet` 读纯红图,文本轮次仍走 `deepseek`,带图那一轮落到 `nemotron-3.5-super-vl`,答 `Red`。没有这条规则时,每次截图都会被 `deepseek` 答成 Orange/White。

**模型级降级(2026-10-18 新增)**:某个上游模型拒绝请求时(如 glm 间歇性的 `Endpoint is unavailable`),网关会沿排名取下一个模型重试,而不是直接失败。规则:

- 只降级 **上游模型拒绝**(`kind === "upstream"`)。**429 是账户+模型的额度冷却,403 是准入/指纹闸门,两者都按设计终止本次请求,不换模型**——换模型治不了这两类问题。
- 只在**尚未开始向客户端吐字节**时降级;流一旦开始就不再换模型。
- 客户端**显式指名**的模型绝不替换(只尝试该模型本身)。
- 带图片的请求只在“确实能识图”的模型之间降级,不会落到收不了图的纯文本模型上;链尾还会排除**识图实测错误**的模型(`deepseek`),只保留 `visionTrusted` 里的模型。显式指名且能收图的模型作为第一跳保留,但不参与后续降级。
- 也该机制由 `ranking.mjs` 的 `fallbackChain()` 构造、`server.mjs` 的账户/模型双层循环消费;`node test-model-fallback.mjs` 与 `test-ranking.mjs` 覆盖链构造与控制流。

**Claude Code 把各槽位直接按排名填好**(环境变量;填好后 `/model` 的 opus/sonnet/haiku 与后台任务各就各位):

```bash
export ANTHROPIC_BASE_URL="https://bronco-rewrap-january.ngrok-free.dev"   # 本机直连改成 http://127.0.0.1:8317
export ANTHROPIC_AUTH_TOKEN="<口令>"                                       # 本机直连可填任意非空值
export ANTHROPIC_MODEL="glm-5.3-flash-free"                    # 默认会话 → 能力 #1(识图最准,上游若拒则自动降级)
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.3-flash-free"       # opus 槽 → 能力 #1
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4.1-flash-free"    # sonnet 槽 → 能力 #4(编码/代理最稳)
export ANTHROPIC_DEFAULT_HAIKU_MODEL="mimo-v2.6-flash-free"    # haiku 槽 + 后台任务 → 能力 #3,~3.2 秒
export CLAUDE_CODE_SUBAGENT_MODEL="beam-free"                  # 子代理 → 纯文本最快 ~0.69 秒(能力 #5)
export API_TIMEOUT_MS=600000                                       # 大模型首字较慢,放宽超时
```

> Windows 上 `export X="v"` 换成 PowerShell 的 `$env:X="v"`(或 cmd 的 `set X=v`)。这些变量**不设也照样能用**:网关的槽位兜底会把 Claude 硬编码的模型名按上表自动路由;若版本还有 `ANTHROPIC_DEFAULT_FABLE_MODEL` 槽位,fable 默认归入 opus 槽。

- **自动选优**:请求名只要是免费模型就直接用;**槽位名**按上表对齐;**未知 / 付费目录 / 占位名**(如 `claude-sonnet-5-5`、空)落到排名第一——不会再出现"付费名透传 → 免费号必然报错 → 账号误冷却"的连锁;别名 `auto` / `best` / `best-free` / `ccgw-auto` / `free-auto` 等价于"用第一"。
- `GET /v1/models` 只列原生 provider 的**免费模型**(按排名顺序),每条带 `ccgw_rank`(排名)与 `ccgw_input`(桥接输入能力,与 `/health.freeRanked` 的 `bridgeInput` 同源),客户端模型选择器不混入其他 provider 或付费目录。
- `GET /health` 的 `freeRanked` = 当前完整排名(每条含 `rank` / `id` / `name` / `input` / `bridgeInput` / `context`;`input` 保留上游目录能力,`bridgeInput` 表示当前桥接输入),另有 `modelSlots`(槽位映射)/ `defaultModel` / `modelPin`;每次请求日志带 `model` + `modelSource`(`requested` / `slot:<槽位>` / `alias` / `not-free` / `top-free` / `default` / `static`)。
- 想固定模型:`CCGW_MODEL=deepseek-v4.1-flash-free`(须在免费列表内;它只影响"兜底用哪个",槽位匹配优先);自检:`node test-ranking.mjs && node test-model-fallback.mjs`。

## 可选网络守卫与手动备用出口

`/health` 的 `pool` 对象提供实例、身份与冷却计数。`limitedModels` 表示在所有账户均有本地限流记录的模型;只有全部已知免费模型都符合这一条件,`quotaExhausted` 才为 true。这些状态不证明 IP 限流策略。已有 `zero-window\net-guard.ps1` 可监听此信号并按本机配置处理备用出口,但连接成功后仍须实际调用确认,不能承诺解除 403 或恢复额度。

**出口后端**(`net-guard.ps1 -Backend` 参数,或本机文件 `zero-window\net-guard.backend` 写 `warp` / `nord` / `vpngate` / `none`;`auto` 根据已有安装选择 WARP 或 Nord,都没有则不自动切换):

| 后端 | 账号 / 安装 | 说明 |
|---|---|---|
| `warp` | **零账号、零登录**(匿名设备注册) | [Cloudflare WARP](https://1.1.1.1/);2026-10-17 曾记录经网关调用成功,属于当时的网络观测,不保证后续可用或额度变化 |
| `nord` | 需已登录的 NordVPN | 官方 CLI 通道,零窗口秒级(见 `nord-cli.ps1`) |
| `vpngate` | **零账号、零安装** | [VPN Gate](https://www.vpngate.net/)(筑波大学公共 VPN);历史测试中出现过 403,原因未被上游确认,保留为手动网络工具 |
| `none` | 无 | 只监听并写日志提示(WARP / Nord 都没装时 `auto` 的默认值) |

- 启用守卫时,`quotaExhausted:true` 可触发既有备用出口逻辑;守卫改变的是网络连接,实际请求仍可能失败;
- **全程静默**:Nord 走官方 CLI(仅当应用进程被完全退出时回退 UIA 冷启动);WARP 走 `warp-cli`;VPN Gate 走系统拨号——都不创建窗口、不弹前台;守卫进程本身也无窗口(net-guard.vbs 启动);
- 已在备用出口上仍显示全池限流时,按 `Retry-After` 与持久化冷却等待,不通过反复换节点、重启网关或重试来推断额度恢复;
- 平时零动作。暂停:`zero-window` 下建 `net-guard.pause`;日志:`zero-window\net-guard.log`(每 ~10 分钟一行 heartbeat,可判断守卫存活);切换时弹系统通知:建文件 `net-guard.toast`(默认关);自启:`setup.ps1` 检测到 NordVPN 时注册 `net-guard.vbs`(计划任务;无管理员权限时退回注册表 Run 键)。WARP / Nord 都没装时 `auto` 不切换(VPN Gate 仍可显式 `-Backend vpngate`,注意上方警示)。
- **残留自愈**:守卫每轮都检查 `ccgw-vpngate`——当前后端不是 `vpngate` 时,若发现它仍连着,判定为测试/手动残留,自动断开并记日志(`stale egress cleanup`);**`net-guard.pause` 暂停期间同样生效**,机器不会被静默留在公共出口上。
- **本次部署状态(2026-10-18)**:备用出口 = WARP 且保持连接(`warp-guard` 掉线自动重连,原 `ccgw-warp-login` 已退役以免登录时闪窗);自动切网守卫已注册为计划任务 `ccgw-netguard`(无窗口),按 `zero-window\net-guard.backend`(现为 `warp`)在全池限流时处理出口;回切家宽仍是手动动作(`net-back.ps1`)。历史成功不代表 WARP 永久可用——共享出口仍可能被软限流。

> 历史记录包含 VPN Gate 下 403、其他网络条件下成功等现象;WorkBuddy 的网络 A/B 对照也支持网络条件与结果有关。这些观察不足以确认 IP 黑名单、排除账户因素,或认定四个账户及 ngrok 分享造成拒绝。不能据此承诺独享出口会根治问题或刷新免费额度。

配套命令(均在 `zero-window\`):

```powershell
.\nord-cli.ps1 status|connect|disconnect              # 手动控制 NordVPN(官方 CLI,零窗口秒级;冷启动自动回退 UIA)
.\nord-ctl.ps1 status|connect|disconnect              # 旧 UIA 引擎(备用/冷启动兜底)
.\egress-vpngate.ps1 status|connect|disconnect|list  # VPN Gate 免费出口(零账号零安装;list 看服务器;重连自动优先上次成功服务器)
.\net-back.ps1                                        # 一键回切:断开备用出口 → 探测家宽 → 不通自动连回
.\ip-check.ps1 [-Probe] [-Rebase]                     # 出口 IP 体检(对比基线 / 经网关真请求)
```

设计取舍:网络工具与模型调用验证分开,保留手动控制;不自动轮换节点。网络连通只能证明连通,不能证明模型准入或额度恢复。

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
| base_url(手工直连) | `http://127.0.0.1:8317/v1` |
| base_url(经 CC Switch) | `http://127.0.0.1:15721/v1` |
| 上游格式 | **Responses(native)** |
| Model | `auto`(或 `best-free`);写具体免费模型名会变成“显式指名”,失去模型级降级 |

**实测(2026-10-19):** `POST /v1/responses` 带 `Authorization: Bearer ccgw-local` 返回 200,`output_text = CODEX-OK`,ccgw 日志 `dialect=responses`。同一入口的 `/v1/chat/completions` 也返回 200。

手工配置等价于 `~/.codex/config.toml`:

```toml
model = "auto"
model_provider = "ccgw"

[model_providers.ccgw]
name = "ccgw"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
```

> 为什么推荐 `auto`:它解析为当前排名第一的免费模型(`source=alias`),并带上完整降级链;写成 `deepseek-v4.1-flash-free` 这类具体名字会得到 `source=requested`,上游报 `Model unavailable` 时不会换模型。

**CC Switch 实际接入(2026-10-19):** codex 的 `proxy_route` 已切到 `ccgwopencode-1792100388084`,`is_current=1`,provider 的 `model` 已固化为 `auto`。用 Codex 自带 CLI 真机验证:

```text
codex exec --skip-git-repo-check --sandbox read-only -C D:\Temp\opencode "Reply with exactly: CODEX-FINAL-OK"
→ CODEX-FINAL-OK (exit 0)
→ ccgw.log: dialect=responses requestedModel=auto model=glm-5.3-flash-free modelSource=alias stream=true tools=11 bridge=gw...
```

`tools=11` 说明 Codex 的工具定义也走了网关的 MCP 桥,不是纯文本降级。


### Claude Desktop

**实测结论(2026-10-19):** Claude Desktop 的「自定义模式」就是 `deploymentMode: "3p"`。它**不会**用 `ANTHROPIC_BASE_URL` 驱动桌面聊天界面——桌面聊天走托管下发的 `inference_provider` / `inference_base_url`,本机没有可写的 `managed-settings.json`。3p 会话的宿主回环 `127.0.0.1:15721` 只在 Code 标签页真正开会话时才绑定;`host-creds-*.json` 每次启动用新 UUID 重写、旧文件被清扫,所以**改 host-creds 不是持久注入点**。直接改配置指向 8317 这条路(a 方案)实测不可行。

可行路径是 **CC Switch 的 proxy 模式**(b 方案):CC Switch 监听 `127.0.0.1:15721`,按 `/claude-desktop` 路径转发到 ccgw,并由它写入 `host-creds` 的 `ANTHROPIC_BASE_URL` 与 `ccs-` 令牌。实测 `claude-opus-5` 经该路由到达 ccgw 后解析为 `slot:opus` → `glm`。

配置要点:

- `providers` 表里 `app_type = claude-desktop` 的 provider,其 `meta.claudeDesktopModelRoutes` 的每个 `model` 必须写成**别名本身**(`claude-opus-5 → claude-opus-5`)。写成具体免费模型名会被 ccgw 当成“显式指名”,从而跳过槽位与模型级降级。
- `app_type = claude`(Claude Code)的 provider 同理:`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 写别名,不要写死免费模型名。
- CC Switch 必须保持运行;它的本地代理(15721)停掉时,两个客户端都会 `ECONNREFUSED`。

**GUI 级实测(2026-10-19):** Code 标签页能正常渲染,并从 `%LOCALAPPDATA%\Claude-3p\configLibrary\<id>.json` 读到 `inferenceGatewayBaseUrl=http://127.0.0.1:15721/claude-desktop`。桌面端宿主回环在 `04:36:45` 发出 `claude-fable-5`,ccgw 日志记录 `modelSource=slot:opus → glm-5.3-flash-free`、`status:200 event-stream`,`main.log` 记 `Turn succeeded`。同一时刻界面可能显示 `Can't reach 127.0.0.1:15721`:这是桌面端自己的健康探针(一次真实推理请求,约 10 秒超时)在免费模型冷启动时超时,`main.log` 落 `not_testable`(不是 `unreachable`),成功一轮后自动清除。**判据以 ccgw 日志和 `cli_api_route_observed` 为准,不要以横幅为准**;CC Switch 的 `/claude-desktop/health` 是 404,但 `/claude-desktop/v1/messages` 带 `ccs-` 令牌返回 200。

### Claude Code 经 CC Switch(proxy 模式)

CC Switch 处于 proxy 模式时会**接管** `~/.claude/settings.json`:写入 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`、`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED` 和三个 `claude-*` 别名。此时客户端配置的 `env` 优先级高于进程环境变量,手工改环境变量不会生效——要改模型映射请改 CC Switch 里的 provider。direct 模式则由 CC Switch 直接把 provider 的 `settings_config.env` 写进 `~/.claude/settings.json`,指向 `8317`。

### 三端实测(2026-10-19,CC Switch 重启后)

| 客户端 | 真实请求 | 结果 | ccgw 日志 |
|---|---|---|---|
| Claude Code CLI | `claude -p "Reply with exactly: CLAUDE-CLI-OK"` | `CLAUDE-CLI-OK` | `dialect=anthropic`,`slot:opus` → glm |
| Claude Code 工具回合 | `claude -p "Use Bash ... echo CLAUDE-TOOL-OK"` | `CLAUDE-TOOL-OK .` | `toolCalls=Bash` → 结果回灌 → 文本 |
| Claude Desktop 宿主路由 | `POST 15721/claude-desktop/v1/messages` + `ccs-` 令牌 | `DESK-RESTART-OK` | `slot:opus` → glm |
| Claude Desktop 流式+工具 | 同上 + `stream:true` + `get_time` 工具 | `get_time {"city":"Seoul"}` | `toolCalls=get_time`,SSE 7 事件完整 |
| Codex CLI | `codex exec ... "Reply with exactly: CODEX-FINAL-OK"` | `CODEX-FINAL-OK` | `dialect=responses`,`auto` → glm,`tools=11` |
| Codex 工具回合 | `codex exec "Use shell ... echo CODEX-TOOL-OK"` | `CODEX-TOOL-OK` | `toolCalls=exec_command` → 结果回灌 → 文本 |

三者的共同前置:CC Switch `15721` 在监听,`live-state.json` 的 `claude` / `claude-desktop` / `codex` 三条 `proxy_route` 都指向 ccgw provider。


### 一键导入深链

```powershell
node make-ccswitch-links.mjs   # 生成 ccswitch-links.txt(Claude Code / Codex 导入深链)
```

### 其他 OpenAI SDK 客户端

`base_url = http://127.0.0.1:8317/v1`,key 任意。

### 共享给朋友(零客户端安装 + 免费公网地址)

网关可同时给多台设备/朋友使用,他们不需要安装任何东西——在任意支持自定义 API 地址的工具(或纯 curl / SDK)里填 **地址 + 口令** 即可。所有请求使用同一账户池和有界重试规则,分享不增加免费额度。

- 公网入口 = 两条免费隧道，**默认都不常驻**（都转发本地 `http://127.0.0.1:8317`，同一口令）。需要分享时再按需启动，用完即停：

  | 隧道 | 地址 | 说明 |
  |---|---|---|
  | **ngrok 固定域名**(推荐发给朋友) | **`https://bronco-rewrap-january.ngrok-free.dev`** | 永久不变;计划任务 `ccgw-tunnel-ngrok`(**现默认关闭**——公网转发会把所有外部请求的指纹记到本机出口;分享时才开:`Enable-ScheduledTask ccgw-tunnel-ngrok` 后 `Start-ScheduledTask ccgw-tunnel-ngrok`);免费额度 2 万请求/月、1 GB 流量/月 |
  | cloudflared 快速隧道(备用) | `zero-window\tunnel.ps1 -Action start` 输出的 `https://<随机名>.trycloudflare.com` | 免账号但每次启动换址;计划任务 `ccgw-tunnel` **已停用**(2026-10-19:旧快速隧道被上游回收后 `cloudflared` 只会无限重试 `Tunnel not found`，362 次错误/不停机)。用 `tunnel.ps1 start` 现取新址，`stop` 立即收回 |

  cloudflared 备用隧道的按需用法（脚本自带公网鉴权自检：匿名必须 401、带口令必须 200）：

  ```powershell
  .\ccgw\zero-window\tunnel.ps1 -Action start   # 新建隧道并打印 url，同时验证 401/200
  .\ccgw\zero-window\tunnel.ps1 -Action probe   # 复验当前 url
  .\ccgw\zero-window\tunnel.ps1 -Action clients # 看 cloudflared 指标：连接数/请求数/错误数
  .\ccgw\zero-window\tunnel.ps1 -Action stop    # 收回公网入口
  ```

  `clients` 读 `127.0.0.1:20241/metrics`（`cloudflared_tunnel_ha_connections` / `total_requests` / `request_errors`）。注意 `total_requests` 也包含自检请求，所以“0 客户端”只能作为趋势判断，不能当成绝对计数；真正的准入仍由 `CCGW_TOKEN` 强制（匿名 401）。

  自检用 `HttpClient` 且 `UseProxy=false`：本机系统代理会间歇性拦 `trycloudflare.com`，走代理会把“隧道已注册”误判成失败。`start` 在自检不通过时会**主动停掉刚起的隧道**，不会留下未验证的公网入口；`stop` 只杀带 `--url 127.0.0.1:8317` / `--metrics 20241` 的 cloudflared，不影响用户自己的其他隧道。

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
- 额度共享:所有人使用同一个免费账户池;429 按账户与模型冷却,没有就绪候选时返回等待时间。任意模型名自动解析——`haiku` / `sonnet` / `opus` 等槽位名按槽位表对齐,其余(含付费名/占位名)落排名第一——见「免费模型:自动发现 + 排名 + 选优(模型槽位按需填充)」;建议朋友照着该章节把 Claude Code 各模型槽位填好。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages(含 `?beta=true`、流式、工具) |
| POST | `/v1/messages/count_tokens` | 本地估算(Claude Code 会用) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions(流式、工具) |
| POST | `/v1/responses` | OpenAI Responses / Codex(流式、函数调用) |
| GET | `/v1/models` | 免费模型列表,按排名顺序;每条带 `ccgw_rank` 排名与 `ccgw_input` 输入能力(带 `anthropic-version` 头返回 Anthropic 形状,否则 OpenAI 形状) |
| GET | `/health` | 状态 + 账户池(连接/冷却/登录身份)+ `pool` 全池限流信号 + 模型目录 + `freeRanked` 免费模型排名(每条含 rank/input/bridgeInput/context)+ `modelSlots` 槽位映射 + `defaultModel` / `modelPin` + `egress`(上游出口:`preferredFamily` / `active` / `connections` / `failures` / `fallbacks` / `lastFamily`)+ `nord`(轮换状态:`rotating` / `activeTurns` / `lastGroup` / `lastAt` / `lastIp` / `guard`) |

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
| `CCGW_STATE_FILE` | `.ccgw-state.json`（网关目录） | 持久化本地冷却截止时间与失败次数;重启后恢复,请勿作为源码同步 |
| `CCGW_NORD_ROTATE` | `on` | Nord 节点自动轮换:`off` 关闭,`stub` 只记录决策不换网(测试用) |
| `CCGW_NORD_MIN_INTERVAL_SEC` | `120` | 两次节点轮换的最短间隔(秒) |
| `CCGW_NORD_MAX_PER_HOUR` | `6` | 每小时成功轮换次数上限 |
| `CCGW_NORD_DRAIN_MS` | `15000` | 换节点前等待其他进行中回合结束的上限;超时跳过本次轮换(避免掐断流式响应) |
| `CCGW_NORD_STATE` | `nord-rotate.state.json`（网关目录） | 轮换审计状态文件(测试可指向临时目录) |

## 验证与日志

- `node smoke1.mjs` — 引擎冒烟(文本回合 + 工具捕获/中断)。
- `node test-formats.mjs [anthropic|openai|responses|real]` — 全链路验收:三协议 ×(非流式 / 流式 / 工具往返),外加 `real` 组:模拟客户端**真实读取文件、真实执行命令**(输出含一次性 token,最终回答必须包含它们)。
- `node test-ranking.mjs` — 免费模型识别 / 排名 / 自动选优自检。
- `node --test test-errors.mjs test-protocol-regressions.mjs test-cooldowns.mjs test-budget.mjs test-images.mjs test-toolnames.mjs test-nord-rotate.mjs test-egress.mjs test-cancel.mjs test-plugin-readiness.mjs test-silent-node.mjs test-direct-ipv6.mjs test-request-timeout.mjs test-geo-fallback.mjs` — 本地模拟回归(共 15 个套件,全部不调用真实上游):错误分类、输出预算、协议输入、冷却恢复、受管会话插件、内嵌图片、上游工具上限(名称 64 / 数量 128 / 分发器)、Nord 轮换护栏、IPv6 出口 CONNECT、取消传播、插件就绪、GUI 子系统 node、原生 IPv6 直连、控制面请求超时、模型国家限制降级。
- `test-all.cmd` — 一键跑上面全部离线回归 + `test-ranking.mjs`;只看退出码(0 = 全绿)。
- `node verify-live.mjs` — 对运行中的网关做健康 + 文本 + 工具往返快速验证。
- `ccgw.log` — 每请求一行 JSON,路由证明 = `sessionID`(可在 OpenCode 桌面版里打开对应会话)。

## 工作原理

1. 解析客户端请求 → 规范化(canonical)消息 + 工具定义;模型名解析:免费模型直用,未知 / 付费 / `auto` → 排名第一的免费模型。
2. 若有工具:生成唯一桥接名 `gw<随机>` 与清单文件,`PUT /api/experimental/mcp/<name>` 注册 stdio MCP 桥接(`codemode:false`,工具直接暴露);等待其 `connected` 且位置工具目录完成重建(`command.updated` 事件)——这是"工具找不到"问题的根因修复。
3. 确认 scratch location 的网关预算插件已激活,创建带 `metadata.ccgw.managed` 的一次性 OpenCode 会话:权限 `[deny *, allow read, allow <bridge>_*]`。请求的输出预算写入会话元数据,原生 `context` hook 将 `event.options.maxTokens` 限制为请求预算与既有上限的较小值;原生 `retry` hook 仅对该受管会话关闭重复重试。
4. 把系统提示 + 历史(含既往工具调用/结果,工具名改写为当前桥接名)渲染为单个提示,`POST /api/session/<id>/prompt`。
5. 订阅 `/api/event`:文本增量实时转发;捕获 `tool.input.started/ended` + `tool.called`(按 `id` 关联工具名);模型流完该步后宽限 350ms 再 `POST /interrupt`,把工具调用按客户端方言回给客户端。桥接进程对 `tools/call` 永远挂起,直到回合被中断。
6. 客户端执行工具 → 结果在下次请求的历史中回到模型(新会话、重新注册桥接)。
7. 清理:注销桥接、删清单临时目录;会话按空闲时间定时清扫。

## 已知限制

- 依赖 OpenCode 的 `/api/experimental/*` 内部 API;OpenCode 大版本升级后接口可能变化,需跟进适配(已在 V2.0.30 桌面版与 `opencode-cli` v2.0.30 实测)。
- 推理内容可能混入文本;工具回合的 usage 常为 0。
- 免费层有速率限制与准入检查。429 表示限流;403 是准入或权限拒绝,需保留错误并处理原因,不能当作额度耗尽或成功调用。
- 输出预算接受 Anthropic `max_tokens`、Chat Completions `max_completion_tokens`（优先）/ `max_tokens`、Responses `max_output_tokens`,须为正安全整数,否则返回 400。预算由 `budget-plugin/index.mjs` 通过每个受管会话的原生 hook 执行,未提供预算时沿用上游默认;其余采样参数不代表已完整透传。
- 内嵌 PNG/JPEG/WebP/GIF 图片已通过原生 prompt files 转发；三协议实测识图通过。远程图片网址、本地文件路径、音频、视频与文档仍明确返回 400，不静默丢弃。

## 故障排查

| 症状 | 处理 |
|---|---|
| `/health` 显示 `eventStream:false` | OpenCode 服务未运行或刚重启;网关每秒自动重连,持续异常运行 `zero-window\start.cmd`(零窗口模式) |
| 工具调用失败/模型说工具不存在 | 多为桥接目录重建竞态;网关已等待 `command.updated`。若仍出现,查看日志中 `putBridge` 行 |
| 503 `gateway_plugin_unavailable` | 网关专用插件未激活,不能保证预算和重试策略。检查 scratch location 下 `.opencode/plugins/ccgw-budget/index.mjs` 与 OpenCode 插件加载错误,重新加载该 location 后发起一条带输出预算的文本请求确认 |
| 请求附件返回 400 | 图片请直接上传为内嵌 PNG/JPEG/WebP/GIF；其他附件与远程图片网址仍未支持，不能删掉附件后宣称已完成分析 |
| 免费层 403 / "can only be used from within OpenCode" | 保留 403,不按额度耗尽处理,不轮换账户或模型。记录官方客户端版本、登录身份与 UTC 时间,在同一网络、同一模型下对照官方客户端和网关各一次;保留脱敏错误。仍失败时通过 [OpenCode 官方支持入口](https://opencode.ai/v2/docs/console/models/) 联系 `help@anoma.ly`,提供上述对照和错误码,不要发送令牌或密码。修复标准是新的真实文本调用成功,并非连接恢复 |
| 403 在不同网络条件下结果不同 | 记录网络与客户端、身份、模型等对照条件,只能得出相关性;不能据此确认 IP 封禁、四账户或 ngrok 的原因。保持用户指定的网络状态,避免连续重试 |
| 池里 3 个实例,但只登录了 1 个账号 | 正常:`total` 是实例数不是账号数;`accounts-status.ps1 -Live` 看每个实例的真实身份,未登录显示 `(anonymous / not logged in)`;`/health` 的 `pool.loggedIn` / `pool.anonymous` 是计数;同一账号登多个实例额度不叠加 |
| 频繁 429 / 当前模型全池限流 | 遵守 `Retry-After`,由网关统一执行一层本地退避;查看 `limitedModels` / `modelCooldowns`,可由用户主动选择其他未受限的免费模型。不要无条件加账户、重启清状态或不断重试;冷却结束后用一次实际调用确认 |
| 全池限流但出口没自动切 | 查 `zero-window\net-guard.log`(每 ~10 分钟应有 heartbeat,没有说明守卫没在跑);确认没有 `net-guard.pause`、`/health` 里有 `pool` 字段;后端:装了 Nord 需已登录;没装 Nord 时 `auto` 默认不切换(需要免费出口就显式 `-Backend vpngate`,注意上方警示) |
| 修改配置后不生效 | 重启网关进程;客户端会话也要重开 |
| 想看执行细节 | 置 `CCGW_KEEP_SESSIONS=1` 后用 OpenCode 桌面版打开对应 `sessionID` |

## 2026-10-18：403 与限流分开处理

- `403 FreeTierError` 表示上游准入拒绝，不能据此认定账户额度耗尽。网关保留 403；不进行同一请求的账户轮换，也不设置 `pool.quotaExhausted`。
- `401`、`429`、`503` 保留原始状态；流式请求在已经发送的 HTTP 200 内使用协议错误事件。日志增加 `upstreamStatus`、`errorKind`、`errorCode`，不记录认证信息。
- 自动切换出口只影响网络，不等于修复上游准入。当前备用出口为 WARP，掉线由 `warp-guard` 自动重连,按用户要求保留`ccgw-netguard` 待命,回切家宽仍为手动;账户授权和网关密钥均不随网络状态改变。
- 离线回归：`node --test test-errors.mjs`；排名回归：`node test-ranking.mjs`。`test-formats.mjs` 是真实上游验收；上游 403 时验收失败，不能把离线通过写成模型服务恢复。

## 2026-10-18：输出预算截断不再触发整链降级

- 上游在输出预算过小时会返回 `Response still truncated after two output token limit continuations`。这属于**请求参数**问题，不是模型或账户故障。
- 网关把上游输出预算下限设为 **512 tokens**；命中截断时只对**同一模型**按 4 倍递增预算（上限 8192）重试，最多两次；仍失败才返回 400 `invalid_request_error`，日志 `errorCode=output_limit`。
- 截断不再进入模型级降级链。此前一次 `max_tokens:16` 的请求会依次烧掉 glm、nemotron、mimo、deepseek、beam、space-bunny 六个模型、耗时 20 秒以上；修复后同一请求一次命中（实测未知模型请求从 21 秒降到 0.9 秒）。
- 空 `messages` / 空 `input` 在进入账户池前直接 400（`messages: at least one message is required`），避免空请求复用上游会话状态。
- 成功日志的 `model` 字段改为**实际服务该回合的模型**；发生降级时不再误报原始槽位模型，`modelSource` 仍保留原始来源。
- `test-all.cmd` 会自动切到脚本所在目录，可在仓库根直接运行。
- 离线回归新增 4 条：空 messages、截断同模型重试、截断耗尽 400 不降级、降级后成功日志模型（`test-errors.mjs` 共 24 条）。

## 2026-10-18：IPv4 准入拒绝的本机修复

同账户官方客户端对照(2026-10-18 04:20)显示 IPv4 返回 FreeTierError、IPv6 正常;同日 07:33 同一家宽 IPv4 用官方客户端已恢复正常——该拒绝是偶发软限流,不是永久封禁,遇到先重试。现有 8317 增加仅限本机、带认证、仅允许 opencode.ai:443 的透明 CONNECT，四个专用后台进程优先 IPv6；不修改 TLS/客户端身份，不开启 VPN。原账号、会话和工具权限保留。DeepSeek、Claude Messages、Codex Responses、官方桌面服务经 ccgw 及外部工具往返均已真实成功。启动配置已持久保存，凭据只在进程内解密。出口运行状态见 `/health.egress`（`preferredFamily:6`，失败自动回退 IPv4）。详见 [修复与验证记录](RATE_LIMIT_RETRY.md)。

## 2026-10-18：模型可用性复核与槽位调整

- 在 WARP 出口下逐模型实测 13 个免费模型：8 个可用且**工具调用正确**；`glm-5.3-flash-free` 持续 `Endpoint is unavailable`；`muse-spark` / `cat-jam` `Model unavailable`；`ll-alpha-free` `deprecated`。`nemotron-3.5-lightning` 单请求可超时。
- `sonnet` / `haiku` / `vision` 原本都指向 glm，同日一并失效；现已改为 `longcat-2.5-preview-free` / `space-bunny-free` / `nemotron-3.5-super-vl-free`，`opus` 保持 `deepseek-v4.1-flash-free`。
- 初次探测时所有模型都报 `Gateway session plugin is not active`：网关 scratch（`D:\Temp\ccgw-scratch`）下的 `ccgw-output-budget` 插件目录被清理器移除，网关只在启动时安装一次。已重装并重启网关，两个实例均确认 `ccgw-output-budget-v1 status=active`。**临时清理器删掉 scratch 后，必须重启网关，否则所有请求都会 503。**
- 实测 403 是**出口维度**的软拒绝：家宽 IPv6 两个账户全拒，切 WARP 后 deepseek 立即恢复；但 WARP 下 glm 仍不可用（模型维度），两者要分开判断。
- `node test-ranking.mjs` 与 `test-all.cmd` 在改槽位后仍需全绿；`test-all.cmd` 不调用上游。

### 2026-10-18 深夜复核（推翻了两条当日结论）

同日晚间重测，结论与上面两条不同，**以本节为准**：

1. **`glm-5.3-flash-free` 并非持续不可用**：本轮一次成功、一次 `Endpoint is unavailable`，属**间歇性**。因此它保留在排名末尾，但任何槽位都不指向它。
2. **当日“前几名不能全是纯文本”的排名不符合真实能力**：当时把 `beam` / `space-bunny` / `longcat` 记为支持图片，依据是上游目录文字；但**目录不提供输入型元数据**。本轮直接给 `beam-free` / `space-bunny-free` / `jev-1.13-free` / `nemotron-3-ultra-free` / `longcat-2.5-preview-free` 各发一张真实 1×1 PNG，五个**全部**返回“所选模型不支持图片”。真正接受图片的免费模型只有 `nemotron-3.5-super-vl-free` 与 `deepseek-v4.1-flash-free`。
   - 排名改为按实测延迟排（`beam` 0.7s 最快），但 `opus` 与 `vision` 两个槽位**不随延迟走**，仍指向能看图且稳定的 `deepseek` 与 `nemotron-3.5-super-vl-free`。
   - `test-ranking.mjs` 的 top-5 能力表同步改为实测结论，并修正了原 fixture 中 `beam-free` 被重复键覆盖成 `["text"]` 的笔误——那会让“top-5 必须有视觉模型”这条约束永远失效。
3. **一次更正**：当日本会话曾据 `curl` 探针下的“WARP 也 403”判断该出口同样被拒，那是**探测方式的问题**——探针缺少真实客户端指纹，` https://opencode.ai/zen/v1/chat/completions` 对任何非 OpenCode 指纹都返回 `FreeTierError`。用真实 OpenCode 后台进程走同一条 WARP 代理重测：WARP 出口 `succeeded`，家宽出口同机同时刻返回 `FreeTierError`。**判断出口是否被拒，必须走网关/真实客户端，不能用裸 curl 探针。**
4. **模型实测延迟（WARP 出口，本机）**：`beam` 0.69s、`space-bunny` 1.09s、`jev` 2.26s、`nemotron-3-ultra` 2.22s、`longcat` 3.56s、`mimo` 5.12s、`big-pickle` 7.20s、`glm` 6.84s、`nemotron-3.5-lightning` 12.29s、`deepseek` 29.61s、`nemotron-3.5-super-vl` 42.65s。前 3 名用 `max_tokens=24` 会触发上游截断；网关现在会把预算抬到 ≥512 并对同一模型重试，但测延迟仍建议 ≥300 tokens，避免把重试耗时算进模型延迟。

## 2026-10-18：WARP 出口轮换（自治，只为 ccgw）

家宽出口被 `Detect Abuse Traffic` 403 后，改为让 ccgw 的后台上游走 WARP 的**本机 SOCKS5/HTTP 代理模式**（`warp-cli mode proxy`，端口 41700）。这一点符合 `AGENTS.md`：桌面端 OpenCode 保持原生连接，**没有改动整机隧道**——WARP 在 proxy 模式下系统流量不再走隧道（`trace` 的 `warp=off`），只有 ccgw 用 `CCGW_EGRESS_UPSTREAM=http://127.0.0.1:41700` 显式走它。

- `egress.mjs` 新增 `relayConnect`：把原本仅限本机、带认证的 CONNECT 转成到本地代理的普通 CONNECT，TLS 仍端到端。默认 `relay=null`，不带 `CCGW_EGRESS_UPSTREAM` 时行为与以前完全一致；`test-egress.mjs` 有用假代理与不可达代理两个用例覆盖，并有一条“直连模式绝不触碰 relay”的回归测试。
  - 修过一个自己引入的崩溃：默认参数写成 `relay=relayConnect` 时，ccgw 进程启动后第一条请求就 `TypeError: Cannot read properties of null (reading 'host')` 退出，网关表现为“转个身就没了”。修复后 3/3 请求 `SERVED`。
- `zero-window\warp-rotate.ps1`：探测一次真实网关请求，被拒就重拨隧道换边（`disconnect/connect`），同一 IP 时再 `tunnel rotate-keys`，最多 6 次；可 `pause` 一键停。实测一条轮换 18 秒完成：`2a09:bac1:6f60::3c3:1c` → `2a09:bac5:56bb:2723::3e6:43`，随后网关 `served`。
- 计划任务 `ccgw-warp-rotate`（每 30 分钟）。启动器用 `mshta` 而非 `wscript`：`wscript` + `sh.Run(...,0,True)` 在没有控制台的任务宿主里会永久挂起并弹出可见的 Windows Script Host 窗口；`mshta` 版返回结果 `0`、零可见窗口、真实执行轮换。
- **WARP 不能选国家**：消费版 `warp-cli` 只有 `tunnel endpoint set`，无法指定 colo；本机反复重拨始终落在新加坡边缘（`colo=SIN`）。多次尝试强制其它 Cloudflare edge 段均连不上，已 `tunnel endpoint reset` 还原。所以“换国家”目前只能等独享出口。
- 出口 × 模型结论：**WARP/SIN 出口下 11 个免费模型全部可用**（见上表），glm 间歇。决定排名的依据是延迟与图片能力，不再是出口。

## 2026-10-19：Claude Desktop 接入与 CC Switch 路由修正

- **a 方案(直接改 Claude Desktop 指向 ccgw)失败,判据明确:** 3p 模式的端点由托管 bootstrap 下发(日志两次 `Bootstrap request failed: 503 Service Unavailable`,并刷 `This functionality is not available in third-party mode.`);桌面端启动后重写 `host-creds-*.json`(新 UUID、`expiresAt` 1 小时),但 `127.0.0.1:15721` 在未打开 Code 标签页时始终 `NOT LISTENING`,7 个 `claude` 进程没有一个持有监听端口。
- **b 方案(CC Switch proxy)成功:** CC Switch 监听 15721,`/claude-desktop` 转发 ccgw。用桌面端 `host-creds` 的真实 env 跑真实 Claude Code 客户端,得到 `DESKTOP-ROUTE-OK`,ccgw 日志 `requested=claude-opus-5 served=glm-5.3-flash-free source=slot:opus`。
- **修掉一次静默回归:** CC Switch 的 provider 把三个槽位全写成 `deepseek-v4.1-flash-free`,请求在到达 ccgw 前就被改写,`slot:` 与模型级降级完全失效(日志 `requested=deepseek...`)。改为透传别名后,真实客户端三槽实测:`opus→glm` / `sonnet→deepseek` / `haiku→mimo`,全部 `modelSource=slot:*`。
- **清掉 docode 残留:** `providers` 表里 `claude` 的 `is_current=1` 仍是 `docode-1792089790180`,另有 `opencode/docode`;已删除,并把 current 指回 ccgw。
- **新增 `visionTrusted` 与带图改道**(见「免费模型」章节),避免 `sonnet` 槽用 `deepseek` 的不可信识图回答截图。

## License

MIT © 2026 liyangru

## 2026-10-18：工具黑框与图片转发

原生 MCP 工具每次注册使用控制台版 node.exe，Windows 子进程可能分配控制台窗口。改为专用本机 GUI 子系统 Node 副本运行 stdio 桥接，不修改系统 Node 或官方 OpenCode 文件，保留 stdin/stdout 和工具权限。可执行文件存于 LocalAppData/ccgw/runtime，按原 Node 内容哈希分版本。无控制台子系统与 stdio 测试通过，正式工具 probe_sum(20,22) 往返仍返回 42。其他应用（包括 WorkBuddy）启动的命令窗口不属于此次改动。

image_url 报错源于旧协议适配器主动拒绝图片。新增三协议内嵌图片提取，字节作为原生 files 发送；历史文本保留附件名标记，支持工具图片结果。不抓取任意远程网址或本地路径；上限 20 张、解码字节合计 15MB，入口请求体限制仍适用。图片由官方后台实际解码。hub → ccgw → GLM 在 Chat、Claude Messages 和 Codex Responses 三种请求中均准确读出测试图 Q7M42（字符只在图片中，不在提示词中）。

## 2026-10-19：上游工具上限（名称 64 / 数量 128）与桥接分发器

桌面端 Claude Code 一次会带 137–141 个工具，其中 MCP 名称很长。上游免费层有两条硬限制：`tools[*].function.name` ≤ 64 字符、`tools` 数组 ≤ 128 项。旧实现把名称截到 60 字符后再加 14 字符桥接前缀（最长 75），并且把 137 个工具全部注册，于是同一类回合先后报 `Invalid value for 'tools[75].function.name': maximum string length is 64` 和 `Invalid value for 'tools': maximum number of items is 128`。

修复：

- `buildNameMap(tools, { prefix })` 按前缀长度预算截断（64 − 前缀 − 去重后缀），长名称截断后的冲突用 `_n` 去重，往返映射不变。
- `planBridgeTools()` 把桥接预算限制在 128 以内（预留 16 个 OpenCode 内置工具）：前 111 个直接注册，其余通过一个随机命名的分发器工具 `gwcall*` 暴露；模型调用 `{"name": "<工具名>", "input": {...}}`，网关在返回客户端前解包成原始工具调用（`unpackDispatcherCalls`），流式与非流式共用同一条解包路径。
- 提示词同步：直接注册的工具按精确 wire 名列出，溢出工具列在分发器下；助手历史里的旧工具调用也会渲染成分发器形式，避免模型看到不存在的工具名。
- 回归：`node --test test-toolnames.mjs`（8 项）覆盖 64/128 两条限制、去重、往返映射、分发器解包与提示词渲染；`test-errors.mjs` 另加了两个服务级用例（全池 429 触发换节点并同模型重试、单账户限流不触发）。
- 实测：137 工具 → 200 + `TOOLS-OK`（`tools:137`、bridge 非空）；桌面端 Code 回合 `tools:138/141` 连续成功，修复后日志不再出现两类 `invalid_value`。

## 2026-10-19：控制面请求有界（/health 与新建回合不再被上游卡死）

`OpenCode.req()` 原来没有超时：本机 OpenCode 服务一旦不响应，模型列表、会话创建、中断和 `/health` 会一起永久挂起。实测在桌面端 + Codex 同时跑回合时，`/health` 连续 5 秒超时、`activeTurns` 只增不减，排障完全失明。

- `req(method, path, body, { timeoutMs = 30000, signal })`：默认 30 秒上限，可传入调用方信号；超时抛 `OpenCode GET /api/... timed out after Nms`，不再返回裸 `AbortError`。
- 模型列表单独收紧到 5 秒（`accountModels`），超时后沿用 60 秒缓存，`/health` 与路由继续可用。
- `/health` 新增 `nord` 字段（`rotating` / `activeTurns` / `lastGroup` / `lastAt` / `lastIp` / `guard`），不必翻日志就能看轮换状态。
- 回归：`test-request-timeout.mjs`（4 项）覆盖挂起超时、调用方中止保留原因、正常请求不变、预中止不发请求。

## 2026-10-19：整链国家限制后的换节点重放 + 轮换触发器回归

- `This model is not available in your country` 是**出口国家**维度、但按模型报的 403：单个模型命中时只把它短暂冷却并走排名降级链（不换节点）；只有当整条链都拒绝、且链尾仍是国家限制或 429 时，才阻塞式换一次 Nord 节点、清掉本次请求的模型冷却并**重放整条链**。链尾是 401/参数错误不换（换个出口也修不了，只会白烧一次轮换额度）。
- 国家限制不再计入“403 准入风暴”计数；那条计数只留给网络级闸门（FreeTierError / abusive-traffic），避免一个被国家限制的模型把出口来回切。
- 轮换触发器新增服务级回归（`test-errors.mjs`，Nord 用 `stub` 模式，不动网络）：全池 429 → 换节点并在同请求重试成功；单账户 429 → 账户间故障转移、不换节点；整链国家限制 → 换节点重放成功；单模型国家限制 → 降级不换；国家限制 + 链尾 401 → 不换；有进行中的回合 → `deferred` 跳过而不是掐断它。
- 护栏窗口回归：`test-nord-rotate.mjs` 新增“满额轮换记录超过一小时后重新放行”；本机实测 `--dry-run` 返回 `hourly-cap / inHour:6`（窗口未满时的设计行为，不是故障）。
- `net-guard`（backend=nord）用 `-Once -ForceQuota` 实测：识别到 Nord 适配器已连接后只记 `already on alternate egress ... (no action)`，不重复换网。
- 本套件计数：`test-errors.mjs` 30 项、`test-nord-rotate.mjs` 15 项；`test-all.cmd` 全绿。

## 2026-10-19：控制面失败不再当成“模型被拒”

实测一次 `claude-sonnet-5` 请求耗时 **100 秒**才返回，日志里是 `phase:"model-fallback" … upstream refused the model (OpenCode GET /api/plugin?location[directory]=… timed out after 30000ms), trying next ranked model`：网关自己的 OpenCode 控制面（插件就绪检查）超时，被分类成 `upstream`，于是**烧掉了模型降级链**（`deepseek` → `beam-free`）并让用户多等 30 秒。

- `errors.mjs` 新增控制面规则：`OpenCode <METHOD> <path> timed out after Nms`、`<METHOD> /api/… -> 5xx …`、`Gateway session plugin is not active` 全部归类为 **`kind:"network"`、`code:"control_plane_error"`**（账户/出口维度，不是模型维度）。效果：该账户短暂冷却、请求立刻换另一个账户，**不再走模型降级链**，客户端拿到的仍是原始控制面错误（5xx），全账户都失败时如实返回。
- `engine.mjs` 的插件就绪探测每次调用最多 8 秒（`min(8000, 剩余预算)`，下限 1 秒），一次挂死的控制面调用不再吃掉整个 30 秒就绪预算；插件**不活跃仍然 fail closed**（`gateway_plugin_unavailable`），只是失败得更快、更准。
- 回归：`test-errors.mjs` 新增 3 项——控制面错误的分类（三种消息形态 + 与 geo/403 的优先级），单账户控制面 500 时换账户且同模型成功（日志有 `phase:"rotate"`、无 `model-fallback`），全部账户控制面 500 时返回 5xx 且**一个模型都没被调用**（`turns:0`）。


