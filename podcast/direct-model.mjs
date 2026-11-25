/** Direct, explicit account policy. No gateway and no implicit paid fallback. */
export function modelConfig(env = process.env) {
  const url = new URL(env.PODCAST_MODEL_BASE_URL || 'https://integrate.api.nvidia.com/v1');
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'integrate.api.nvidia.com') throw new Error('Direct HTTPS model endpoint required; gateway fallback disabled.');
  const models = [...new Set((env.PODCAST_MODELS || 'nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3.5-super-vl-120b-a12b').split(',').map(s=>s.trim()).filter(Boolean))];
  if (models.length < 2 || !env.NVIDIA_API_KEY) throw new Error('Two independent eligible model IDs and direct API credential required.');
  return { base: url.href.replace(/\/$/, ''), models, key: env.NVIDIA_API_KEY };
}
export async function directJson(config, messages, { exclude = [], fetchImpl = fetch } = {}) {
  const eligible = config.models.filter(m=>!exclude.includes(m));
  if (!eligible.length) throw new Error('No independent eligible reviewer; audio blocked.');
  let lastTimeout;
  for (const model of eligible) {
    let response;
    try {
      response = await fetchImpl(config.base + '/chat/completions', {
        method:'POST', headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},
        body:JSON.stringify({model,messages,temperature:0.2,max_tokens:12000}), signal:AbortSignal.timeout(300000),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') { lastTimeout = error; continue; }
      throw error;
    }
    if ([429,500,502,503,504].includes(response.status)) { await response.body?.cancel(); continue; }
    if (!response.ok) throw new Error(`Direct model HTTP ${response.status}; no alternate provider or paid fallback.`);
    const data=await response.json();
    const raw=(data.choices?.[0]?.message?.content||'').trim().replace(/<think>[\s\S]*?<\/think>/gi,'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    try {return {model, data:JSON.parse(raw)};}
    catch {throw new Error('Invalid model JSON; audio blocked.');}
  }
  if (lastTimeout) throw lastTimeout;
  throw new Error('Eligible free models unavailable; job paused without paid fallback.');
}
