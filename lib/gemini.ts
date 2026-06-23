import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";

export const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

/** Primary model — good quality with generous free-tier limits. */
export const GEMINI_MODEL = "gemini-2.5-flash";

/** Fallback models each have their own daily quota on the free tier. */
export const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
] as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Pull the human-readable message out of nested ApiError JSON. */
function getNestedErrorMessage(err: unknown): string | null {
  const text = getErrorText(err);

  try {
    const outer = JSON.parse(text) as { error?: { message?: string } };
    const innerRaw = outer?.error?.message;
    if (!innerRaw) return null;

    try {
      const inner = JSON.parse(innerRaw) as {
        error?: { message?: string };
      };
      return inner?.error?.message ?? innerRaw;
    } catch {
      return innerRaw;
    }
  } catch {
    return null;
  }
}

export function isQuotaError(err: unknown): boolean {
  const text = getErrorText(err);
  const nested = getNestedErrorMessage(err) ?? "";
  return (
    getErrorStatus(err) === 429 ||
    /quota|rate[- ]?limit|429|RESOURCE_EXHAUSTED/i.test(text + nested)
  );
}

export function isUnavailableError(err: unknown): boolean {
  const text = getErrorText(err);
  const nested = getNestedErrorMessage(err) ?? "";
  const combined = text + nested;
  return (
    getErrorStatus(err) === 503 ||
    /503|UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(
      combined
    )
  );
}

export function isRetryableError(err: unknown): boolean {
  return isQuotaError(err) || isUnavailableError(err);
}

function getRetryDelaySeconds(err: unknown): number | null {
  const text = getErrorText(err);
  const nested = getNestedErrorMessage(err) ?? "";
  const combined = text + nested;

  const directMatch = combined.match(/retry in ([\d.]+)s/i);
  if (directMatch) return Math.ceil(parseFloat(directMatch[1]));

  return null;
}

function isDailyQuota(err: unknown): boolean {
  const combined = getErrorText(err) + (getNestedErrorMessage(err) ?? "");
  return /PerDay|GenerateRequestsPerDay|RPD|daily quota/i.test(combined);
}

export function formatGeminiError(err: unknown): string {
  if (isUnavailableError(err)) {
    return "The AI service is busy right now. Please wait a few seconds and try again.";
  }

  if (isQuotaError(err)) {
    const seconds = getRetryDelaySeconds(err);

    if (isDailyQuota(err)) {
      if (seconds) {
        return `Daily AI quota reached on the free tier. Wait ${seconds}s, try again, or enable billing at https://ai.google.dev to get higher limits.`;
      }
      return "Daily AI quota reached on the free tier. Wait until tomorrow (resets midnight PT) or enable billing at https://ai.google.dev.";
    }

    if (seconds) {
      return `AI rate limit reached. Wait ${seconds}s and try again.`;
    }

    return "AI rate limit reached. Please wait a moment and try again.";
  }

  const nested = getNestedErrorMessage(err);
  if (nested) return nested;

  const text = getErrorText(err);
  return text || "Something went wrong. Please try again.";
}

export function extractThoughtLabel(text: string): string | null {
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  const sentence = text.split(/[.\n]/)[0].trim();
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;

  return null;
}

type StreamParams = Omit<GenerateContentParameters, "model"> & {
  model?: string;
};

async function tryGenerateStream(model: string, params: StreamParams) {
  return gemini.models.generateContentStream({
    ...params,
    model,
  });
}

/**
 * Calls Gemini with automatic retry + model fallback for quota/overload errors.
 */
export async function generateContentStreamWithFallback(
  params: StreamParams
) {
  const models = params.model
    ? [
        params.model,
        ...GEMINI_FALLBACK_MODELS.filter((m) => m !== params.model),
      ]
    : [...GEMINI_FALLBACK_MODELS];

  let lastError: unknown;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await tryGenerateStream(model, params);
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) throw err;

        const delay = getRetryDelaySeconds(err) ?? (isUnavailableError(err) ? 3 : null);

        if (attempt === 0 && delay && delay <= 65) {
          console.warn(
            `[gemini] ${model} unavailable (${getErrorStatus(err) ?? "retryable"}), retrying in ${delay}s…`
          );
          await sleep(delay * 1000);
          continue;
        }

        break;
      }
    }

    if (isRetryableError(lastError)) {
      console.warn(`[gemini] ${model} failed, trying next model…`);
    }
  }

  throw lastError;
}
