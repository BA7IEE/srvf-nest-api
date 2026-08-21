### Fixed

- 附件维护权限补角色(第七轮评审 R7-D-01):组长(`group-manager`)能替别人上传活动 / 他人证书 / 他人队员资料三类附件,**传错了却改不了删不了** —— `attachment.{update,delete}.{activity,certificate.other,member.other}` 六条权限码在 seed 里建了出来、在 `attachment-write.service.ts` 上判着权,却**没有任何内建角色持有**,于是这六个动作对除 `SUPER_ADMIN` 外的所有人恒 403,只能找超管代劳。对照本身就是判据:content 类有完整的传/删、self 类有完整的传/改/删,不存在「本系统就是不给删」的设计原则,这三类是单独漏的。维护者拍板方案 B:**只补 `group-manager`**,与既有 upload 完全对称 —— 不新建角色,也不把 `org-admin` 纳入(实测 `org-admin` 在该码族零持有,连 upload/view 都没有,给它 update/delete 属真实扩面且会造出「能改能删却不能传不能看」的新不对称)。`group-manager` 20 → 26 条;`group-readonly` 恒 11 条不变(只读投影过滤器结构上取不到 update/delete)。实测零角色码 14 → 8,余下 8 条全部落在显式豁免口内。

### Added

- 「权限码必须有持有人」机器闸(`src/modules/permissions/permission-code-holders.spec.ts`):断言权限目录里每一条码要么至少被一个内建角色持有,要么在显式豁免口内,零持有即红并点名。此前**零执法** —— `check-rbac-map.ts` 的 A/D/E/F/G 五条判据没有一条断言「码必须挂到角色」,判据 F 只把这类码记成「孤码候选」并 WARN、退出码仍是 0;`RBAC_MAP.md` 也没有「角色→权限码」这一维。

  三处刻意的设计:① **扫描面从权限目录(seed 事实闭包 typed-AST)出发,不从 `src/` 字面量出发** —— 这六条码是动态拼的(`` `attachment.update.${row.ownerType}…` ``),`src` 里 grep 字面量为 0,判据若认字面量则整类在盲区;复用 `docs-counts` 既有提取器,不新造第四份正则。② **覆盖全部码,不按「当前是否可达」隐式排除** —— `activity-responsibility.override.record` 现在不算缺口只因 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=false`,而该开关在 production 必须显式设值,置 true 那天 6 个端点立刻可达而码仍零角色;按可达性过滤的判据在那一刻依然是绿的,故闸后的码一律走显式白名单 + 到期条件。③ **SA-only 豁免复用 `reservedSuperAdminOnlyPermissionCodes` 而非另抄一份** —— 抄一份就是造第二个事实源,两份清单各自漂移时「本闸放行了但控制面没拦」不会有任何症状。

  判据自证全用地板锚点(`≥N`)不用「恰 N 条」,并含一条双向结构锚点:目录声明的角色数必须等于 seed 里 `rbacRole.upsert(` 的实际调用数 —— 少一个(新角色漏投影)与多一个(目录里的幽灵角色假装持有码)都会红。

- `RBAC_MAP.md` 新增「角色 → 权限码覆盖」派生表(228/236 条码有持有人)与「零持有权限码」清单,由 `pnpm docs:rbacmap` 生成。原先两张表只回答「有哪些码 / 码挂在哪个路由上」,没有一张回答**「这条码谁拿得到」**,零持有这一类缺陷在地图上完全不可见。
