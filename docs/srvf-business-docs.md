# SRVF 业务文档库索引

> 本文是**路径索引**，不是业务文档本身。
> 业务文档库**不在本代码仓库内**，独立维护在另一个路径下。

---

## 路径

业务文档库位置：

```
/Users/dengwang/Documents/coding/SRVF
```

入口文件：

```
/Users/dengwang/Documents/coding/SRVF/README.md
```

> README.md 中含完整文档地图与 AI 优先读取顺序（按场景 A-F）。

---

## 仓库分工

| 仓库 | 路径 | 定位 |
|---|---|---|
| **代码仓库**（本仓库）| `/Users/dengwang/Documents/coding/srvf-nest-api` | 工程文档：`ARCHITECTURE.md` / `CLAUDE.md` / `AGENTS.md` / `TASKS.md` / `docs/v1.x-*.md` / `docs/v2-*.md` / `docs/srvf-foundation-*.md` / 部署 / 测试 / 安全等工程铁律 |
| **业务文档库** | `/Users/dengwang/Documents/coding/SRVF` | 业务资料、顶层设计、Plan、Schema 草案、决议表、访谈记录、审查报告 |

> **冲突优先级**：代码仓库内的文档**优先级高于** SRVF 目录；业务文档是设计输入，工程文档是落地铁律；两者冲突时**以代码仓库的为准**。

---

## SRVF 目录结构（参考）

```
SRVF/
├── README.md                   # 文档地图，必读
├── CLAUDE.md                   # 业务整理助手角色定义
├── 00-顶层基准/                # 顶层设计规划 + 业务字典（最权威）
├── 01-业务整理/                # 访谈记录 + 问题清单
├── 02-敏感资料专项/            # 敏感资料字段 / 权限矩阵 / 决策记录
├── 03-批次Plan/                # 7 个批次的 Plan + 总审查
├── 04-Schema设计/              # Schema 前评审 + 草案 + 决议
└── 99-archive/                 # 历史归档（不作为当前依据）
```

---

## AI 协作准则

### 新任务开始前

**先读** `/Users/dengwang/Documents/coding/SRVF/README.md`，按其中的"AI 优先读取顺序"决定要读哪些目录。

最常见路径：

- 涉及业务规则 / 字段含义 / 流程：先读 `00-顶层基准/` 与 `01-业务整理/`；
- 涉及敏感资料 / 权限：加读 `02-敏感资料专项/`；
- 涉及某个具体批次：加读 `03-批次Plan/批次N` 和 `04-Schema设计/批次N`。

### 不要默认读 `99-archive/`

`99-archive/` 是**历史归档**（早期 v0.13 需求说明书等），仅作演进路径追溯参考；**多数日常协作场景下应跳过**，不要把归档版本当作当前业务依据。

详见 `99-archive/README.md`。

---

## 边界

- 本仓库**不复制** SRVF 业务文档内容；
- SRVF 文档**不移动**到本仓库；
- 任何业务规则修订发生在 SRVF 仓库；本仓库代码改动按已冻结的 SRVF Plan / Schema 草案 / 决议表执行。
