import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for job progress → SSE (§37, §50).
 * For a multi-node deployment this would be backed by Redis pub/sub.
 */
export interface JobEvent {
  jobId: string;
  projectId: string | null;
  type: string;
  status: string;
  progress?: unknown;
  error?: string | null;
  at: string;
}

class JobBus extends EventEmitter {
  publish(evt: JobEvent): void {
    this.emit('job', evt);
    if (evt.projectId) this.emit(`project:${evt.projectId}`, evt);
    this.emit(`job:${evt.jobId}`, evt);
  }
}

export const jobBus = new JobBus();
jobBus.setMaxListeners(1000);
