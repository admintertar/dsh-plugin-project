# 多会话并发写入约束（产品设计）

Multi-session write concurrency: product constraints and enforcement points.

状态：设计草案，未实现。目标是把「多个会话同时改同一个项目」从**靠 Agent 自觉**变成**产品强制**。

## 0. 结论摘要

1. 冲突有三类，必须分开治理：**提交范围被污染（A）**、**他人未提交改动被覆盖（B）**、**同分支提交交错（C）**。
   `git worktree` 只解决 A/B，并把 C 转成「分支归并」问题。
2. **项目资产仓库（项目根：`tasks/`、`skills/`、`memory/`、`mcp/`、`skills/index.yaml`）永不做 worktree。**
   技能、任务、记忆、资产面板、`AGENTS.md` 全部绑定「项目根路径」，一会话一工作树会让项目资产分叉。
3. 真正缺的不是隔离，而是**写入所有权**：目前 Agent 用裸 git 提交，绕过了 Host 已有的锁、
   `git-index-dirty` 拒绝与 revision 校验（见 §2）。
4. 落地顺序：**P0 提交守卫** → **P1 Host 提交通道（模型工具）** → **P2 可见性/提示** → **P3 隔离模式（自动 worktree）**。
5. 「模型自动用 worktree」不能靠提示模型自觉：DSH 的 `session.header.cwd` 是**创建时冻结的元数据，没有原地切换目录的能力**
   （system prompt 的 `{{cwd}}`、shell 默认 workdir、sandbox root 都由它派生）。产品层只有两条路：**fork 会话**
   （`agents.create` + `meta.cwd`）或**不切 cwd、模型在 worktree 的绝对路径下工作**（§4.4）。
   强制点用官方扩展点 `tools/pre-execute` / `ctx.tools.guard()`，不是写进提示词。

## 1. 问题定义

| 类型 | 现象 | 本次实证 | 直接原因 |
| --- | --- | --- | --- |
| A 提交范围污染 | 别人的未提交改动被自己的提交带走 | 差点把壳仓库其他任务的改动一起提交 | 共享工作树 + `git add -A` |
| B 他人改动丢失 | 别人正在编辑的文件被改写/回退 | 我重置共享文件后，另一会话提交，12 行断言既未提交也从工作树消失 | 重置/覆盖共享工作树文件 |
| C 提交交错 | 自己的改动落进别人的提交，历史语义错位 | 我的 3 条断言进了他人的 `d6da5b6` | 共享 HEAD/index，无提交互斥 |

注入点：多个 Agent 会话共享**同一个物理工作树**，且都能执行任意 git 命令。

## 2. 现状盘点

已经存在、但只在 Host 通道内生效的机制：

| 机制 | 位置 | 提供什么 |
| --- | --- | --- |
| 仓库级串行锁 | `resource-sync.ts` `lockRepository()`：锁 key = `git rev-parse --git-common-dir` | 同仓库（含 linked worktree 共享 refs）的写操作串行；不同 clone 独立。**已为多 worktree 预留语义** |
| 预暂存拒绝 | `resource-sync.ts` `commitProjectSelection()`：`git diff --cached` 非空 → `git-index-dirty` | 别人的 staged 内容不会被顺带提交 |
| 乐观并发 | 同上：`assertRevision` + `git-state-changed` | 提交前仓库被改动会报错而不是静默继续 |
| 单资源互斥 | `resource-sync.ts`：`this.active.set(id, …)` → `git-sync-busy` | 同一资源的并发操作互斥 |
| 跨 Host 排他锁 | `task-lock.ts` `withTaskWriteLock()` | 文件锁 + PID/hostname 存活检测 + 陈旧锁回收 + 「模糊所有权永不接管」 |
| 面板资产提交 | `ProjectChangesPanel` → `/changes` | 按资产提交、提交计划预览、（技能索引）精确内容暂存 |

缺口：

