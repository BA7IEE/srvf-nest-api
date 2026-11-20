# T56 独立只读审查

**PASS。Mobile #5 可以作为 #3、#4、#5 三项改动进入 main 的唯一合并入口。** 实时 base 为 `main`，HEAD 为 `529ee3a3c441eaaf992049cbbe6ee32f1414fa63`。两个前序 tip 都已纳入，面向 main 的全量 CI 已成功。建议维护者按 **后端 #1447 → Mobile #5 → Admin #172** 合并。Mobile #3、#4 继续保留到 #5 确实合入 main、内容核实之后。审查时三个候选 PR 均为 OPEN、Draft。[Mobile #5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) · [最终 CI](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44705508066/job/136183979106)

## Mobile 全量范围

GitHub 时间线记录北京时间 16:47:47 将 #5 的 base 从 `feat/h5-same-origin-session` 改为 `main`，16:48:37 关闭，16:48:39 重开。#5 的 HEAD 与此前隔离验收相同。当前 main 为 `009976a22cce757ee13d48983764c1f5b6c07764`，也是比较所得共同祖先。相对 main 共 **5 个提交、45 个文件**，其中 7 个新增、38 个修改。[完整 diff](https://github.com/BA7IEE/SRVFMobileWeb/compare/009976a22cce757ee13d48983764c1f5b6c07764...529ee3a3c441eaaf992049cbbe6ee32f1414fa63)

| 来源 | 提交及祖先核查 | 最终树中的交付内容 |
|---|---|---|
| #3 | tip `ce14f84b5add85de11816136a0ef975a28ff7b7e`。#5 相对它领先 4、落后 0 | 同源认证传输准备、A 退出后切换 B 的身份及缓存隔离测试。 |
| #4 | `81823988`、tip `5e5be8dc11daf86781cf648c8c35572b3e79df60`。#5 相对它领先 2、落后 0 | ADR 001、独立 H5 构建、Cookie 会话恢复、跨标签协调、真实队员页面及报名草稿隔离。 |
| #5 | `7ea8036f`、tip `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | 本人保险资格、场次签到签退、服务端定位要求和报名开放判断。最后一个提交采用 `publicRegistrationOpen`，字段缺失时保持关闭。 |

两次从前序 tip 到最终 HEAD 的比较均以对应前序 tip 为共同祖先。五个提交在同一条父链上，#3 和 #4 均没有留在各自分支的独有提交。已对照最终文件内容，包括仍在执行的换号测试、H5 会话测试和登记考勤入口。[#3 到最终 HEAD](https://github.com/BA7IEE/SRVFMobileWeb/compare/ce14f84b5add85de11816136a0ef975a28ff7b7e...529ee3a3c441eaaf992049cbbe6ee32f1414fa63) · [#4 到最终 HEAD](https://github.com/BA7IEE/SRVFMobileWeb/compare/5e5be8dc11daf86781cf648c8c35572b3e79df60...529ee3a3c441eaaf992049cbbe6ee32f1414fa63)

## 原生 CI 与三端配对

新 run `44705508066` 为 #5 的 `pull_request` 作业，记录的目标是上述 main，源是上述 HEAD，job `136183979106` 的 `pnpm check` 为 SUCCESS。checkout 日志和 Git 对象均确认，实际测试合并提交 `ebd993ed5b4bf7bdd9cc97a601872a230e28971a` 的双亲恰为这两个 SHA，文件树 `a48294c88b9fbb6eedb0a27fc0a38df7c4feffef` 与 #5 HEAD 完全相同。日志列出 118 个单测、62 个契约测试及 82 个浏览器 E2E 通过，普通、mock 和 H5 三种构建均成功。浏览器 E2E 的服务配置为 mock 和未接线预览，真实 H5 业务凭隔离栈回执验收。旧 run `44667834661` 测的是合入 #4 tip 的结果，`44667827714` 是 push 作业。[新作业日志](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44705508066/job/136183979106) · [旧 PR 作业](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44667834661/job/136061383971) · [浏览器测试配置](https://github.com/BA7IEE/SRVFMobileWeb/blob/529ee3a3c441eaaf992049cbbe6ee32f1414fa63/playwright.config.ts)

