#!/usr/bin/env python3
"""Small, dependency-free Git/provenance guard. Read-only unless `build` is explicit."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

SCHEMA = 1
SKIP = {'.git', '.codex', '.agents', 'node_modules', 'dist', 'build', '.next',
        'coverage', '.cache', 'target', 'vendor', 'data', 'uploads', 'sessions',
        'deliverables', 'evidence', 'artifacts', 'logs', '__pycache__'}
ENV = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0',
           GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=8',
           GIT_PAGER='cat', LC_ALL='C')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args, timeout=20, optional=False):
    try:
        p = subprocess.run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
                            '-c', 'core.untrackedCache=false', '-C', str(repo), *args],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV,
                           timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        if optional:
            return None
        raise ValueError('GIT_UNAVAILABLE_OR_TIMEOUT') from None
    if p.returncode:
        if optional:
            return None
        # Never emit Git stderr: it can contain credential-bearing URLs.
        raise ValueError('GIT_QUERY_FAILED:' + args[0])
    return p.stdout


def gs(repo, *args, optional=False):
    b = git(repo, *args, optional=optional)
    return b.decode('utf-8', 'replace').strip() if b is not None else None


def remote_identity(raw):
    """Strip userinfo, query, fragment and SSH login; no raw URLs leave memory."""
    if not raw:
        return None
    if '://' in raw:
        u = urllib.parse.urlsplit(raw)
        if u.scheme not in ('https', 'http', 'ssh', 'git') or not u.hostname:
            return 'LOCAL_OR_OPAQUE_REMOTE'
        host, path = u.hostname.lower(), u.path
    else:
        m = re.fullmatch(r'(?:[^@/:]+@)?([^/:]+):(.+)', raw)
        if not m:
            return 'LOCAL_OR_OPAQUE_REMOTE'
        host, path = m.group(1).lower(), m.group(2)
    path = urllib.parse.unquote(path).strip('/')
    if path.endswith('.git'):
        path = path[:-4]
    # URLs whose path embeds auth material are unsuitable as identities.
    if re.search(r'(token|password|secret|credential|access[_-]?key)', path, re.I):
        return host + '/[REDACTED_PATH]'
    if host == 'github.com':
        path = path.lower()
    return host + '/' + path


def sensitive(path):
    for part in Path(path).parts:
        s = part.lower()
        if (s.startswith('.env') or s in {'.aws', '.ssh', 'secrets', 'credentials',
                                       'auth.json', 'config.toml', 'secrets.xcconfig'}
                or re.search(r'(credential|secret|private[-_]?key)', s)
                or s.endswith(('.pem', '.key', '.p12', '.pfx'))):
            return True
    return False


def category(path):
    parts = {p.lower() for p in Path(path).parts}
    suffix = Path(path).suffix.lower()
    if sensitive(path):
        return 'sensitive_metadata_only'
    if parts & {'data', 'uploads', 'storage', 'backups', 'backup', 'sessions'}:
        return 'data_or_unknown_preserve'
    if parts & {'node_modules', 'dist', 'build', '.next', 'target', 'coverage', 'out'}:
        return 'generated_or_cache'
    if parts & {'evidence', 'artifacts', 'deliverables', 'releases', 'logs', 'checkpoints', 'deployments'} or suffix in {'.zip', '.tgz', '.gz', '.dmg', '.pdf', '.png', '.jpg', '.sqlite'}:
        return 'artifact_or_evidence'
    if suffix in {'.md', '.rst', '.txt'}:
        return 'documentation'
    if suffix in {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.swift', '.rs', '.go', '.java', '.sql', '.prisma', '.html', '.css', '.scss', '.sh'}:
        return 'source_or_test'
    if suffix in {'.json', '.yml', '.yaml', '.toml', '.lock', '.xml'} or Path(path).name in {'Dockerfile', 'Makefile', 'Package.swift', '.gitignore', '.gitattributes'}:
        return 'configuration'
    return 'other_unknown_preserve'


def parse_status(raw):
    records, chunks, i = [], raw.split(b'\0'), 0
    while i < len(chunks):
        item = chunks[i]; i += 1
        if not item:
            continue
        xy = item[:2].decode('ascii', 'replace')
        path = item[3:].decode('utf-8', 'replace')
        rec = {'xy': xy, 'path': path, 'category': category(path)}
        if 'R' in xy or 'C' in xy:
            if i >= len(chunks) or not chunks[i]:
                raise ValueError('INVALID_STATUS_RENAME')
            rec['old_path'] = chunks[i].decode('utf-8', 'replace'); i += 1
        records.append(rec)
    return records


def state(repo):
    head = gs(repo, 'rev-parse', '--verify', 'HEAD', optional=True)
    branch = gs(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD', optional=True)
    raw = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    records = parse_status(raw)
    return {'head': head, 'branch': branch or 'DETACHED', 'records': records,
            'status_sha256': digest(raw),
            'index_sha256': digest(git(repo, 'ls-files', '--stage', '-z'))}


def state_token(s):
    return {k: s[k] for k in ('head', 'branch', 'status_sha256', 'index_sha256')}


def versions(root):
    out = []
    for name in ('package.json', 'apps/api/package.json', 'apps/web/package.json',
                 'frontend/package.json', 'backend/package.json'):
        p = root / name
        if p.is_file() and not p.is_symlink() and p.stat().st_size <= 256 * 1024:
            try:
                x = json.loads(p.read_text())
                out.append({'file': name, 'name': x.get('name'), 'version': x.get('version'),
                            'entry_keys': [k for k in x.get('scripts', {}) if re.search('build|pack|release|preflight|checkpoint|handoff', k)]})
            except (OSError, ValueError):
                out.append({'file': name, 'state': 'UNREADABLE'})
    for name in ('Cargo.toml', 'pyproject.toml', 'Package.swift', 'project.yml', 'VERSION', 'version.json'):
        if (root / name).is_file():
            out.append({'file': name, 'state': 'ENTRY_PRESENT_VALUE_NOT_READ'})
    return out


def worktrees(root):
    raw = gs(root, 'worktree', 'list', '--porcelain')
    out = []
    for block in raw.split('\n\n'):
        d = {}
        for line in block.splitlines():
            k, _, v = line.partition(' ')
            if k in ('worktree', 'HEAD', 'branch'):
                d[k] = v
            elif k in ('detached', 'bare', 'locked', 'prunable'):
                d[k] = True
        if 'worktree' in d:
            d['exists'] = Path(d['worktree']).exists()
            out.append(d)
    return out


def audit(path, phase='preflight', online=False):
    started = now()
    root = Path(gs(path, 'rev-parse', '--show-toplevel')).resolve()
    common = gs(root, 'rev-parse', '--git-common-dir')
    common = str((root / common).resolve())
    first = state(root)
    remotes = []
    for name in gs(root, 'remote').splitlines():
        urls = gs(root, 'remote', 'get-url', '--all', name, optional=True) or ''
        remotes.append({'name': name, 'identities': sorted(set(remote_identity(u) for u in urls.splitlines()))})
    ids = [i for r in remotes if r['name'] == 'origin' for i in r['identities']]
    repo_id = ids[0] if len(ids) == 1 and ids[0] != 'LOCAL_OR_OPAQUE_REMOTE' else 'local:' + common
    upstream = gs(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}', optional=True)
    cached_sha = gs(root, 'rev-parse', '--verify', '@{upstream}', optional=True)
    sync = {'upstream': upstream, 'cached_upstream_commit': cached_sha,
            'cached_ahead': None, 'cached_behind': None, 'network': 'NOT_CHECKED',
            'verified_ahead': None, 'verified_behind': None}
    if cached_sha and first['head']:
        counts = gs(root, 'rev-list', '--left-right', '--count', first['head'] + '...' + cached_sha)
        sync['cached_ahead'], sync['cached_behind'] = map(int, counts.split())
    if online and first['branch'] != 'DETACHED':
        remote = gs(root, 'config', '--get', 'branch.' + first['branch'] + '.remote', optional=True)
        ref = gs(root, 'config', '--get', 'branch.' + first['branch'] + '.merge', optional=True)
        if remote and remote != '.' and ref and ref.startswith('refs/heads/'):
            raw_url = gs(root, 'remote', 'get-url', remote, optional=True)
            ident = remote_identity(raw_url)
            # No local-path, custom-helper or production-host connections.
            if ident and ident.startswith('github.com/'):
                raw = git(root, 'ls-remote', '--exit-code', remote, ref, timeout=12, optional=True)
                if raw:
                    lines = [l.split() for l in raw.decode().splitlines()]
                    matches = [v[0] for v in lines if len(v) == 2 and v[1] == ref]
                    if len(matches) == 1:
                        live = matches[0]
                        sync.update(network='VERIFIED_REF', remote_commit=live, verified_at=now())
                        counts = gs(root, 'rev-list', '--left-right', '--count', first['head'] + '...' + live, optional=True)
                        if counts:
                            sync['verified_ahead'], sync['verified_behind'] = map(int, counts.split())
                        else:
                            sync['network'] = 'VERIFIED_REF_COUNTS_UNKNOWN_NO_FETCH'
                    else:
                        sync['network'] = 'UNKNOWN_AMBIGUOUS_REF'
                else:
                    sync['network'] = 'UNKNOWN_NETWORK_OR_AUTH_OR_MISSING_REF'
            else:
                sync['network'] = 'SKIPPED_NON_GITHUB_REMOTE'
        else:
            sync['network'] = 'UNKNOWN_NO_REMOTE_UPSTREAM'
    records = first['records']
    tracked = [r for r in records if r['xy'] != '??']
    untracked = [r for r in records if r['xy'] == '??']
    dirty = {'tracked': len(tracked), 'untracked': len(untracked),
             'staged': sum(r['xy'][0] not in ' ?' for r in records),
             'unstaged': sum(r['xy'][1] not in ' ?' for r in records),
             'conflicts': sum(r['xy'] in {'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'} for r in records),
             'tracked_categories': dict(collections.Counter(r['category'] for r in tracked)),
             'untracked_categories': dict(collections.Counter(r['category'] for r in untracked)),
             'samples': [{'xy': r['xy'], 'path': '[REDACTED]' if sensitive(r['path']) or r['category'] == 'data_or_unknown_preserve' else r['path'],
                          'category': r['category']} for r in records[:30]],
             'ignored': 'NOT_ENUMERATED_PRESERVE', 'dirty': bool(records)}
    warnings = []
    if records:
        warnings.append('WORK_IN_PROGRESS_DIRTY_NONBLOCKING')
    if dirty['conflicts']:
        warnings.append('UNRESOLVED_GIT_CONFLICTS_OWNER_REVIEW')
    if sum(dirty['tracked_categories'].get(c, 0) + dirty['untracked_categories'].get(c, 0)
           for c in ('source_or_test', 'configuration')):
        warnings.append('UNCOMMITTED_SOURCE_OR_CONFIGURATION_OWNER_REVIEW')
    if sync['cached_behind']:
        warnings.append('BEHIND_CACHED_UPSTREAM')
    if sync.get('verified_behind'):
        warnings.append('BEHIND_VERIFIED_UPSTREAM')
    if sync['cached_ahead']:
        warnings.append('LOCAL_COMMITS_NOT_IN_CACHED_UPSTREAM')
    if not upstream:
        warnings.append('UPSTREAM_UNKNOWN')
    if not first['head']:
        warnings.append('NO_COMMITTED_HEAD_SOURCE_NOT_RECOVERABLE_FROM_GIT')
    main_ref = None
    main_sha = None
    main_counts = None
    for ref in ('refs/remotes/origin/main', 'refs/remotes/origin/master'):
        candidate = gs(root, 'rev-parse', '--verify', ref, optional=True)
        if candidate:
            main_ref, main_sha = ref, candidate
            if first['head']:
                counts = gs(root, 'rev-list', '--left-right', '--count', first['head'] + '...' + candidate, optional=True)
                main_counts = list(map(int, counts.split())) if counts else None
            break
    if repo_id.startswith('local:'):
        warnings.append('CANONICAL_REMOTE_UNKNOWN')
    last = state(root)
    if state_token(first) != state_token(last):
        warnings.append('SNAPSHOT_CHANGED_DURING_READ_RECHECK_OWNER')
    refs_time = None
    f = Path(common) / 'FETCH_HEAD'
    if f.exists():
        refs_time = dt.datetime.fromtimestamp(f.stat().st_mtime, dt.timezone.utc).isoformat()
    return {'schema': SCHEMA, 'phase': phase, 'observed_at': started, 'finished_at': now(),
            'requested_path': str(path), 'root': str(root), 'common_dir': common,
            'repo_id': repo_id, 'remotes': remotes, 'branch': first['branch'], 'head': first['head'],
            'head_time': gs(root, 'log', '-1', '--format=%cI', first['head'], optional=True) if first['head'] else None,
            'exact_tag': gs(root, 'describe', '--tags', '--exact-match', first['head'], optional=True) if first['head'] else None,
            'sync': sync, 'fetch_head_mtime_metadata_only': refs_time,
            'cached_default_reference': {'ref': main_ref, 'commit': main_sha,
                                        'ahead': main_counts[0] if main_counts else None,
                                        'behind': main_counts[1] if main_counts else None,
                                        'network_verified': False, 'purpose': 'reference only; feature divergence is not an error'},
            'dirty': dirty, 'snapshot': state_token(first),
            'snapshot_scope': 'Git metadata only; same-path content edits are not a frozen source snapshot',
            'worktrees': worktrees(root),
            'versions': versions(root), 'deployment': {'state': 'UNKNOWN', 'reason': 'No live deployment evidence supplied; Git/tag/version is not deployment proof'},
            'warnings': warnings}


def discover(roots, depth):
    found, omitted, missing = [], [], []
    def visit(p, n):
        if (p / '.git').exists():
            found.append(str(p.resolve())); return
        if n >= depth:
            return
        try:
            children = sorted(p.iterdir())
        except OSError:
            missing.append(str(p)); return
        for child in children:
            if child.is_symlink() or not child.is_dir() or child.name.startswith('.') or child.name in SKIP:
                continue
            if 'backup' in child.name.lower() or 'archive' in child.name.lower():
                omitted.append(str(child)); continue
            visit(child, n + 1)
    for root in roots:
        visit(Path(root), 0)
    return {'roots': roots, 'max_depth': depth, 'repositories': sorted(set(found)),
            'archives_preserved_not_expanded': omitted, 'unavailable_roots': missing}


def artifact_hash(path):
    """Explicit artifact hashing only; never follow symlinks or hash secret paths."""
    p = Path(path)
    if sensitive(str(p)) or p.is_symlink() or any(parent.is_symlink() for parent in p.parents):
        raise ValueError('UNSAFE_ARTIFACT_PATH')
    def file_hash(f):
        h = hashlib.sha256()
        with f.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    if p.is_file():
        return {'kind': 'file', 'sha256': file_hash(p), 'bytes': p.stat().st_size, 'files': 1}
    if not p.is_dir():
        raise ValueError('ARTIFACT_MISSING')
    rows, total = [], 0
    for base, dirs, files in os.walk(p, followlinks=False):
        for name in dirs + files:
            f = Path(base) / name
            relative = f.relative_to(p).as_posix()
            if f.is_symlink() or sensitive(relative) or name in {'.git', 'node_modules', '.codex', 'sessions', 'data', 'uploads'}:
                raise ValueError('UNSAFE_ARTIFACT_MEMBER')
        for name in sorted(files):
            f = Path(base) / name
            if not f.is_file():
                raise ValueError('NONREGULAR_ARTIFACT_MEMBER')
            rows.append([f.relative_to(p).as_posix(), f.stat().st_size, file_hash(f)])
            total += f.stat().st_size
            if len(rows) > 20000:
                raise ValueError('ARTIFACT_FILE_LIMIT')
    if not rows:
        raise ValueError('EMPTY_ARTIFACT')
    return {'kind': 'tree-sha256-v1', 'sha256': digest(json.dumps(sorted(rows), separators=(',', ':'), ensure_ascii=True).encode()),
            'bytes': total, 'files': len(rows)}


def build(args):
    # Explicit opt-in. A pre-existing artifact is never retrospectively certified.
    root = Path(gs(args.repo, 'rev-parse', '--show-toplevel')).resolve()
    artifact = Path(args.artifact).absolute()
    manifest = Path(args.manifest).absolute()
    if artifact.exists() or artifact.is_symlink() or manifest.exists() or manifest.is_symlink():
        raise ValueError('FRESH_OUTPUT_REQUIRED_NO_OVERWRITE')
    if (sensitive(str(artifact)) or sensitive(str(manifest))
            or any(q.is_symlink() for q in (*artifact.parents, *manifest.parents))):
        raise ValueError('UNSAFE_OUTPUT_PATH')
    if manifest.is_relative_to(root):
        raise ValueError('MANIFEST_MUST_BE_OUTSIDE_SOURCE_TREE')
    cmd = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not cmd:
        raise ValueError('EXPLICIT_BUILD_COMMAND_REQUIRED')
    if bool(args.input) == bool(args.tracked_only):
        raise ValueError('DECLARE_EXTRA_INPUTS_OR_EXPLICIT_TRACKED_ONLY')
    first = audit(root)
    if not first['head'] or first['dirty']['dirty'] or 'SNAPSHOT_CHANGED_DURING_READ_RECHECK_OWNER' in first['warnings']:
        raise ValueError('RELEASE_BUILD_REQUIRES_STABLE_COMMITTED_SOURCE')
    if first['repo_id'].startswith('local:') or '[REDACTED_PATH]' in first['repo_id']:
        raise ValueError('CANONICAL_REMOTE_REQUIRED')
    inputs_before = {str(Path(v).absolute()): artifact_hash(Path(v).absolute())
                     for v in (args.input or [])}
    start = now()
    # Caller selects a known local build. Do not collect or expose child logs.
    rc = subprocess.run(cmd, cwd=root, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL).returncode
    if rc:
        raise ValueError('BUILD_FAILED_NO_MANIFEST')
    second = audit(root)
    if state_token(state(root)) != first['snapshot'] or second['dirty']['dirty']:
        raise ValueError('SOURCE_CHANGED_DURING_BUILD_NO_MANIFEST')
    inputs_after = {str(Path(v).absolute()): artifact_hash(Path(v).absolute())
                    for v in (args.input or [])}
    if inputs_before != inputs_after:
        raise ValueError('DECLARED_INPUT_CHANGED_DURING_BUILD_NO_MANIFEST')
    result = artifact_hash(artifact)
    if state_token(state(root)) != first['snapshot']:
        raise ValueError('SOURCE_CHANGED_DURING_HASH_NO_MANIFEST')
    record = {'schema': SCHEMA, 'provenance': 'dev-guard-wrapped-build-v1',
              'repo': first['repo_id'], 'branch': first['branch'], 'commit': first['head'],
              'dirty': False, 'source_before': first['snapshot'], 'source_after': second['snapshot'],
              'build_started_at': start, 'build_finished_at': now(),
              'build_command_sha256': digest(json.dumps(cmd).encode()), 'artifact': result,
              'buildhash': result['sha256'],
              'source_scope': 'owner-declared-tracked-only' if args.tracked_only else 'tracked-plus-owner-declared-inputs',
              'extra_inputs': inputs_before,
              'tool_sha256': file_digest(Path(__file__)),
              'verification': 'LOCAL_BUILD_RECORD_ONLY_NOT_TEST_OR_DEPLOYMENT_APPROVAL'}
    # Exclusive create preserves history on repeated invocations.
    with manifest.open('x') as f:
        json.dump(record, f, indent=2); f.write('\n')
    return {'state': 'BUILD_RECORDED', 'manifest': str(manifest), 'record': record}


def file_digest(p):
    return digest(p.read_bytes())


def release(args):
    root = Path(gs(args.repo, 'rev-parse', '--show-toplevel')).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', args.target):
        raise ValueError('FULL_TARGET_COMMIT_REQUIRED')
    if gs(root, 'rev-parse', '--verify', args.target + '^{commit}', optional=True) != args.target:
        raise ValueError('TARGET_COMMIT_UNAVAILABLE_LOCALLY')
    p = Path(args.manifest)
    if sensitive(str(p)) or p.is_symlink() or not p.is_file() or p.stat().st_size > 65536:
        raise ValueError('MANIFEST_MISSING_OR_UNSAFE')
    x = json.loads(p.read_text())
    if not isinstance(x, dict):
        raise ValueError('MANIFEST_OBJECT_REQUIRED')
    current = audit(root)
    errors = []
    if x.get('schema') != SCHEMA or x.get('provenance') != 'dev-guard-wrapped-build-v1':
        errors.append('UNKNOWN_BUILD_PROVENANCE')
    if current['repo_id'].startswith('local:') or x.get('repo') != current['repo_id']:
        errors.append('REPOSITORY_MISMATCH_OR_UNKNOWN')
    if x.get('commit') != args.target:
        errors.append('TARGET_COMMIT_MISMATCH')
    if x.get('dirty') is not False:
        errors.append('DIRTY_BUILD_SOURCE')
    before, after = x.get('source_before'), x.get('source_after')
    if not isinstance(before, dict) or before != after or before.get('head') != args.target or before.get('branch') != x.get('branch'):
        errors.append('UNSTABLE_OR_MISSING_BUILD_SOURCE')
    if not x.get('build_started_at') or not x.get('build_finished_at') or not re.fullmatch(r'[0-9a-f]{64}', x.get('build_command_sha256', '')):
        errors.append('MISSING_BUILD_RECORD')
    if x.get('tool_sha256') != file_digest(Path(__file__)):
        errors.append('BUILD_GUARD_VERSION_MISMATCH_REVIEW_REQUIRED')
    if (x.get('source_scope') not in {'owner-declared-tracked-only', 'tracked-plus-owner-declared-inputs'}
            or not isinstance(x.get('extra_inputs'), dict)
            or (x.get('source_scope') == 'tracked-plus-owner-declared-inputs' and not x.get('extra_inputs'))):
        errors.append('BUILD_INPUT_SCOPE_UNKNOWN')
    elif any(sensitive(k) or not isinstance(v, dict) or not re.fullmatch(r'[0-9a-f]{64}', v.get('sha256', ''))
             for k, v in x['extra_inputs'].items()):
        errors.append('INVALID_OR_SENSITIVE_BUILD_INPUT_RECORD')
    actual = artifact_hash(args.artifact)
    if x.get('artifact') != actual or x.get('buildhash') != actual['sha256']:
        errors.append('ARTIFACT_HASH_OR_LAYOUT_MISMATCH')
    return {'state': 'REJECT' if errors else 'PASS_PROVENANCE_ONLY', 'errors': errors,
            'repo': current['repo_id'], 'target': args.target, 'artifact': actual,
            'local_dirty_nonblocking': current['dirty']['dirty'],
            'deployment': 'UNKNOWN_UNTIL_PUBLIC_BUILD_ID_OR_DEPLOYMENT_RECEIPT',
            'limits': 'Unsigned local record; review build command, tests, supply chain, approval and rollback separately.'}, 2 if errors else 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    d = sub.add_parser('discover'); d.add_argument('--root', action='append', required=True); d.add_argument('--depth', type=int, default=3)
    a = sub.add_parser('audit'); a.add_argument('--repo', action='append'); a.add_argument('--inventory'); a.add_argument('--online', action='store_true'); a.add_argument('--phase', choices=['preflight', 'checkpoint', 'handoff'], default='preflight')
    b = sub.add_parser('build', help='EXPLICIT opt-in: execute the given build and exclusively create an external manifest')
    b.add_argument('--repo', required=True); b.add_argument('--artifact', required=True); b.add_argument('--manifest', required=True)
    b.add_argument('--input', action='append', help='Explicit extra public build input, absolute path (e.g. ignored media); hashed before/after')
    b.add_argument('--tracked-only', action='store_true', help='Owner explicitly declares no source input outside committed tracked files')
    b.add_argument('command', nargs=argparse.REMAINDER)
    r = sub.add_parser('release', help='Read-only provenance gate; never deploys')
    r.add_argument('--repo', required=True); r.add_argument('--target', required=True); r.add_argument('--artifact', required=True); r.add_argument('--manifest', required=True)
    args = p.parse_args(); rc = 0
    try:
        if args.action == 'discover':
            if not 1 <= args.depth <= 4:
                raise ValueError('DISCOVERY_DEPTH_MUST_BE_1_TO_4')
            result = discover(args.root, args.depth)
        elif args.action == 'audit':
            paths = args.repo or []
            if args.inventory:
                paths += json.loads(Path(args.inventory).read_text())['repositories']
            result = []
            for path in dict.fromkeys(paths or ['.']):
                try:
                    result.append(audit(path, args.phase, args.online))
                except (ValueError, OSError):
                    result.append({'root': path, 'state': 'UNKNOWN_QUERY_FAILED', 'observed_at': now()}); rc = 2
        elif args.action == 'build':
            result = build(args)
        else:
            result, rc = release(args)
    except (ValueError, OSError, TypeError, KeyError) as exc:
        # Emit only our machine codes; arbitrary exception text may carry credentials.
        code = str(exc)
        reason = code if re.fullmatch('[A-Z][A-Z0-9_:]+', code) else 'INVALID_INPUT_OR_QUERY_FAILED'
        result = {'state': 'ERROR_OR_REJECT', 'reason': reason}; rc = 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return rc


if __name__ == '__main__':
    sys.exit(main())
