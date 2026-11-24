# dsh-go-workbuddy-claim

WorkBuddy（国内版）每日签到积分自动领取 —— **dsh-go 手机 App 原生界面插件**。

在 dsh-go 里显示今天的签到状态，并一键领取当天积分。直接复用本机已有的
CodeBuddy / WorkBuddy 登录态，**不把 token 写进任何配置文件或日志**。

## 界面入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 状态条 | 输入框上方 | 显示「今日已领 ✓ / 今日未领 / 未登录」，点它打开面板；每 5 分钟自刷新 |
| 「领积分」胶囊 | 输入框上方 | 一键领取（点了才动作） |
| 面板 | 会话详情 → 插件 / 全部功能 | 账号、今日、连续天数、今日/总积分、最近记录 +「立即领取 / 刷新」 |

## 安装（dsh-go 手机本机引擎）

```bash
git clone https://github.com/youzhangjin67-a11y/dsh-go-workbuddy-claim.git
dsh plugin --profile web add "$PWD/dsh-go-workbuddy-claim"
```

装完在 App 的「引擎」页**重启引擎**，状态条 / 胶囊 / 面板就会出现。

## 凭据从哪来

按「最后刷新时间」从新到旧取第一份可用的：

1. `~/.dsh/.workbuddy-daily-claim.cn.json`（本插件自己续期后的缓存）
2. `~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`（CodeBuddy CLI 登录态）
3. `~/.dsh/.workbuddy-auth.cn.json`（其它 WorkBuddy 登录副本）

一份被上游拒（HTTP 401/403）时自动换下一份；全部被拒才报错。token 快过期时用
`refreshToken` 续期，续期结果只落到本插件的缓存文件（权限 `0600`），不回写别处。

## 与上游的区别

改编自 [grixeo/dsh-workbuddy-daily-claim](https://github.com/grixeo/dsh-workbuddy-daily-claim)
（桌面版 Cordis 插件）。桌面版在 DSH 启动时自动后台领取；dsh-go 版按原生插件规矩，
**只在点「领积分」/「立即领取」时领取**，不做无点击副作用。其余逻辑一致：
上游幂等（`code 10001` = 今天已签到，不算失败）、401 自动续期重试、日志与输出不打印 token。

## 限制

- 仅支持国内版（`www.codebuddy.cn`）；国际版账号会被跳过。
- 一次处理一份凭据（最新那份）。
- 只读查询（状态条 / 面板）无副作用；领取只在点击时发生。

## 许可

MIT。见 [LICENSE](LICENSE)。