1. **模型没有提交通道**：`task-tools.ts` / `memory-tools.ts` 有工具，但资源、项目资产的提交只有 HTTP 路由与 UI，Agent 只能裸 git。
2. **服务不可共享**：`ResourceSyncManager` 在 `resource-api.ts` 内部创建（`index.ts:47` 只拿到 `clones`），模型工具拿不到同一条通道。
3. **没有写入所有权**：无法声明"这些文件属于我"，`git add -A` 语义上就把工作树里的一切当自己的。
4. **隔离硬绑定**：壳 `desktop-adapter/index.mjs` 以 `cwd: projectRoot` fork 每项目一个 Host；
   插件 `session-capabilities.ts` 硬校验 `observation.header.cwd !== root → 404 project-session-unavailable`。
   会话级工作目录既不是现在的形态，也不是靠 Agent 建目录能绕过的。

## 2.5 DSH 可挂载点与生态先例

官方**没有** worktree 能力（`node_modules/@deepseek-ai` 全量 grep `worktree` 零命中），但提供了足够的产品级挂载点；
社区已有可对照、甚至可复用的实现。

官方扩展点（seam 名称取自 DSH 实际实现，社区守卫插件已在用）：

| 扩展点 | 能做什么 | 对本设计的意义 |
| --- | --- | --- |
| `tools/pre-execute` / `tools/post-execute` / `tools/result` | 工具调用前拦截、调用后处理、结果只读观察 | **写操作前置条件的强制点**（未进入隔离工作树则 `ask`/`block`） |
| `ctx.tools.guard()` | deny-only 单调守卫 | 约束一旦成立不可被后续步骤放宽 |
| `agent/pre-step`、`agent/turn-stopping`、`agent/session-start`、`subagent/start`/`end` | 轮次、停止边界、会话启动、子代理生命周期 | 会话启动或首个改动轮注入约束 / 建工作树 |
| 决策 `allow` / `ask` / `block` / `warn` | `ask` 走 harness 原生审批服务 | 交互式用 `ask`，强约束用 `block` |
| system prompt 注入 | 把当前生效规则告知模型 | 「机制强制」与「模型知情」两层都要有 |
| `dsh-hook-protocol` + `dsh-hooks-claude-code` / `-codex` | 兼容 Claude Code / Codex 的 hook 配置（`PreToolUse` 等，含 `permissionDecision: allow/deny/ask`） | 社区 hook 方案可直接迁移；`PreToolUse` 确能拒绝工具调用 |
| `dsh-permission-presets`、`dsh-sandbox-policy` | 按会话/预设设置权限与沙箱模式 | 「隔离模式」可以做成会话级预设 |
| `workspaceRegistry` / `workspace-files` | 为目录注册 Workspace 并把会话挂上去 | worktree 目录可被产品登记 |

生态先例（社区插件）：

| 插件 | 形态 | 关键做法 |
| --- | --- | --- |
| `dsh-worktree-jump` | 新会话界面按钮 → **fork 会话到 worktree** | 实证 `session.header.cwd` 冻结；唯一入口是 `agents.create` + `meta.cwd`；用 Workspace 承载 worktree |
| `dsh-task-worktree` | **任务级 worktree**：不切会话 cwd，模型用绝对路径在 checkout 内干活，会话头打 branch badge；`worktree_create/list/status` 是模型工具，`finish`/`bring-back`/`remove` **人类专属**；per-repo manifest 跨重启存活 | 「交付与清理由人类控制」的产品原则；不切 cwd 恰好绕开 `session-capabilities.ts` 的 `cwd === root` 校验 |
| `dsh-worktree` | Codex 风格永久 worktree：`worktree_create/list/remove` 工具 + `/worktree` 命令 + manifest | 工具化形态 |
| `deepseek-harness-security-guard` | 规则表 + `allow/block/ask/warn`，绑 `tools/pre-execute`、`agent/pre-step`、prompt 注入、`ctx.tools.guard()`，带审批、审计与面板 | 证明「从产品角度约束模型」在 DSH 上已被完整实现过一次，可作为本设计的实现范本 |

### 已实证：拒绝链路真的可用（2026-09-23 探针）

