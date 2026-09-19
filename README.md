# dsh-plugin-project

[English](README.en.md) · 简体中文

为 DeepSeek Harness 提供以项目为单位的资源、任务、记忆、技能和 MCP 管理。
一个项目可以组织多个独立仓库，Agent 获取当前项目的资源位置与已登记的记忆，任务和交付物可以随项目一起保存。

本仓库负责项目内能力。配套的 **dsh-project-desktop** 负责桌面窗口、创建项目引导、原生菜单和恢复流程；官方 Desktop 源码保持原样。

## 功能

- **资源**：关联本地目录或 Git 仓库，异步克隆、认证、取消、远端状态和同步操作。
- **任务**：独立于会话的任务记录、验收条件、交接信息、Git 提交引用和文件预览。
- **记忆**：在项目根 `memory/` 中维护长期知识，只有项目文件登记的内容进入上下文。
- **技能与 MCP**：项目级启用状态和共享声明，本机路径、环境变量与请求头单独保存。
- **项目会话**：按项目根目录限定会话列表、搜索和上下文，复用官方聊天与界面组件。

## 版本与状态

当前为早期开发版本，只适配 `stable` 通道：Desktop **2.0.11**、Harness **0.1.5-rc.2**。精确提交见 [upstream.json](upstream.json)。stable 是通道名称，不代表上游接口已长期稳定；beta 不属于当前支持范围。

本项目独立维护，不是 DeepSeek 或 Anywhere Labs 的官方产品。自有代码**暂不授予开源许可**；公开可读与使用许可的区别见下文。

## 本地开发

需要 Node.js `^22.19.0 || >=24.0.0`、npm、Git 和 tar。以下命令在本仓库目录执行：

```sh
npm ci
git clone --filter=blob:none --no-checkout https://github.com/anywhere-labs/dsh-desktop.git ../dsh-desktop-source
npm run setup -- --desktop ../dsh-desktop-source
npm run check
npm start
```

`setup` 只读取锁定的官方 Git 提交，校验 stable 元数据与运行时归档的 SHA-256，并在 `.dev/` 安装独立依赖。它不构建或启动官方桌面应用，也不读取源码目录的未提交修改。`npm ci` 后需执行 `setup`，才能取得匹配的完整官方开发类型。

`npm start` 默认打开虚构的 `examples/demo-web` 项目，终端打印本机 Web 调试地址。可指定其他项目和端口：

```sh
npm start -- /path/to/example/example.agent-project 43191
```

模型服务按需在官方设置页配置。测试不要求模型密钥，也不调用模型。开发依赖与 Profile 放在忽略的 `.dev/`；不要把个人配置写入示例。

## 项目结构

```text
example/
├── example.agent-project       # 项目定义（YAML）
├── resources/                  # 默认资源位置，可有多个独立仓库
├── memory/                     # 登记后加载的长期知识
├── tasks/<task>/               # 每个任务独立目录
│   ├── task.md                 # v3 任务记录
│   └── artifacts/              # 该任务的交付物
├── skills/                     # 项目技能及启用索引
├── mcp/servers.yaml            # 共享 MCP 声明
└── .agent-project/             # 程序数据；共享文件提交，本机与临时文件忽略
```

详见 [项目目录说明](docs/project-layout.md)。两个[示例](examples/)均为虚构内容，不包含真实服务或远端凭据。

## 桌面集成与验证

插件可独立调试；原生桌面体验由 `dsh-project-desktop` 提供。壳通过锁定的插件提交构建，修改插件不会自动替换正在运行的项目窗口。

```sh
npm run setup -- --shell ../dsh-project-desktop
npm run test:compatibility -- ../dsh-project-desktop
```

开发边界、检查命令及平台限制见 [开发说明](docs/development.md)。

界面开发须遵循 [前端组件与交互规范](docs/frontend-guidelines.md)，包括官方组件复用、表单/弹窗布局、滚动稳定性和验收要求。

## 权利与第三方代码

自有代码目前为**公开可读、保留其他权利**，未授予通用的使用、修改或再分发许可。详见 [LICENSE](LICENSE)；法律、托管平台条款及第三方许可证授予的权利不受该声明限制。`private: true` 防止误发布到 npm，不代表 Git 托管仓库必须私有。

复用的 DeepSeek Harness 和 DSH Desktop 材料保留各自 MIT 许可证与版权声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
