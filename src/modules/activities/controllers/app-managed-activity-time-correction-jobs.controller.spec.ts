import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { ActivityTimeCorrectionBackgroundService } from '../activity-time-correction-background.service';
import type { AppCommitActivityTimeCorrectionDto } from '../dto/app/app-activity-time-correction.dto';
import { HumanCorrectionAuthorityUnavailableError } from '../human-correction-intent';
import { HumanCorrectionQualificationError } from '../human-correction-trusted-connection';
import { AppManagedActivityTimeCorrectionJobsController } from './app-managed-activity-time-correction-jobs.controller';

describe('AppManagedActivityTimeCorrectionJobsController', () => {
  const params = { activityId: 'activity-id', requestId: 'request-id', jobId: 'job-id' };
  const dto: AppCommitActivityTimeCorrectionDto = {
    correctionApplicationId: 'application-id',
    postingBatchId: 'batch-id',
    expectedBaseSettlementVersionId: 'base-id',
    operationKey: 'operation-id',
  };
  const user: CurrentUserPayload = {
    id: 'user-id',
    username: 'user',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: 'member-id',
  };
  const jobs = { enqueue: jest.fn(), detail: jest.fn(), retry: jest.fn() };
  const controller = new AppManagedActivityTimeCorrectionJobsController(
    jobs as unknown as ActivityTimeCorrectionBackgroundService,
  );
  const handlers = [
    {
      name: 'enqueue',
      mock: jobs.enqueue,
      invoke: () => controller.enqueue(params, dto, user),
      args: [params.activityId, params.requestId, dto, user],
    },
    {
      name: 'detail',
      mock: jobs.detail,
      invoke: () => controller.detail(params, user),
      args: [params.activityId, params.requestId, params.jobId, user],
    },
    {
      name: 'retry',
      mock: jobs.retry,
      invoke: () => controller.retry(params, user),
      args: [params.activityId, params.requestId, params.jobId, user],
    },
  ];

  beforeEach(() => jest.resetAllMocks());

  describe.each(handlers)('$name', ({ mock, invoke, args }) => {
    it.each([
      ['unavailable', () => new HumanCorrectionAuthorityUnavailableError()],
      ['qualification', () => new HumanCorrectionQualificationError('test-stage')],
    ])('translates %s authority errors to service unavailable', async (_name, makeError) => {
      mock.mockRejectedValue(makeError());
      const error: unknown = await invoke().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BizException);
      expect(error).toMatchObject({ biz: BizCode.SERVICE_UNAVAILABLE });
      expect(mock).toHaveBeenCalledWith(...args);
    });

    it.each([
      ['business', () => new BizException(BizCode.NOT_FOUND)],
      ['generic', () => new Error('failure')],
    ])('rethrows %s errors unchanged', async (_name, makeError) => {
      const error = makeError();
      mock.mockRejectedValue(error);
      await expect(invoke()).rejects.toBe(error);
      expect(mock).toHaveBeenCalledWith(...args);
    });

    it('returns the service result unchanged', async () => {
      const result = { jobId: 'job-id' };
      mock.mockResolvedValue(result);
      await expect(invoke()).resolves.toBe(result);
      expect(mock).toHaveBeenCalledWith(...args);
    });
  });
});
