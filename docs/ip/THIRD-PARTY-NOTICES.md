# 第三方依赖与许可证声明(THIRD-PARTY NOTICES)

> **NestJS、Prisma、腾讯云 SDK 及本项目使用的其他所有第三方依赖,其知识产权归各自权利人所有,并各自适用其自身许可证。本项目不对第三方代码主张任何权利。**
>
> 权利口径见 [`COPYRIGHT.md`](../../COPYRIGHT.md);本文件不复制第三方许可证正文,请以各依赖包官方发布的 LICENSE 文本为准。

---

## 1. 扫描方法与数据来源

| 项 | 说明 |
|---|---|
| 扫描时点 | 2026-08-13,对应 main HEAD `8edfc59e403e2b5b72e0b8833119fbf466749a79` |
| 版本口径 | [`pnpm-lock.yaml`](../../pnpm-lock.yaml) 锁定的版本(以 `pnpm install --frozen-lockfile` 还原) |
| 许可证来源 | **各依赖包自身 `package.json` 的 `license` 字段**(即包作者的自我声明),以及 `pnpm licenses list` 的汇总 |
| 命令 | `pnpm licenses list --json` · `pnpm licenses list -P --json` · 逐包读取 `node_modules/<pkg>/package.json#license` |
| 原始输出 | 存于仓库外私人证据包 `SRVF-IP-EVIDENCE-2026-08-13/raw/`(`dependency-licenses-all.json` 等) |

**方法边界**:本表反映的是**包内元数据声明**,不等同于对每个包 LICENSE 全文的逐项法律核验。用于正式登记、对外分发或合规审查时,应以官方 LICENSE 文本另行核验(见 §5)。

## 2. 直接依赖

### 2.1 dependencies(运行时,24 个)

| 包名 | package.json 声明范围 | 锁定安装版本 | 包内声明许可证 |
|---|---|---|---|
| `@nestjs/common` | `^11.0.0` | `11.1.19` | MIT |
| `@nestjs/config` | `^4.0.4` | `4.0.4` | MIT |
| `@nestjs/core` | `^11.0.0` | `11.1.19` | MIT |
| `@nestjs/jwt` | `^11.0.2` | `11.0.2` | MIT |
| `@nestjs/passport` | `^11.0.5` | `11.0.5` | MIT |
| `@nestjs/platform-express` | `^11.0.0` | `11.1.19` | MIT |
| `@nestjs/schedule` | `6.1.3` | `6.1.3` | MIT |
| `@nestjs/swagger` | `^11.4.2` | `11.4.2` | MIT |
| `@nestjs/terminus` | `^11.1.1` | `11.1.1` | MIT |
| `@nestjs/throttler` | `^6.5.0` | `6.5.0` | MIT |
| `@prisma/client` | `^6.19.3` | `6.19.3` | Apache-2.0 |
| `bcryptjs` | `^3.0.3` | `3.0.3` | BSD-3-Clause |
| `class-transformer` | `^0.5.1` | `0.5.1` | MIT |
| `class-validator` | `^0.15.1` | `0.15.1` | MIT |
| `cos-nodejs-sdk-v5` | `^2.15.4` | `2.15.4` | ISC |
| `helmet` | `^8.1.0` | `8.1.0` | MIT |
| `nestjs-pino` | `^4.6.1` | `4.6.1` | MIT |
| `passport` | `^0.7.0` | `0.7.0` | MIT |
| `passport-jwt` | `^4.0.1` | `4.0.1` | MIT |
| `pino` | `^10.3.1` | `10.3.1` | MIT |
| `pino-http` | `^11.0.0` | `11.0.0` | MIT |
| `reflect-metadata` | `^0.2.2` | `0.2.2` | Apache-2.0 |
| `rxjs` | `^7.8.1` | `7.8.2` | Apache-2.0 |
| `tencentcloud-sdk-nodejs-sms` | `4.1.240` | `4.1.240` | Apache-2.0 |

### 2.2 devDependencies(开发期,26 个)

| 包名 | package.json 声明范围 | 锁定安装版本 | 包内声明许可证 |
|---|---|---|---|
| `@eslint/js` | `^9.18.0` | `9.39.4` | MIT |
| `@nestjs/cli` | `^11.0.0` | `11.0.21` | MIT |
| `@nestjs/schematics` | `^11.0.0` | `11.1.0` | MIT |
| `@nestjs/testing` | `^11.1.19` | `11.1.19` | MIT |
| `@types/bcryptjs` | `^3.0.0` | `3.0.0` | MIT |
| `@types/express` | `^5.0.0` | `5.0.6` | MIT |
| `@types/jest` | `^30.0.0` | `30.0.0` | MIT |
| `@types/node` | `^22.10.7` | `22.19.17` | MIT |
| `@types/passport-jwt` | `^4.0.1` | `4.0.1` | MIT |
| `@types/supertest` | `^7.2.0` | `7.2.0` | MIT |
| `dotenv` | `^17.4.2` | `17.4.2` | BSD-2-Clause |
| `eslint` | `^9.18.0` | `9.39.4` | MIT |
| `eslint-config-prettier` | `^10.0.1` | `10.1.8` | MIT |
| `eslint-plugin-prettier` | `^5.2.2` | `5.5.5` | MIT |
| `globals` | `^15.14.0` | `15.15.0` | MIT |
| `jest` | `^30.3.0` | `30.3.0` | MIT |
| `pino-pretty` | `^13.1.3` | `13.1.3` | MIT |
| `prettier` | `^3.4.2` | `3.8.3` | MIT |
| `prisma` | `^6.19.3` | `6.19.3` | Apache-2.0 |
| `supertest` | `^7.2.2` | `7.2.2` | MIT |
| `ts-jest` | `^29.4.9` | `29.4.9` | MIT |
| `ts-node` | `^10.9.2` | `10.9.2` | MIT |
| `tsconfig-paths` | `^4.2.0` | `4.2.0` | MIT |
| `tsx` | `^4.21.0` | `4.21.0` | MIT |
| `typescript` | `^5.7.3` | `5.9.3` | Apache-2.0 |
| `typescript-eslint` | `^8.20.0` | `8.59.1` | MIT |

