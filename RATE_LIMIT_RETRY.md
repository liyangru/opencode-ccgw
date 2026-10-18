# 限流与重试修复记录

日期：2026-10-18（Asia/Bangkok）。

## 本轮范围

本记录覆盖限流与重试、输出预算、输入边界和模型目录隔离。运行中的 ccgw（8317）与 hub（8787）是否已载入最新代码,须在重载后核对状态与实际请求。hub 的基座仅按明确的源码清单同步,不复制账户配置、令牌、冷却状态或日志。

## 确认并修复的问题

1. 旧代码在所有候选冷却时仍选择冷却中的实例，客户端重试会反复打上游。现在没有就绪实例就直接返回错误与 Retry-After，不创建新的上游会话。
2. 原冷却记录覆盖整个账户，且其他模型成功会清除它。现在 429 按账户与模型组合记录，网络故障仍按实例冷却。
3. 全池信号原先只看账户最近一次失败。现在只有所有已知免费模型在所有实例均处于限流冷却时才发出信号，另提供 limitedModels 与 modelCooldowns。此信号不等于确认上游按 IP 统计。
4. 上游提供 Retry-After 时优先采用；缺少时采用本地退避，默认 300 秒、连续失败递增至 1800 秒。等待时间不是官方额度重置时间。冷却截止时间与失败次数持久化到 `CCGW_STATE_FILE`（默认网关目录的 `.ccgw-state.json`）,重启后恢复未过期且账户作用域匹配的记录;重启不会清空冷却。该状态不包含凭据、提示词或上游响应正文,不应随源码复制。
5. SSE 首个非空内容到达前保留真实 HTTP 错误和 Retry-After；开始输出后发生失败，不换账户重放。
6. 并发下，迟到的成功不会清除较新的冷却；较短的限流响应不会缩短现有截止时间；空 delta 不会提前发送 200 SSE。
7. 三种协议的输出上限规范化为 `maxOutputTokens`:Anthropic `max_tokens`、Chat Completions `max_completion_tokens`（优先）/ `max_tokens`、Responses `max_output_tokens`;非法值返回 400。`budget-plugin/index.mjs` 仅安装到网关 scratch location,根据 `metadata.ccgw.managed` 与会话预算,通过 OpenCode 原生 `context` hook 将模型调用的 `event.options.maxTokens` 限制为预算与既有上限的较小值。插件未激活时返回 503,不假装预算已生效;普通原生会话不受影响。
8. 同一插件通过原生 `retry` hook 对受管会话设置 `retry:false`,关闭原生重复重试,由网关统一执行有界重试与冷却。403 准入拒绝保留原状态,不换账户或模型重试;已经输出的请求不重放。
9. 模型目录只接受 `providerID = opencode` 的原生目录;其中已启用的免费模型才进入网关可选列表,本次为 10 个。其他本地 provider（包括指回网关的 provider）不混入目录或路由。原生目录还包含付费条目,目录条目不代表权限、额度或调用成功。
10. 文本、工具及内嵌 PNG/JPEG/WebP/GIF 图片可转发。图片经三协议归一化后作为 OpenCode 原生 prompt files 传递，不把图片当成文本；选择无图片能力的模型时明确返回 400。远程网址、本地路径、音视频和文档仍拒绝。`bridgeInput` 与 `ccgw_input` 根据可用图片能力声明。
11. 取消监听覆盖目录发现、插件检查和会话创建阶段,客户端提前关闭不会再提交新的模型 prompt;hub 的流式关闭也传到上游。
12. 到达输出上限后,Chat 返回 `finish_reason:length`,Responses 返回 `incomplete`/`max_output_tokens`,不再标成正常完成。

## 验证

- 离线回归:`node --test test-errors.mjs test-protocol-regressions.mjs test-cooldowns.mjs test-cancel.mjs`;另运行 `node test-budget.mjs --native`。后者启动隔离官方 CLI 并只连接本地模型模拟服务,实测并发出站预算 64/8192/12000、429 仅一次调用;不消耗真实上游额度。
- 排名回归:`node test-ranking.mjs`。同步基座后还须从 hub 的 `ccgw/` 目录重复执行相关离线回归,核对同步文件哈希。
- 真实上游验证与离线模拟分开记录。`/health` 可达、事件流已连接、`quotaExhausted:false` 或构建通过,均不能写成模型服务恢复。修复标准是新的真实调用按预期成功并遵守输出预算;失败应保留实际状态与错误。

## 最近已记录的真实调用边界

2026-10-18 02:04:07（2026-10-17 19:04:07 UTC），通过 hub8787 → ccgw8317 请求默认 DeepSeek 免费模型。实际结果为 HTTP 403 / free_tier_access_denied / permission_error；流式请求没有被提前改成 HTTP 200，也没有返回误导的 Retry-After。

该次免费模型推理被上游准入拒绝,不能因本地修复或离线测试通过而宣称模型服务已恢复。该次验证没有连续重试,也没有打开 VPN、更换账户或付费回退。

本轮最新实测（2026-10-18, Asia/Bangkok）:

- 06:17:22,现有 WARP 连接下,hub → ccgw → GLM 返回 HTTP 200 和 `VERIFY_OK`。这次发生在本轮代码部署前。
- 06:28:25,VPN 关闭、修复版已部署,同一网关 GLM 请求返回 HTTP 403 / `free_tier_access_denied`,无 Retry-After。
- 06:29:15,绕开两个网关,通过官方桌面服务直接请求原生 `opencode/glm-5.3-flash-free`,仍返回 `provider.auth`/403 与相同 FreeTierError 文案。当前失败不只存在于 hub 转发层。
- 用户附件最新失败发生在 06:13:06:DeepSeek 429,附带本地冷却 939 秒,不是该次官方额度重置承诺。稍后冷却到期本身不构成调用恢复证据。

网络配置以用户最后明确要求“关闭 VPN,保留自切”为准:当前 WARP 断开;`net-guard.pause` 已移到可恢复备份,自动切网守卫运行待命,单个模型限流或 403 不触发全池信号。`warp-guard.pause` 保留,`ccgw-warp-login` 强制开机连接禁用,避免手动关闭后马上被重连。手动网络工具保留。

WorkBuddy 共享记录确有官方 CLI 切换网络前 403、切换后成功的工具输出,支持网络条件相关性;没有官方黑名单判定、单账户或关闭隧道对照,不能证明“IP 已被封”“四个账户或 ngrok 导致封禁”,也不能保证更换独享出口能根治。上述为 IPv6 修复部署前的历史结果；随后完成同账户双栈对照和无 VPN 修复，见下节。

若相同准入问题再次出现，官方入口 https://opencode.ai/v2/docs/console/models/ 与 help@anoma.ly。反馈时提供 UTC 时间、模型 ID、官方版本、同一账户同一网络的脱敏错误和本地 session ID（本轮 `ses_eb3cd5fd8ffejDVVc894GJWakh`,2026-10-17T23:29:15Z）,不要附密钥、完整数据库或 OAuth 令牌。验证标准是相同账户/模型/网络下新的真实原生调用与网关调用均成功;配置保存、联网或冷却到期均不算。

## 2026-10-18 后续：双栈对照与正式恢复

同一官方 CLI 2.0.32、同一 OAuth 账户/组织、同一 GLM 模型及原始请求，仅改变 TCP 地址族：IPv4 返回 403 FreeTierError；IPv6 返回 200 / ADMISSION_OK。只读权限与完整工具需批准权限均复现，VPN 全程关闭。确认本机当前 IPv4 路径被拒绝而 IPv6 路径可用；没有证据推断上游具体风控算法、永久 IP 黑名单或账户被封。

修复：复用 ccgw 8317 的 loopback CONNECT 通道，只允许带认证的本机后台连接 opencode.ai:443，优先 IPv6。TLS 与官方请求端到端不改写，不伪造客户端身份；仅初始 TCP 连接失败才允许一次 IPv4 回退，不因模型 403/429 重放请求。原账户、工具权限、用户全机网络和客户端本地接入地址保留。认证值由统一私有配置的 DPAPI 帮助函数在进程内读取，不写入源码、启动器或日志。四个后台与网关的原启动器先做 DPAPI 加密备份，再加入进程级配置，重启仍生效。

实际验收（hub 8787 → ccgw 8317 → 官方后台）：GLM 返回 RECOVERY_OK；默认 DeepSeek 返回 DEEPSEEK_RECOVERED；Responses 返回 CODEX_RECOVERED / completed；Anthropic Messages 返回 CLAUDE_RECOVERED / end_turn。外部工具 probe_sum(20,22) 发起和结果回传后回复 42。官方桌面后台通过 ccgw provider 返回 OPENCODE_RECOVERED，会话 ses_eb3b7e8ffffeEceSdkv7KCne1j。这些是新的真实推理与工具往返，不是健康检查。

冷启动曾有一次本地插件未就绪 503，随后核对四个后台预算插件均 active。将本地就绪等待由 5 秒调整为有界 30 秒，并增加先失败后修复的回归；插件失败仍立即拒绝请求，不移除预算和重试防护。37 项离线回归通过。

保留限制：真实 429 仍遵守 Retry-After，不承诺免费额度无限或永久可用；未来网络无可用 IPv6 时可能再次遇到准入拒绝，保留真实错误。VPN 当前断开，按需自切守卫保留，无条件开机/掉线强制连接保持禁用。

## 2026-10-18：工具黑框与图片转发

原生 MCP 工具每次注册使用控制台版 node.exe，Windows 子进程可能分配控制台窗口。改为专用本机 GUI 子系统 Node 副本运行 stdio 桥接，不修改系统 Node 或官方 OpenCode 文件，保留 stdin/stdout 和工具权限。可执行文件存于 LocalAppData/ccgw/runtime，按原 Node 内容哈希分版本。无控制台子系统与 stdio 测试通过，正式工具 probe_sum(20,22) 往返仍返回 42。其他应用（包括 WorkBuddy）启动的命令窗口不属于此次改动。

image_url 报错源于旧协议适配器主动拒绝图片。新增三协议内嵌图片提取，字节作为原生 files 发送；历史文本保留附件名标记，支持工具图片结果。不抓取任意远程网址或本地路径；上限 20 张、解码字节合计 15MB，入口请求体限制仍适用。图片由官方后台实际解码。hub → ccgw → GLM 在 Chat、Claude Messages 和 Codex Responses 三种请求中均准确读出测试图 Q7M42（字符只在图片中，不在提示词中）。
