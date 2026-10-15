// The DeepSeek endpoint this server talks to.
//
// The chat/vision calls themselves live behind the provider abstraction in
// llm.ts; what stays here is the one shared credential: the OpenAI-compatible
// chat-completions base URL, the model and the key. Keeping the key here is the
// point - the browser host names a model at most, and never holds a key.

/** The upstream credentials, read per request so an env change needs no restart. */
export function deepseekConfig(): { baseUrl: string; model: string; apiKey: string | null } {
  return {
    baseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
  };
}