用 `@deepseek-ai/dsh-agent-loop-testkit` + `@deepseek-ai/dsh-tools` 在**真实运行时**上跑了一次最小探针
（脚本与输出：`tasks/多会话并发写入约束：提交守卫与 Host 提交通道/artifacts/hook-deny-probe.mts` 与 `hook-deny-probe.log`；
把脚本放回插件仓库根、`node node_modules/tsx/dist/cli.mjs <脚本>` 即可重现）：

| 场景 | 结果 | 工具体是否执行 |
| --- | --- | --- |
| 无守卫 | `isError: false`，返回 `{"wrote":"a.ts"}` | 是 |
| `ctx.tools.guard()` 返回拒绝理由 | `isError: true`，内容 `Error: denied: create a worktree first` | **否** |
| 用 disposer 释放守卫后 | 恢复成功 | 是 |
| `tools/pre-execute` 返回 `{kind:'ask'}` 且无审批服务 | `isError: true`，`Error: run in a worktree?` | **否** |

结论：

1. 「未进入隔离工作树的会话不得写目标仓库」**可以机械强制**；模型收到的是可读的拒绝理由，不是静默失败。
2. `ask` 在缺少审批服务时**降级为拒绝**（fail-closed），不会退化成放行——这正是产品约束需要的语义。
3. **`tools/pre-execute` 不能改写工具输入**（官方注释：arguments are already logged and presented；`PreToolDecision` 只有 `allow`/`deny`/`ask`）。
   产品**无法**"悄悄把这次写入重定向进 worktree"，强制只有两种形态：**拒绝 + 指引模型先建工作树**，或 **fork 会话让路径天然就是 worktree**（§4.4 的形态 A）。

### 复用评估结论：现成插件只能借鉴，不能直接依赖（2026-09-23，读源码后）

对 `dsh-task-worktree`（最新 0.4.2，MIT，2026-09-08）逐个核对源码后的结论：**不采用直接依赖，仅借鉴设计；P3 落地时小范围 fork（≈4–5 人日）**。

阻断项（按严重度）：

1. **peer 版本不满足 + `dsh plugin add` 的 pnpm 转发会装出第二份 harness**：它声明 `@deepseek-ai/*: ^0.1.2-rc.1`，而本机 harness 是 **0.1.5-rc.2**——
   预发布版本必须落在 range 中带 prerelease 的同一元组内，实测 `^0.1.2-rc.1` 既不接受 0.1.5-rc.2 也不接受 0.1.6-alpha.1。
   `dsh plugin add` 实为转发 pnpm，auto-install-peers 默认 true，会把 0.1.2 线 harness 装进 profile 形成**第二实例**；
   按它自己的 README，这会使 `TOOL_RUNTIME_SCHEDULER` 的 unique symbol 分裂、工具调用整体失效。
2. **没有"仓库排除"概念**：会在项目根建 worktree 并向 `.gitignore` **追加** `.dsh-worktrees/`，弄脏主工作树——正好撞上我们自己的 `git-index-dirty` 拒绝。
3. **仓库只由会话 cwd 推导**：根会话无法为 `resources/dsh-plugin-project` 建 worktree（不过其 `manager.create({cwd})` 接受任意 cwd，fork 改造成本低）。
4. **收尾走裸 git**：`finish`/`bring-back` 直接 `git add -A && git commit` / `git merge --no-ff`，绕过 Host 资源通道（无仓库锁、无 revision 校验、无 index 审计）。
5. **"人类专属"只是命令面分离**：模型仍可用 bash 自行 `git merge` / `git worktree remove`；真正的机械点必须是我们自己的 `ctx.tools.guard()`。

值得借鉴（进 P3 设计）：

- per-repo manifest + tmp/rename 原子写 + 按 `git worktree list --porcelain` 剔除失效记录；
- **用 `.git/info/exclude` 而不是改 `.gitignore`**（同生态 `dsh-worktree-jump` 的做法，不弄脏被跟踪文件）；
- 不切 cwd、模型用绝对路径在 checkout 内工作；会话头 branch badge；
- 人类专属命令面 vs 最小模型工具面（只把 `create`/`list`/`status` 给模型，收尾不给）；
- manifest 无跨进程锁 → **多会话并发 create 会互相覆盖**，我们要补锁（复用 §2 的 `withTaskWriteLock` 语义）。

