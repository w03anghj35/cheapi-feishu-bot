# 第三方依赖

本仓库不分发 node_modules 或 Electron 二进制，使用锁文件安装各依赖。此表为主要直接依赖索引，不替代依赖包内完整 LICENSE/NOTICE。

| 依赖 | 版本 | 用途 | 上游许可与来源 |
| --- | --- | --- | --- |
| Electron | 42.4.0 | Windows 桌面运行环境 | MIT；[electron/electron](https://github.com/electron/electron)，其 Chromium/Node 等组件有各自通知 |
| @larksuiteoapi/node-sdk | 1.76.0 | 飞书长连接/API适配 | MIT；[larksuite/node-sdk](https://github.com/larksuite/node-sdk) |

锁定的传递依赖以两份 package-lock.json 为准，许可证以实际安装包内容为准。没有复制飞书/平台网页、视频、图标或开源项目页面作为产品素材。业务应用源码为 `UNLICENSED`，不因依赖采用MIT就自动授予本项目MIT许可。

