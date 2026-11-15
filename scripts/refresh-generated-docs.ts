import { execFileSync } from 'node:child_process';

// OpenAPI feeds the client generator; authorization declarations are independent.
const commands = ['docs:openapi', 'docs:feclient', 'docs:authz'];
for (const command of commands) {
  console.log(`pnpm ${command}`);
  if (!process.argv.includes('--dry-run')) {
    execFileSync('pnpm', [command], { stdio: 'inherit' });
  }
}
