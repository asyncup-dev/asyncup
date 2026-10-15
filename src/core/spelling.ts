import type { Repo } from '../db/repo.js';
import type { SettingsService } from './settings.js';

export type SpellingDialect = 'en-GB' | 'en-US';
export const SPELLING_DIALECTS: SpellingDialect[] = ['en-GB', 'en-US'];

/** One spelling or typo finding in texts[index], from start to end. */
export interface RawLint {
  index: number;
  start: number;
  end: number;
  word: string;
  suggestion: string | null;
}

/** Finds likely typos. Throws when it can't answer in time. */
export interface SpellEngine {
  lint(texts: string[], dialect: SpellingDialect): Promise<RawLint[]>;
}

export interface Typo {
  word: string;
  suggestion: string | null;
}

const spans = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as const);

/** Why a finding is left alone: code, links, mentions, IDs, jargon and names. Null when it should be shown. */
export function skipReason(text: string, lint: Pick<RawLint, 'start' | 'end' | 'word'>): string | null {
  const { start, end, word } = lint;
  const within = (re: RegExp) => spans(text, re).some(([a, b]) => start >= a && end <= b);
  if (within(/`[^`]*`/g) || within(/https?:\/\/\S+/g) || within(/@\S+/g)) return 'code, link or mention';
  if (/\d/.test(word)) return 'digits';
  if (/[/_\-.]/.test(word)) return 'joined';
  if (word.length > 1 && word === word.toUpperCase()) return 'all capitals';
  if (/[a-z][A-Z]/.test(word)) return 'inner capital';
  // Joined to its neighbour by / _ . or - (a full stop ending a sentence doesn't count).
  if (/[/_\-.]\w/.test(text.slice(end, end + 2)) || /\w[/_\-.]$/.test(text.slice(Math.max(0, start - 2), start))) return 'joined';
  if (/^[A-Z]/.test(word) && start > 0 && !/(^|[.!?:])\s*$/.test(text.slice(0, start))) return 'capitalised mid-sentence';
  return null;
}

/** "Possible typos. Fix them, or submit again to send as is: Reveiwed → Reviewed · teh → the" */
export function typoNotice(typos: Typo[]): string {
  return `Possible typos. Fix them, or submit again to send as is: ${typos.map((t) => (t.suggestion ? `${t.word} → ${t.suggestion}` : t.word)).join(' · ')}`;
}

/**
 * Points out likely typos in answers before they are posted. Off unless the
 * workspace turns it on; accepted words and roster names are never flagged.
 * Any failure means no suggestions: spelling must never block an answer.
 */
export class Spelling {
  constructor(
    private settings: SettingsService,
    private repo: Repo,
    private engine: SpellEngine | null,
    private log: (msg: string) => void = () => {},
  ) {}

  async typos(texts: string[]): Promise<Typo[]> {
    const s = await this.settings.get();
    if (!s.spellingEnabled || !this.engine || texts.every((t) => !t.trim())) return [];
    let lints: RawLint[];
    try {
      lints = await this.engine.lint(texts, s.spellingDialect as SpellingDialect);
    } catch (err) {
      this.log(`spelling check skipped: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const accepted = new Set([...acceptedWords(s.spellingWords), ...(await this.repo.listDisplayNames()).flatMap((n) => n.split(/\s+/))].map((w) => w.toLowerCase()));
    const seen = new Set<string>();
    const typos: Typo[] = [];
    for (const lint of lints) {
      const key = lint.word.toLowerCase();
      if (accepted.has(key) || seen.has(key) || skipReason(texts[lint.index] ?? '', lint)) continue;
      seen.add(key);
      typos.push({ word: lint.word, suggestion: lint.suggestion });
    }
    return typos;
  }
}

/** The admin's list: one word or phrase per line; a phrase accepts each of its words. */
export function acceptedWords(list: string): string[] {
  return list.split(/\r?\n/).flatMap((line) => line.trim().split(/\s+/)).filter(Boolean);
}
