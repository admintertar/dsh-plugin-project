# 项目目录 / Project layout

项目入口只有根目录的 `名称.agent-project`（YAML）。资源与记忆路径以项目根为基准；任务产物路径以任务目录为基准。

The root `name.agent-project` YAML file is the project entry point. Resource and memory paths are relative to the project root; artifact paths are relative to their task directory.

| 路径 / Path | 用途 / Purpose | Git |
| --- | --- | --- |
| `name.agent-project` | 项目身份、资源与记忆清单 / Identity, resource and memory declarations | Share |
| `resources/` | 默认资源位置；各资源可使用独立仓库 / Default resource location; repositories remain independent | Per resource |
| `memory/` | 长期知识，仅加载登记文件 / Long-term knowledge; registered files only | Share |
| `tasks/<name>/task.md` | v3 任务记录，不绑定会话 / v3 task record, independent of sessions | Share |
| `tasks/<name>/artifacts/` | 报告、SQL、图片等交付物；代码用 Git 提交引用 / Deliverables; reference code by Git commit | Share |
| `skills/index.yaml`、`skills/<name>/SKILL.md` | 启用索引、技能定义与附属文件 / Enablement, skill instructions and supporting files | Share |
| `mcp/servers.yaml` | 共享服务声明 / Shared service declarations | Share |
| `mcp/local.yaml` | 本机环境、请求头、工作目录 / Local environment, headers and working directories | Ignore |
| `.agent-project/.gitignore` | 精确忽略规则，保留内部目录 / Precise ignore rules retaining the metadata directory | Share |
| `.agent-project/local.yaml` | 本机资源路径绑定 / Machine-local resource bindings | Ignore |
| `.agent-project/task-sources.yaml` | 可选的来源会话追溯 / Optional local session provenance | Ignore |
| `.agent-project/resource-transaction.json` | 临时恢复记录 / Temporary recovery journal | Ignore |
| `tasks/.write-lock`、`tasks/.write-lock.recovery` | 并发写入与恢复锁 / Write and recovery locks | Ignore |

不要忽略整个 `.agent-project/`。记忆默认为空，可按需创建 `memory/` 并登记；程序不会自动把整个目录注入上下文。项目配置不采用旧 `.agent-project/project.yaml` 格式。

Do not ignore `.agent-project/` as a whole. Memory starts empty and is created and registered as needed; the directory is not injected automatically. The old `.agent-project/project.yaml` entry format is not supported.

桌面壳创建的项目还会包含项目级与新资源级 `AGENT.md`、根 Git 和独立资源 Git。根目录的内部 `root` 绑定用于项目上下文与任务引用，不作为普通资源展示。根 Git 与资源 Git 各自管理远端；初始化不等于自动提交或推送。示例中的 `local` 资源只包含占位文档，不预置 Git 仓库。

Projects created by the desktop shell also have project/resource `AGENT.md` files and independent root/resource Git repositories. An internal `root` binding supports context and task references; it is not shown as an ordinary resource. Root and resource remotes are independent. Initialization does not commit or push automatically. The examples use local placeholder directories without pre-initialized Git repositories.
