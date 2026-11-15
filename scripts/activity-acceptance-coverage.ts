import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Count business acceptance bindings, independently of any progress ledger. */
export function activityAcceptanceCoverage(root: string): {
  defined: number;
  bound: number;
  todo: number;
} {
  const plan = readFileSync(
    join(
      root,
      'docs/archive/reviews/activity-business-overhaul-v1.1/SRVF_活动业务全流程修正方案_正式版_v1.1.md',
    ),
    'utf8',
  );
  const defined = new Set<string>();
  for (const match of plan.matchAll(/^- \*\*((?:AC|ADV)-\d{3})\*\*/gm)) defined.add(match[1]);

  const registry = readFileSync(
    join(root, 'src/modules/activities/activity-business-overhaul-acceptance.spec.ts'),
    'utf8',
  );
  const bound = new Set<string>();
  let table: string | null = null;
  for (const line of registry.split('\n')) {
    const opened = /^const ([A-Z0-9_]+)(?::|\s*=)/.exec(line);
    if (opened) table = opened[1];
    if (/^\};/.test(line)) table = null;
    const key = /^ {2}'((?:AC|ADV)-\d{3})':/.exec(line);
    if (key && table !== null && table.includes('DESTINATIONS')) bound.add(key[1]);
  }
  return { defined: defined.size, bound: bound.size, todo: defined.size - bound.size };
}
