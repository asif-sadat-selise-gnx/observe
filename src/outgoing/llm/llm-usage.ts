/**
 * Reading token usage out of a model provider's response - a JSON body, or
 * the events of a server-sent stream - without ever keeping its text.
 */

/** What one call consumed, as far as the response said. */
export interface LlmUsage {
  /** The model that answered - more precise than the one asked for. */
  model?: string;
  /** Every input token, cached ones included. */
  inputTokens?: number;
  outputTokens?: number;
  /** The part of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;

const sum = (...values: Array<number | undefined>): number | undefined =>
  values.some((value) => value !== undefined)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined;

/**
 * One usage object, in whichever provider's spelling, as input, output and
 * cached input.
 *
 * Input means every input token. OpenAI already counts cached tokens inside
 * `prompt_tokens`; Anthropic reports cache reads and writes beside
 * `input_tokens`, so they are added in - otherwise its cached calls would
 * look nearly free of input.
 */
export function normalizeUsage(usage: unknown): LlmUsage {
  if (!isObject(usage)) {
    return {};
  }
  // Cohere v2 nests its counts.
  const billed = isObject(usage.billed_units) ? usage.billed_units : undefined;
  const anthropicCacheRead = count(usage.cache_read_input_tokens);
  const anthropicCacheWrite = count(usage.cache_creation_input_tokens);
  const openAiInput = count(usage.prompt_tokens);
  const input =
    openAiInput ??
    count(usage.promptTokenCount) ??
    count(usage.inputTokens) ??
    (count(usage.input_tokens) !== undefined ||
    anthropicCacheRead !== undefined ||
    anthropicCacheWrite !== undefined
      ? sum(count(usage.input_tokens), anthropicCacheRead, anthropicCacheWrite)
      : count(billed?.input_tokens));
  const output =
    count(usage.completion_tokens) ??
    count(usage.output_tokens) ??
    count(usage.outputTokens) ??
    sum(count(usage.candidatesTokenCount), count(usage.thoughtsTokenCount)) ??
    count(billed?.output_tokens);
  const details =
    (isObject(usage.prompt_tokens_details) && usage.prompt_tokens_details) ||
    (isObject(usage.input_tokens_details) && usage.input_tokens_details) ||
    undefined;
  const cached =
    count(details?.cached_tokens) ??
    anthropicCacheRead ??
    count(usage.cachedContentTokenCount) ??
    count(usage.prompt_cache_hit_tokens) ??
    count(usage.cacheReadInputTokens);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

/** Later readings win, field by field - a stream reports in pieces. */
export function mergeUsage(into: LlmUsage, next: LlmUsage): LlmUsage {
  return {
    model: next.model ?? into.model,
    inputTokens: next.inputTokens ?? into.inputTokens,
    outputTokens: next.outputTokens ?? into.outputTokens,
    cachedInputTokens: next.cachedInputTokens ?? into.cachedInputTokens,
  };
}

const modelOf = (value: Json): string | undefined =>
  typeof value.model === "string"
    ? value.model.slice(0, 128)
    : typeof value.modelVersion === "string"
      ? value.modelVersion.slice(0, 128)
      : undefined;

/**
 * The usage in one parsed JSON document: a whole response body, or one event
 * of a stream.
 */
export function usageFromDocument(document: unknown): LlmUsage {
  if (!isObject(document)) {
    return {};
  }
  // OpenAI's Responses API streams `response.*` events around a nested
  // response object; Anthropic opens its stream with `message_start` around
  // a nested message.
  const nested = isObject(document.response)
    ? document.response
    : isObject(document.message)
      ? document.message
      : undefined;
  const source = nested ?? document;
  const usage = normalizeUsage(
    source.usage ??
      source.usageMetadata ??
      document.usage ??
      document.usageMetadata ??
      (isObject(document.meta) ? document.meta.billed_units : undefined),
  );
  const model = modelOf(source) ?? modelOf(document);
  return { ...usage, ...(model ? { model } : {}) };
}

/** Largest JSON body parsed whole. Past it only the head and tail are read. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** What is kept of an oversized body: usage sits at its end, model at its start. */
const EDGE_BYTES = 32 * 1024;

/**
 * Reads a JSON response as it passes through, keeping at most 2 MB.
 *
 * A larger body - a long completion, a batch of embeddings - is not kept: its
 * first and last 32 KB are, and the usage is matched out of those. Every
 * provider writes `usage` after the content and `model` before it.
 */
export class JsonUsageReader {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private head: Uint8Array | undefined;
  private tail: Uint8Array | undefined;

  push(chunk: Uint8Array): void {
    if (this.head) {
      this.tail = keepTail(this.tail, chunk, EDGE_BYTES);
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    if (this.size > MAX_JSON_BYTES) {
      const whole = concat(this.chunks, this.size);
      this.head = whole.subarray(0, EDGE_BYTES);
      this.tail = whole.subarray(whole.byteLength - EDGE_BYTES);
      this.chunks.length = 0;
    }
  }

  finish(): LlmUsage {
    const decoder = new TextDecoder();
    if (!this.head) {
      try {
        return usageFromDocument(
          JSON.parse(decoder.decode(concat(this.chunks, this.size))),
        );
      } catch {
        return {};
      }
    }
    return usageFromEdges(
      decoder.decode(this.head),
      decoder.decode(this.tail ?? new Uint8Array()),
    );
  }
}

/** Usage matched out of the two ends of a body too large to parse. */
function usageFromEdges(head: string, tail: string): LlmUsage {
  const number = (name: string) => {
    const match = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(tail);
    return match ? { [name]: Number(match[1]) } : {};
  };
  const usage = normalizeUsage({
    ...number("prompt_tokens"),
    ...number("completion_tokens"),
    ...number("input_tokens"),
    ...number("output_tokens"),
    ...number("cached_tokens"),
    ...number("cache_read_input_tokens"),
    ...number("cache_creation_input_tokens"),
    ...number("promptTokenCount"),
    ...number("candidatesTokenCount"),
  });
  const cached = /"cached_tokens"\s*:\s*(\d+)/.exec(tail);
  if (cached && usage.cachedInputTokens === undefined) {
    usage.cachedInputTokens = Number(cached[1]);
  }
  const model = /"model"\s*:\s*"([^"\\]{1,128})"/.exec(head)?.[1];
  return { ...usage, ...(model ? { model } : {}) };
}

/** Longest stream line examined. Longer lines carry content, not usage. */
const MAX_SSE_LINE = 1024 * 1024;

/**
 * Reads a server-sent event stream as it passes through, one line at a time.
 *
 * Only `data:` lines that can carry usage or a model are parsed - the first
 * event, and any that mention `usage` - so a long stream of text deltas costs
 * a substring search per line rather than a parse.
 */
export class SseUsageReader {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private skipping = false;
  private usage: LlmUsage = {};
  private sawEvent = false;
  /** When the first content event arrived, for time to first token. */
  firstEventAt: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        break;
      }
      if (this.skipping) {
        // The oversized line ends here, unread.
        this.skipping = false;
      } else {
        this.line(this.pending + text.slice(start, newline));
      }
      this.pending = "";
      start = newline + 1;
    }
    if (this.skipping) {
      return;
    }
    const rest = text.slice(start);
    if (this.pending.length + rest.length > MAX_SSE_LINE) {
      // An oversized line is content; drop it until its end comes past.
      this.pending = "";
      this.skipping = true;
      return;
    }
    this.pending += rest;
  }

  finish(): LlmUsage {
    if (this.pending) {
      this.line(this.pending);
      this.pending = "";
    }
    return this.usage;
  }

  private line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) {
      return;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      return;
    }
    this.firstEventAt ??= this.now();
    const first = !this.sawEvent;
    this.sawEvent = true;
    if (!first && !data.includes("sage")) {
      return;
    }
    try {
      this.usage = mergeUsage(this.usage, usageFromDocument(JSON.parse(data)));
    } catch {
      /* not JSON, or not ours to read */
    }
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return whole;
}

function keepTail(
  tail: Uint8Array | undefined,
  chunk: Uint8Array,
  limit: number,
): Uint8Array {
  if (chunk.byteLength >= limit) {
    return chunk.slice(chunk.byteLength - limit);
  }
  const previous = tail ?? new Uint8Array();
  const keep = Math.min(previous.byteLength, limit - chunk.byteLength);
  const next = new Uint8Array(keep + chunk.byteLength);
  next.set(previous.subarray(previous.byteLength - keep), 0);
  next.set(chunk, keep);
  return next;
}
