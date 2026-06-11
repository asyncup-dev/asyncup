import { describe, expect, it } from 'vitest';
import { createLlm } from '../src/ai/llm.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('createLlm', () => {
  it('calls the Anthropic Messages API with the documented shape', async () => {
    const { fn, calls } = fakeFetch(200, {
      content: [{ type: 'text', text: 'Summary here' }],
    });
    const complete = createLlm({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-7' }, fn);

    const result = await complete('You summarize.', 'Standup data');
    expect(result).toBe('Summary here');

    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.headers['x-api-key']).toBe('sk-test');
    expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(call.init.body);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.system).toBe('You summarize.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Standup data' }]);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('calls the OpenAI chat completions API', async () => {
    const { fn, calls } = fakeFetch(200, {
      choices: [{ message: { content: 'OpenAI summary' } }],
    });
    const complete = createLlm({ provider: 'openai', apiKey: 'sk-oa', model: 'some-model' }, fn);

    expect(await complete('sys', 'user')).toBe('OpenAI summary');
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init.headers.authorization).toBe('Bearer sk-oa');
    const body = JSON.parse(call.init.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('throws with provider context on HTTP errors', async () => {
    const { fn } = fakeFetch(429, { error: 'rate limited' });
    const complete = createLlm({ provider: 'anthropic', apiKey: 'k', model: 'm' }, fn);
    await expect(complete('s', 'p')).rejects.toThrow('Anthropic API 429');
  });
});
