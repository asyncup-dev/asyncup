export interface LlmConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  /** Defaults: anthropic → claude-opus-4-7. Required for openai. */
  model: string;
}

export type LlmComplete = (system: string, prompt: string) => Promise<string>;

const MAX_OUTPUT_TOKENS = 1000;

/**
 * Minimal BYO-key client over plain fetch — deliberately no SDK dependency
 * to keep the self-hosted footprint small. One-shot completions only.
 */
export function createLlm(config: LlmConfig, fetchFn: typeof fetch = fetch): LlmComplete {
  if (config.provider === 'anthropic') {
    return async (system, prompt) => {
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      return (data.content ?? [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n')
        .trim();
    };
  }

  return async (system, prompt) => {
    const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return (data.choices?.[0]?.message?.content ?? '').trim();
  };
}
