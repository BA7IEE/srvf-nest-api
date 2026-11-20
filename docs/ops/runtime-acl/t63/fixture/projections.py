"""PG16 executor permission masks for the two application logins; output contains no SQL values."""

import hashlib
import re

PERMS = re.compile(
    r"\{RTEPERMISSIONINFO :relid (\d+) :inh \w+ :requiredPerms (\d+) :checkAsUser (\d+) "
    r":selectedCols \(b([^)]*)\) :insertedCols \(b([^)]*)\) :updatedCols \(b([^)]*)\)"
)


def collect(rows, catalog):
    result = {}
    for row in rows:
        if (
            len(row) < 23
            or row[1] not in ("t63_api", "t63_worker")
            or row[2] != "t63_lab"
            or row[13] != "plan:"
        ):
            continue
        # PostgreSQL's internal referential-integrity checks execute as the referenced table owner.
        if "FROM ONLY" in row[18] and "FOR KEY SHARE" in row[18]:
            continue
        statement = hashlib.sha256(row[19].encode()).hexdigest()
        for oid, mask, subject, sel, ins, upd in PERMS.findall(" ".join(row[14].split())):
            if oid not in catalog or subject != "0":
                continue
            table, attrs = catalog[oid]
            for bit, op, bitmap in ((2, "SELECT", sel), (1, "INSERT", ins), (4, "UPDATE", upd)):
                if not int(mask) & bit:
                    continue
                # PG16 numbers user attributes from 1, bitmap members from 8.
                nums = set(map(int, bitmap.split()))
                columns = (
                    sorted(attrs.values()) if 7 in nums else sorted(attrs[n] for n in nums if n in attrs)
                )
                key = (row[1], table, op, tuple(columns))
                result.setdefault(key, set()).add(statement)
    return [
        dict(role=r, table=t, op=o, columns=list(c), sqlSHA256=sorted(h))
        for (r, t, o, c), h in sorted(result.items())
    ]


def verify(contract, evidence):
    """Every explicit column needs a witness. A row lock/count can require any one column."""
    witnessed = {}
    for v in evidence:
        key = (v["role"], v["table"], v["op"])
        witnessed.setdefault(key, set()).update(v["columns"])
    for role, tables in contract.items():
        for table, ops in tables.items():
            for op, cols in ops.items():
                key = (role, table, op)
                if key not in witnessed:
                    raise ValueError(f"No execution evidence for {key}")
                actual = witnessed.pop(key)
                if (actual and actual != set(cols)) or (not actual and len(cols) != 1):
                    raise ValueError(
                        f"Unexpected projection for {key}: {sorted(actual.symmetric_difference(cols))}"
                    )
    if witnessed:
        raise ValueError(f"Unregistered execution evidence: {list(witnessed)}")
