### Changed

- Reuse successful ISO instant parsing within each C3 bucket calculation while retaining original invalid-input handling and integral arithmetic.
- Reuse canonical unit text for identical validated primitive time units and serialize primitive evaluation fields with the exact original canonical branches. Preserve all reference ordering, hashes, checks, limits, correction paths and transaction budgets.
- Freeze complete C3 outputs before the change and compare both C3 bucket hashes and E4 evaluation hashes against the original generic canonicalizers.
