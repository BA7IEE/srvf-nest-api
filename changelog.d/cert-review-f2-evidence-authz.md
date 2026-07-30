- **证据授权按申报状态分流(2026-07-30;证书标准库跨模型评审 findings F2,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §13.5 / §15.5 / §15.9)**:零新增端点、零新增权限码、零新增 BizCode、零 schema 变更。

  `GET /admin/v1/recruitment/certificate-claims/:id/image-urls` 修复前只做「查 `read.sensitive` → 签全部 key」—— **申报状态完全不参与判定**。现在按状态分流:

  | 状态 | 结果 | 理由 |
  |---|---|---|
  | `SUBMITTED` / `NEEDS_INFO` / `APPROVED` / `REJECTED` | 放行 | 都还在审核流里。`REJECTED` 尤其不能拒 —— 申请人可以从它重投,审核员必须能回看「当初拒的是什么」 |
  | `WITHDRAWN` | **拒(28057)** | 撤回的语义就是「别再看了」。继续放行等于撤回只撤掉了列表可见性(§15.5) |
  | `PROMOTED` | **拒(28057)** | 证据已成为正式证书的认定依据,此后只能经 `GET /admin/v1/members/:memberId/certificates/:id/evidence-urls` 读 —— 那条走 Certificate 的 **scoped** authz(能看这个队员才能看),而招新审核码是 GLOBAL 的。留着 Claim 端点等于给已发号队员的档案开了一条绕过 scope 的旁路(§15.9) |

  状态闸做成纯函数 `assertClaimEvidenceReadable` 放在 Claim 状态机文件里,与既有的转移闸同侧 —— service 只能调、不能绕。

  **§15.5「URL 生成前重新检查」**:入口读取与签发之间隔着一次审计写的 IO 往返,申请人完全可能在这个窗口里撤回、或管理员发号把它转成 `PROMOTED`。所以状态、归属与权限在**签发前**再验一次。审计已经落账了,这次拒签只是不发 URL,不影响「谁在什么时候试图读过」这条记录的完整性。

  **§13.5「不写第二套签名逻辑」**:PR-4a-1 与 PR-5 各写了一遍「取 key → 循环 `generateDownloadUrl` → 拼 `expiresAt`」,连 TTL 常量都各声明了一个 300。现在合并为 `CertificateEvidenceSigner`(`CertificatesModule` 导出,招新侧注入)。它**只负责签**:判权在各 service 的入口码,状态闸在各自的状态机,审计必须先于签发落账 —— 把这三件事塞进签发器会让「谁把的关」变得取决于调用顺序。

  测试是**正反成对**的:4 条非终态必须出图 + 2 条终态必须拒且 provider 一次都不调 + 1 条「审计后被撤回仍拒签」(专测复读那一道,少了它这一格会照常签出 URL)。原有的「正常 Claim 能返两个 URL」那条对不该出图的状态一个字都没说 —— 那正是这条规则此前可以被整段删掉而全绿的原因。
