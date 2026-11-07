import { isLocalName, localDomainFor } from '@devmagic-panel/shared';
import type { FastifyInstance } from 'fastify';
import type { Executor } from '../exec.js';
import type { Jobs } from '../jobs.js';
import type { JobView, UploadResult } from '@devmagic-panel/shared';
import { currentUpload, removeUpload, saveUpload, UploadError } from './uploads.js';

export interface CreateRouteDeps {
  exec: Executor;
  jobs: Jobs;
  uploadsDir: string;
}

/** Dump uploads and job status; registered inside the authenticated scope. */
export function registerCreateRoutes(api: FastifyInstance, deps: CreateRouteDeps): void {
  // Dumps arrive as a raw body and are streamed straight to disk.
  api.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  // What the wizard suggests from a dump: a local name for every address it uses. The core is always the newest you have, or your pick.
  const withSuggestions = (info: Omit<UploadResult, 'suggestions'>): UploadResult => {
    return {
      ...info,
      suggestions: {
        // Every address the dump uses; one that is already a local name maps to itself, which the wizard leaves out of the replace.
        replace: info.facts.hosts.map((from) => ({ from, to: isLocalName(from) ? from : localDomainFor(from) })),
      },
    };
  };

  api.post<{ Querystring: { name?: string } }>('/api/uploads', async (request, reply) => {
    try {
      return withSuggestions(await saveUpload(deps.exec, deps.uploadsDir, request.query.name ?? '', request.body as NodeJS.ReadableStream));
    } catch (error) {
      if (error instanceof UploadError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // The wizard drops a dump it no longer uses (another file was picked); one a job still reads stays.
  // An upload's name, size and what its dump holds, for a dump the wizard did not upload itself, like a download.
  api.get<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply): Promise<UploadResult | undefined> => {
    const upload = /^[0-9a-f-]{36}$/.test(request.params.id) ? await currentUpload(deps.exec, deps.uploadsDir, request.params.id) : null;
    if (!upload) return reply.code(404).send({ error: 'No such upload: it is gone' });
    return withSuggestions({ id: upload.id, name: upload.name, size: upload.size, facts: upload.facts });
  });

  api.delete<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(400).send({ error: 'unknown upload' });
    if (deps.jobs.uploadsInUse().has(request.params.id)) return reply.code(409).send({ error: 'a job still reads this dump' });
    removeUpload(deps.uploadsDir, request.params.id);
    return { ok: true };
  });

  // Queued, running and recent jobs, for the header's progress indicator.
  api.get('/api/jobs', async (): Promise<JobView[]> => deps.jobs.list());

  api.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => deps.jobs.get(request.params.id) ?? reply.code(404).send({ error: 'unknown job' }));

  api.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) =>
    deps.jobs.retry(request.params.id) ?? reply.code(409).send({ error: 'only a failed job can be retried' }),
  );

  api.post<{ Params: { id: string } }>('/api/jobs/:id/stop', async (request, reply) =>
    deps.jobs.stop(request.params.id) ?? reply.code(409).send({ error: 'only a running job that can stop safely can be stopped' }),
  );

  api.post<{ Params: { id: string } }>('/api/jobs/:id/skip', async (request, reply) =>
    deps.jobs.skip(request.params.id) ?? reply.code(409).send({ error: 'only a failed step the panel marks as skippable can be skipped' }),
  );

  api.post<{ Params: { id: string } }>('/api/jobs/:id/undo', async (request, reply) =>
    deps.jobs.undo(request.params.id) ?? reply.code(409).send({ error: 'this job cannot be undone now' }),
  );
}
