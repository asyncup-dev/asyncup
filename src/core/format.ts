/**
 * Chat's shorthand in answers: *bold*, _italic_, ~strike~, `code` and
 * "- " lists, plus __underline__. One parser, rendered as card HTML, as
 * Chat text, or (in the web app) as React elements. Stored text never changes.
 */

export type Inline = { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'bold' | 'italic' | 'strike' | 'underline'; children: Inline[] };
export type Block = { type: 'lines'; lines: Inline[][] } | { type: 'list'; items: Inline[][] };

type Marker = '__' | '*' | '_' | '~';
const KIND: Record<Marker, 'bold' | 'italic' | 'strike' | 'underline'> = { '*': 'bold', _: 'italic', '~': 'strike', __: 'underline' };
const SYMBOL: Record<string, string> = { bold: '*', italic: '_', strike: '~' };
const LIST_ITEM = /^(\s*)- (.*)$/;

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function markerAt(s: string, i: number): Marker | null {
  if (s.startsWith('__', i)) return '__';
  const ch = s[i]!;
  return ch === '*' || ch === '_' || ch === '~' ? ch : null;
}

/** A marker opens at a word edge, right against the text that follows. */
function opens(s: string, i: number, m: Marker): boolean {
  const before = s[i - 1];
  const after = s[i + m.length];
  return (i === 0 || (!isWord(before) && before !== m[0])) && !isSpace(after) && after !== m[0];
}

/** Where the matching marker closes, skipping code spans; -1 when it never does. */
function closeAt(s: string, from: number, m: Marker): number {
  for (let k = from + 1; k < s.length; k++) {
    if (s[k] === '`') {
      const end = s.indexOf('`', k + 1);
      if (end > k + 1) k = end;
      continue;
    }
    const after = s[k + m.length];
    if (s.startsWith(m, k) && !isSpace(s[k - 1]) && !isWord(after) && after !== m[0]) return k;
  }
  return -1;
}

/** Parses one line; `marks` collects where each formatting marker sits. */
function inline(s: string, offset = 0, marks?: [number, number][]): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    const m = markerAt(s, i);
    if (m && opens(s, i, m)) {
      const end = closeAt(s, i + m.length, m);
      if (end >= 0) {
        flush();
        marks?.push([offset + i, m.length], [offset + end, m.length]);
        out.push({ type: KIND[m], children: inline(s.slice(i + m.length, end), offset + i + m.length, marks) });
        i = end + m.length;
        continue;
      }
    }
    text += s[i];
    i++;
  }
  flush();
  return out;
}

export function parseFormatted(text: string): Block[] {
  // Text from a request body may not be a string at all.
  text = typeof text === 'string' ? text : '';
  const blocks: Block[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    const last = blocks[blocks.length - 1];
    if (item) {
      if (last?.type === 'list') last.items.push(inline(item[2]!));
      else blocks.push({ type: 'list', items: [inline(item[2]!)] });
    } else if (last?.type === 'lines') last.lines.push(inline(line));
    else blocks.push({ type: 'lines', lines: [inline(line)] });
  }
  return blocks;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TAG = { bold: 'b', italic: 'i', strike: 's', underline: 'u' } as const;

function cardInline(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return escape(n.text);
      if (n.type === 'code') return `<code>${escape(n.text)}</code>`;
      return `<${TAG[n.type]}>${cardInline(n.children)}</${TAG[n.type]}>`;
    })
    .join('');
}

/** Card HTML: everything typed is escaped, then only the shorthand becomes tags. */
export function toCardHtml(text: string): string {
  return parseFormatted(text)
    .map((b) => (b.type === 'list' ? `<ul>${b.items.map((i) => `<li>${cardInline(i)}</li>`).join('')}</ul>` : b.lines.map(cardInline).join('<br>')))
    .join('');
}

function chatInline(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'code') return `\`${n.text}\``;
      // Chat text messages have no underline.
      if (n.type === 'underline') return chatInline(n.children);
      return `${SYMBOL[n.type]}${chatInline(n.children)}${SYMBOL[n.type]}`;
    })
    .join('');
}

/** For plain Chat messages, which render Chat's own syntax themselves. */
export function toChatText(text: string): string {
  return parseFormatted(text)
    .map((b) => (b.type === 'list' ? b.items.map((i) => `- ${chatInline(i)}`).join('\n') : b.lines.map(chatInline).join('\n')))
    .join('\n');
}

/** The text with formatting markers swapped for spaces, so a spell checker's positions still line up. */
export function blankMarkers(text: string): string {
  text = typeof text === 'string' ? text : '';
  const blank = new Set<number>();
  let offset = 0;
  for (const line of text.split('\n')) {
    const item = LIST_ITEM.exec(line);
    const marks: [number, number][] = [];
    if (item) inline(item[2]!, offset + item[1]!.length + 2, marks);
    else inline(line, offset, marks);
    for (const [at, length] of marks) for (let k = at; k < at + length; k++) blank.add(k);
    offset += line.length + 1;
  }
  return text.replace(/[\s\S]/g, (ch, k: number) => (blank.has(k) ? ' ' : ch));
}
