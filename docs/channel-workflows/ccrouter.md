# CC Router：剩余余额

- 站点：`https://ccrouter.ai`；目标页：`/dashboard`；未登录时进入同源`/login`。
- 指标：当前剩余余额（USD）。用户在2026-11-03明确把原`/usage`“总消费”改成`/dashboard`余额，两个数不能互用。
- 页面组件：仪表盘“当前余额 (USD)”旁的金额；当前公开页面资源`UsageView-B_gT0I-p.js`只用于反证`/usage`展示的是累计消费/实际成本，不作为余额源。
- 代码定位：`key-tool/channel-monitor.js`的稳定内部ID`spent-ccrouter`保留旧名仅为了复用本机浏览器分区，实际`metric`与`path`是权威口径；`observationScript`从余额标签的相邻金额取值，明确排除“总消费”和`/usage`。
- 验证：更正版加载后实际卡片已成功读取剩余余额；仍需按常规周期核对后续刷新。内部ID不能单独解释业务口径。
- 2026-11-03公开前端复核：`/login`表单使用`#email`（email）、`#password`（password）及唯一提交按钮，前端有可选验证组件与二次验证路径。新本地版本只在固定HTTPS同源`/login`、无可见验证组件时通过网站表单尝试一次；若展示验证组件、邮箱验证码、MFA或证书警告，停下交给管理员。成功仍须回到`/dashboard`并读到“当前余额 (USD)”，不把`/usage`总消费当作成功。真实自动登录和在线换版未验收。
