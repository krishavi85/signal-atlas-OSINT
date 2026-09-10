-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "storageKey" TEXT,
    "sha256" TEXT,
    "format" TEXT,
    "byteSize" INTEGER,
    "perceptualHash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" REAL,
    "exifJson" JSONB,
    "gpsLat" REAL,
    "gpsLon" REAL,
    "capturedAt" DATETIME,
    "ocrText" TEXT,
    "visionText" TEXT,
    "transcript" TEXT,
    "clusterId" TEXT,
    "duplicateOfId" TEXT,
    "evidenceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "note" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "media_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "media" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_media" ("createdAt", "durationSec", "evidenceId", "exifJson", "height", "id", "kind", "note", "ocrText", "perceptualHash", "projectId", "sha256", "sourceUrl", "status", "storageKey", "transcript", "width") SELECT "createdAt", "durationSec", "evidenceId", "exifJson", "height", "id", "kind", "note", "ocrText", "perceptualHash", "projectId", "sha256", "sourceUrl", "status", "storageKey", "transcript", "width" FROM "media";
DROP TABLE "media";
ALTER TABLE "new_media" RENAME TO "media";
CREATE INDEX "media_projectId_status_idx" ON "media"("projectId", "status");
CREATE INDEX "media_sha256_idx" ON "media"("sha256");
CREATE INDEX "media_perceptualHash_idx" ON "media"("perceptualHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
