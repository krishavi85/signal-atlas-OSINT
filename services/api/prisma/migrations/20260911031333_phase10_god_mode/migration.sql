-- CreateTable
CREATE TABLE "god_mode_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "objective" TEXT,
    "subjectType" TEXT,
    "depth" TEXT NOT NULL DEFAULT 'STANDARD',
    "languages" TEXT NOT NULL DEFAULT 'en',
    "dateRangeStart" DATETIME,
    "dateRangeEnd" DATETIME,
    "requestedConnectors" JSONB,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "searchIds" JSONB,
    "reportId" TEXT,
    "resultJson" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "god_mode_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "god_mode_runs_projectId_createdAt_idx" ON "god_mode_runs"("projectId", "createdAt");
