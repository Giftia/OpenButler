# Electron First-Run Productization Shell

OB-GOAL-022 把 OpenButler 从本地 Web 原型推进到 Windows 桌面产品壳。

## 产品目标

普通用户安装 OpenButler 后，不需要理解后端、端口、MineContext、PCActivity 或数据库。第一次打开时，用户只需要看懂三件事：

1. OpenButler 能整理什么。
2. 样例体验和真实本地模式有什么区别。
3. 真实模式会先检测和预览，确认后才开始整理。

## 桌面壳边界

本轮新增 `desktop/` Electron 应用。

- Electron 主进程启动本地 FastAPI 后端。
- 后端只绑定 `127.0.0.1`。
- OpenButler 数据放在 Electron `userData/data`。
- 前端通过 `window.openbutlerDesktop.apiBase` 连接本机后端。
- preload 只暴露服务状态、重启本机服务、选择本机记录目录、打开本地数据文件夹。

## 本地模式默认设置

桌面模式默认：

- `strict`
- 只读数据源
- `OPENBUTLER_DISABLE_SEED_EVENTS=1`
- 不复制截图
- 不调用外部模型
- 不调用外部 webhook
- 不自动导入真实事件
- 不读取真实活动标题、窗口标题、URL 或 raw output 用作桌面状态展示

选择本机记录目录只表示用户准备配置本地模式。真实整理仍要走“预览会读取什么 -> 用户确认 -> 再开始”的路径。

## 首次激活 V2

首次启动展示 5 步：

1. 看懂产品。
2. 选择样例体验或本地模式。
3. 确认隐私承诺。
4. 检测本地线索。
5. 预览后再开始。

用户可选：

- `先看样例`
- `让 OpenButler 整理我的本机记录`
- `稍后配置`

## 我的 OpenButler

`/me` 是普通用户的管理页。第一层展示：

- 本机服务状态
- 严格隐私
- 样例种子是否关闭
- 截图是否复制
- 外部模型是否允许
- 本地线索是否已选择

技术诊断、插件、OpenClaw、API、数据库信息仍放在高级与实验室。

## 不做的事

本轮不做：

- 代码签名
- 自动更新
- macOS/Linux 安装包
- 云账号体系
- 插件市场
- 新硬件接入
- 真实数据自动导入
- 截图复制或上传

## 验收

- `desktop/` 存在 Electron 主进程、preload、打包配置。
- `/api/desktop/status` 不返回真实活动标题、URL、截图路径或本地路径。
- `/me` 能解释当前是样例体验还是本地桌面模式。
- 首次激活流能说明连接后会得到什么。
- 商业概念 PPT 存在且不含真实用户数据。
- 前端 build、后端核心测试、桌面合同检查通过。
