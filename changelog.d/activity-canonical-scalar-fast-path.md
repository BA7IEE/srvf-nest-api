### Changed

- Add migration 138 to reuse the original JSONB scalar text directly inside canonical arrays and objects. Preserve recursive container handling, canonical ordering, scalar representation, function identity and privileges.
- Keep historical E4 validation on the exact first 137 migrations. Add a separate nonempty 137-to-138 upgrade proof covering complete canonical text, hashes, business rows, function metadata and a second no-op deploy. Synchronize current migration count declarations without changing historical baselines or transaction budgets.
