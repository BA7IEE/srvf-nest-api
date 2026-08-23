import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import * as ts from 'typescript';

/**
 * 活动图片引用判据(P2-14 刀 A)。
 *
 * ⚠️ 本文件在 `harness/redzone.json` 的 selfGuard 内(`scripts/check-*.ts`)。
 *    判据逻辑刻意放在这里而不是 spec 里:spec(`src/**\/*.spec.ts`)不在 selfGuard,
 *    任何 PR 都能顺手改松它;把**实质逻辑**放在受保护文件里,改松就必须动红区。
 *    spec 侧只做薄运行器(见 `src/modules/activities/activity-image-reference.criteria.spec.ts`)。
 *
 * 规则一句话:**活动模块的可写 DTO 上不得存在任何 `*ImageUrl` / `*ImageUrls` 形状的字段**。
 *
 * 为什么这是一类缺陷而不是两个实例:`Activity.coverImageUrl` 与 `galleryImageUrls` 曾经
 * 只有 `@IsString() @MaxLength(512)` 把关 —— 即「任何字符串都能当封面」。于是
 *   ① 能填任意外站地址,外站换图 / 删图后封面变裂图或**变成别的内容**
 *   ② 图不在本仓存储里,备份 / 迁移 / 清理 / 配额全都管不到
 *   ③ 也可能填站内签名链接,而签名链接会过期 ⇒ 封面一张一张慢慢坏掉且无告警
 *   ④ 无访问控制,该 URL 谁拿到谁能看、永不失效
 * 这四条与「叫 cover 还是叫 banner」毫无关系。只修那两个字段,下一个
 * `bannerImageUrl` / `posterImageUrls` 会原样把洞挖回来,而本刀不会有任何东西变红。
 *
 * ⚠️ **判据的发现面是「形状」不是「名字清单」**:任何 `xxxImageUrl` / `xxxImageUrls` 都算,
 *    包括本文件写完之后才加的字段。写死两个字段名的判据在第三个字段出现时静默失明 ——
 *    这是本仓已登记的事故形状(「至少一处」型判据在第二个采纳者之后失明)。
 *
 * ⚠️ **「可写」的判据是「带 class-validator 装饰器」**,不是「名字里有 Create/Update」:
 *    全局 ValidationPipe 开了 `whitelist` + `forbidNonWhitelisted`,**没有校验装饰器的属性
 *    根本进不来**。所以「带校验装饰器」恰好就是「能被请求体写入」的结构性定义。
 *    响应 DTO 只有 `@ApiProperty` / `@ApiPropertyOptional`,不会被误报 ——
 *    出参里的 `coverImageUrl` 是**现签 URL**,那是本刀想要的结果,不是缺陷。
 *
 * ⚠️ 本判据只读 `src/modules/activities/**` 的**文本**,证明的是「可写面上没有裸 URL 字段」。
 *    它证明不了「设封面时真的校验了归属」也证明不了「读出的真是签名 URL」——
 *    那两格分别由 `test/e2e/activity-cover-attachment.e2e-spec.ts` 的越权负例
 *    与签名断言负责,三者缺一不可。
 */

const ROOT = resolve(__dirname, '..');

/** 扫描面:活动模块全部 TS 源(含 dto/ 与 controllers/ 子目录)。 */
export const ACTIVITY_SOURCE_ROOT = join('src', 'modules', 'activities');

/**
 * 扫描面地板:至少要扫到这么多个 class,否则说明扫描器坏了 / 目录挪走了。
 *
 * 原先这个 `50` 以字面量写在 spec 里 —— 那正是「把判据改松」最省事的下手处
 * (改成 `0`,diff 一个字符,没人看得见)。现在它是受保护文件里的具名常量。
 */
export const MIN_SCANNED_DTO_CLASSES = 50;

/**
 * 被禁的字段形状。`ImageUrl` / `ImageUrls` 结尾即命中,前缀任意。
 *
 * 为什么连 `Urls` 复数一起管:图集 `galleryImageUrls` 是同一个缺陷的数组版本,
 * 而且更松 —— 它此前连 `ArrayMaxSize` 和每项 `MaxLength` 都没有。
 */
const FORBIDDEN_FIELD_SHAPE = /^[a-z][A-Za-z0-9]*Image(Url|Urls)$/;

/**
 * class-validator 装饰器识别。取「以 Is / Matches / Length / Array / Min / Max 等开头」
 * 过于模糊,故用显式前缀集合 + 已知全集的并集:凡不属于 Swagger 文档装饰器
 * (`ApiProperty` 系)与 Nest 参数装饰器的,都按校验装饰器处理。
 *
 * 这个方向是**故意保守的**:宁可把未知装饰器当成校验装饰器(可能误红、会被人看见),
 * 也不要把校验装饰器当成文档装饰器(会漏红、没有症状)。
 */
const DOC_ONLY_DECORATORS = new Set(['ApiProperty', 'ApiPropertyOptional', 'ApiHideProperty']);

export interface ImageUrlFieldViolation {
  file: string;
  line: number;
  className: string;
  fieldName: string;
  decorators: string[];
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // 判据自身与测试文件不算生产可写面:本文件正文里就写着被禁的字面量,
      // 把自己算进去会让判据把自己的注释当成违规(本仓已登记的形状:
      // 判据注释写下它自己要匹配的字面量会把自己算进计数)。
      if (entry.endsWith('.spec.ts') || entry.endsWith('.criteria.ts')) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function decoratorName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  return ts.isIdentifier(callee) ? callee.text : null;
}

/**
 * 扫出全部违规。返回空数组 = 可写面干净。
 *
 * @param repoRoot 仓库根;判据在 spec 里以 `process.cwd()` 传入。
 */