补充结论：**worktree 的独立 index 天然消除"多会话 index 撞车"**——恰是 P0/P1 的痛点之一，所以两者是互补而非替代：
P3 上线后 P0 守卫仍需要（在同一个 worktree 内裸 `git add -A` 一样会吞掉他人的改动，只是范围小一个数量级）。

其它候选：`FlashingChen/dsh-worktree` 把 `worktree_remove` 做成**模型工具**（违反人类专属收尾），且真装 `@deepseek-ai/*` 依赖（重复基础设施）；
`frederico-kluser/dsh-worktree-jump` npm 包 404 / private / node ≥ 24 / 需构建，且形态相反（fork 会话把 cwd 移进 worktree）。

## 3. 产品约束（CONSTRAINTS）

每条包含：约束、强制点、违反时的行为。

| ID | 约束 | 强制点 | 违反行为 |
| --- | --- | --- | --- |
| C1 | 提交必须声明路径集合，禁止 `git add -A` / `git add .` | 提交守卫 + 工具 schema（`paths` 必填，≤500，且经 `safeChangePath`） | 拒绝提交，返回 `resource-target-invalid` |
| C2 | 提交前 index 必须干净 | Host（已有）与守卫（新增，CLI 层同样检查） | `git-index-dirty` |
| C3 | 提交必须在锁内串行执行 | 守卫文件锁；Host 侧 `lockRepository` | 等待或 `git-sync-busy`（不静默并写） |
| C4 | 不得改写工作树中未暂存的他人改动 | 守卫：提交前后快照工作树 diff 集合，只允许"减少自己的部分" | 中止提交并列出被影响的路径 |
| C5 | 共享文件（`skills/index.yaml`、`mcp/servers/*.yaml`）必须经 Host 精确暂存 | 已有 `stageSkillIndex` / staged 分支 | 回退到按路径提交前先做归属判定 |
| C6 | 项目资产仓库禁止 worktree | 文档 + 壳/插件：拒绝把项目根指向 worktree（`git rev-parse --git-common-dir != --git-dir` 时警告） | 打开项目时提示不受支持 |
| C7 | 提交必须能被审计归属 | 提交记录/回执携带 session 或 operationId（可选 trailer） | 面板显示"来源未声明" |
| C8 | 有他人未提交改动 / 有人正在写时必须可见 | 面板与资源卡片状态 | 显示"另一个会话正在写"提示 |

约束的呈现位置（三处必须一致）：

1. 插件 `docs/session-concurrency.md`（本文）；
2. 项目 `AGENT.md` 的「仓库边界/验证」段落增补提交纪律，并指向 `skills/git-pitfalls`；
3. 模型工具描述（`defineTool` 的 description）—— 约束要写进工具自己会读到的地方。

## 4. 机制设计

### 4.1 P0 提交守卫（`scripts/commit-guard.mjs`，本地、无运行时依赖）

形态：一个包装命令，Agent 与人都用它提交，而不是裸 `git commit`。

```
node scripts/commit-guard.mjs --message "…" --paths a.ts b.ts [--repository <path>]
```

步骤：

1. 解析仓库（默认当前目录），取 `git rev-parse --git-common-dir` 作为锁 key；
2. 获取文件锁 `<common-dir>/dsh-commit.lock`（语义照搬 `withTaskWriteLock`：PID + hostname + 存活检测 + 陈旧回收 + 模糊所有权不接管）；
3. 校验 `git diff --cached --name-only` 为空（C2）；
4. 校验 `--paths` 全部经 `safeChangePath` 等价规则（相对、无 `..`、无驱动盘、无控制字符）；
5. **快照工作树**：记录 `git status --porcelain=v2` 全集，提交后重算，断言"未在 `--paths` 内且未 staged 的路径状态没有从有改动变成无改动"（C4：绝不替别人清理工作树）；
6. `git add -- <paths>` → 再次断言 staged 集合 ⊆ `--paths`（防止 pathspec 意外扩大）；
7. `git commit --no-verify -m …`（沿用现有约定：跳过 hooks，自建校验在 6 之前完成）；
8. 输出回执 JSON（提交 hash、文件列表、耗时、锁等待时长），供 Agent 写进任务记录的 `type: commit`。

