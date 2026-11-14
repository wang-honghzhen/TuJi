# 图记

图记使用图文档、节点和关系组织笔记，提供画布编辑、聊天、探索和临时会话。界面使用 React、TypeScript 和 Vite，桌面入口使用 Electron，画布、会话和附件由本地 SQLite 服务维护。

## 下载 Windows 桌面版

从 [GitHub Releases](https://github.com/wang-honghzhen/TuJi/releases) 下载 `Tuji-版本号-win-x64-setup.exe`，双击安装后从桌面或开始菜单启动“图记”。支持 Windows 10/11 64 位，无需另行安装 Node.js。软件图标使用保留星空背景的白色树图，桌面窗口不显示默认英文菜单栏。

安装包内置简体中文、英文 OCR 模型。AI 功能仍需在首次启动时填写自己的服务地址、模型和 API 密钥。

安装时分别选择程序安装目录和“数据存储位置”，例如程序放在 `F:\Apps\Tuji`，数据放在 `F:\TujiData`。笔记、聊天记录、附件、连接配置及桌面缓存写入所选数据目录，两个目录不能互相包含。

首次安装的数据目录默认是 `%APPDATA%\QIXUE-v2`。升级默认沿用此前选择；此前使用默认位置的安装版也继续使用原数据目录。选择其他空目录会从空白数据开始，旧数据保留在原位置，不自动搬迁或合并。卸载默认保留数据。

目录设置保存在当前 Windows 用户的 `%APPDATA%\Tuji\data-directory.txt`（UTF-16LE），无需修改环境变量。若选定磁盘不可用，软件会提示恢复磁盘或重新选择目录，不会自动改用另一处空数据库。`QIXUE_DATA_DIR` 仍可用于临时覆盖。开发版本使用独立的 `.local/data`。

当前安装包未配置代码签名，Windows 会将发布者显示为未知发布者。

需要静默安装时，也可以指定数据目录（`/D=` 必须放在最后）：

```powershell
.\Tuji-0.2.0-win-x64-setup.exe /S /currentuser /DATA_DIR="F:\TujiData" /D=F:\Apps\Tuji
```

## 启动

需要 Node.js 24.13.0 或更高版本。

```powershell
npm ci
npm run dev
```

浏览器访问终端输出的地址，默认 `http://localhost:5173`。开发命令同时启动页面和本地服务，后端源码修改后会自动重载。

```powershell
npm run dev:desktop
```

以上命令在桌面窗口运行开发版本。构建和运行正式版本：

```powershell
npm run build
npm run desktop
```

当前源码的桌面窗口使用无边框界面。将鼠标移到右上角顶部 12 像素的区域，会显示唯一的透明最小化按钮，将主窗口收起为悬浮球；移开后隐藏。顶部其余区域可拖动窗口，双击可切换最大化／还原。键盘 Tab 也可进入窗口按钮，Esc 退出。浏览器运行时不显示这些桌面控件。软件图标的四角为透明圆角，由 `scripts/prepare-app-icon.mjs` 统一生成 PNG 和 ICO。

关闭或最小化主窗口后，图记保留在系统托盘，并显示可拖动、贴边半隐藏的圆形悬浮球。双击悬浮球恢复主窗口及原窗口尺寸、缩放；悬停显示笔记、新建极简会话及编号会话入口。使用过侧边页后，单击悬浮球恢复上次标签。托盘菜单中的“退出”才会保存编辑内容并关闭程序；安装维护也可运行 `Tuji.exe --quit` 正常退出。

用户笔记与临时会话共用右侧标签式侧边页，可调整宽度、整体窗口化或向右隐藏。“笔记”和“目录”两个入口常驻，目录派生标签可关闭并横向滚动；会话标签右侧可删除。原画布临时会话仍每画布最多三个，另有全局最多三个悬浮极简会话，编号不会随其他会话删除而改变。两组临时会话均沿用闲置一小时清理及运行中保护；切换窗口会交接未发送的文字、附件、笔记和阅读位置。

用户笔记保留连续页号，单页可以持续向下书写。通过 Ctrl+V 粘贴图片，选中后可拖动、缩放、裁剪、旋转或调整层次；图片区独占所在行。目录可以嵌套，但同层不混放目录与笔记页，每页只归属一个目录。打开含页目录始终新建标签，顶部展示路径和目录内页号，全局页号固定在底栏中央；退出重启会恢复标签与阅读位置。目录菜单直接提供“删除目录，保留笔记”和“删除目录及全部笔记”两个操作。

笔记搜索返回正文命中的页号与归属路径，不识别图片文字。画布工具栏与目录栏可搜索当前画布对象并定位，关系结果显示端点与方向。图文档栏支持图文档和待审核提交搜索，“AI 修改”栏也可以按关键词查找待审核内容。

执行 `npm run build` 后，`npm run test:notebook` 验证目录约束、图文编辑、两种删除、搜索、窗口交接及实际退出重启恢复；`npm run test:search` 验证当前画布范围、折叠对象和关系定位，以及图文档和待审核提交搜索。这些测试使用独立数据，不调用真实 AI，截图保存在 `.cache/`。

`npm run test:companion` 验证独立名额、清理、窗口切换、草稿及笔记保存、贴边和编号入口，测试使用独立数据，不调用真实 AI。桌面测试截图保存在 `.cache/companion-*.png`。

悬浮按钮展开后，球体、各按钮及其间的连接区域共同保持展开，离开缓冲区域约 300 毫秒后收起。透明空隙仍允许点击下方软件；主窗口的页面缩放不会改变悬浮球的尺寸和鼠标命中位置。拖至屏幕边缘后，图标和圆形外圈沿直径隐藏一半，露出的部分保持连续的半圆轮廓。

`npm run test:orb-native` 在 Windows 上用系统鼠标输入验证拖动、单击／双击、窗口切换后的首次点击、连续悬停、透明空隙穿透、删除和贴边操作。此测试使用独立数据，会短暂显示测试窗口并移动鼠标，完成后恢复鼠标位置；运行期间请勿操作鼠标。可追加 `-- --force-device-scale-factor=1.5` 验证另一档显示缩放，或 `-- --packaged release/win-unpacked/Tuji.exe` 验证打包程序。截图保存在 `.cache/orb-native-*.png`。

`npm run serve` 或 `npm run preview` 在浏览器中运行已构建版本。`npm run build` 同时执行 TypeScript 检查、页面构建和本地服务构建。

## 打包安装包和源码

在 Windows 上执行：

```powershell
npm ci
npm run package:win
npm run test:desktop
npm run package:source
```

输出位于 `release/`：

- `Tuji-0.2.0-win-x64-setup.exe`：给普通用户使用的安装程序，包含 Electron、页面、本地服务和 OCR 模型。
- `Tuji-0.2.0-source.zip`：给开发者使用的源码包，包含源文件、资源、需求与设计文档、构建配置和依赖锁定文件。
- `win-unpacked/`：用于本机验证的完整程序目录，不能只拷贝其中的 `Tuji.exe`。

首次打包需要联网下载 Electron、安装器工具及官方 OCR 模型；后续使用本地缓存。`npm run package:dir` 只生成程序目录，跳过安装器生成。打包版本号以根目录 `package.json` 为准。

`npm run test:desktop` 使用 `.cache/` 内的独立空数据目录验证打包后的桌面页面、本地服务、SQLite、PDF、OCR 和布局线程，不读取现有笔记或调用 AI。验证时窗口保持隐藏。

`npm run test:storage` 验证目录读取及失效处理；`npm run test:installer` 编译独立的 NSIS 测试程序，验证中文及空格路径、升级保留和错误路径处理，不修改真实安装配置。图标裁剪区域保存在 `scripts/prepare-app-icon.mjs`，打包前自动生成 PNG 和多尺寸 ICO。

安装包使用文件白名单；源码包也按明确的文件列表生成。两者均不携带 `.local`、个人数据库、聊天附件、真实 `api-config.json` 或加密凭据。`node_modules`、构建产物及 `release/` 不提交到 Git。

## 发布到 GitHub

仓库：[wang-honghzhen/TuJi](https://github.com/wang-honghzhen/TuJi)。源码放在仓库 Code 中，安装包和源码压缩包放在 Releases 中。

以后发布新版本时，先更新版本号、重新打包并验证，再提交源码：

```powershell
npm version patch --no-git-tag-version
npm run package:win
npm run test:desktop
npm run package:source
git add .
git commit -m "Release next version"
git push origin main
```

然后进入仓库的 **Releases → Draft a new release**，使用与 `package.json` 一致的版本标签（例如 `v0.2.0`），目标选择 `main`，填写说明并上传对应 `.exe` 和 `-source.zip`，最后发布。GitHub 也会按标签自动提供源码下载。不要将安装包作为普通源码提交到 Code。

参考：[GitHub 发布版本说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[electron-builder Windows 安装器](https://www.electron.build/nsis/)。

## 本地数据和模型配置

开发和未打包桌面版本默认使用 `.local/data`，可通过 `QIXUE_DATA_DIR` 指定独立数据目录。`QIXUE_PORT` 指定服务端口。桌面缓存位于数据目录的 `desktop-profile`，附件和自定义背景保存在 `artifacts`。

首次启动显示连接设置页，填写服务地址、协议、模型和 API 密钥后开始使用。通过界面输入的密钥在本机加密保存。数据目录中的 `api-config.json` 管理执行模型、可选摘要模型、联网服务和附件限制；修改后重启应用生效。根目录的 `api-config.example.json` 是不含有效密钥的格式示例。

- `execution`：执行模型，支持 `chat-completions` 和 `responses`。
- `summary`：可选独立摘要模型；为 `null` 时复用执行模型。
- `webSearch`：可选联网服务，默认关闭；独立服务需要单独配置连接。
- `attachments`：上传、文本分片和视觉读取限制。

在配置文件中手动填写的 `apiKey` 为明文，不应分享含密钥的配置文件。界面保存连接时保留文件中的其他高级参数。

普通会话左侧任务列表按最近一次正式组装的提示词更新；任务在执行中退出提示词时，标记会在下一次组装后同步变化。临时会话窗口不显示左侧任务列表。

极简临时会话仅支持上传图片，联网搜索由配置控制。记忆中每满十次对话进行压缩，压缩后携带最近五轮对话；按已完成任务计数，同一任务内的补充消息、工具调用和重试不增加轮数。压缩只裁剪后续模型输入，完整聊天记录仍可回看。

## 附件与 OCR

支持文本、Markdown、JSON、CSV、HTML、PDF 和常用图片格式。扫描文档可使用本地 OCR，先运行：

```powershell
npm run ocr:setup
```

默认准备简体中文和英文模型，可通过 `QIXUE_OCR_LANGUAGE` 选择 `chi_sim`、`chi_tra`、`eng`，以 `+` 连接。`QIXUE_OCR_DATA_DIR` 可指定模型目录。识别在本地进行；模型安装需要下载语言资源。

运行依赖、音效及其许可文件保留在项目中。用户数据、缓存和构建产物不属于源代码。
