# R5 canonical singleton repair candidate

Production NO_GO. Release5 incomplete. This candidate follows the real D7 precondition failure, not an unchanged retry.

The original default CI D7 Human V3 2000 case failed P2028 at 7077/7000ms. Diagnostic682c ran once on new602aaf pair and failed earlier in initial prepare receipt at31939.010ms; the correction commit was NOT_REACHED/UNKNOWN. Both failures remain open.

Current148 read-only profile: sourceDocument1643.015ms, canonical32001calls/3823.350ms; instrumented hash window5533.278ms. Timing includes instrumentation and cannot prove a native budget. Flags shape9999 single-key objects each containing a one-element scalar array,1NULL; empty containers0. The empty-container proposal was not implemented.

Neww99 pure JSON comparison retained all old26 OIDs and all27 databases.184 full byte oracles and an8184628-byte real test-source document matched142 and the fixed148 hash. One sequential component comparison: baseline2432.307ms,array1769.134ms,combined singletons1325.100ms. This supports a candidate only; no native acceptance is claimed.

149 only changes astr_canonical_json body. Single-element arrays bypass the generic aggregate; small single-key objects bypass object aggregate and retain recursive children. All other containers retain142, including the nine-key scalar unit path. Signature, volatility, strictness, ownership/ACL, guards, locks, budgets and assertions stay unchanged. Service lock-preflight hash remains because it also rejects invalid input before locks.

New6-phase test covers nonempty148→149/no-op with catalog/business rows unchanged, complete canonical edge bytes, real guarded prepare/submit, receipt positive/forged negative rollback, forward restore142 body rehearsal rolled back, and post-COMMIT roots. The prior148 test is pinned to148; its assertions and budget remain unchanged. Historical137 prefix stays closed,149 is separately pinned. Typed total counts advance149.

Validation order: final static/unit checks, new isolated upgrade once, only allPASS+known resource terminal then original failed D7 case once, only allPASS then ordinaryR4 once. No local maximum repeat. A later Draft default CI counts maximum only if separately permitted and all prerequisites passed. Any FAIL/UNKNOWN stops downstream work and preserves all evidence databases. Fullnightly paused; C1/S13 and originalR5/E4 maximum remain unaccepted. AC013/020/025 deferred, AC017 shelved TODO unchanged.

Current: repository migration149 written at exact approved SHA997589df; normal CLI grant cleared. Final36-file lint and actual-tree test TypeScript passed (2026 declared inputs unchanged); prefix unit pending. First codemap check failed due prisma/CLAUDE.md stale148 declaration and is preserved; current149 note added without editing old history. New upgrade/D7/R4/CI NOT_RUN; push/Ready/merge/production/data conversion NOT_RUN. Only the singleton pure JSON component experiment has passed.
