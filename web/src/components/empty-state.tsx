import type { ReactNode } from 'react';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty card" role="status">
      <h2 className="t-h3" style={{ margin: 0 }}>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
