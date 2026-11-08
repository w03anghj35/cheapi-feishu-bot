# 模块与接口

## 桌面与业务

- `group-settings-service.js`：管理员分组目录、精确用户定位、配置快照、独立修改账本、严格PUT与回读；`feishu-group-settings.js`：管理员分页倍率卡片与表单校验；`admin-group-settings.js`：独立别名发布与待核对记录入口。详见 [接口契约](group-settings.md)。
- `user-ownership.js`：按平台管理员与飞书目标群隔离的姓名档案、成员登记及管理员确认的稳定身份→档案绑定，本机加密追加记录兼容旧身份归属，追加完整修改快照与时间；只读分页查询平台用户、按余额排序。`ownership-draft.js` 加密暂存未保存表单并按范围恢复，`ownership-query-audit.js` 加密记录每次已绑定成员查询，日志故障时拒绝展示资料。查询要求目标群 @进入、私聊点击功能，未绑定者仅得到自己的显示名与待核对提示；已绑定者一键查归属，不接受自报姓名作为权限。`admin-user-ownership.js` 为管理员姓名建档、身份核对与绑定入口。见 [用户归属说明](user-ownership.md)。
- `daily-usage.js` 固定按用户 ID/北京时间自然日并发上限 2 路只读查询平台用户实付；`daily-usage-card.js` 生成为每归属人最近 3 天的纯文本分栏卡片，`daily-usage-store.js` 独立加密追加快照、群卡定时时刻、尝试/消息 ID。`daily-usage-publisher.js` 将本机约每小时历史采样与管理员设定的每日群卡发布分开；旧启用配置无定时时刻则不群发，结果不明停发。`member-usage-query.js` 为已绑定成员的本人实时私聊用量读取，历史仅用已固定快照；身份/归属在读数前后复核，加密查询审计区分余额与用量。`admin-daily-usage.js` 为管理员预览/设时/暂停入口；`daily-usage-history.js` 与 `admin-usage-history.js` 为历史周表与手动补采，`daily-usage-export.js` 从本机历史快照生成 Excel。群发布、私聊查询与原令牌/注册账本隔离。见[每日用量说明](daily-usage.md)。
- `daily-usage-review.js` 为管理员主进程的单笔人工核对流程：默认取消的系统确认、前后两次管理员和群范围核验；`daily-usage-store.js` 以一个加密事件同时保存人工未见声明并关闭群发布。`admin-daily-usage.js` 只展示白名单脱敏失败分类和核对入口，旧记录不补造错误码；此流程不调用飞书发送 API。见[每日用量说明](daily-usage.md)。
- `account-schedule.js`：管理员账号调度开关的一次性、双步骤本机计划；加密追加日志先记录尝试，再调用固定 `schedulable` 接口并回读。`admin-account-schedule.js` 为第九侧栏的账号列表、顺序和北京时间表单。见 [账号调度说明](account-schedule.md)。
- `key-tool/main.js`：业务 Electron 主入口、平台授权、同源请求、IPC和飞书业务连接。
- `admin.html/admin-renderer.js/admin-preload.js`：管理员分组、记录、飞书策略与绑定入口。
- `admin-navigation.js`：本机侧边栏栏目切换，保留原DOM草稿并设置hidden/inert隔离未显示栏目；离开秘密展示页清空内容并使迟到回执失效。它不是权限边界，主进程IPC与业务权限仍单独校验。
- `admin-operation-log.js`：白名单管理操作的脱敏追加日志、异步阶段关联与重开状态；`admin-operation-log-view.js`：第六栏目操作日志筛选；保存反馈与日志边界见[说明](admin-operation-log.md)。
- `service.js/disk-store.js/operation-history.js`：令牌创建及独立权威账本，先写pending再请求，结果未知不重放。
- `user-registration-service.js`：普通用户注册、字段白名单、并发与余额校验、独立账本。
- `feishu-bot-workflow.js`：发送者/私聊/准确群/当前卡片/nonce校验、会话、排队与两阶段确认。
- `feishu-features.js`：可维护功能菜单。新增业务应独立校验、账本、权限和回执，不复用其他业务额度字段。
- `feishu-registration-card.js/feishu-registration-flow.js/feishu-request-cards.js`：原生卡片表单、无秘密确认页、原令牌卡片。
- `feishu-connection.js/feishu-sdk.js`：飞书 SDK 长连接和受限私聊发送。
- `feishu-lease-recovery.js/recover-feishu-lease.ps1`：Windows 连接锁恢复；仅确认旧 PID 不存在时，以独占文件句柄再次核验、完整备份和移除旧锁。仍由原 `wx` 独占创建获得新连接权；异常状态保持保护，业务账本不参与恢复。
- `feishu-member-names.js`：只针对已绑定群的成员姓名分页缓存；新记录姓名快照与旧记录当前姓名投影、归属后台登记成员的当前群姓名投影，不改稳定身份或历史账本。归属投影按完整身份摘要对应，不按姓名或列表顺序猜测。权限与边界见[成员姓名](feishu-member-names.md)。
- `feishu-reconnect.js`：业务主进程独立于界面的连接守护，自动首次连接、退避重试、手动暂停与迟到授权隔离；只替换已安全停止的SDK实例，不重试业务请求。见[自动连接说明](auto-reconnect.md)。
- `feishu-main.js`：独立连接诊断入口，不承载正式注册/创建。
- `platform-error.js`：将平台创建错误的有限字段映射为固定安全类别，供注册与令牌私聊提示使用；不透传原始响应。见[失败提示规则](platform-error-messages.md)。
- `channel-monitor*.js`：五个固定来源的独立内置浏览器会话、成功后半小时串行调度、异常时每站2/5/10/15分钟退避复查、金额只读识别与本机名称配置；`channel-login-store.js`为每站管理员主动启用的自动登录分别保存 Windows 加密凭据，沿用 AeroRelay 原文件名以保留已有配置。管理页金额优先、登录设置默认收起；未登录/歧义明确显示，不自动重试已暂停的密码提交，安全边界见[渠道监控](channel-monitor.md)。
- `channel-alert.js`：可选 QQ SMTP 低余额提醒和北京时间每日五站汇总；低余额只接受本次成功读取结果，五站各自按加密保存的阈值比较。每日汇总只用近一小时成功读数，缺失标未知。两类发送分别在独立加密状态中先记尝试、结果不明不自动重发；另有管理员显式测试邮件，不更改正式去重。管理端设置与状态由 `admin-channel-alert.js`、管理员 IPC 提供；不接触创建业务账本。
- `channel-access.js`：本机加密的成员与渠道授权首版；只读查询按可信机器人账号与成员稳定标识过滤监控快照，拒绝未授权或过期读数。管理员界面 `admin-channel-access.js` 位于独立“渠道授权”栏，可配置、撤销及预览。尚无真实聊天身份绑定、CodexBridge/AI 接入或对外发送；不能把手工录入的身份视为已认证。见[渠道授权说明](channel-access.md)。
- 渠道页面的入口、指标、组件定位和升级步骤维护在[页面定位台账](channel-workflows/README.md)，具体来源按站点分文件；代码仍以`CHANNELS`与提取函数为执行依据，文档不携带真实业务金额或凭据。

