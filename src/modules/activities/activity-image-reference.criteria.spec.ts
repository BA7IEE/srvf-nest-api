import {
  MIN_SCANNED_DTO_CLASSES,
  countScannedDtoClasses,
  findWritableImageUrlFields,
  negativeControl,
  positiveControl,
} from '../../../scripts/check-activity-image-reference';

/*
 * P2-14 刀 A 的 DoD 1 执行位:**写入侧再也收不下裸 URL**。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-activity-image-reference.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
 *    而 `src/**\/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
 *
 * 判据是**结构性扫描**而不是挑几个字段名 —— 下一个 `bannerImageUrl` 也会被抓。
 * 这一条是刻意的:goal 的核验点 1 明写「挑样例的话,下一个 bannerImageUrl 照样溜进来」。
 */
describe('活动图片引用判据(P2-14 刀 A)', () => {
  // ============ 自证:判据自己没瞎 ============

  it('自证:扫描面非空(扫到的 DTO / service class 数有地板)', () => {
    // 地板锚点而非「恰好 N 个」:恰好 N 会在每次加 class 时假红,
    // 而真正要防的是「目录挪走 / 扫描器坏掉 ⇒ 零命中 ⇒ 判据自动全绿」。
    expect(countScannedDtoClasses()).toBeGreaterThan(MIN_SCANNED_DTO_CLASSES);
  });

  it('自证(真阳性对照):人工造一个带校验装饰器的 *ImageUrl 字段必须被抓到', () => {
    const found = positiveControl();

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(
      expect.objectContaining({ className: 'CreateSomethingDto', fieldName: 'bannerImageUrl' }),
    );
  });

  it('自证(假阳性对照):只带 @ApiProperty 的响应字段不算可写,必须放行', () => {
    // 出参里的 coverImageUrl 是**现签 URL**,是本刀想要的结果,不是缺陷。
    // 判据若在这里也红,它就没法用了(整个读出面都会红)。
    expect(negativeControl()).toEqual([]);
  });

  // ============ 真判据 ============

  it('活动模块的可写 DTO 上不存在任何 *ImageUrl / *ImageUrls 字段', () => {
    expect(findWritableImageUrlFields()).toEqual([]);
  });
});