为什么不做成 git hook：本仓库大量提交带 `--no-verify`，hook 会被绕过；守卫必须是**唯一入口**而非补丁。

### 4.2 P1 Host 提交通道（模型工具）

目标：让 Agent 的提交与面板提交走**同一把锁、同一套校验**，从而跨会话串行。

改动点：

- 把 `ResourceSyncManager` 的构建从 `resource-api.ts` 提升到 `index.ts`，同时传给 `registerResourceApi` 与新的工具注册函数（保持参数对象向后兼容）。
- 新增 `registerProjectCommitTools(ctx, services)`，工具草案：
  - `project_resource_commit`：`{resourceId, paths[], message, expectedRevision}` → 复用 `commitProjectSelection`；
  - 项目资产提交继续使用现有 `/changes` 语义，工具化时复用 `resolveStaged`（技能索引精确暂存）。
- 工具描述里必须写明 C1/C2/C3 与「operationId 重试」约定，与 `task-tools.ts` 的 `WRITE_GUIDANCE` 同风格。
- 错误码直接复用 `resource-contract.ts` 现有集合（`git-index-dirty`、`git-nothing-to-commit`、`git-sync-busy`、`revision-conflict`、`git-state-changed`、`git-local-changes`），不新增同义词。

验收要点：两个并发请求（一个持锁提交、一个同时提交）必须串行且都不丢改动；staged 污染必须被拒绝而非夹带。

### 4.3 P2 可见性与提示

- 资源卡片/项目资产面板：当锁被占用时显示「另一个会话正在写」；当工作树存在**非本人**未提交改动时显示「有待确认的改动（可能来自其他会话）」。
- 提交计划 tooltip 已有（`ProjectChangesPanel`），补一句"本次只提交以下路径"。
- 文案键进 `capability-locales.ts` / `locales.ts`，中英双语，配窄窗口与暗色验收。

### 4.4 P3 隔离模式：把「自动 worktree」做进产品

需求形态：用户说「帮我改一下 xxx」，产品就让这次改动发生在隔离工作树里，而不是共享工作树。

**硬约束（决定方案形状）**：DSH 的 `session.header.cwd` 是创建时冻结的元数据，system prompt 的 `{{cwd}}`、
shell 默认 workdir、sandbox root 都由它派生，**没有原地切换目录的能力**。只有两种可行形态：

| 形态 | 触发者 | 机制 | 代价 |
| --- | --- | --- | --- |
| A. fork 到 worktree | 用户（会话创建时）或产品在首个改动前自动执行 | `agents.create` + `meta.cwd = <worktree>`，预设/血缘/seed 照搬 | 新会话要重新带上下文，血缘变复杂 |
| B. 会话留在原 cwd，工作在 worktree 内发生 | 产品武装隔离模式 + 模型调用 `worktree_create` | 会话头打 branch badge；模型用**绝对路径**在 checkout 内读写；不切会话、不注册 Workspace | 模型可能"忘记"用绝对路径而改到主工作树（§7 危害 1） |

推荐 **B 为默认、A 用于整段任务都要隔离的场景**，且两者都由产品强制而非提示：

1. **触发判定**：`agent/session-start` 或用户消息进入时，按规则（是否改动类意图）+ 可选模型判定决定"武装隔离模式"。
2. **强制点**：`tools/pre-execute` 检查——会话未处于隔离工作树、而工具是写类（`Edit`/`Write`/写操作 `Bash`）且目标仓库允许隔离时，
   返回 `ask`（确认后由产品调 `worktree_create`）或按项目配置直接 `block`；配合 `ctx.tools.guard()` 保持 deny-only 单调。