export function findWritableImageUrlFields(repoRoot: string = ROOT): ImageUrlFieldViolation[] {
  const violations: ImageUrlFieldViolation[] = [];
  const root = join(repoRoot, ACTIVITY_SOURCE_ROOT);

  for (const file of listTsFiles(root)) {
    const text = readFileSync(file, 'utf-8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const className = node.name?.text ?? '<anonymous>';
        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member)) continue;
          const name = member.name;
          if (!ts.isIdentifier(name)) continue;
          if (!FORBIDDEN_FIELD_SHAPE.test(name.text)) continue;

          const decorators = ts
            .getDecorators(member)
            ?.map(decoratorName)
            .filter((value): value is string => value !== null);
          const all = decorators ?? [];
          const validators = all.filter((value) => !DOC_ONLY_DECORATORS.has(value));
          // 只有文档装饰器 ⇒ 响应 DTO 字段 ⇒ 放行(出参的签名 URL 正是本刀的产物)。
          if (validators.length === 0) continue;

          violations.push({
            file: relative(repoRoot, file),
            line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
            className,
            fieldName: name.text,
            decorators: all,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return violations;
}

/**
 * 自证锚点:判据的**发现面**非空。
 *
 * 用「至少扫到 N 个 class」而不是「恰好 N 个」—— 恰好 N 会在每次加 DTO 时假红,
 * 而它要防的其实是「扫描器坏了 / 目录挪走了 ⇒ 零命中 ⇒ 判据自动全绿」。
 * 地板锚点(不是精确计数)是本仓登记过的正确形状。
 */
export function countScannedDtoClasses(repoRoot: string = ROOT): number {
  let count = 0;
  const root = join(repoRoot, ACTIVITY_SOURCE_ROOT);
  for (const file of listTsFiles(root)) {
    const text = readFileSync(file, 'utf-8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) count += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return count;
}

// ============================================================================
// 自证对照:真阳性 / 假阳性各一条
//
// 这两条原先以 `mkdtempSync` + `writeFileSync` 的形态写在 spec 里 —— 那是判据
// 「会不会红」的证明本身,放在无保护文件里等于证明可以被顺手删掉。
// 搬进来后 spec 只拿结果,不再自己造夹具。
//
// 刻意在**临时目录**里复刻扫描面结构,不在真实 src/ 上做变异 —— 那会污染工作树。
// ============================================================================

function withFixture(fileName: string, lines: string[]): ImageUrlFieldViolation[] {
  const tmp = mkdtempSync(join(tmpdir(), 'p214-criteria-'));
  try {
    const dir = join(tmp, ACTIVITY_SOURCE_ROOT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), lines.join('\n'), 'utf-8');
    return findWritableImageUrlFields(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 真阳性对照:人工造一个带校验装饰器的 `*ImageUrl` 字段,判据必须抓到。 */
export function positiveControl(): ImageUrlFieldViolation[] {
  return withFixture('fake.dto.ts', [
    'export class CreateSomethingDto {',
    '  @ApiPropertyOptional({ maxLength: 512 })',
    '  @IsOptional()',
    '  @IsString()',
    '  bannerImageUrl?: string;',
    '}',
  ]);
}

/**
 * 假阳性对照:只带 `@ApiProperty` 的响应字段不算可写,必须放行。
 *
 * 判据若在这里也红,它就没法用了(整个读出面都会红)——
 * 出参里的 `coverImageUrl` 是**现签 URL**,是本刀想要的结果,不是缺陷。
 */
export function negativeControl(): ImageUrlFieldViolation[] {
  return withFixture('fake-response.dto.ts', [
    'export class SomethingResponseDto {',
    '  @ApiPropertyOptional({ nullable: true })',
    '  coverImageUrl!: string | null;',
    '}',
  ]);
}

/** 自证:仪器没瞎才报数。返回空数组 = 自证通过。 */
export function selfCheck(): string[] {
  const problems: string[] = [];

  const scanned = countScannedDtoClasses();
  if (scanned <= MIN_SCANNED_DTO_CLASSES) {
    problems.push(
      `扫描面塌了:只扫到 ${scanned} 个 class,地板是 >${MIN_SCANNED_DTO_CLASSES}。` +
        '「判据失去输入 ≠ 通过」—— 目录挪走了或扫描器坏了。',
    );
  }

  const positive = positiveControl();
  if (positive.length !== 1 || positive[0]?.fieldName !== 'bannerImageUrl') {
    problems.push('真阳性对照失败:人工造的 bannerImageUrl 没被抓到 —— 判据不会红了。');
  }

  const negative = negativeControl();
  if (negative.length !== 0) {
    problems.push('假阳性对照失败:只带 @ApiProperty 的响应字段被误判成可写 —— 判据不可用。');
  }

  return problems;
}

function main(): void {
  const problems = selfCheck();
  for (const problem of problems) console.error(`🔴 自证失败:${problem}`);

  const violations = findWritableImageUrlFields();
  for (const v of violations) {
    console.error(
      `🔴 可写 DTO 上有裸图片 URL 字段:${v.file}:${v.line} ${v.className}.${v.fieldName}` +
        `(装饰器:${v.decorators.join(' ')})`,
    );
  }

  const broken = problems.length + violations.length;
  if (broken === 0) {
    console.log(`✓ 活动模块可写面无 *ImageUrl 字段(扫描面 ${countScannedDtoClasses()} 个 class)。`);
  } else {
    console.error('\n修法:图片一律走附件 id + 现签 URL,不要在可写 DTO 上收裸 URL 字符串。');
  }
  process.exit(broken === 0 ? 0 : 1);
}

if (require.main === module) main();
