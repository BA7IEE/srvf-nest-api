import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Logger } from '@nestjs/common';

import {
  JOURNEY_2_KNOWN_GAP,
  JOURNEY_2_REVIEW_TRIGGER,
  runActivityRegistrationCheckInJourney,
} from '../support/journey-activity-registration-checkin';
import { createJourneyRuntime, type JourneyRuntime } from '../support/journey-runtime';

const ROUTE_AUTHZ_MANIFEST_PATH = resolve(__dirname, '../../docs/ai-harness/ROUTE_AUTHZ.md');

function countManifestUndeclaredRoutes(): number {
  const manifest = readFileSync(ROUTE_AUTHZ_MANIFEST_PATH, 'utf8');
  const allEndpointsOffset = manifest.indexOf('## All endpoints\n');
  if (allEndpointsOffset < 0) throw new Error('ROUTE_AUTHZ manifest has no endpoint inventory');

  const rows = manifest
    .slice(allEndpointsOffset)
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('| ') && !line.startsWith('| method |') && !line.startsWith('|---|'),
    );

  return rows.reduce((count, row) => {
    const columns = row
      .split('|')
      .slice(1, -1)
      .map((column) => column.trim());
    if (columns.length !== 7 || columns[5] === '')
      throw new Error('ROUTE_AUTHZ manifest endpoint row has an invalid truth source');
    return columns[5] === 'code' ? count : count + 1;
  }, 0);
}

describe('旅程金五条② 活动报名审批签到（当前真实部分链）', () => {
  let runtime: JourneyRuntime;
  let log: jest.SpyInstance;

  beforeAll(async () => {
    // createJourneyRuntime 走与生产相同的 Nest bootstrap；借此同时验证 report Guard 在启动时盘点。
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    runtime = await createJourneyRuntime();
  });

  afterAll(async () => {
    await runtime.close();
    log.mockRestore();
  });

  it('经真实 HTTP 留下 ActivityCheckIn 证据，并登记结算账本的具名缺口', async () => {
    // 禁止改回硬编码计数：每个回填面都必须让 Guard 静态库存与生成 manifest 的
    // truth source 同步，而不是再为一个实例数字改既有旅程断言。
    const manifestUndeclaredRouteCount = countManifestUndeclaredRoutes();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authz_declaration_inventory',
        mode: 'enforce',
        totalUndeclaredRouteCount: manifestUndeclaredRouteCount,
      }),
      'Route authorization declaration inventory',
    );

    const result = await runActivityRegistrationCheckInJourney(runtime);

    expect(result.checkInRegistrationId).toBe(result.registrationId);
    expect(result.replayCheckInId).toBe(result.checkInId);
    expect(result.checkInCount).toBe(1);
    expect(result.knownGap).toBe(JOURNEY_2_KNOWN_GAP);
    expect(result.reviewTrigger).toBe(JOURNEY_2_REVIEW_TRIGGER);

    // 变异红证据：若合法重试不再返回同一 ActivityCheckIn，或一报名可生成多条证据，id/count
    // 任一断言都会变红；该探针不通过 Prisma 伪造 punch 或结算事实。
  });
});
