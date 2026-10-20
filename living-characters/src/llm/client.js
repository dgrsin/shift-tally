// LLM layer: one function, `complete`, returning a schema-validated JSON object.
// Provider "claude" uses the official SDK with structured outputs; "mock" is a
// deterministic rule-based stand-in for tests and dry runs (see mock.js).
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { config } from '../config.js';
import { logger } from '../log.js';
import { mockComplete } from './mock.js';

const log = logger('llm');
let client = null;

export class LlmError extends Error {
  constructor(message, { retryable = false, cause } = {}) { super(message); this.retryable = retryable; this.cause = cause; }
}

/**
 * @param {object} req
 * @param {string} req.system   stable system prompt (cached prefix)
 * @param {Array<{role:'user'|'assistant', content:string}>} req.messages
 * @param {object} req.schema   JSON schema (type: object) the reply must satisfy
 * @param {string} [req.effort] low|medium|high
 * @param {string} [req.tag]    for logging / mock routing
 */
export async function complete(req) {
  if (config.llm.provider === 'mock') return mockComplete(req);
  return claudeComplete(req);
}

async function claudeComplete({ system, messages, schema, effort, tag }) {
  if (!client) client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
  const params = {
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      format: jsonSchemaOutputFormat(schema),
      effort: effort || config.llm.effort,
    },
  };
  if (config.llm.fallbacks !== 'off') {
    // Server-side refusal fallbacks: on a policy decline the API re-runs the
    // request on a fallback model inside the same call (routing by category).
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res;
  try {
    res = await client.beta.messages.parse(params);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new LlmError('rate limited', { retryable: true, cause: err });
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError('invalid ANTHROPIC_API_KEY', { cause: err });
    if (err instanceof Anthropic.BadRequestError) throw new LlmError(`bad request: ${err.message}`, { cause: err });
    if (err instanceof Anthropic.APIConnectionError) throw new LlmError('connection error', { retryable: true, cause: err });
    if (err instanceof Anthropic.APIError) throw new LlmError(`api error ${err.status}: ${err.message}`, { retryable: (err.status ?? 0) >= 500, cause: err });
    throw new LlmError(String(err?.message || err), { cause: err });
  }
  if (res.stop_reason === 'refusal') {
    throw new LlmError(`model refused (${res.stop_details?.category ?? 'unknown'}): ${res.stop_details?.explanation ?? ''}`);
  }
  if (res.stop_reason === 'max_tokens') throw new LlmError('output truncated (max_tokens)', { retryable: true });
  if (!res.parsed_output) throw new LlmError('no parsable output', { retryable: true });
  log.debug(`${tag ?? 'call'} ok`, {
    model: res.model, in: res.usage?.input_tokens, out: res.usage?.output_tokens, cached: res.usage?.cache_read_input_tokens,
  });
  return res.parsed_output;
}

/** Retry wrapper for transient failures. The simulation never dies on one bad call. */
export async function completeWithRetry(req, { attempts = 3, baseDelayMs = 2000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await complete(req); }
    catch (e) {
      last = e;
      if (!(e instanceof LlmError) || !e.retryable) throw e;
      const wait = baseDelayMs * 2 ** i;
      log.warn(`retryable llm error (${e.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
