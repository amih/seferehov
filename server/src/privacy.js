import { config } from './config.js';

// Library names, hints and notes are public. They must not carry door/gate codes,
// passwords, phone numbers or similar. Two layers:
//   1. patterns (instant, always on)
//   2. the local LLM (understands "the code is two-four-six-eight", Hebrew, etc.)
// Returns { flagged, reason, snippets } — snippets are the suspicious bits to show.

const CODE_WORDS = /(קוד|קודן|סיסמ|אינטרקום|אינטרקם|כניסה|דלת|שער|לחצ|הקש|מפתח|code|pin|password|passcode|keypad|intercom|buzz|door|gate|entry|key\b|пароль|код|домофон|كود|رمز)/iu;

export function patternCheck(text) {
  const s = String(text ?? '');
  const snippets = [];
  // e-mail addresses
  for (const m of s.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) snippets.push(m[0]);
  // phone numbers (Israeli and international)
  for (const m of s.matchAll(/(?:\+?972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}\b/g)) snippets.push(m[0]);
  // keypad-style codes: 1234#, *1234, #1234
  for (const m of s.matchAll(/[*#]\s?\d{3,8}|\d{3,8}\s?[*#]/g)) snippets.push(m[0]);
  // 3–8 digit numbers near a code word ("קוד 2468", "the door code is 1357")
  for (const m of s.matchAll(/\d[\d\s-]{2,10}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 3 || digits.length > 8) continue;
    const around = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    const isYear = /^(19|20)\d\d$/.test(digits);
    if (CODE_WORDS.test(around) && !isYear) snippets.push(m[0].trim());
  }
  return [...new Set(snippets)];
}

const PROMPT = `You check text that will be shown PUBLICLY on a map of free street libraries (book boxes).
Flag it if it reveals private or security information, for example:
- a code, PIN or password for a door, gate, building entrance, intercom, lock, alarm or Wi-Fi (in digits or words, any language)
- where a key is hidden
- a phone number, e-mail, or a private person's full name or apartment number
Do NOT flag normal directions ("next to the bus stop", "in the lobby of building 12", "open 8:00-20:00"), street numbers, or business names.
Text:
"""
{TEXT}
"""
Answer with only JSON: {"private": true|false, "reason": "short reason in English", "snippets": ["exact private parts copied from the text"]}`;

async function llmCheck(text) {
  const res = await fetch(`${config.vision.url}/api/generate`, {
    method: 'POST',
    // Someone is waiting for this answer: go before photo reading in the GPU queue.
    headers: { 'Content-Type': 'application/json', 'X-GPU-Priority': 'interactive' },
    body: JSON.stringify({
      model: config.privacyModel,
      prompt: PROMPT.replace('{TEXT}', text.replaceAll('"""', '"')),
      stream: false,
      think: false,
      format: 'json',
      keep_alive: '3m',
      options: { temperature: 0, num_predict: 200, num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`privacy llm ${res.status}`);
  const raw = (await res.json()).response;
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return {
    flagged: json.private === true,
    reason: String(json.reason ?? '').slice(0, 200),
    snippets: (Array.isArray(json.snippets) ? json.snippets : []).map(String).filter((x) => x && text.includes(x)).slice(0, 5),
  };
}

export async function checkPrivate(...parts) {
  const text = parts.filter(Boolean).join('\n').trim();
  if (!text) return { flagged: false };
  const snippets = patternCheck(text);
  let llm = null;
  try { llm = await llmCheck(text); } catch { /* model busy or down: patterns only */ }
  if (snippets.length) return { flagged: true, reason: llm?.reason || 'looks like a code, phone number or e-mail', snippets: [...new Set([...snippets, ...(llm?.snippets ?? [])])], by: 'pattern' };
  if (llm?.flagged) return { ...llm, by: 'llm' };
  return { flagged: false, checked: llm ? 'llm' : 'pattern' };
}
