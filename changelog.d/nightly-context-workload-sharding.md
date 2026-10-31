### Fixed

- Split nightly serial E2E into four workload groups (currently 42/136/108/166 suites). Keep the complete historical 42-suite antecedent chain in an explicit, cache-independent Jest order, and keep the platform group intact. All 452 suites remain covered exactly once; other activity suites stay in whole business-family groups.
- Keep each shard's 70-minute test budget, 85-minute job limit, 8 GiB Node heap cap, serial handle detection, assertions and workflow permissions unchanged. Peak test concurrency increases from two to four. Timing estimates are planning evidence rather than an SLA; unknown interactions between the new groups and the original slow-query cause remain unproven. Preserve each shard's planned suite list with its full log.
