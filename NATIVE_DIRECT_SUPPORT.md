> 当前策略已更新：官方桌面端保持原生，不安装自定义网络传输，不接入 ccgw。以下直连插件记录属于历史排查过程；当前结果见 CLIENT_BOUNDARIES.md。

# OpenCode 官方模型直连故障反馈

日期：2026-10-18（Asia/Bangkok）

## 当前可复现结果

- Windows，官方桌面后台 CLI 2.0.32，使用原账户。
- 默认与原会话模型均为 opencode/deepseek-v4.1-flash-free，不是 ccgw provider。
- WARP 断开；WLAN 有 IPv6 默认路由；opencode.ai 的 IPv6 DNS 与 TLS 连接成功。
- 本机 native-opencode-ipv6-v1 插件 active，使用 Node HTTPS 直连官方 inference；保留原始 HTTP 请求身份与 TLS 主机名，不经过模型网关。此为自定义传输插件，不应描述成无插件的官方环境。
- 新的实际请求返回 HTTP 403 / FreeTierError：Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic。
- 失败会话：ses_eb15e2b5dffeP97QIjJ49Hu5hH。
- 检查时 ccgw 日志近 10 分钟无模型请求记录；这只能排除该网关近期记录中的请求，不能排除其他设备或服务的账户活动。

## 请求官方协助

请核查该账户此次 FreeTierError 的准入原因、是否需要账户验证，以及自定义 IPv6 HTTPS 传输是否影响官方免费层识别。请提供解除限制的官方步骤，不假定为 IP 黑名单或永久封禁。

官方入口：https://opencode.ai/v2/docs/console/models/
支持邮箱：help@anoma.ly

请从受影响账户的控制台核对最近用量，向官方提供以上会话、版本、模型、日期与脱敏错误；不要提交 API Key、OAuth 令牌或完整数据库。本文件没有自动发出，也不包含凭据。

## 验证标准

官方处理或确认配置要求后，在 VPN 关闭的当前 IPv6 网络下，以同一账户、同一原生模型发起一次新请求并成功回复。配置保存、插件 active、TLS 成功均不能代替推理成功。
