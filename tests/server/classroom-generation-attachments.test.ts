import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  reserveClassroom: vi.fn(),
  releaseClassroomReservation: vi.fn(),
  persistClassroom: vi.fn(),
  generateClassroomId: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  callLLM: vi.fn(),
  persistClassroomMediaBytes: vi.fn(),
  saveClassroomToLibrary: vi.fn(),
}));
const PBLGenerationErrorMock = vi.hoisted(
  () =>
    class PBLGenerationError extends Error {
      readonly statusCode?: number;

      constructor(message: string, options?: { statusCode?: number }) {
        super(message);
        this.name = 'PBLGenerationError';
        this.statusCode = options?.statusCode;
      }
    },
);

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  // The module graph now reaches the settings store (stage store -> settings),
  // whose init reads PROVIDERS - keep the real exports and stub only the probe.
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  PBLGenerationError: PBLGenerationErrorMock,
}));

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  // Keep the real module (including the real ClassroomAlreadyExistsError) and
  // stub only the calls that touch the filesystem, so the generation path's
  // collision handling is exercised against the actual error class.
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  reserveClassroom: mocks.reserveClassroom,
  releaseClassroomReservation: mocks.releaseClassroomReservation,
  persistClassroom: mocks.persistClassroom,
  generateClassroomId: mocks.generateClassroomId,
}));

vi.mock('@/lib/server/classroom-media-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-media-generation')>()),
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persistClassroomMediaBytes,
}));

vi.mock('@/lib/server/auth/library', () => ({
  saveClassroomToLibrary: mocks.saveClassroomToLibrary,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};


const WEBP = 'data:image/webp;base64,' + Buffer.from('fake-image').toString('base64');
const attachments = {
  text: '## Source Document 1: worksheet.pdf\n5 + (-3) =',
  images: [
    { id: 'img_1', src: WEBP, pageNumber: 1, width: 800, height: 600 },
    { id: 'img_2', src: WEBP, pageNumber: 2 },
  ],
  summary: { files: 1, textChars: 30, images: 2 },
};

describe('classroom API attachments, model and library', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: { id: 'm', name: 'm', capabilities: { vision: true } },
      modelString: 'openai:grok-4.7-medium',
      providerId: 'openai',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      async (_requirements, _pdfText, _pdfImages, aiCall, options) => {
        await aiCall(
          'system',
          'outline prompt',
          options?.visionEnabled ? [{ id: 'img_1', src: WEBP }] : undefined,
        );
        return {
          success: true,
          data: {
            languageDirective: 'Use English.',
            outlines: [{ ...outline, suggestedImageIds: ['img_2'] }],
          },
        };
      },
    );
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const created = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return created.success ? (created.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, stage, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      stage,
      scenes,
      createdAt: '2026-09-27T00:00:00.000Z',
    }));
    mocks.reserveClassroom.mockResolvedValue(undefined);
    mocks.releaseClassroomReservation.mockResolvedValue(undefined);
    mocks.generateTTSForClassroom.mockResolvedValue({ written: 0, total: 0 });
    mocks.generateClassroomId.mockReturnValue('stageatt01');
    mocks.persistClassroomMediaBytes.mockImplementation(
      async ({ stageId, prefix }) => `/api/classroom-media/${stageId}/media/${prefix}-x.webp`,
    );
    mocks.saveClassroomToLibrary.mockResolvedValue(undefined);
  });

  async function run(input: Partial<GenerateClassroomInput>) {
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    return generateClassroom(
      { requirement: 'Teach the attached worksheet', ...input },
      { baseUrl: 'http://localhost' },
    );
  }

  it('passes the requested model, the student profile and the attachment text', async () => {
    await run({ modelString: 'openai:grok-4.7-medium', studentProfile: 'UK Year 8', attachments });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'generate-classroom',
      modelString: 'openai:grok-4.7-medium',
    });
    const [requirements, pdfText, pdfImages, , options] =
      mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(requirements).toMatchObject({
      requirement: 'Teach the attached worksheet',
      userBio: 'UK Year 8',
    });
    expect(pdfText).toBe(attachments.text);
    expect(pdfImages).toHaveLength(2);
    expect(options).toMatchObject({
      visionEnabled: true,
      imageMapping: { img_1: WEBP, img_2: WEBP },
    });
  });

  it('sends the pictures to a vision model as image parts', async () => {
    await run({ attachments });
    const outlineCall = mocks.callLLM.mock.calls[0]![0];
    const user = outlineCall.messages.find((message: { role: string }) => message.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((part: { type: string }) => part.type === 'image')).toBe(true);
  });

  it('describes pictures but sends none to a model without vision', async () => {
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    await run({ attachments });
    const [, , pdfImages, , options] = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(pdfImages).toHaveLength(2);
    expect(options?.visionEnabled).toBeUndefined();
    const user = mocks.callLLM.mock.calls[0]![0].messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(typeof user.content).toBe('string');
  });

  it('stores the pictures with the classroom and gives each page its assigned ones', async () => {
    await run({ attachments });
    expect(mocks.persistClassroomMediaBytes).toHaveBeenCalledTimes(2);
    const sceneOptions = mocks.generateSceneContent.mock.calls[0]![2];
    expect(sceneOptions.assignedImages.map((image: { id: string }) => image.id)).toEqual(['img_2']);
    expect(sceneOptions.imageMapping.img_2).toBe(
      '/api/classroom-media/stageatt01/media/source-x.webp',
    );
    expect(sceneOptions.visionEnabled).toBe(true);
    expect(sceneOptions.resolvedVisionImages).toEqual([{ id: 'img_2', src: WEBP }]);
  });

  it('saves to the member library and shares when asked, and not otherwise', async () => {
    await run({ attachments });
    expect(mocks.saveClassroomToLibrary).not.toHaveBeenCalled();

    const library = { ownerId: 'acct_owner', shareWithOwnerIds: ['acct_kid'] };
    const result = await run({ library, jobId: 'job123' });
    expect(result.id).toBe('stageatt01');
    const [classroom, target] = mocks.saveClassroomToLibrary.mock.calls[0]!;
    expect(target).toEqual(library);
    expect(classroom).toMatchObject({
      requirement: 'Teach the attached worksheet',
      producerRef: 'job123',
    });
    expect(classroom.stage.id).toBe('stageatt01');
    expect(classroom.outlines).toHaveLength(1);
  });

  it('keeps the upstream request unchanged without the new fields', async () => {
    await run({});
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'generate-classroom',
      modelString: undefined,
    });
    const [requirements, pdfText, pdfImages] =
      mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(requirements).toEqual({ requirement: 'Teach the attached worksheet' });
    expect(pdfText).toBeUndefined();
    expect(pdfImages).toBeUndefined();
    expect(mocks.persistClassroomMediaBytes).not.toHaveBeenCalled();
  });
});
