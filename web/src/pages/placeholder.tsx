import { EmptyState } from '../components/empty-state';

/** Route stubs for the sections later releases fill in. */
export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <h1 className="t-h1" style={{ margin: 0 }}>{title}</h1>
      <EmptyState title="Coming in a later release">This screen is designed and on the roadmap. The dashboard at /dashboard still covers it today.</EmptyState>
    </>
  );
}
