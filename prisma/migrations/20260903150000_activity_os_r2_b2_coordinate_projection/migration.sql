-- Activity OS Release 2 / B2：地点坐标的成对、坐标系与全球范围证明。
--
-- 只收紧 B1 新增的 PlacePreset / ActivityPlace；每张表三条 CHECK 均在同一事务内
-- 验证既有行。零 ALTER Activity / ActivitySession 旧列，零回填、零触发器、零 writer。

BEGIN;

ALTER TABLE "PlacePreset"
  ADD CONSTRAINT "place_preset_coordinate_pair_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL)
      OR ("longitude" IS NOT NULL AND "latitude" IS NOT NULL)
    ),
  ADD CONSTRAINT "place_preset_coordinate_system_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL AND "coordinateSystemCode" IS NULL)
      OR (
        "longitude" IS NOT NULL
        AND "latitude" IS NOT NULL
        AND "coordinateSystemCode" IS NOT NULL
        AND "coordinateSystemCode" IN ('wgs84', 'gcj02', 'bd09')
      )
    ),
  ADD CONSTRAINT "place_preset_coordinate_range_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL)
      OR (
        "longitude" IS NOT NULL
        AND "latitude" IS NOT NULL
        AND "longitude" >= -180
        AND "longitude" <= 180
        AND "latitude" >= -90
        AND "latitude" <= 90
      )
    );

ALTER TABLE "ActivityPlace"
  ADD CONSTRAINT "activity_place_coordinate_pair_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL)
      OR ("longitude" IS NOT NULL AND "latitude" IS NOT NULL)
    ),
  ADD CONSTRAINT "activity_place_coordinate_system_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL AND "coordinateSystemCode" IS NULL)
      OR (
        "longitude" IS NOT NULL
        AND "latitude" IS NOT NULL
        AND "coordinateSystemCode" IS NOT NULL
        AND "coordinateSystemCode" IN ('wgs84', 'gcj02', 'bd09')
      )
    ),
  ADD CONSTRAINT "activity_place_coordinate_range_check"
    CHECK (
      ("longitude" IS NULL AND "latitude" IS NULL)
      OR (
        "longitude" IS NOT NULL
        AND "latitude" IS NOT NULL
        AND "longitude" >= -180
        AND "longitude" <= 180
        AND "latitude" >= -90
        AND "latitude" <= 90
      )
    );

COMMIT;
