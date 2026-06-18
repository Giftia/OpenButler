# Electron First-Run Productization Shell

OB-GOAL-022 把 OpenButler 从本地 Web 原型推进到 Windows 桌面产品壳。
OB-GOAL-023 在此基础上修复桌面空白窗口、托盘常驻、二次唤起和本地完全体激活缺口。

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
- preload 暴露最小桌面能力：服务状态、重启本机服务、选择本机记录目录、打开本地数据文件夹、MineContext 检测、安装程序选择、启动 MineContext、模型配置检查与确认写入。

## 桌面空白页修复

Electron `loadFile()` 打开本地 `index.html` 时，不能依赖 `/assets/...` 绝对路径。桌面构建通过 `OPENBUTLER_DESKTOP_BUILD=1` 生成 `./assets/...` 相对路径；Web/Vercel 构建仍保持普通 Web 路径。

桌面主进程还提供：

- 前端资源缺失时的可读错误页。
- `did-fail-load` 和渲染进程异常时的可读错误页。
- packaged app smoke，用于验证页面非空、桌面桥存在、`/health` 返回 strict。

## 托盘和二次唤起

Windows 桌面版默认常驻系统托盘：

- 关闭窗口会隐藏到托盘，不退出本机服务。
- 最小化会隐藏到托盘。
- 二次启动会唤起已有窗口。
- 托盘菜单包含打开 OpenButler、重启本机服务、打开本地数据文件夹和退出。

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

## 首次激活 V3

首次启动展示 6 步：

1. 看懂产品。
2. 选择样例体验或本地完全体。
3. 确认隐私承诺。
4. 检测 MineContext 是否运行。
5. 配置模型供应商。
6. 预览后再开始。

用户可选：

- `先看样例`
- `让 OpenButler 整理我的本机记录`
- `稍后配置`

本地完全体不会默认静默安装 MineContext。OpenButler 只自动检测；安装或启动需要用户明确点击。若仓库没有内置安装包来源，用户先选择安装程序或按说明手动安装。

## 模型供应商配置

首次激活和 `/me` 管理页提供模型配置入口。用户需要补充：

- 模型平台
- 模型 ID
- Base URL
- API Key
- Embedding 模型 ID
- Embedding Base URL
- Embedding API Key
- 是否使用独立 Embedding 配置

点击确认后，OpenButler 才会向本机 MineContext 后台写入配置。Key 不出现在状态接口、日志、PPT 或 Git 中。

## 我的 OpenButler

`/me` 是普通用户的管理页。第一层展示：

- 本机服务状态
- 严格隐私
- 样例种子是否关闭
- 截图是否复制
- 外部模型是否允许
- 本地线索是否已选择
- MineContext 后台是否运行
- 模型配置是否完成

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
- 静默安装 MineContext
- 自动获取或保存明文模型 Key

## 验收

- `desktop/` 存在 Electron 主进程、preload、打包配置。
- `/api/desktop/status` 不返回真实活动标题、URL、截图路径或本地路径。
- `/me` 能解释当前是样例体验还是本地桌面模式。
- 首次激活流能说明连接后会得到什么，并提供 MineContext 检测和模型供应商配置。
- 商业概念 PPT 改为高信息密度版本，且不含真实用户数据。
- 前端 build、后端核心测试、桌面合同检查、桌面资源路径检查和 packaged app smoke 通过。
