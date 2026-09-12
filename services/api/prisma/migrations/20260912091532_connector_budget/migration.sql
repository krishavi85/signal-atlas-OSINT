-- CreateTable
CREATE TABLE "connector_budget_usage" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "connectorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "connector_budget_usage_connectorId_day_idx" ON "connector_budget_usage"("connectorId", "day");
