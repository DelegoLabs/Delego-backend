import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReconciliationJobService } from './reconciliationJobService.js';

describe('ReconciliationJobService', () => {
  let service: any;
  let jobRepo: any;
  let auditRepo: any;
  let reportGenerator: any;

  beforeEach(() => {
    jobRepo = {
      insert: vi.fn(async (job: any) => ({ ...job, id: 'job-1' })),
      findById: vi.fn(),
      list: vi.fn(),
      update: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
      getUnresolvedDiscrepancies: vi.fn(),
    };
    auditRepo = { insert: vi.fn() };
    reportGenerator = { generate: vi.fn() };
    service = new ReconciliationJobService(jobRepo, auditRepo, reportGenerator);
  });

  it('should instantiate', () => {
    expect(service).toBeDefined();
  });

  it('createJob persists a job in pending status', async () => {
    const job = await service.createJob({ tenantId: 't1', period: '2024-01' });
    expect(job.status).toBe('pending');
    expect(jobRepo.insert).toHaveBeenCalled();
  });

  it('getJob returns the stored job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'pending' });
    const job = await service.getJob('job-1');
    expect(job.id).toBe('job-1');
  });

  it('listJobs delegates to repository', async () => {
    jobRepo.list.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const jobs = await service.listJobs({ tenantId: 't1' });
    expect(jobs).toHaveLength(2);
  });

  it('updateJobStatus transitions pending -> running', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'pending' });
    await service.updateJobStatus('job-1', 'running');
    expect(jobRepo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'running' }));
  });

  it('updateJobStatus rejects invalid transition completed -> running', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'completed' });
    await expect(service.updateJobStatus('job-1', 'running')).rejects.toThrow();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('completeJob marks running job as completed with timestamp', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'running' });
    await service.completeJob('job-1');
    expect(jobRepo.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'completed', completedAt: expect.any(Date) }),
    );
  });

  it('cancelJob marks pending job as cancelled', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'pending' });
    await service.cancelJob('job-1');
    expect(jobRepo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('cancelJob rejects a completed job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'completed' });
    await expect(service.cancelJob('job-1')).rejects.toThrow();
  });

  it('generateReport invokes the report generator for the job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'completed' });
    reportGenerator.generate.mockResolvedValue({ url: 'r.pdf' });
    const report = await service.generateReport('job-1');
    expect(report.url).toBe('r.pdf');
    expect(reportGenerator.generate).toHaveBeenCalled();
  });

  it('logAudit writes an audit entry', async () => {
    await service.logAudit('job-1', 'status_changed', { to: 'running' });
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', action: 'status_changed' }),
    );
  });

  it('getUnresolvedDiscrepancies delegates to repository', async () => {
    jobRepo.getUnresolvedDiscrepancies.mockResolvedValue([{ id: 'd1' }]);
    const result = await service.getUnresolvedDiscrepancies('job-1');
    expect(result).toHaveLength(1);
  });
});
