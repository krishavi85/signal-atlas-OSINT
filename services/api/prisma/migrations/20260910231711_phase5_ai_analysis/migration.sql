-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "question" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outputText" TEXT NOT NULL,
    "outputJson" JSONB,
    "citedEvidenceIds" JSONB NOT NULL,
    "ungroundedStatements" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_analyses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ai_analyses_projectId_kind_createdAt_idx" ON "ai_analyses"("projectId", "kind", "createdAt");