3. **目标仓库**：worktree 按**被改文件所属的 git 仓库**创建，不是会话仓库（本项目一个项目根下还有 plugin/shell 两个仓库）。
4. **人类专属动作**：`finish` / `bring-back` / `remove` 只提供人类命令，模型够不到；产品对主工作树做"分支名 + dirty 状态"提交前后快照校验。
5. **模型侧规则**：每段工作用 `git -C <worktree>` 绝对路径、首次 `pwd` 校验；禁止导出 `GIT_DIR`/`GIT_WORK_TREE`；禁止在 worktree 内切分支。
6. **项目资产仓库永久排除**（C6）；worktree 内的技能/任务仍读主工作树，避免项目资产分叉。
7. **工装**：worktree 内没有 `node_modules`/`dist`/Electron 运行时。可选：共享 Yarn cache、符号链接依赖、或"创建后先跑工装脚本"，
   否则模型进去就构建不了（这是本项目引入隔离模式前必须实测的成本项）。
8. **已知边界（实测见 §2.5）**：`tools/pre-execute` 不能改写工具输入，所以产品**无法**把一次 `Edit` 自动重定向进 worktree；
   强制只能是「拒绝 + 指引」。若要求写入路径天然就在 worktree 内，只有形态 A（fork）能做到。
9. **形态 A 的宿主改造点**：fork 出的会话 `cwd` 是 worktree 路径，会撞上两处现有约束——
   插件 `session-capabilities.ts` 的 `observation.header.cwd !== root → 404 project-session-unavailable`（须放宽为"属于本项目的已知工作树集合"），
   以及壳"以 `cwd: projectRoot` fork 每项目一个 Host"的假设。`dsh-worktree-jump` 的解法是**把 worktree 注册成 Workspace** 再在其下建会话。
   形态 B 不需要这些改造（会话 cwd 仍是项目根），代价是模型必须自觉使用绝对路径。

## 5. 接口草案（要点）

提交回执（守卫与工具共用）：

```ts
interface CommitReceipt {
  repository: string;          // 仓库根或资源 id
  commit: string;              // 完整 hash
  paths: string[];             // 落在提交里的路径
  waitedMs: number;            // 等锁时长，用于暴露并发
  session?: string;            // 可选：来源会话，写入 commit trailer
}
```

## 6. 分阶段计划与验收

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P0 | `commit-guard` + 文档 + `AGENT.md`/`git-pitfalls` 增补 | 并发复现：A 会话留下未暂存改动，B 会话用守卫提交 → 必须成功且 A 的改动**仍在工作树**；B 直接 `git add -A` 的场景由 C4 检测拦截 |
| P1 | `project_resource_commit` + 服务提升 | 工具单测（参数/错误码/串行）；原生 smoke：两个会话并发提交，历史顺序确定、无夹带 |
| P2 | 面板与卡片提示 + 双语文案 | 原生视觉验收（中英、明暗、窄窗、键盘） |
| P3 | 隔离模式：`worktree_create` 工具 + `tools/pre-execute` 守卫 + 人类专属收尾命令（若走 fork 定制 ≈4–5 人日，不含 Host 通道改造） | 复现「用户说改 xxx → 未进入 worktree 的写入被 `ask`/`block`」；worktree 内完成改动后 `bring-back` 合并、主工作树 dirty 状态不变 |

## 7. 风险与未决问题

- **锁粒度**：按 `--git-common-dir` 串行会连带阻塞无关资源的写入；可接受（写入本来稀疏），但要在回执里暴露 `waitedMs`。
- **跨进程/跨 app 实例**：文件锁能覆盖；但"谁持有锁"的可见性需要落到锁文件内容，UI 只能尽力展示。
- **Windows**：`unlink`/`open` 语义与 macOS 不同，锁的陈旧回收需按 `windows-ci-pitfalls` 复验。
- **项目资产仓库的"提交即共享"语义**：守卫不应替用户决定提交哪些资产，只保证"提交的东西是声明的"。
- **是否给提交加 trailer**（会话/operationId）：利于审计，但会让历史与现有提交格式不一致，待确认。
- **worktree 的工装成本**（node_modules/dist/Electron 运行时）尚无实测数据（§4.4 第 7 条给出可选做法）。
- **引入任何社区插件前先核对 peer 版本**：DSH 预发布版本语义（`^0.1.2-rc.1` 不接受 `0.1.5-rc.2`）叠加 `dsh plugin add` 的 pnpm
  auto-install-peers 默认行为，会静默装出第二份 harness 并使工具调用整体失效。装插件前必须核对 peer range，必要时先 pin 或隔离 profile 并冒烟。

