# COS 闭环测试 —— 证明「这套系统能用 COS」

> **状态**:**PASS**(2026-08-20,维护者在真机实测,9 项判据全通过)。
> 实测中查出本脚本一处字段名缺陷(见 §6),已修。

## 0. 为什么需要这一轮

第二阶段部署 PASS **不覆盖**对象存储可用性。实测方当时明确保留了这条边界:

> 本轮证明的是「COS 配置已写入 + 凭据已加密 + production 能解密 + fail-fast 通过」。
> **尚未执行真实的 COS PUT / HEAD / signed download / DELETE。**

这条克制是对的,根因与 stage2 runbook §1.3 同源:**bootstrap 全程不连 COS**,
值能写进数据库**不等于**云端真的可用。

本测试要证明的**不是**「COS 能用」,而是「**这套系统能用 COS**」——
所以它走应用的真实上传链路(模式 B 签名直传),**不拿 COS SDK 直接传**。
后者只能证明桶和密钥没问题,证明不了应用这条链通。

关联:issue #935「完成真实外部供应商链路验证」的 COS 那一半 ·
`docs/current-state.md` 列的 production GO 硬门。

## 1. 测什么

一次跑完四个真实动作,每个动作都有独立判据:

| 步骤 | 真实发生的事 | 判据 |
|---|---|---|
| ② 申请签名 URL | 用 COS 凭据签名 | 签得出来 ⇒ 凭据可解密、地域/桶名格式正确 |
| ③ **PUT** | 对象真实写入腾讯云 | 直传 COS 返回 200/201/204(**不经过我们的 API**) |
| ④ **HEAD** | 服务端回查对象 | `confirm-upload` 通过 ⇒ 对象在云端、大小对得上、是真 PNG |
| ⑤ **signed GET** | 取回对象内容 | 下载字节与上传**逐字节一致**(`cmp`) |
| ⑥ **DELETE** | 对象从云端移除 | 删除后旧短链**不再返回 200** |

⚠️ 第 ⑤ 步刻意做**字节比对**而不是只看 HTTP 200 —— 200 只证明「有个对象」,
比对才证明「是**我传的那个**对象,且内容没被改写」。

⚠️ 第 ⑥ 步刻意**复用删除前那条短链**。签名短链在过期前一直有效,
所以它返回 404/403 只可能是**对象真没了**,不是链接失效。

## 2. 怎么跑

在服务器上(或任何能 HTTPS 访问该域名的机器):

```bash
./scripts/ops/cos-closed-loop-test.sh https://srvf-dp.23cc.cn <super-admin-username>
```

密码从 stdin 读,**不走命令行参数** —— 不进 shell history,`ps` 也看不到。
token 全程不回显。脚本自建一条测试内容作为附件 owner,**退出时自动删除**(含异常退出)。

需要 `bash 4+`(脚本内已硬校验)、`jq`、`curl`。

## 3. 关键实现约束(改脚本前先看)

- **owner 只能用 `content-image`**。`attachment_type_configs` 的 seed 只建了三条
  (`content-image` / `content-file` / `registration-upload-session`);
  `member` / `certificate` 虽在 enum 里但**没有配置行**,用了会被 13010 挡掉。
- **`ownerId` 必须真实存在**(`attachment-access.service.ts` 的 `assertOwnerExists`)
  ⇒ 所以脚本要先建一条内容,不能塞假 id。
- **`uploadHeaders` 必须原样带上**。COS 签名对 header 敏感,漏一个就 403。
  脚本用 `mapfile` 把它展开成 `-H` 参数(这是要求 bash 4+ 的原因)。
- **探针是 70 字节的合法 1×1 PNG**,magic `89504e470d0a1a0a` 与
  `attachment-signature.ts:5` 的 `image/png` 条目逐字节一致 ⇒ 能过服务端签名校验。
  换探针文件时必须同时满足「真实合法图片」+「MIME 在 owner 的白名单内」。
- **删除是同步删云端对象**,不是延迟队列 —— `attachment-write.service.ts` 里
  intent 提交后紧接着 `executeEventKey()` 执行 provider effect。所以第 ⑥ 步的断言成立。

## 4. 判据

```
全部通过 → 可以声称「对象存储真实可用」,#935 的 COS 那一半闭合。
任一失败 → 不得声称,按脚本输出的失败项定位。
```

⚠️ 脚本刻意在 PUT 失败时**直接终止**(后续步骤没有意义),
其余失败项则继续跑完再汇总 —— 一次跑出全部问题,不用来回试。

## 5. 常见失败与定位

| 现象 | 大概率原因 |
|---|---|
| ② 签 URL 就失败 | 凭据解不开(`STORAGE_ENCRYPTION_KEY` 换过?)或 storage_settings 未初始化 |
| ③ PUT 返回 403 | 签名 header 没带全;或 SecretId/SecretKey 不对(**这个可救**:走凭据重置口) |
| ③ PUT 返回 404 | **桶名或地域错**(⚠️ 这个救不了,见 stage2 runbook §1.3) |
| ④ confirm 失败 | 对象没真写进去,或大小/签名对不上 |
| ⑤ 字节不一致 | 取到了别的对象,或传输被改写 —— **这是严重问题,停下取证** |
| ⑥ 删除后仍 200 | 云端对象未真正删除 —— 停下取证,别当小问题 |

## 6. 实测结论

**2026-08-20 · PASS · 通过 9 项 / 失败 0 项**

环境:`https://srvf-dp.23cc.cn` · `APP_ENV=production` ·
bucket `srvf-attachments-1433783892` / region `ap-guangzhou` / envPrefix `staging`。

| 步骤 | 实测读数 |
|---|---|
| ② 签名 URL | 签发成功,对象 key = `attachments/staging/2026/08/20/MMjIH_o30Dlk0imH.png` |
| ③ **COS PUT** | **200** |
| ④ confirm(服务端 HEAD) | 通过,attachmentId = `cmt15f7gy000rph011sj9ka1o` |
| ⑤ **signed GET + 字节比对** | 下载 **70 字节**,与上传**逐字节一致** |
| ⑥ **DELETE + 复查** | 删除返 200;复用删除前那条短链再取 → **404** |

⇒ **可以声称「对象存储真实可用」**。issue #935「完成真实外部供应商链路验证」的 **COS 那一半已闭合**
(企业微信 / 短信 / OCR 仍未验)。

### 🔴 首跑失败:本脚本的字段名缺陷(已修)

第一次跑在第 ② 步就失败:

```
签 URL 失败: {"code":40000,"message":"property size should not exist;
sizeBytes must not be less than 0; sizeBytes must be an integer number"}
```

**根因是脚本自己的 bug,不是 COS 出错** —— `GenerateUploadUrlDto` 要的是 `sizeBytes`,
脚本发的是 `size`。

⚠️ **起草时是怎么错的**(留给后来者):当时用
`grep -B2 "ownerType\|ownerId\|mime\|size\|originalName" attachments.dto.ts`
一次性捞字段名,输出把**多个 DTO 类的字段拍平成一张列表**,里面既有 `size!` 又有 `sizeBytes!`,
**没核端点绑的是哪个类**就挑了前者。

⇒ **教训:查请求体字段必须先定位端点绑定的那个 DTO 类,再读那个类的字段**,
不能跨类 grep 字段名 —— 同名/近名字段在不同 DTO 里含义不同。
修复后已把脚本其余三个请求体(登录 / 建内容 / confirm)**逐个对着各自的 DTO 类重核**,均无误。
