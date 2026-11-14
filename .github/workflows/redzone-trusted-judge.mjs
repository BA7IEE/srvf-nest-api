// Runs from BASE under pull_request_target. PR files are data, never executable.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function protectedPaths(files, registry) {
  const entries = [...registry.redzone, ...registry.selfGuard];
  if (!entries.length || entries.some((e) => !Array.isArray(e.globs) || !e.globs.length ||
      e.globs.some((g) => typeof g !== 'string' || !g))) {
    throw new Error('Invalid protected-path registry');
  }
  const globs = ['.github/workflows/**', 'harness/redzone.json', ...entries.flatMap((e) => e.globs)];
  return [...new Set(files.flatMap((f) => {
    if (typeof f.filename !== 'string' || !f.filename ||
        !['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(f.status) ||
        (f.status === 'renamed' && !f.previous_filename)) throw new Error('Invalid changed file');
    return [f.filename, f.previous_filename].filter(Boolean);
  }))].filter((file) => globs.some((glob) => path.matchesGlob(file, glob)));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function api(endpoint, paginate = false) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, ...(paginate ? ['--paginate', '--slurp'] : [])],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

function changedFiles() {
  if (process.argv[2] === '--local') {
    const base = process.argv[3];
    if (!base || !/^[a-f0-9]{40}$/.test(base)) throw new Error('Expected base commit SHA');
    // --no-renames reports both deletion and addition, covering both rename paths.
    return git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0')
      .filter(Boolean).map((filename) => ({ filename, status: 'modified' }));
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const number = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^\d+$/.test(number ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error('Missing PR identity');
  }
  const endpoint = `repos/${repo}/pulls/${number}`;
  const checkRevision = (pr) => {
    if (pr.head.sha !== event.pull_request.head.sha || pr.base.sha !== event.pull_request.base.sha ||
        git('rev-parse', 'HEAD').trim() !== pr.base.sha) throw new Error('PR changed during scan');
  };
  const before = api(endpoint);
  checkRevision(before);
  const files = api(`${endpoint}/files?per_page=100`, true).flat();
  const after = api(endpoint);
  checkRevision(after);
  if (!Number.isInteger(before.changed_files) || before.changed_files <= 0 ||
      before.changed_files >= 3000 || before.changed_files !== files.length ||
      after.changed_files !== files.length || new Set(files.map((f) => f.filename)).size !== files.length) {
    throw new Error('Incomplete changed-file list');
  }
  return files;
}

function main() {
  const registry = JSON.parse(readFileSync('harness/redzone.json', 'utf8'));
  const hits = protectedPaths(changedFiles(), registry);
  console.log(JSON.stringify({ protectedPaths: hits }));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${hits.length > 0}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(`Trusted scan failed: ${error.message}`);
    process.exitCode = 1;
  }
}
