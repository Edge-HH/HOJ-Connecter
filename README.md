<div align="center">

<img src="media/hoj-connecter.png" width="96" alt="HOJ-Connecter" />

# HOJ-Connecter

**在 VS Code 中使用 [Hcode Online Judge（HOJ）](https://github.com/HimitZH/HOJ)**

浏览题目 · 进入团队和比赛 · 编写代码 · 提交评测 · 查看结果 · 本地测试样例

[![Version](https://img.shields.io/badge/version-0.6.0-blue)](CHANGELOG.md)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.106-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#-简介)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

## 📑 目录

- [✨ 功能特性](#-功能特性)
- [📖 简介](#-简介)
- [📦 安装](#-安装)
- [🚀 快速上手](#-快速上手)
- [⌨️ 命令与快捷键](#️-命令与快捷键)
- [🤖 附加到 Codex / Claude](#-附加到-codex--claude)
- [🔐 登录与站点](#-登录与站点)
- [🧪 本地编译和测试](#-本地编译和测试)
- [⚙️ 配置](#️-配置)
- [🛠️ 开发](#️-开发)
- [📂 项目结构](#-项目结构)
- [🙏 致谢](#-致谢)
- [📄 许可证](#-许可证)

## ✨ 功能特性

- 🌐 **多站点 / 多账号**：自行添加任意 HOJ 站点，支持部署子路径与自定义 API 前缀，账号一键切换。
- 📚 **原生导航**：公共题单、公共比赛、团队题单与团队比赛统一在侧栏多级树中浏览、搜索和翻页。
- 🏆 **比赛模式**：支持私有 / 保护比赛密码，自动获取完整题单，侧栏与状态栏显示倒计时。
- 📝 **侧栏题面**：在右侧辅助侧栏渲染题面、公式、表格与样例，不占用编辑区标签。
- 🚀 **一键提交**：自动推荐提交语言，实时轮询评测结果，展示逐测试点与子任务详情。
- 🧪 **本地样例测试**：自动检测本机编译器 / 解释器，结果同步到 VS Code 原生测试面板。
- 🤖 **AI 求助**：将题面、代码与失败信息整理后附加到 Codex 或 Claude Code 会话。
- 🔒 **安全存储**：Token 与密码保存在系统钥匙串（`SecretStorage`），失效时自动续期。

## 📖 简介

插件不内置任何站点，首次使用时在侧栏点击“添加一个 HOJ 站点”填写 OJ 网址。

- 支持 **VS Code 1.106** 及以上，在 Windows、macOS、Linux 的桌面扩展宿主运行。
- 也可在 **Remote SSH / WSL** 的工作区扩展宿主运行，此时文件、网络与编译器均位于远端。

> [!NOTE]
> 本项目为独立社区插件，与 HOJ 官方无隶属关系。

## 📦 安装

1. 在 VS Code 扩展面板右上角选择 **从 VSIX 安装…**。
2. 选择项目生成的 `hoj-connecter-0.6.0.vsix`。
3. 安装后，活动栏出现 **HOJ-Connecter** 图标。

可直接覆盖安装旧版，已有站点、账号与文件关联会保留。

## 🚀 快速上手

1. **打开工作区**：打开存放代码的工作区文件夹，点击活动栏 **HOJ-Connecter**。
2. **选择站点与账号**：在 **OJ 导航** 顶部展开站点行，选择站点或账号。可保存多个账号，点击账号或“游客”切换；右键站点可编辑地址、API 前缀或删除。常用搜索和刷新保留在标题栏，管理操作位于展开菜单和右键菜单中。
3. **浏览题目**：**公共题单** 和 **公共比赛** 始终显示在一级菜单。展开题单可搜索、分页或按编号打开题目（团队题单的搜索为当前页筛选，比赛题单为完整题单筛选）。题面在编辑器右侧独立的 **HOJ-Connecter 题面与结果** 辅助侧栏展示，支持公式、表格和样例，不会打开或替换编辑区标签。只有点击 **以文件打开** 时，才在编辑区域打开只读 Markdown 文档。
4. **团队与比赛**：展开 **选择团队**，用复选框勾选一个或多个团队；也可在命令面板使用 **选择团队（可多选）** 或 **按编号添加团队**。每个选中的团队都会在一级菜单显示 **团队名 题单** 和 **团队名 比赛**，选择按站点和账号保存，各题单独立搜索、翻页。
   - 点击比赛进入，也可在导航标题栏“…”中输入比赛编号或完整网址。
   - 进入比赛会主动获取并展开完整题单，保留 `01` 等前导零题号；公共与团队入口继续保留，侧栏和状态栏显示比赛时间与倒计时。
   - 私有 / 保护比赛支持输入密码。退出比赛会返回所属团队，返回公共题单不会取消已选团队。访问和提交权限由服务器决定。
5. **关联题目文件**：选中题目后，展开该题下的 **题目文件**，点击 **新建题目文件**、**使用当前打开的文件** 或 **切换 / 选择其他文件**。同一道题可关联多个文件，当前选择的文件用于测试和提交；新建文件不会覆盖已有代码。
6. **提交语言**：根据关联文件、编辑器语言及题目实际允许的语言自动推荐，切换文件时自动更新。点击语言行可手动覆盖或恢复自动推荐。推荐考虑常见 C++20 特性与 Python2 语法线索；手动选择同一语言族内的具体版本时会记住设置。文件语言不在题目允许的列表中时会提示切换文件。
7. **提交评测**：点击 **提交评测**，自动保存关联文件并等待结果。结果默认显示在侧栏的 **结果** 页，包含分数、编译错误和 **测试点详情**：每个测试点的判定、得分、耗时、内存，以及服务器返回的具体错误 / 输出提示；支持子任务分组。
   - 展开 **我的提交** 可查看历史记录及其测试点详情。
   - 题目未开放详情、权限不足或接口失败时会显示原因，仍可查看提交总结果和可用代码。
   - 后台轮询不会强行切走你正在阅读的题面。取消等待不会撤销服务器上的提交。
8. **测试样例**：展开当前题目的 **样例**，一键填入或测试 `.in` / `.out`。导入和测试默认保留当前代码编辑位置；结果和输出差异在侧栏显示，同时写入 VS Code 原生测试面板，按需点击 **测试面板** 查看完整记录。

## ⌨️ 命令与快捷键

所有操作都可在命令面板搜索 `HOJ-Connecter`。当前编辑器打开的是已关联的代码文件时，显示提交 / 测试按钮并启用快捷键，无关文件不会显示这些入口。

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 提交评测 | `Ctrl+Alt+Enter` | `Cmd+Alt+Enter` |
| 测试样例 | `Ctrl+Alt+T` | `Cmd+Alt+T` |

> [!TIP]
> “在右侧栏查看题面”会自动展开阅读视图并等待题面渲染完成；升级后若视图位置或显示状态异常，可在命令面板执行 **HOJ-Connecter: 恢复题面侧栏**，将阅读视图恢复到右侧辅助侧栏，不会打开编辑区文档。

## 🤖 附加到 Codex / Claude

安装并启用 **Codex**（`openai.chatgpt`）或 **Claude Code**（`Anthropic.claude-code`）后，侧栏题面底部会显示对应的 **附加到 Codex** / **附加到 Claude** 按钮。两个扩展独立检测，安装或移除后会更新入口。

未 AC 的最终评测结果（含部分通过、编译错误、运行错误、超时等）以及失败的本地样例也会显示这些按钮；AC、等待评测和比赛信息不显示。

点击后将完整题面、样例、相关代码、逐测试点结果及错误提示 / 输出差异和中文求助要求整理为文件，附加到对应助手的会话输入区，请确认后发送：

- 题面使用关联文件的当前内容（包括未保存修改）。
- 结果使用本次提交 / 测试的代码，避免把后来修改的代码当作失败代码。
- 历史提交优先使用服务器提供的代码和题号，无法取得题面时仅附加可用结果。

上下文文件保存在所选工作区的 `.hoj-connecter/ai-context/`，每次点击独立生成，后续操作不会覆盖之前附加的内容。需要打开受信任的工作区。Claude 的附加命令读取当前编辑器，因此会打开上下文文件供你查看；Codex 直接接收文件 URI。两个入口均使用扩展自带命令，无需配置 API Key；如果助手尚未登录，请在对应扩展中登录。扩展版本不提供所需命令时会提示更新。

## 🔐 登录与站点

### 用户名与密码

标准 HOJ 使用 `/api/login` 返回的 `Authorization` Token。使用用户名和密码登录时，Token 与密码均由 VS Code `SecretStorage`（系统钥匙串）保存，不写入工作区设置。

- 登录失效（HTTP 401）时插件自动用保存的密码重新登录并重试原请求，多个并发请求只登录一次。
- 移除账号或更改站点地址时一并删除。
- 账号节点和当前会话行提供“重新登录”按钮：有保存的密码时直接续期，否则预填用户名后输入密码或改用浏览器 Token；重新登录同一账号会保留当前团队、比赛和题目。
- 账号信息和站点保存在用户全局状态中；题目文件关联和样例路径保存在工作区状态中。站点、账号、团队、比赛之间的文件关联相互独立。

### 浏览器 Token

如果站点有验证码或统一身份认证，选择 **浏览器 Token**：先在浏览器登录，在开发者工具的 **Application → Local Storage** 复制 `token` 值，再粘贴到插件密码输入框。插件先验证权限，再由服务器返回当前登录账号的资料。

标准 HOJ 支持自动续期；浏览器 Token 过期后无法自动重新登录，请点击账号旁的“重新登录”。切换账号后会恢复该账号已选的团队，并清除当前比赛与题目。

### 站点设置

支持每个站点设置网址（含部署子路径）和 API 前缀，默认 `/api`。请求使用填写的 HTTP / HTTPS 地址，不自动改写协议，也不关闭 TLS 验证。更改地址时移除原站点保存的 Token。自定义登录协议、额外请求头或非标准 API 需另行适配。

## 🧪 本地编译和测试

### 工具链检测

点击“一键测试样例”时，插件会自动检测并选择机器上已安装的编译器 / 解释器，优先级如下：

1. 当前文件所在文件夹（直到工作区根目录）`.vscode` 中已有的运行配置：`tasks.json`（默认生成任务优先）、`launch.json` 的调试器路径和 `c_cpp_properties.json` 的 `compilerPath`；
2. Code Runner、C/C++、C/C++ Runner 和 Python 扩展中配置的工具路径；
3. PATH 和常见安装目录，包括 Windows 的 MSYS2 / MinGW / LLVM、Python、JDK、Go、Rust 等位置。

检测会检查工具能否启动并报告版本，跳过失效路径和 Windows Store 的 Python 安装占位程序。

在“当前题目 → 样例 → **选择 / 配置本地编译器**”、导航栏更多操作菜单，或命令面板运行 **HOJ-Connecter: 选择 / 配置本地编译器**，可以查看检测到的路径和版本，也可以浏览其他安装位置。选择后保存到当前文件夹的 `hoj-connecter.runners`，以后测试优先使用该设置；清除对应扩展名的配置即可恢复自动检测。编译器无需加入系统 PATH，测试时会将所选工具目录加入子进程 PATH，供工具及其运行库使用。测试结果中会显示实际选用的工具路径。

### 默认运行器

| 文件 | 本地工具 |
| --- | --- |
| `.cpp` / `.cc` / `.cxx` | GCC `g++` 或 `clang++`，C++17，`-O2` |
| `.c` | GCC `gcc` 或 `clang`，C17，`-O2` |
| `.py` | Python 3 / PyPy3；Windows 支持 `py -3` |
| `.js` | `node` |
| `.java` | 同一 JDK 中的 `javac` / `java`，按文件名运行类（例如 `Main.java`） |
| `.go` | `go build` |
| `.rs` | `rustc` |

> [!IMPORTANT]
> 本地工具版本、编译选项和 OJ 的评测环境可以不同。例如选用 C++20 时应配置本地编译器为 `-std=c++20`；Python2 需自行配置相应解释器。

- Windows 上已安装的 Visual Studio / Build Tools 的 MSVC（`cl.exe`）会通过 vswhere 自动检测，并在 Developer Command Prompt 环境中编译；默认生成任务使用 `cl.exe` 或 C/C++ Runner 开启 `useMsvc` 时优先选用，并为 MSVC 提供 `<bits/stdc++.h>`。
- C#、Ruby 等工具链仍可通过自定义运行器使用。
- Windows 推荐安装 MSYS2 / MinGW 的 GCC 工具链；使用 Clang 需同时具备所需的 C/C++ 标准库和 SDK。
- Remote SSH / WSL 中检测和执行的是远端工具。

### 测试行为

输出比较可选 `trimEnd`（忽略行尾空白和末尾换行）、`tokens`（忽略空白差异）、`exact`（统一换行后严格比较）。测试时读取编辑器中的样例内容，重新导入会先确认是否覆盖修改过的样例。单次编译后运行所选样例，支持取消、时限、输出上限和进程树终止。标准文件 IO 题会在每个样例独立的临时目录中读写指定文件；交互题、自定义 checker / SPJ 和附加数据文件不在本地模拟。

### 通过代码与模板

新建或关联题目文件后，题面底部和“题目文件”菜单提供“获取最后一次通过的代码”和“重置为模板”。获取通过代码需要登录，读取当前账号在当前题目 / 比赛下的最后一次 AC；语言与当前文件不兼容时会提示更换文件。重置使用当前提交语言的题目模板，站点未提供时使用默认起始模板。两项操作都会先提示将覆盖当前代码（包括未保存修改），取消后保留原文；确认后可撤销，检查后自行保存。

### 文件位置

默认代码位于 `.hoj-connecter/solutions/`，样例位于 `.hoj-connecter/samples/`；可通过 `hoj-connecter.solutionDirectory` 更改代码目录。临时编译产物保存在扩展存储目录，运行结束后清理。

> [!WARNING]
> 本地测试结果只代表公开样例，最终结果以 OJ 为准。编译和运行的是本机程序，不是沙箱；仅在受信任工作区启用创建、提交和运行操作。

## ⚙️ 配置

在用户或工作区 `settings.json` 中按文件扩展名覆盖运行器：

```json
{
  "hoj-connecter.defaultLanguage": "C++ 20",
  "hoj-connecter.runners": {
    "cpp": {
      "compile": ["g++", "${file}", "-std=c++20", "-O2", "-o", "${output}"],
      "run": ["${output}"]
    },
    "py": { "run": ["C:/Python313/python.exe", "${file}"] }
  },
  "hoj-connecter.sampleTimeoutMs": 5000,
  "hoj-connecter.compileTimeoutMs": 30000,
  "hoj-connecter.sampleComparison": "trimEnd"
}
```

| 变量 | 含义 |
| --- | --- |
| `${file}` | 代码绝对路径 |
| `${dir}` | 代码所在目录 |
| `${stem}` | 不含扩展名的文件名 |
| `${output}` | 临时可执行文件 |
| `${buildDir}` | 临时构建目录 |

每个参数单独传递，路径带空格无需添加引号，命令不经过 shell。需要 shell 时可明确配置 `bash -c` / PowerShell 等程序。

## 🛠️ 开发

```sh
pnpm install     # 安装依赖
pnpm build       # 构建扩展
pnpm check       # TypeScript 类型检查
pnpm test        # 单元测试
pnpm test:live   # 真实站点只读检查
pnpm package     # 打包 VSIX
```

构建后按 <kbd>F5</kbd>，选择“运行 HOJ-Connecter 插件”即可调试。问题排查查看 **输出 → HOJ-Connecter**。

<details>
<summary><b>集成测试</b></summary>

- `test:live` 仅发送只读请求，需用环境变量 `HOJ_CONNECTER_SITE` 指定要检查的站点地址，未设置时直接退出。
- Windows 可在 `pnpm test` 构建测试后执行以下命令，在独立 VS Code 配置和临时工作区运行集成测试；可用 `-VSCodeExecutable` 指定安装位置。测试记录保留在 `.test-host/`。

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/test-host.ps1
  ```

- 附加 `-AssistantFixtures` 可加载隔离的 Codex / Claude 命令替身，验证安装检测、按钮、错误上下文、未保存代码及两种附加方式，不连接真实 AI 会话。
- 授权的真实账号验证使用 `-TestSuite live-host.test.js`，从临时环境变量 `HOJ_CONNECTER_SITE`、`HOJ_CONNECTER_LIVE_CONTEST`（比赛编号）、`HOJ_CONNECTER_LIVE_USERNAME` / `HOJ_CONNECTER_LIVE_PASSWORD` 读取站点与凭据，只验证题单与题面，不会提交代码。

</details>

## 📂 项目结构

```text
HOJ-Connecter/
├─ src/                扩展源码，入口为 extension.ts
├─ test/               单元测试（core.test.ts）与 VS Code 扩展宿主集成测试
├─ scripts/            构建、真实站点只读检查和集成测试启动脚本
├─ media/              侧栏样式与活动栏图标（media/katex/ 由构建生成）
├─ .vscode/            调试与构建任务配置
├─ package.json        扩展清单：命令、视图、设置和脚本
└─ CHANGELOG.md · LICENSE · THIRD_PARTY_NOTICES.md
```

接口适配依据 [HOJ 上游前端 API](https://github.com/HimitZH/HOJ/blob/master/hoj-vue/src/common/api.js) 与后端数据结构。导航、选择、文件编辑和测试使用 VS Code 原生 API；富文本题面与结果在侧栏 WebviewView 中只读渲染，使用 VS Code 主题变量，Markdown 与公式资源均随安装包提供，无外部脚本或 CDN。

## 🙏 致谢

- [HOJ](https://github.com/HimitZH/HOJ) —— 开源的在线评测系统。
- 第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

源码仓库：[Edge-HH/HOJ-Connecter](https://github.com/Edge-HH/HOJ-Connecter)
