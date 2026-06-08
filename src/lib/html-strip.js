// Convert a Freshdesk note's HTML/body_text into clean, short, voice-friendly text.

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#039;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/** Strip tags, decode common entities, collapse whitespace. */
export function stripHtml(input) {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/<\s*br\s*\/?>/gi, ' ');
  s = s.replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#?\w+;/g, (m) => (ENTITIES[m.toLowerCase()] ?? ENTITIES[m] ?? ' '));
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Trim to roughly one sentence, capped at maxChars, for the voice agent to read.
 */
export function toOneSentence(text, maxChars = 200) {
  const clean = stripHtml(text);
  if (clean.length <= maxChars) {
    const dot = clean.search(/[.!?]\s/);
    if (dot > 30 && dot < clean.length - 1) return clean.slice(0, dot + 1);
    return clean;
  }
  const cut = clean.slice(0, maxChars);
  const lastDot = cut.search(/[.!?](?=[^.!?]*$)/);
  if (lastDot > 40) return cut.slice(0, lastDot + 1);
  return cut.replace(/\s+\S*$/, '') + '…';
}
