import { afterEach, describe, expect, it, vi } from 'vitest';

import { operatorVisionModels, withOperatorVision } from '@/lib/server/model-vision';

afterEach(() => vi.unstubAllEnvs());

describe('operator-declared vision models', () => {
  it('changes nothing when unset', () => {
    vi.stubEnv('OPENAI_VISION_MODELS', '');
    expect(withOperatorVision('openai', 'gateway-model', null)).toBeNull();
    const known = { id: 'm', name: 'm', outputWindow: 1000 };
    expect(withOperatorVision('openai', 'm', known)).toBe(known);
  });

  it('marks listed models as vision-capable, keeping known fields', () => {
    vi.stubEnv('OPENAI_VISION_MODELS', ' gateway-low , gateway-high,');
    expect([...operatorVisionModels('openai')]).toEqual(['gateway-low', 'gateway-high']);
    expect(withOperatorVision('openai', 'gateway-low', null)).toEqual({
      id: 'gateway-low',
      name: 'gateway-low',
      capabilities: { vision: true },
    });
    expect(
      withOperatorVision('openai', 'gateway-high', {
        id: 'gateway-high',
        name: 'High',
        outputWindow: 8000,
        capabilities: { tools: true },
      }),
    ).toEqual({
      id: 'gateway-high',
      name: 'High',
      outputWindow: 8000,
      capabilities: { tools: true, vision: true },
    });
    // Other models and other providers are untouched.
    expect(withOperatorVision('openai', 'gateway-other', null)).toBeNull();
    expect(withOperatorVision('deepseek', 'gateway-low', null)).toBeNull();
  });

  it('reads the prefix of the provider the model belongs to', () => {
    vi.stubEnv('DEEPSEEK_VISION_MODELS', 'ds-vl');
    expect(withOperatorVision('deepseek', 'ds-vl', null)?.capabilities?.vision).toBe(true);
    expect(withOperatorVision('openai', 'ds-vl', null)).toBeNull();
  });
});

describe('resolveModel applies operator vision', () => {
  it('returns vision-capable modelInfo for a listed gateway model', async () => {
    vi.resetModules();
    vi.doMock('@/lib/ai/providers', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
      return {
        ...actual,
        getModel: (args: { modelId: string }) => ({ model: { id: args.modelId }, modelInfo: null }),
      };
    });
    vi.stubEnv('OPENAI_VISION_MODELS', 'gateway-low');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const listed = await resolveModel({ modelString: 'openai:gateway-low' });
    expect(listed.modelInfo?.capabilities?.vision).toBe(true);
    const unlisted = await resolveModel({ modelString: 'openai:gateway-other' });
    expect(unlisted.modelInfo?.capabilities?.vision).toBeFalsy();
    vi.doUnmock('@/lib/ai/providers');
  });
});
