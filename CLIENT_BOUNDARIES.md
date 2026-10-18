# OpenCode 桌面与 ccgw 分离记录

2026-10-18，按用户最新要求：桌面端不使用 ccgw；ccgw 保留给 Claude、Codex。

已执行：
- 从桌面 opencode.json 移除 ccgw 提供方，保留其他已配置提供方与官方默认模型；原配置另有 DPAPI 加密备份。
- 将全局 native-ipv6 插件移到自动发现目录以外，并重载服务。桌面目录验证：自定义网络插件 0，ccgw 模型 0，官方模型 10。
- ccgw 第一个后台迁移到 zero-window/accounts/acct1/home；第二个后台保持 accounts/acct2/home。配置、数据、缓存、状态和 AppData 均位于各自目录，不再复用桌面用户目录。只通过官方 credential API 在进程内迁移第一个后台既有的 opencode 登录凭据，不复制聊天数据库、不打印凭据。运行库沿用原生存储形式，并限制目录权限。
- 两个 ccgw 后台各保留一条登录凭据，桌面原登录仍在。以后新增后台写最小配置，不再复制桌面 providers 和密钥。
- 全机换网守卫改为 monitor-only，强制 WARP 保活继续暂停；手动工具保留，ccgw 的进程内 IPv6/IPv4 连接选择、模型/账户路由继续保留。start.cmd 不再把 VPN/隧道任务一律重新启用，setup 的系统 VPN 需显式选择。
- ccgw 恢复诊断不再通过桌面 ccgw provider 发请求。

实际调用：恢复原生传输后，官方 DeepSeek 返回 403 Detect Abuse Traffic；隔离后的 ccgw Claude Messages 和 Codex Responses 两次请求也分别返回同一 403。记录的是本轮真实拒绝，不是调用成功。未为此继续轮换账户或反复试探。

本机路由与目录隔离已验证；模型可用性仍受上游准入限制。同一上游账户、OAuth 授权或公网出口仍可能共享服务端限制。此分离不能被描述为免费额度隔离，也不能据此断言某个 IP 被永久封禁。
