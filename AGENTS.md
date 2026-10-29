# 飞书机器人维护约定

- 中文沟通。先读 README.md、docs/migration.md、docs/architecture.md。
- 本仓库仅包含 Windows Electron 管理端与飞书机器人，不包含账号池、MySQL或真实数据。
- `npm ci` 后执行 `npm run deps:bot`、`npm run runtime:install`；根与 key-tool 的 package-lock.json 分别锁定各自依赖，均应保留。测试前串行安装并校验 Electron，禁止由测试worker并发触发懒下载。
- 先运行 `npm test`、`npm run check`、`npm run check:release`。`npm run test:ui` 仅为隔离夹具，不证明真实飞书卡片渲染或注册成功。
- 禁止提交真实 App Secret、平台授权、密码、Cookie、创建账本、浏览器分区、日志、截图和本机运行目录。即使私有仓库也不能提交。
- 密钥只能由管理员在本机密码框输入。不能跨 Windows 用户/电脑复制密文并假设可解密。
- 未得到明确同意，不重启在线服务，不启用群申请，不提交真实注册/令牌创建。
- 只允许单机处理正式业务；本机连接锁不是跨机互斥。切换前必须停旧实例，新实例重新授权与确认绑定。
- pending/unknown 不能自动重试、删除账本或绕过；保留原件，先只读核对。源代码迁移不迁移业务保护状态。
- 不创建、启用或执行关机任务，不调用任何关机命令。