## 外部接口与失败策略

平台固定源 `https://max.cheapi.cc`，主进程通过管理员首次本机登录获取授权，API使用Bearer认证且不混入Cookie身份；不把授权下放群成员。

- GET `/api/v1/auth/me`：验证当前管理员及绑定账户。
- GET `/api/v1/groups/available`：平台原始分组；实际路由以 `main.js` 与 `service.js` 为准。
- POST `/api/v1/keys`：白名单名称/分组/额度；业务记录先pending落盘，禁止自动重试创建。
- POST `/api/v1/admin/users`：只允许 `email,password,username,role,balance,concurrency,rpm_limit,notes`；role固定user、并发1–50、余额固定四档。
- GET `/api/v1/admin/accounts?page=N&page_size=100`、GET `/api/v1/admin/accounts/{id}`：只读账号与调度开关；POST `/api/v1/admin/accounts/{id}/schedulable`：仅计划执行器在同一管理员与持久尝试记录保护下发送布尔目标，回读确认后才进入下一步。
- GET `/api/v1/keys?page=1&page_size=100&search={encodedName}`，随后GET `/api/v1/keys/{id}`：仅按精确操作名称核对第一页最多100条；当前不自动遍历后续页，未唯一匹配时保持unknown，不能以猜测ID或广泛扫描代替精确核对。

飞书通过 `@larksuiteoapi/node-sdk` 长连接接收消息与卡片回调，无需本地公网回调端口。同步回调只校验和安全应答，异步队列推进；不持久化SDK原始事件/密码。短时去重和本机互斥不是跨电脑幂等保障。网络重连由连接模块受控处理，业务创建与私聊秘密交付不因超时自动重试。

管理员授权、飞书凭据/策略采用 Windows Electron `safeStorage`；不同入口的加密上下文分离。不要跨入口或跨机直接使用密文。

## 参考契约（2026-10-29）

- [飞书输入框组件](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input)：表单输入和密码遮挡；官方说明V6.8+，真实手机需另外验收。
- [飞书表单容器](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/containers/form-container)：`form_submit`、`action.form_value`，服务端严格白名单。
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)：沿原项目锁定1.76.0，保持已有JSON1.0卡片契约，不无关升级。

保留已有原生卡片与两阶段确认；未引入网页抓取、第三方卡片模板、AI自动代办或新的服务端框架。

