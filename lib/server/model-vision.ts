/**
 * Operator-declared image input for server-managed models.
 *
 * Whether a generation step sends document page images to the model is
 * decided by `modelInfo.capabilities.vision`, which comes from the built-in
 * model catalog. A model the catalog does not know — anything reached through
 * an OpenAI-compatible gateway under its own name, such as a LiteLLM alias —
 * therefore never receives images, and a photographed or scanned worksheet
 * arrives as nothing but "a PDF with N pages".
 *
 * `<PROVIDER>_VISION_MODELS` (e.g. `OPENAI_VISION_MODELS=gateway-low,gateway-high`)
 * lets the operator vouch for those models. `<PROVIDER>` is the provider id
 * upper-cased with non-alphanumerics as `_` (`openai` → `OPENAI`,
 * `tencent-hunyuan` → `TENCENT_HUNYUAN`). Unset — the default — changes
 * nothing. Read per call, like the other provider env settings.
 */
import type { ModelInfo } from '@/lib/types/provider';

export function visionModelsEnvName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_VISION_MODELS`;
}

export function operatorVisionModels(providerId: string): Set<string> {
  const models = new Set<string>();
  for (const item of (process.env[visionModelsEnvName(providerId)] ?? '').split(',')) {
    const model = item.trim();
    if (model) models.add(model);
  }
  return models;
}

/** `modelInfo` with `capabilities.vision` set when the operator listed the model. */
export function withOperatorVision(
  providerId: string,
  modelId: string,
  modelInfo: ModelInfo | null,
): ModelInfo | null {
  if (modelInfo?.capabilities?.vision) return modelInfo;
  if (!operatorVisionModels(providerId).has(modelId)) return modelInfo;
  const base: ModelInfo = modelInfo ?? { id: modelId, name: modelId };
  return { ...base, capabilities: { ...base.capabilities, vision: true } };
}
