import { Fragment, type ReactNode } from 'react';
import { parseFormatted, type Inline } from '../../../src/core/format.ts';

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return <Fragment key={i}>{n.text}</Fragment>;
    if (n.type === 'code') return <code key={i}>{n.text}</code>;
    const children = inline(n.children);
    if (n.type === 'bold') return <strong key={i}>{children}</strong>;
    if (n.type === 'italic') return <em key={i}>{children}</em>;
    if (n.type === 'strike') return <s key={i}>{children}</s>;
    return <u key={i}>{children}</u>;
  });
}

/** An answer or blocker with Chat's shorthand rendered; spans only, so it fits inline or in a block. */
export function Formatted({ text }: { text: string }) {
  return (
    <span className="fmt">
      {parseFormatted(text).map((block, b) =>
        block.type === 'list' ? (
          <span key={b} className="fmt-list">
            {block.items.map((item, i) => (
              <span key={i} className="fmt-item">{inline(item)}</span>
            ))}
          </span>
        ) : (
          block.lines.map((line, i) => (
            <Fragment key={`${b}-${i}`}>
              {i > 0 ? <br /> : null}
              {inline(line)}
            </Fragment>
          ))
        ),
      )}
    </span>
  );
}
