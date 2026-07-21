import {
  parseStorageSettingsBootstrapArgs,
  runStorageSettingsBootstrap,
} from './modules/storage/storage-settings-bootstrap';

async function bootstrap(): Promise<void> {
  try {
    const args = parseStorageSettingsBootstrapArgs(process.argv.slice(2));
    const result = await runStorageSettingsBootstrap(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`storage-settings-bootstrap failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void bootstrap();
