import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppSubmitActivityChangeReviewDto } from './app-managed-activity.dto';

describe('AppSubmitActivityChangeReviewDto', () => {
  const validateBody = (body: object) =>
    validate(plainToInstance(AppSubmitActivityChangeReviewDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([
    ['missing', {}],
    ['string', { activity: 'x' }],
    ['null', { activity: null }],
    ['array', { activity: [] }],
  ])('rejects %s activity', async (_description, body) => {
    const errors = await validateBody(body);
    expect(errors.map((error) => error.property)).toContain('activity');
  });

  it('accepts an empty activity object', async () => {
    await expect(validateBody({ activity: {} })).resolves.toEqual([]);
  });
});
