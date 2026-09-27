import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { parseModelString } from '@/lib/ai/providers';
import { AttachmentError, buildAttachmentBundle } from '@/lib/server/attachments/extract';
import { readClassroomRequest } from '@/lib/server/attachments/request';
import {
  classroomCallerOr401,
  serviceOwnerId,
  skillApiWriteGate,
} from '@/lib/server/auth/classroom-access';
import { LibraryTargetError, resolveLibraryTarget } from '@/lib/server/auth/library';
import { isAuthModeEnabled } from '@/lib/server/auth/signed-identity';
import { getServerProviders } from '@/lib/server/provider-config';

const log = createLogger('GenerateClassroom API');

// Attachments are read here, before the job starts; large PDFs take a while.
export const maxDuration = 300;

const MAX_STUDENT_PROFILE_CHARS = 1000;

/**
 * A server model for this job. Accepts `provider:model` or a bare model id,
 * which must be one the server offers (the same list as the web page's model
 * picker). Returns the `provider:model` string, or an error message.
 */
function resolveRequestedModel(value: unknown): { modelString: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'model must be a string' };
  const providers = getServerProviders();
  const offered = Object.entries(providers).flatMap(([providerId, entry]) =>
    (entry.models ?? []).map((modelId) => ({ providerId, modelId })),
  );
  const requested = value.trim();
  const match = requested.includes(':')
    ? (() => {
        const { providerId, modelId } = parseModelString(requested);
        return offered.find((item) => item.providerId === providerId && item.modelId === modelId);
      })()
    : offered.find((item) => item.modelId === requested);
  if (!match) {
    const names = offered.map((item) => item.modelId).join(', ') || 'none';
    return { error: `model must be one of: ${names}` };
  }
  return { modelString: `${match.providerId}:${match.modelId}` };
}

type PdfContent = NonNullable<GenerateClassroomInput['pdfContent']>;

function isValidPdfContent(value: unknown): value is PdfContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const { text, images } = value as { text?: unknown; images?: unknown };
  return (
    typeof text === 'string' &&
    Array.isArray(images) &&
    images.every((item) => typeof item === 'string')
  );
}

export async function POST(req: NextRequest) {
  // Signed-header sign-in: admins and the skill service token only (D18).
  const denied = skillApiWriteGate(req);
  if (denied) return denied;
  let requirementSnippet: string | undefined;
  try {
    let request: Awaited<ReturnType<typeof readClassroomRequest>>;
    try {
      request = await readClassroomRequest(req);
    } catch (error) {
      if (error instanceof AttachmentError) {
        return apiError('INVALID_REQUEST', error.status, error.message);
      }
      throw error;
    }
    const rawBody = request.fields as Partial<GenerateClassroomInput> & {
      model?: unknown;
      owner?: unknown;
      shareWith?: unknown;
      studentProfile?: unknown;
    };
    requirementSnippet =
      typeof rawBody.requirement === 'string' ? rawBody.requirement.substring(0, 60) : undefined;
    const pdfContent = rawBody.pdfContent;

    if (pdfContent !== undefined && !isValidPdfContent(pdfContent)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Invalid pdfContent: expected { text: string; images: string[] }',
      );
    }

    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(pdfContent !== undefined ? { pdfContent } : {}),

      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.webSearchProviderId ? { webSearchProviderId: rawBody.webSearchProviderId } : {}),
      ...(rawBody.webSearchApiKey ? { webSearchApiKey: rawBody.webSearchApiKey } : {}),
      ...(rawBody.webSearchModelId ? { webSearchModelId: rawBody.webSearchModelId } : {}),
      ...(rawBody.baiduSubSources ? { baiduSubSources: rawBody.baiduSubSources } : {}),
      ...(rawBody.enableImageGeneration != null
        ? { enableImageGeneration: rawBody.enableImageGeneration }
        : {}),
      ...(rawBody.enableVideoGeneration != null
        ? { enableVideoGeneration: rawBody.enableVideoGeneration }
        : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };
    const { requirement } = body;

    if (!requirement || typeof requirement !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    if (rawBody.model !== undefined) {
      const resolved = resolveRequestedModel(rawBody.model);
      if ('error' in resolved) return apiError('INVALID_REQUEST', 400, resolved.error);
      body.modelString = resolved.modelString;
    }

    if (rawBody.studentProfile !== undefined) {
      if (typeof rawBody.studentProfile !== 'string') {
        return apiError('INVALID_REQUEST', 400, 'studentProfile must be a string');
      }
      const profile = rawBody.studentProfile.trim().slice(0, MAX_STUDENT_PROFILE_CHARS);
      if (profile) body.studentProfile = profile;
    }

    // Library and sharing exist only with signed-header sign-in.
    if (isAuthModeEnabled()) {
      const caller = classroomCallerOr401(req);
      if (caller instanceof Response) return caller;
      const defaultOwnerId = caller.kind === 'member' ? caller.identity.ownerId : serviceOwnerId();
      if (!defaultOwnerId) {
        return apiError('INVALID_REQUEST', 400, 'No owner: set AUTH_SERVICE_OWNER_LOGIN');
      }
      try {
        body.library = await resolveLibraryTarget({
          defaultOwnerId,
          owner: rawBody.owner,
          shareWith: rawBody.shareWith,
        });
      } catch (error) {
        if (error instanceof LibraryTargetError) {
          return apiError('INVALID_REQUEST', 400, error.message);
        }
        throw error;
      }
    } else if (rawBody.owner !== undefined || rawBody.shareWith !== undefined) {
      return apiError('INVALID_REQUEST', 400, 'owner and shareWith need sign-in to be enabled');
    }

    if (request.files.length > 0) {
      try {
        body.attachments = await buildAttachmentBundle(request.files);
      } catch (error) {
        if (error instanceof AttachmentError) {
          return apiError('INVALID_REQUEST', error.status, error.message);
        }
        throw error;
      }
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    body.jobId = jobId;
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
        ...(body.attachments ? { attachments: body.attachments.summary } : {}),
      },
      202,
    );
  } catch (error) {
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
