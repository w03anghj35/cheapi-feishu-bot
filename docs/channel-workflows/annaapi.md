# AnnaAPI：积分余额

- 站点：`https://www.annaapi.com`；目标页：`/dashboard`；未登录时进入同源`/auth`。
- 指标：当前账号可用积分，不是“积分消耗”；单位为积分。
- 页面组件：可见“积分余额”卡片，`data-testid="points-balance"`。`title`提供完整精度，正文可能只显示两位；公开资源当前对应`DashboardPage-jvTIiHYD.js`，资源名不是永久路径。
- 旧失败：与IP积分站相同，8位小数金额被最多6位小数的解析规则拒绝。现支持至多12位，仍要求来源与路径匹配及唯一候选。
- 代码定位：`key-tool/channel-monitor.js`的`points-anna`、`observationScript`、`parseAmount`，周期与UI职责见[总台账](README.md)。
- 验证：本机登录后的实际页面已只读看到积分卡片；新解析器同格式测试通过。2026-11-03修复版正式卡片已显示“读取成功”和完整精度积分；尚未验收跨时段刷新。
- 2026-11-03公开前端复核：`/auth`凭据步骤使用`#auth-email`（email）与`#auth-password`（password）及同表单唯一提交按钮，可能要求一次性验证码或恢复码。新本地版本可由管理员在本站卡片单独启用加密自动登录，仅固定HTTPS同源`/auth`、`data-step="credentials"`及无可见验证组件时尝试一次；成功按`/dashboard`积分元素核验，否则暂停并请管理员手动处理。不跨站共享凭据、Cookie或加密文件。真实账号自动登录与在线换版未验收。