| 仓库 | 实时目标及精确 HEAD | 配对核对 |
|---|---|---|
| nest-api #1447 | `main` ← `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9` | 沿用 T55 对该 SHA 的 PASS。本轮只对照公开契约。H5 登录、续期、退出、保险查询、场次打卡和本人账本的路径相符；活动 DTO 包含 `publicRegistrationOpen` 和 `locationRequired`。 |
| Mobile #5 | `main` ← `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | H5 构建要求同源 HTTPS 和服务端 Cookie 会话。此前隔离证据覆盖保险报名、图片签到和读回；T54 配对回执记录本次结算后本人 2 条、另一队员 0 条。 |
| Admin #172 | `main` ← `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | 原生 verify SUCCESS，仍是 T54 记录的管理端版本。其 Simple 草稿确认依赖后端 `expectedDraftHash` 契约。 |

配对证据与源码相符。T54 现场复用 T53 的应用构建并施加 T54 两份精确迁移，这一边界沿用 T55 审查结论。[后端会话契约](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/docs/handoff/h5-session.md) · [固定 OpenAPI](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/docs/handoff/openapi.json) · [报名签到回执](https://github.com/BA7IEE/srvf-nest-api/blob/929f33cdd77aa2a0c7207c43161c8aa9deeb9ad3/docs/ops/runtime-acl/t47/h5-enrollment-checkin.jsonl) · [T54 配对与读回](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json) · [T55 独审]((local-receipt; see linked GitHub evidence))

## 维护者执行顺序与保留项

1. **先合后端 #1447 到 nest-api/main。** 将 Draft 转为可合并后按仓库规则操作，记录合入提交。后端旧 #1445、#1446、#1439、#1444 的当前 tip 均为 #1447 的祖先，待后端 main 实际包含对应交付后，再处理仍开放的旧 PR。[后端 #1447](https://github.com/BA7IEE/srvf-nest-api/pull/1447)
2. **再单独合 Mobile #5 到 Mobile/main。** 操作前核对 base、HEAD 与已测结果。若源码或待合入的内容改变，以新组合 CI 为准。合入后核实 #5 的 `merged=true`、目标为 main，并确认合入提交已进入 main。采用普通 merge 时可查 #5 tip 是否为 main 祖先；采用 squash 或 rebase 时核对实际落入的完整文件差异。确认 #3、#4 没有新独有提交后，仅关闭仍开放的 #3、#4，注明由 #5 覆盖。[Mobile #5](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) · [#3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) · [#4](https://github.com/BA7IEE/SRVFMobileWeb/pull/4)
3. **最后合 Admin #172 到 Admin/main。** 以表中 HEAD 和其 verify 为据。Mobile 在 Admin 之前是本批建议顺序。两端各自调用后端，Admin 合并后无需再处理 Mobile 的历史 PR。[Admin #172](https://github.com/BA7IEE/srvf-admin-web/pull/172)

**保留** nest #1442 证据材料及其 T55 独审记录；其余未满足独立验收条件的 Issue/PR 保持原去向。共享账本 13 列、B130、目标环境迁移及部署各自单列。本轮共享 GRANT=0，公网切流、真机和微信实测均为 NOT_RUN。本轮只读审查，没有执行合并或关闭。[材料 #1442](https://github.com/BA7IEE/srvf-nest-api/pull/1442) · [固定 T55 记录](https://github.com/BA7IEE/srvf-nest-api/tree/9bcc4ea25888ac6235a823286e643f0a28870540/docs/ops/runtime-acl/t55)

**收尾记录仍有旧表述。** #1447 的 T56 索引仍写 Mobile CI“进行中”、独审待办，应以此处新作业 SUCCESS 和本独审 PASS 交接。Mobile #5 正文开头保留原堆叠关系；其 `integration-readiness.md` 也保留 #3 阶段“ADR 未批准、真实接线未实现”的表述。当前 base 以 GitHub 字段为准，当前 H5 范围以固定 HEAD 的 README、已批准 ADR 001 和配对回执为准。两项均可在收尾说明中澄清，无需因此重新申请后端红区批准。[收尾索引]((local-receipt; see linked GitHub evidence)) · [阶段性准备文档](https://github.com/BA7IEE/SRVFMobileWeb/blob/529ee3a3c441eaaf992049cbbe6ee32f1414fa63/docs/integration-readiness.md) · [ADR 001](https://github.com/BA7IEE/SRVFMobileWeb/blob/529ee3a3c441eaaf992049cbbe6ee32f1414fa63/docs/adr-001-credentials.md)
