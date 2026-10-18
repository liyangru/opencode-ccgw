> 当前策略已更新：官方桌面端保持原生，不安装自定义网络传输，不接入 ccgw。以下直连插件记录属于历史排查过程；当前结果见 CLIENT_BOUNDARIES.md。

# 官方客户端直连排查与修复（2026-10-18）

当前状态：直连配置已保存，但当前无 VPN 网络的免费推理仍被上游拒绝，不能写成恢复成功。

已核实：官方桌面后台 45278 加载 native-opencode-ipv6-v1；该插件直接使用 Node HTTPS 连接 opencode.ai 的官方 inference 路径，不通过 ccgw，不改变原始账户、TLS 目标或原生请求身份。已将默认模型及原会话 ses_ebef74d03ffeHcMikUtYqbxZi5 改为 opencode/deepseek-v4.1-flash-free，保留其他提供方、历史与会话权限。原配置已在私有目录用 Windows DPAPI 加密备份。

本轮新修复：原插件强制 IPv6，在当前没有 IPv6 默认路由的网络下报 DNS/连接失败。现在只在 IPv6 初始 DNS/TCP/TLS 连接失败时，允许一次 IPv4 回退；连接后的错误以及真实 403/429 不重放。原始 POST 请求体在回退中保留。7 项直连回归通过。

真实验证：WARP 连接时，官方客户端 DeepSeek 直连返回 NATIVE_DIRECT_OK；GLM 曾返回 ADMISSION_OK，也出现过 429 Endpoint unavailable。断开 WARP 后，当前电脑无 IPv6 默认路由，系统可解析 IPv4 且官网 HTTPS 200，但原生 DeepSeek 和 GLM 推理均返回 403 FreeTierError。GLM 日志时间 2026-10-18T10:20:06Z，官方 trace ID 01a14e86-9b25-7e35-8f3a-51bc7a9bbf4a。不能据此确认上游具体风控算法或永久 IP 封禁。

网络偏好：保持 WARP 断开，暂停并禁用无条件 ccgw-warp-guard 保活；保留 ccgw-netguard 按需自切。已向用户询问：允许按需 WARP，或改用支持 IPv6 的网络后复测。没有自动开通付费服务，也不覆盖供应商密钥。

下一步标准：用户选择网络方式后，同一官方客户端、账户、免费模型新的真实推理成功；仅插件激活、配置保存、官网连通或离线回归不算恢复。若继续被拒绝，可向 https://opencode.ai/v2/docs/console/models/ 的官方支持入口提交上述脱敏 trace、版本 2.0.32 与 UTC 时间，不附密钥或完整数据库。

## 后续 IPv6 网络复测

已切到具备 WLAN IPv6 默认路由的网络；IPv6 DNS 与 TLS 均成功，WARP 断开。原生 DeepSeek 新请求仍返回 403：Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic。直连插件已核实 active，近 10 分钟 ccgw 日志无推理请求记录。问题未恢复，不再连续探测或切换账户。脱敏反馈与官方处理步骤见 NATIVE_DIRECT_SUPPORT.md。
