# 模块与接口

## 桌面与业务

- `key-tool/main.js`：业务 Electron 主入口、平台授权、同源请求、IPC和飞书业务连接。
- `admin.html/admin-renderer.js/admin-preload.js`：管理员分组、记录、飞书策略与绑定入口。
- `service.js/disk-store.js/operation-history.js`：令牌创建及独立权威账本，先写pending再请求，结果未知不重放。
- `user-registration-service.js`：普通用户注册、字段白名单、并发与余额校验、独立账本。
- `feishu-bot-workflow.js`：发送者/私聊/准确群/当前卡片/nonce校验、会话、排队与两阶段确认。
- `feishu-features.js`：可维护功能菜单。新增业务应独立校验、账本、权限和回执，不复用其他业务额度字段。
- `feishu-registration-card.js/feishu-registration-flow.js/feishu-request-cards.js`：原生卡片表单、无秘密确认页、原令牌卡片。
- `feishu-connection.js/feishu-sdk.js`：飞书 SDK 长连接和受限私聊发送。
- `feishu-main.js`：独立连接诊断入口，不承载正式注册/创建。

## 外部接口与失败策略

平台固定源 `https://max.cheapi.cc`，主进程通过管理员首次本机登录获取授权，API使用Bearer认证且不混入Cookie身份；不把授权下放群成员。

- GET `/api/v1/auth/me`：验证当前管理员及绑定账户。
- GET `/api/v1/groups/available`：平台原始分组；实际路由以 `main.js` 与 `service.js` 为准。
- POST `/api/v1/keys`：白名单名称/分组/额度；业务记录先pending落盘，禁止自动重试创建。
- POST `/api/v1/admin/users`：只允许 `email,password,username,role,balance,concurrency,rpm_limit,notes`；role固定user、并发1–50、余额固定四档。
- GET `/api/v1/keys?page=1&page_size=100&search={encodedName}`，随后GET `/api/v1/keys/{id}`：仅按精确操作名称核对第一页最多100条；当前不自动遍历后续页，未唯一匹配时保持unknown，不能以猜测ID或广泛扫描代替精确核对。

飞书通过 `@larksuiteoapi/node-sdk` 长连接接收消息与卡片回调，无需本地公网回调端口。同步回调只校验和安全应答，异步队列推进；不持久化SDK原始事件/密码。短时去重和本机互斥不是跨电脑幂等保障。网络重连由连接模块受控处理，业务创建与私聊秘密交付不因超时自动重试。

管理员授权、飞书凭据/策略采用 Windows Electron `safeStorage`；不同入口的加密上下文分离。不要跨入口或跨机直接使用密文。

## 参考契约（2026-10-29）

- [飞书输入框组件](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input)：表单输入和密码遮挡；官方说明V6.8+，真实手机需另外验收。
- [飞书表单容器](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/containers/form-container)：`form_submit`、`action.form_value`，服务端严格白名单。
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)：沿原项目锁定1.76.0，保持已有JSON1.0卡片契约，不无关升级。

保留已有原生卡片与两阶段确认；未引入网页抓取、第三方卡片模板、AI自动代办或新的服务端框架。

