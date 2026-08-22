import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACTIVITY_SOURCE_ROOT,
  countScannedDtoClasses,
  findWritableImageUrlFields,
} from './activity-image-reference.criteria';

/*
 * P2-14 刀 A 的 DoD 1 执行位:**写入侧再也收不下裸 URL**。
 *
 * 判据是**结构性扫描**而不是挑几个字段名 —— 下一个 `bannerImageUrl` 也会被抓。
 * 这一条是刻意的:goal 的核验点 1 明写「挑样例的话,下一个 bannerImageUrl 照样溜进来」。
 */
describe('活动图片引用判据(P2-14 刀 A)', () => {
  const repoRoot = process.cwd();

  // ============ 自证:判据自己没瞎 ============

  it('自证:扫描面非空(扫到的 DTO / service class 数有地板)', () => {
    // 地板锚点而非「恰好 N 个」:恰好 N 会在每次加 class 时假红,
    // 而真正要防的是「目录挪走 / 扫描器坏掉 ⇒ 零命中 ⇒ 判据自动全绿」。
    expect(countScannedDtoClasses(repoRoot)).toBeGreaterThan(50);
  });

  it('自证(真阳性对照):人工造一个带校验装饰器的 *ImageUrl 字段必须被抓到', () => {
    // 在临时目录里复刻扫描面结构,证明判据**会**红。
    // 不在真实 src/ 上做变异 —— 那会污染工作树。
    const tmp = mkdtempSync(join(tmpdir(), 'p214-criteria-'));
    try {
      const dir = join(tmp, ACTIVITY_SOURCE_ROOT);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'fake.dto.ts'),
        [
          'export class CreateSomethingDto {',
          '  @ApiPropertyOptional({ maxLength: 512 })',
          '  @IsOptional()',
          '  @IsString()',
          '  bannerImageUrl?: string;',
          '}',
        ].join('\n'),
        'utf-8',
      );

      const found = findWritableImageUrlFields(tmp);

      expect(found).toHaveLength(1);
      expect(found[0]).toEqual(
        expect.objectContaining({ className: 'CreateSomethingDto', fieldName: 'bannerImageUrl' }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('自证(假阳性对照):只带 @ApiProperty 的响应字段不算可写,必须放行', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'p214-criteria-'));
    try {
      const dir = join(tmp, ACTIVITY_SOURCE_ROOT);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'fake-response.dto.ts'),
        [
          'export class SomethingResponseDto {',
          '  @ApiPropertyOptional({ nullable: true })',
          '  coverImageUrl!: string | null;',
          '}',
        ].join('\n'),
        'utf-8',
      );

      // 出参里的 coverImageUrl 是**现签 URL**,是本刀想要的结果,不是缺陷。
      // 判据若在这里也红,它就没法用了(整个读出面都会红)。
      expect(findWritableImageUrlFields(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ============ 真判据 ============

  it('活动模块的可写 DTO 上不存在任何 *ImageUrl / *ImageUrls 字段', () => {
    const violations = findWritableImageUrlFields(repoRoot);

    expect(violations).toEqual([]);
  });
});
