import {
  LocalActivityFrontendFixtureError,
  runLocalActivityFrontendFixture,
} from './local-activity-frontend-fixture';

async function bootstrap(): Promise<void> {
  try {
    const command = process.argv[2];
    const output = await runLocalActivityFrontendFixture(command, process.env);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const message =
      error instanceof LocalActivityFrontendFixtureError
        ? error.message
        : 'unexpected local fixture failure; no credential or database URL was logged';
    process.stderr.write(`local-activity-fixture failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void bootstrap();
