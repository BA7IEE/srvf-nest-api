import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityTemplateVersionCommand } from './activity-template-version-command';
import { ActivityTemplateVersionService } from './activity-template-version.service';
import {
  AdminCreateActivityTemplateVersionDto,
  AdminUpdateActivityTemplateVersionDto,
} from './dto/admin/activity-template-version.dto';

const actor: CurrentUserPayload = {
  id: 'actor',
  username: 'actor',
  role: Role.SUPER_ADMIN,
  status: 'ACTIVE',
  memberId: null,
};
const meta = { requestId: 'template-dto', ip: null, ua: null };
const definition = {
  activity: { allocationModeCode: 'first_come' },
  sessions: [],
  registrationForm: null,
  metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
};
const command = {
  operationKey: 'create-one',
  code: 'test-template',
  name: '模板',
  categoryCode: 'training',
  activityTypeCode: 'training',
  version: 1,
  effectiveFrom: '2000-01-01T00:00:00.000Z',
  definition,
};

describe('C1 D2b template HTTP DTO → strict domain parser', () => {
  const run = jest.fn<
    ReturnType<ActivityTemplateVersionCommand['run']>,
    Parameters<ActivityTemplateVersionCommand['run']>
  >();
  const service = new ActivityTemplateVersionService(
    { run } as unknown as ActivityTemplateVersionCommand,
    undefined!,
    undefined!,
    undefined!, // DTO characterization covers the V3 branch only.
    undefined!,
  );
  beforeEach(() => run.mockReset());

  it('omitted DTO fields remain omitted in the new command hash', async () => {
    const dto = plainToInstance(AdminCreateActivityTemplateVersionDto, command);
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    await service.create(dto, actor, meta);
    const fromDto = run.mock.calls[0][0].canonicalInput;
    await service.create(command, actor, meta);
    expect(fromDto).toBe(run.mock.calls[1][0].canonicalInput);
  });

  it('draft replacement preserves absent optional fields just like creation', async () => {
    const input = {
      operationKey: 'update-one',
      expectedDefinitionHash: 'a'.repeat(64),
      definition,
    };
    const dto = plainToInstance(AdminUpdateActivityTemplateVersionDto, input);
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    await service.change('update', 'template', dto, actor, meta);
    await service.change('update', 'template', input, actor, meta);
    expect(run.mock.calls[0][0].canonicalInput).toBe(run.mock.calls[1][0].canonicalInput);
  });

  it.each([
    { ...definition, metricSelection: { metricRequirementCode: 'not_required' } },
    { ...definition, metricSelection: null },
    { ...definition, unexpected: true },
    { ...definition, activity: { allocationModeCode: 'first_come', capacity: 0 } },
  ])('rejects invalid definitions before opening a transaction %#', (invalid) => {
    expect(() => service.create({ ...command, definition: invalid }, actor, meta)).toThrow(
      new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID),
    );
    expect(run).not.toHaveBeenCalled();
  });
});
