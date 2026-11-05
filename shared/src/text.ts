/**
 * Plain text split into text and http(s) links, for showing a text email
 * with clickable links. Punctuation that closes a sentence or wraps the URL
 * ("(see https://x.com/a).", "<https://x.com>") stays outside the link.
 */
export function textLinks(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = (m[0] as string).replace(/[).,;:!?\]]+$/, '');
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
