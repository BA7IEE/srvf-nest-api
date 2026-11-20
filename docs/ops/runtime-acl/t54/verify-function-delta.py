"""Run from a checkout with the T54 commit, using only Git objects and the rollback receipt."""
import hashlib
import json
from pathlib import Path
import subprocess

HEAD = '65d1d6ea4caaa815faac0e79ead8846b6cc3ade9'
receipt = json.loads((Path(__file__).parent / 'migration-evidence.json').read_text())['ddl_rollback']
changes = [
    ('ctsp_lifecycle_guard', '20261120073000_settlement_deferred_correction_guard',
     '  -- Plan the restricted function call', '  PERFORM ctsp_assert_complete(',
     '  IF application_id IS NOT NULL AND public.r5_correction_phase_deferred_registered(application_id) THEN RETURN NULL; END IF;\n'),
    ('ctsp_assert_complete', '20261120073100_settlement_correction_proof_lookup',
     '  -- An ordinary batch has no correction', '  SELECT p.*, a."statusCode"', ''),
]
for function, migration, first, after, old_fragment in changes:
    ref = f'{HEAD}:prisma/migrations/{migration}/migration.sql'
    sql = subprocess.check_output(['git', 'show', ref]).decode()
    assert sql.count('$$') == 2
    body = sql.split('$$')[1]
    assert body.count(first) == 1 and body.count(after) == 1
    restored = body[:body.index(first)] + old_fragment + body[body.index(after):]
    for name, value in [('old_function_hashes', restored), ('final_function_hashes', body)]:
        assert hashlib.sha256(value.encode()).hexdigest() == receipt[name][function], (name, function)
    print(function, 'both hashes match')
