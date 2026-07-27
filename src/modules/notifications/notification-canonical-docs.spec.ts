import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('notification canonical documentation', () => {
  const currentState = readRepoFile('docs/current-state.md');
  const nextTasks = readRepoFile('docs/ai-harness/NEXT_TASKS.md');
  const notificationsRules = readRepoFile('src/modules/notifications/CLAUDE.md');
  const adminHandoff = readRepoFile('docs/handoff/admin-web.md');
  const miniappHandoff = readRepoFile('docs/handoff/miniapp.md');

  it('records the final visibility decisions without the closed attendance debt', () => {
    expect(currentState).not.toContain('考勤待接');
    expect(currentState).toContain('Decision 15.1=B/15.2=B');
    expect(currentState).toContain('业务负责人最终确认:2026-07-27');
    expect(currentState).toContain('PRIMARY/SECONDARY/TEMPORARY/SUPPORT');

    for (const document of [nextTasks, notificationsRules]) {
      expect(document).toContain('Decision 15.1=B');
      expect(document).toContain('Decision 15.2=B');
      expect(document).toContain('2026-07-27');
      expect(document).toContain('Role.ADMIN');
      expect(document).toContain('PRIMARY');
      expect(document).toContain('SECONDARY');
      expect(document).toContain('TEMPORARY');
      expect(document).toContain('SUPPORT');
      expect(document).toContain('ACTIVE');
      expect(document).toContain('未软删');
    }
    expect(nextTasks).toContain('业务负责人最终确认日期：2026-07-27');
  });

  it('marks old best-effort prose as history and states the durable current runtime', () => {
    const historicalMarker = '历史实现，已被 2026-07-26 L1–L4 durable outbox 收口取代。';

    for (const document of [adminHandoff, miniappHandoff]) {
      expect(document).toContain(historicalMarker);
      expect(document).toContain('报名 L1');
      expect(document).toContain('活动 L2');
      expect(document).toContain('责任 L3');
      expect(document).toContain('考勤 L4');
      expect(document).toContain('业务事务内写 durable intent');
      expect(document).toContain('provider 失败进入 retry/dead');
    }

    expect(adminHandoff).toContain('前端端点、DTO、响应和操作入口完全不变');
    expect(miniappHandoff).toContain('App API/DTO 未变化');
  });
});
