/** Direct, explicit account policy. No gateway and no implicit paid fallback. */
export function modelConfig(env = process.env) {
  const url = new URL(env.PODCAST_MODEL_BASE_URL || 'https://integrate.api.nvidia.com/v1');
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'integrate.api.nvidia.com') {
    throw new Error('Direct HTTPS model endpoint required; gateway fallback disabled.');
  }
  const models = [...new Set((env.PODCAST_MODELS || 'nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3.5-super-vl-120b-a12b').split(',').map((s) => s.trim()).filter(Boolean))];
  if (models.length < 2 || !env.NVIDIA_API_KEY) {
    throw new Error('Two independent eligible model IDs and direct API credential required.');
  }
  return { base: url.href.replace(/\/$/, ''), models, key: env.NVIDIA_API_KEY };
}

function extractBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const lastEnd = text.lastIndexOf('}');
  return lastEnd > start ? text.slice(start, lastEnd + 1) : null;
}

export function parseModelJson(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*?(?=\{|$)/gi, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {}
  const candidate = extractBalancedObject(cleaned);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {}
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

export async function directJson(config, messages, { exclude = [], fetchImpl = fetch, temperature = 0.2, jsonMode = true } = {}) {
  const eligible = config.models.filter((m) => !exclude.includes(m));
  if (!eligible.length) throw new Error('No independent eligible reviewer; audio blocked.');
  let lastTimeout;
  let lastJsonError;
  for (const model of eligible) {
    for (const useJsonMode of jsonMode ? [true, false] : [false]) {
      let response;
      try {
        const payload = {
          model,
          messages,
          temperature,
          max_tokens: 16384,
          ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(model.startsWith('nvidia/nemotron-3.5') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        };
        response = await fetchImpl(config.base + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(300000),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') {
          lastTimeout = error;
          break;
        }
        throw error;
      }
      if (useJsonMode && (response.status === 400 || response.status === 422)) {
        await response.body?.cancel();
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        break;
      }
      if (!response.ok) throw new Error(`Direct model HTTP ${response.status}; no alternate provider or paid fallback.`);
      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content || '';
      const parsed = parseModelJson(raw);
      if (parsed !== null) return { model, data: parsed };
      const finish = data.choices?.[0]?.finish_reason || 'unknown';
      console.warn(`[direct-model] Invalid JSON from ${model} (finish_reason=${finish}, len=${raw.length})`);
      lastJsonError = new Error('Invalid model JSON; audio blocked.');
      break;
    }
  }
  if (lastJsonError) throw lastJsonError;
  if (lastTimeout) throw lastTimeout;
  throw new Error('Eligible free models unavailable; job paused without paid fallback.');
}
