### Fixed

- Initialize PL/pgSQL on the same PostgreSQL session used for migration144/145 settings snapshots, while retaining full settings comparisons and database invariants.
- Prepare the third genuine revision in the existing setup hook and record setup, oracle and native proof durations. Retain the test's 30-second limit, prepare/native deadlines, all three oracle comparisons and complete NULL/21-field proof; the test no longer charges the third fixture preparation to its own 30-second window.
- Restore the exact pre-fixture-change catalog source before applying the original frozen-source bindings; preserve both prior source and opening hashes, with negative controls for changed fixture, timing, oracle, native deadline and duplicate marker bytes.