### 社区实测的 worktree 危害与本项目映射

来源见 §8 外部参考。逐条映射：

| 危害 | 现象 | 本项目映射与对策 |
| --- | --- | --- |
| cwd 漂移 | 代理 shell 的 cwd 在调用间被重置到会话主目录，`git fetch/checkout/rebase` 实际打在**主工作树**上，把用户未提交改动卷进 autostash | DSH 的 bash 调用同样是独立进程、会话 cwd 冻结；对策：`git -C <worktree>` 绝对路径 + 首次 `pwd` 校验；编排方对主工作树做分支名与 `status --porcelain` 前后快照 |
| `GIT_DIR` / `GIT_WORK_TREE` 泄漏 | 一旦导出，所有 git 命令（含子进程）绕过 `-C` 指向共享 gitdir，可把整个仓库（含全部 worktree）设成 bare | 禁止导出这两个变量；需要干净环境时用 `env -u GIT_DIR -u GIT_WORK_TREE git -C …` |
| 嵌套仓库 | 只 worktree 了「会话所在仓库」，目标文件其实在另一个仓库 | **本项目直接命中**：项目根 + `resources/dsh-plugin-project` + `resources/dsh-project-desktop` 是三个独立仓库；worktree 必须按目标仓库创建 |
| 共享路径冲突 | 两个代理自选同一目录 = 共用一个工作树 | 路径由产品显式分配（任务/会话前缀），不允许模型自选 |
| worktree 被删 | 目录消失后代理 shell 全废，子代理继承死 cwd，未提交工作一起消失 | 生命周期由产品管理；`remove` 人类专属且非 `--force` 时拒绝脏树；要求尽早提交/推送 |
| 固定分支名冲突 | 写死的分支名被别的会话占用 | 分支名带任务前缀 + 创建前预检；用 refspec push 而不是改分支名 |
| 远端隔离静默降级 | 声称远端隔离，实际跑在本地 worktree | 不按参数推断模式，创建后**读回实际路径**并写入回执 |

## 8. 参考（代码位置）

- 锁与提交：`src/resource-sync.ts`（`lockRepository`、`commitProjectSelection`、`stageContent`）
- 服务装配：`src/index.ts`、`src/resource-api.ts`（`registerResourceApi`）
- 工具范式：`src/task-tools.ts`、`src/memory-tools.ts`、`src/tool-schema.ts`
- 会话边界：`src/session-capabilities.ts`；壳 `src/desktop-adapter/index.mjs`、`src/desktop-adapter/stable/host-entry.mjs`
- 错误码与文案：`src/resource-contract.ts`、`src/capability-locales.ts`、`src/locales.ts`
- 面板：`src/client/ProjectChangesPanel.tsx`、`src/client/ResourceCard.tsx`

外部参考：

- Claude Code：Run parallel sessions with worktrees — <https://code.claude.com/docs/en/worktrees>
- Claude Code 多代理社区的 worktree 危害清单（cwd 漂移、`GIT_DIR` 泄漏、嵌套仓库、worktree 被删、分支预检等）—
  <https://github.com/laurigates/claude-plugins/blob/main/agent-patterns-plugin/skills/parallel-agent-dispatch/references/worktree-hazards.md>
- DSH 生态：`dsh-worktree-jump` <https://github.com/frederico-kluser/dsh-worktree-jump>、
  `dsh-task-worktree` <https://github.com/Letter2025/dsh-task-worktree>、
  `dsh-worktree` <https://github.com/FlashingChen/dsh-worktree>
- DSH 守卫类插件（`tools/pre-execute` + `ctx.tools.guard()` 的完整实现）— <https://github.com/SparkShieldLab/deepseek-harness-security-guard>
- Conductor：Git worktrees 概念 — <https://www.conductor.build/docs/concepts/git-worktrees>
- DSH 官方扩展 cookbook — <https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook>
- 项目侧纪律：`skills/git-pitfalls/SKILL.md`
