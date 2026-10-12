### Changed

- Add fixed process CPU deltas at the existing prepare phase boundaries. Keep the same original methods, Promises, inputs, outcomes, restoration, output bound and business budgets.
- CPU intervals include native threads and overlap for nested phases; they are observations for locating the timeout, not performance acceptance. Invalid or unavailable counters remain UNKNOWN.
