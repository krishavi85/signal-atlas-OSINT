-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "disabledAt" DATETIME
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "objective" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "defaultLanguages" TEXT NOT NULL DEFAULT 'en',
    "dateRangeStart" DATETIME,
    "dateRangeEnd" DATETIME,
    "retentionDays" INTEGER,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialsEnc" TEXT,
    "configJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "connector_health" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectorId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "requestsRemaining" INTEGER,
    "message" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "connector_health_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "connectors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "searches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "originalQuery" TEXT NOT NULL,
    "subjectType" TEXT,
    "objective" TEXT,
    "dateAfter" DATETIME,
    "dateBefore" DATETIME,
    "languages" TEXT NOT NULL DEFAULT 'en',
    "depth" TEXT NOT NULL DEFAULT 'STANDARD',
    "requestedConnectors" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "jobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "searches_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "queries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "generatedBy" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "queries_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "searches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "search_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchId" TEXT NOT NULL,
    "queryId" TEXT,
    "connectorId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skippedReason" TEXT,
    "httpRequests" INTEGER NOT NULL DEFAULT 0,
    "rawHitCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueCount" INTEGER NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "notices" JSONB,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_runs_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "searches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "search_runs_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "queries" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "search_runs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "connectors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "registrableDomain" TEXT,
    "platform" TEXT,
    "url" TEXT,
    "tier" TEXT,
    "qualityScore" REAL,
    "qualityReasons" JSONB,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT,
    "extractedText" TEXT,
    "metadataJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT,
    "documentId" TEXT,
    "connectorId" TEXT NOT NULL,
    "searchId" TEXT,
    "discoveryQuery" TEXT NOT NULL,
    "sourcePlatform" TEXT NOT NULL,
    "url" TEXT,
    "canonicalUrl" TEXT,
    "title" TEXT,
    "author" TEXT,
    "publishedAt" DATETIME,
    "retrievedAt" DATETIME NOT NULL,
    "excerpt" TEXT,
    "fullText" TEXT,
    "language" TEXT,
    "rawMetadata" JSONB NOT NULL,
    "mediaJson" JSONB,
    "screenshotKey" TEXT,
    "contentHash" TEXT NOT NULL,
    "simhash" TEXT,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfId" TEXT,
    "duplicateReason" TEXT,
    "clusterId" TEXT,
    "analysisStatus" TEXT NOT NULL DEFAULT 'UNPROCESSED',
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "evidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "evidence_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "connectors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "evidence_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "searches" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "evidence_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "evidence" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "canonicalValue" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "resolutionConfidence" TEXT NOT NULL DEFAULT 'LOW',
    "mergedIntoId" TEXT,
    "attributesJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "entities_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "entities_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "entities" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "entity_aliases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NAME',
    "source" TEXT NOT NULL DEFAULT 'EXTRACTED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_aliases_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "evidence_entities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "evidenceId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "contextText" TEXT NOT NULL,
    "offsetStart" INTEGER,
    "confidence" REAL NOT NULL,
    "method" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'DETERMINISTIC_EXTRACTION',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evidence_entities_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "evidence_entities_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "entity_merge_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "otherEntityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" REAL,
    "factorsJson" JSONB,
    "performedBy" TEXT NOT NULL,
    "reversible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_merge_log_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "directed" BOOLEAN NOT NULL DEFAULT true,
    "evidenceIds" JSONB NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "note" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "relationships_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "relationships_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "relationships_toId_fkey" FOREIGN KEY ("toId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "claimDate" DATETIME,
    "text" TEXT NOT NULL,
    "epistemicTag" TEXT NOT NULL DEFAULT 'CLAIM',
    "corroboration" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "confidenceScore" REAL NOT NULL DEFAULT 0,
    "confidenceLevel" TEXT NOT NULL DEFAULT 'VERY_LOW',
    "confidenceFactorsJson" JSONB,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "createdBy" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "claims_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "claim_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "excerpt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claim_evidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "claim_evidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "contradictions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "claimAId" TEXT NOT NULL,
    "claimBId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "contradictions_claimAId_fkey" FOREIGN KEY ("claimAId") REFERENCES "claims" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "contradictions_claimBId_fkey" FOREIGN KEY ("claimBId") REFERENCES "claims" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "timeline_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "precision" TEXT NOT NULL DEFAULT 'DAY',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "eventType" TEXT NOT NULL DEFAULT 'MENTION',
    "entityId" TEXT,
    "evidenceId" TEXT,
    "confidenceLevel" TEXT NOT NULL DEFAULT 'LOW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "timeline_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "timeline_events_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "monitoring_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "connectorId" TEXT,
    "connectorIds" JSONB,
    "scheduleCron" TEXT NOT NULL,
    "languages" TEXT NOT NULL DEFAULT 'en',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "nextRunAt" DATETIME,
    "lastError" TEXT,
    "rateLimitState" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "monitoring_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "monitoring_jobs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "connectors" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "monitoring_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "monitoringJobId" TEXT NOT NULL,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedDuplicateCount" INTEGER NOT NULL DEFAULT 0,
    "evidenceIds" JSONB,
    "summary" TEXT NOT NULL,
    "error" TEXT,
    CONSTRAINT "monitoring_results_monitoringJobId_fkey" FOREIGN KEY ("monitoringJobId") REFERENCES "monitoring_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "storageKey" TEXT,
    "sha256" TEXT,
    "perceptualHash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" REAL,
    "exifJson" JSONB,
    "ocrText" TEXT,
    "transcript" TEXT,
    "evidenceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NOTE',
    "title" TEXT,
    "body" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'HUMAN_ANALYST',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "referencedEvidenceIds" JSONB,
    "referencedEntityIds" JSONB,
    "tags" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "checksum" TEXT,
    "paramsJson" JSONB,
    "sectionsJson" JSONB,
    "generatedById" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payloadJson" JSONB NOT NULL,
    "progressJson" JSONB,
    "stepsJson" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "scheduledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "response_cache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "connectorId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "counters" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refreshTokenHash_key" ON "auth_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_ownerId_idx" ON "projects"("ownerId");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE INDEX "connector_health_connectorId_checkedAt_idx" ON "connector_health"("connectorId", "checkedAt");

-- CreateIndex
CREATE INDEX "searches_projectId_createdAt_idx" ON "searches"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "queries_searchId_idx" ON "queries"("searchId");

-- CreateIndex
CREATE INDEX "search_runs_searchId_idx" ON "search_runs"("searchId");

-- CreateIndex
CREATE INDEX "search_runs_connectorId_idx" ON "search_runs"("connectorId");

-- CreateIndex
CREATE INDEX "sources_registrableDomain_idx" ON "sources"("registrableDomain");

-- CreateIndex
CREATE UNIQUE INDEX "sources_kind_label_key" ON "sources"("kind", "label");

-- CreateIndex
CREATE INDEX "documents_projectId_idx" ON "documents"("projectId");

-- CreateIndex
CREATE INDEX "documents_sha256_idx" ON "documents"("sha256");

-- CreateIndex
CREATE INDEX "evidence_projectId_createdAt_idx" ON "evidence"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "evidence_contentHash_idx" ON "evidence"("contentHash");

-- CreateIndex
CREATE INDEX "evidence_canonicalUrl_idx" ON "evidence"("canonicalUrl");

-- CreateIndex
CREATE INDEX "evidence_clusterId_idx" ON "evidence"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_year_seq_key" ON "evidence"("year", "seq");

-- CreateIndex
CREATE INDEX "entities_projectId_type_idx" ON "entities"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "entities_projectId_type_canonicalValue_key" ON "entities"("projectId", "type", "canonicalValue");

-- CreateIndex
CREATE UNIQUE INDEX "entity_aliases_entityId_value_kind_key" ON "entity_aliases"("entityId", "value", "kind");

-- CreateIndex
CREATE INDEX "evidence_entities_entityId_idx" ON "evidence_entities"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_entities_evidenceId_entityId_originalText_key" ON "evidence_entities"("evidenceId", "entityId", "originalText");

-- CreateIndex
CREATE INDEX "entity_merge_log_entityId_idx" ON "entity_merge_log"("entityId");

-- CreateIndex
CREATE INDEX "relationships_projectId_idx" ON "relationships"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_projectId_fromId_toId_type_key" ON "relationships"("projectId", "fromId", "toId", "type");

-- CreateIndex
CREATE INDEX "claims_projectId_idx" ON "claims"("projectId");

-- CreateIndex
CREATE INDEX "claim_evidence_evidenceId_idx" ON "claim_evidence"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "claim_evidence_claimId_evidenceId_key" ON "claim_evidence"("claimId", "evidenceId");

-- CreateIndex
CREATE INDEX "contradictions_projectId_idx" ON "contradictions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "contradictions_claimAId_claimBId_key" ON "contradictions"("claimAId", "claimBId");

-- CreateIndex
CREATE INDEX "timeline_events_projectId_occurredAt_idx" ON "timeline_events"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "monitoring_jobs_projectId_idx" ON "monitoring_jobs"("projectId");

-- CreateIndex
CREATE INDEX "monitoring_jobs_enabled_nextRunAt_idx" ON "monitoring_jobs"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "monitoring_results_monitoringJobId_runAt_idx" ON "monitoring_results"("monitoringJobId", "runAt");

-- CreateIndex
CREATE INDEX "media_projectId_idx" ON "media"("projectId");

-- CreateIndex
CREATE INDEX "media_sha256_idx" ON "media"("sha256");

-- CreateIndex
CREATE INDEX "notes_projectId_kind_idx" ON "notes"("projectId", "kind");

-- CreateIndex
CREATE INDEX "reports_projectId_idx" ON "reports"("projectId");

-- CreateIndex
CREATE INDEX "jobs_status_scheduledAt_idx" ON "jobs"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "jobs_projectId_idx" ON "jobs"("projectId");

-- CreateIndex
CREATE INDEX "audit_logs_projectId_createdAt_idx" ON "audit_logs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "response_cache_expiresAt_idx" ON "response_cache"("expiresAt");

-- CreateIndex
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");
