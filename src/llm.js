import { config } from './config.js';

// One non-streaming chat-completion call against the LiteLLM proxy
// (OpenAI-compatible; same proxy + key as trajectory-viewer-v2).
export async function chatCompletion({ messages, tools, temperature = 0.2, maxTokens = 4096, onUsage }) {
  if (!config.litellm.apiKey) throw new Error('LITELLM_API_KEY is not set — copy .env.example to .env');
  const body = {
    model: config.litellm.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools?.length) body.tools = tools;

  // The proxy throws transient 429/5xx under load — retry with backoff.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${config.litellm.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.litellm.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => '');
    const maxAttempts = res.status === 429 ? 6 : 3; // 429 = token-bucket; wait it out
    if (!retryable || attempt >= maxAttempts) throw new Error(`LiteLLM ${res.status}: ${detail.slice(0, 500)}`);
    let wait = 2000 * 2 ** attempt;
    if (res.status === 429) {
      // honor the proxy's "resets at: <ts> UTC" when present, capped at 90s
      const m = detail.match(/resets at:\s*([0-9-]+ [0-9:]+ UTC)/);
      const until = m ? Date.parse(m[1]) : NaN;
      wait = Number.isFinite(until) ? Math.min(Math.max(until - Date.now() + 1500, 2000), 90_000) : Math.min(wait, 30_000);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  const data = await res.json();
  if (onUsage && data.usage) onUsage(data.usage); // {prompt_tokens, completion_tokens, total_tokens}
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LiteLLM returned no message');
  return msg;
}

// Tool-use agent loop. onEvent receives progress events suitable for SSE:
//   {type:'tool', name, args}  {type:'assistant', content}
// Returns the full list of new messages (assistant + tool results) so the
// caller can persist them.
export async function runAgentLoop({ messages, tools, executor, onEvent, maxSteps = 15, onUsage }) {
  const transcript = [...messages];
  const added = [];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await chatCompletion({ messages: transcript, tools, onUsage });
    transcript.push(msg);
    added.push(msg);
    if (msg.content) onEvent?.({ type: 'assistant', content: msg.content });
    const calls = msg.tool_calls || [];
    if (!calls.length) return { messages: added, final: msg.content || '' };

    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch { /* model sent malformed JSON; executor sees {} */ }
      onEvent?.({ type: 'tool', name: call.function.name, args });
      let result;
      try {
        result = await executor(call.function.name, args);
      } catch (e) {
        result = `ERROR: ${e.message}`;
      }
      const toolMsg = { role: 'tool', tool_call_id: call.id, content: String(result) };
      transcript.push(toolMsg);
      added.push(toolMsg);
    }
  }
  const note = '[stopped: agent loop hit max steps]';
  onEvent?.({ type: 'assistant', content: note });
  return { messages: added, final: note };
}
