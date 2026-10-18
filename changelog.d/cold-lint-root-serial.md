### Changed

- Run the original uncached ESLint CLI serially for the original three root globs, releasing each CLI's parser state before the next root. Each input file is scanned once; the original configuration, heap and 300-second global deadline remain fixed.
- Validate every root before continuing and require complete combined coverage. Preserve the original cumulative output cap and all report/process failure checks, with composition and failure controls.
