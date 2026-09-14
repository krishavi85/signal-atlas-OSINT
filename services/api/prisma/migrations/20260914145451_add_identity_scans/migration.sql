-- CreateTable
CREATE TABLE "identity_scans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "jobId" TEXT,
    "totalChecked" INTEGER NOT NULL DEFAULT 0,
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "datasetSource" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "identity_scan_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "category" TEXT,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "protection" TEXT,
    "error" TEXT,
    "evidenceId" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_scan_results_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "identity_scans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "identity_scans_projectId_createdAt_idx" ON "identity_scans"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "identity_scan_results_scanId_status_idx" ON "identity_scan_results"("scanId", "status");
