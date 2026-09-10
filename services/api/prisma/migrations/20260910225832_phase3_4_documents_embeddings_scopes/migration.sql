-- AlterTable
ALTER TABLE "projects" ADD COLUMN "connectorScopesJson" JSONB;

-- CreateTable
CREATE TABLE "evidence_embeddings" (
    "evidenceId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" JSONB NOT NULL,
    "norm" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evidence_embeddings_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "evidence_embeddings_projectId_idx" ON "evidence_embeddings"("projectId");