## 3. 全依赖树许可证汇总(含传递依赖)

### 3.1 全部依赖(749 个包)

| 许可证 | 包数 |
|---|---|
| MIT | 611 |
| ISC | 43 |
| Apache-2.0 | 41 |
| BSD-3-Clause | 24 |
| BSD-2-Clause | 14 |
| BlueOak-1.0.0 | 7 |
| Unlicense | 3 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| Python-2.0 | 1 |
| `(AFL-2.1 OR BSD-3-Clause)` | 1 |
| `(MIT OR CC0-1.0)` | 1 |
| **Unknown(包内无许可证元数据)** | **1** |
| **合计** | **749** |

### 3.2 生产依赖子集(299 个包)

| 许可证 | 包数 |
|---|---|
| MIT | 245 |
| Apache-2.0 | 22 |
| ISC | 13 |
| BSD-3-Clause | 8 |
| BSD-2-Clause | 5 |
| 0BSD / Python-2.0 / Unlicense / `(AFL-2.1 OR BSD-3-Clause)` / `(MIT OR CC0-1.0)` / Unknown | 各 1 |
| **合计** | **299** |

### 3.3 扫描结论

> **基于当前 pnpm lockfile 锁定版本及安装包 package.json 许可证元数据扫描,未检测到 GPL / AGPL / LGPL / MPL 等许可证。**

该结论是**扫描结果的陈述**,不是法律保证;其可靠性受 §1 方法边界与 §5 待核验项限制。

## 4. 其他第三方组件(非 npm 依赖)

| 组件 | 用途 | 归属 |
|---|---|---|
| `actions/checkout@v4`、`actions/setup-node@v4` | GitHub Actions CI 步骤 | GitHub, Inc. 及各自权利人,适用其自身许可证 |
| `pnpm/action-setup@v4` | CI 中安装 pnpm | pnpm 项目及各自权利人 |
| `node:22-alpine` | 生产镜像基础镜像([`Dockerfile`](../../Dockerfile)) | Node.js / Docker 官方镜像及其中各组件的权利人 |
| `postgres:16-alpine` | 本地开发数据库容器([`docker-compose.yml`](../../docker-compose.yml)) | PostgreSQL 及 Docker 官方镜像的权利人 |

以上组件均以**引用方式**使用,其源码未被复制进本仓库。

## 5. 仍待进一步核验的项目

以下三项**不做推定**,标记为待外部核验:

| 包 | 现状 | 待核验原因 |
|---|---|---|
| `pause@0.0.1` | 包内 `license` 字段缺失,扫描结果为 **Unknown** | 无元数据可依据,须查其发布源与仓库中的实际许可条款。依赖链:`@nestjs/passport` → `passport@0.7.0` → `pause@0.0.1`(生产依赖) |
| `caniuse-lite` | 声明 **CC-BY-4.0** | 该许可证含署名义务,与常见代码许可证义务不同;为开发期依赖,须确认其义务是否触发 |
| `cos-nodejs-sdk-v5@2.15.4` | 声明 **ISC** | 腾讯云官方 SDK,ISC 为包内自我声明,建议以其官方仓库 LICENSE 文本核对 |

复核命令:

```bash
pnpm why pause
cat node_modules/pause/package.json
pnpm licenses list --json | node -e "…"   # 见私人证据包 raw/dependency-license-summary.txt
```

## 6. 分发场景下的义务提示

本项目当前为自用部署、未授予开源许可(见 [`COPYRIGHT.md`](../../COPYRIGHT.md) §2)。若未来**向第三方分发**软件(而非仅自行部署运营),需按各依赖许可证履行相应义务,常见包括:

- **MIT / BSD / ISC**:在分发物中保留原始版权声明与许可证文本
- **Apache-2.0**:分发时提供许可证副本并保留适用的版权、专利、商标和署名声明;如上游包含 NOTICE,按许可证要求传递相应 NOTICE 内容;如修改 Apache 许可组件文件,应按许可证要求标注修改

届时应据本文件生成随分发物一并交付的完整第三方声明文件。是否触发上述义务、以何种方式履行,依法及依各许可证条款确定。

## 7. 维护方式

依赖或版本变更后,本文件应重新生成:重跑 §1 的扫描命令,更新 §2/§3 表格与扫描时点。**本文件是快照,不随依赖自动更新**。

---

*最后更新:2026-08-13 · 对应 main HEAD `8edfc59e403e2b5b72e0b8833119fbf466749a79` · lockfile:`pnpm-lock.yaml`(未修改)*
