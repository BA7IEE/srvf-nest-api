# HUMAN_REVIEW_RULES — 人工确认点全集

> **性质**:索引文档,非规则源。确认流程的权威是 [`process.md §3/§4`](../process.md)(档位 + D 档降速)与 [`current-state.md §3`](../current-state.md)(暂不启动清单);本文件汇总成单页检查单。
> 原则:**宁可多停一次,不可越权一次**。AI 拿不准档位时,按更高档位处理。

---

## 1. 触发即停(动手前必须用户拍板)

| # | 触发器 | 档位 | 确认形式 |
|---|---|---|---|
| 1 | 改 `prisma/schema.prisma` / 新 migration / 改 `seed.ts` | D | 只读调研 → 风险表 → 方案 A/B 对比 → 拍板 → 评审稿冻结(`srvf-prisma-change`) |
| 2 | 改 `Role` / Permission code / RolePermission 绑定 / Guard / 装饰器语义 | D | 同上(`srvf-auth-security`)+ [`RBAC_MAP.md §6`](./RBAC_MAP.md) |
| 3 | 改登录 / JWT / refresh token / throttler 参数 | D | P0-E 行为冻结;任何偏移先暂停说明 |
| 4 | 改 `StorageProvider` / COS / 凭证加密 / `STORAGE_ENCRYPTION_KEY` | D | 评审稿 + 拍板 |
| 5 | 改 `audit_logs` 字段 / `AuditLogEvent` union | D | A-1 红线;评审稿 + 拍板 |
| 6 | 新 endpoint / DTO 字段增减 / 新错误码 / 响应语义变化 | C | 动手前确认范围;snapshot diff 逐行可解释 |
| 7 | 改 `.github/workflows/**` / `package.json` 依赖 / Dockerfile | D | 影响所有 PR,评审 + 拍板 |
| 8 | 改全局 Guard / Interceptor / Filter / ValidationPipe / ResponseInterceptor 跳过列表 | D | 评审 + 拍板 |
| 9 | 跨模块大范围重构 / 拆 god-service | D | 单独立项(`srvf-god-service-refactor`;characterization 先行) |
| 10 | release / bump / tag / GitHub Release | E | 强串行;tag 与 Release 由维护者手动(process §5) |
| 11 | 物理删除任何业务数据 / 批量回填 / 数据迁移脚本 | D | 评审 + 拍板 + 回退方案 |
| 12 | 涉及身份证 / 医疗 / 紧急联系人等敏感字段的任何 schema/DTO 草案 | D | **敏感字段三问**先答(AGENTS §18.4):业务用途 / 查看角色与掩码 / 保存期限 |
| 13 | 触碰六大红区文档 / `docs/archive/**` / 已发布 CHANGELOG 段 | — | 非用户授权不动 |
| 14 | `git reset --hard` / `push --force` / `worktree remove --force` / 批量 `-D` | — | 本会话内看到风险描述后**再次**明确授权(AGENTS §20) |

## 2. 暂不启动清单(用户未拍板前,AI 连方案都不应主动实施)

以 [`current-state.md §3`](../current-state.md) 为准,当前包括:Slow-3(ADMIN 内置角色边界)/ Slow-4(业务面 RBAC 接入)/ Slow-5(入队同意书 / 退队清理)/ Slow-7(uploadToken 黑名单等)/ L-3(Storage 变更 audit)/ `events` 等延后模型 / LLM·Redis·queue·cron / 新 schema·Permission seed·Role 扩展 / 运维侧真实 COS / god-service 拆分 / repository 抽象层 / 改 controller path·OpenAPI snapshot(无立项时)。

**AI 的正确动作**:用户诉求命中上述任何一项 → 说明状态 + 列影响面 + 判断档位 + 给最小评审方案 → **等拍板**(AGENTS §1 评审解锁制,不得仅凭旧条目直接拒绝,也不得直接实现)。

## 3. 发现类暂停(调研/实施过程中遇到即停)

1. **文档与代码冲突** → 不擅自调和,报告等拍板(AGENTS 顶部铁律)。
2. **权威源互相冲突** → 按 process §6 优先级判定后仍存疑 → 暂停汇报。
3. **审计/调研发现 bug** → 不顺手修(process §7),记录进 [`templates/risk-register.md`](./templates/risk-register.md) 实例并汇报。
4. **既有断言/测试与新需求冲突** → 改断言 = 改行为契约,停下报告(尤其 6 个 characterization spec 与 e2e 反向锁定断言,如"改密后旧 access 仍可用")。
5. **任务范围外的"看起来该一并修"** → 禁夹带,另列任务(process §4)。
6. **不确定的信息** → 显式标记"需要人工确认",禁止当成事实写入文档/代码。

## 4. 确认请求的标准格式(AI 提交给用户时)

```markdown
## 需要拍板:<一句话标题>
- 背景:<现状 + 证据(路径:行号)>
- 触发规则:<本文件 §1 第 N 条 / current-state §3 某项>
- 影响面:<模块 / 测试 / 已发版本 / 用户可见行为>
- 方案 A(推荐):<内容 + 回退条件>
- 方案 B:<内容 + 回退条件>
- 不动代码承诺:在拍板前仅做只读调研
```
