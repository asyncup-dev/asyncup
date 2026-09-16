import { EmptyState } from '../../components/empty-state';

export function StandupStub({ title }: { title: string }) {
  return <EmptyState title={`${title} is coming in a later release`}>The screen is designed and on the roadmap. Until then, the dashboard at /dashboard covers it.</EmptyState>;
}
