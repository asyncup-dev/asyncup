// Harper in its own process, so its memory goes when the process does. One JSON line in, one out.
import { Dialect, LocalLinter } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';

const linter = new LocalLinter({ binary: slimBinary, dialect: process.argv[2] === 'en-US' ? Dialect.American : Dialect.British });
await linter.setup();
process.stdout.write('ready\n');

for await (const line of console) {
  if (!line.trim()) continue;
  const { id, texts } = JSON.parse(line) as { id: number; texts: string[] };
  const lints = [];
  for (const [index, text] of texts.entries()) {
    for (const lint of await linter.lint(text, { language: 'plaintext' })) {
      if (lint.lint_kind() !== 'Spelling' && lint.lint_kind() !== 'Typo') continue;
      const span = lint.span();
      lints.push({ index, start: span.start, end: span.end, word: lint.get_problem_text(), suggestion: lint.suggestions()[0]?.get_replacement_text() ?? null });
    }
  }
  process.stdout.write(JSON.stringify({ id, lints }) + '\n');
}
