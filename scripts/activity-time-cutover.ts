import { NestFactory } from '@nestjs/core';
import { Role, UserStatus } from '@prisma/client';

import { AppModule } from '../src/app.module';
import type { CurrentUserPayload } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/database/prisma.service';
import { ActivityTimeCutoverService } from '../src/modules/activities/activity-time-cutover.service';

interface CliArgs {
  execute: boolean;
  actorUserId?: string;
  operationKey?: string;
  deployedMainSha?: string;
  evidenceBundleHash?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') args.execute = true;
    else if (token === '--check-only') args.execute = false;
    else if (token === '--actor-user-id') args.actorUserId = argv[++index];
    else if (token === '--operation-key') args.operationKey = argv[++index];
    else if (token === '--deployed-main-sha') args.deployedMainSha = argv[++index];
    else if (token === '--evidence-bundle-hash') args.evidenceBundleHash = argv[++index];
    else throw new Error(`未知参数: ${token}`);
  }
  if (
    args.execute &&
    (!args.actorUserId ||
      !args.operationKey ||
      !args.deployedMainSha ||
      !args.evidenceBundleHash)
  ) {
    throw new Error(
      '--execute 必须同时提供 --actor-user-id、--operation-key、--deployed-main-sha、--evidence-bundle-hash',
    );
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const cutover = app.get(ActivityTimeCutoverService);
    if (!args.execute) {
      console.log(JSON.stringify(await cutover.check(), null, 2));
      return;
    }

    const prisma = app.get(PrismaService);
    const actor = await prisma.user.findUnique({ where: { id: args.actorUserId } });
    if (!actor) throw new Error('指定 actor 不存在');
    const currentUser: CurrentUserPayload = {
      id: actor.id,
      username: actor.username,
      role: actor.role as Role,
      status: actor.status as UserStatus,
      memberId: actor.memberId,
    };
    const result = await cutover.execute({
      currentUser,
      request: {
        operationKey: args.operationKey as string,
        deployedMainSha: args.deployedMainSha as string,
        evidenceBundleHash: args.evidenceBundleHash as string,
      },
      auditMeta: {
        requestId: `activity-time-cutover:${args.operationKey as string}`,
        ip: null,
        ua: 'activity-time-cutover-cli',
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error('正式时长切换失败（fail-closed，未修改 Gate）:', error);
  process.exitCode = 1;
});
