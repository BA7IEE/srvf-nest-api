from pathlib import Path
import hashlib
import json
import subprocess


def verified_migration_sources(checkout):
    helper = Path(__file__).resolve()
    runtime = helper.parents[2]
    result = subprocess.run(
        ['node', '-r', str(runtime / 'node_modules/ts-node/register/transpile-only'),
         str(helper.with_name('migration-inventory.ts')), str(Path(checkout).resolve())],
        cwd=runtime, check=True, capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout)['migrations']


def migration_install_sql(checkout):
    checkout = Path(checkout)
    statements = []
    for source in verified_migration_sources(checkout):
        sql = (checkout / 'prisma/migrations' / source['name'] / 'migration.sql').read_bytes()
        if hashlib.sha256(sql).hexdigest() != source['sha256']:
            raise RuntimeError('MIGRATION_SOURCE_CHECKSUM_CHANGED')
        statements.append('\\echo ' + source['name'] + '\n' + sql.decode('utf8'))
    return '\n'.join(statements)
