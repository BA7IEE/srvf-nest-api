### Changed

- **R8 探针自测成批,一次自测的 `ts.Program` 构建由 32 次降到 2 次**(本机 133–181s → 59–61s)。原实现逐个重写同一个探针文件、每轮换一个 `cacheKey`,于是每轮**必须**重建一次全仓 `ts.Program`;现改为一次性写出 30 个探针文件、共用一个 `cacheKey`,再一次 `scanRouteAuthzClosure` + 一次 `lintFiles` 收结果,全仓首扫移到探针之前(此时 `src/` 还干净)。`SOURCE_INDEX_CACHE_LIMIT = 2` **未改**,峰值内存不升反降。判据强度零放宽,另新增三条机器判据:探针类名 / routeKey 唯一性、lint 覆盖面等于探针数、整段 R8 的 `ts.Program` 构建次数 ≤ 2(防再退化)。
