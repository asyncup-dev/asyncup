import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

import type { PollDraft, PollQuestion, QuestionPoll, QuestionPollSummary } from '../../../src/api/spec/schemas.ts';

export type { PollDraft, PollQuestion, QuestionPoll, QuestionPollSummary };
export type QuestionType = PollQuestion['type'];

export const TYPE_LABEL: Record<QuestionType, string> = { short: 'Short text', long: 'Long text', dropdown: 'Dropdown', single: 'Single choice', multiple: 'Multiple choice' };
export const REMINDERS: { value: number | null; label: string }[] = [
  { value: 15, label: '15 minutes before it closes' },
  { value: 60, label: '1 hour before it closes' },
  { value: 1440, label: '1 day before it closes' },
  { value: null, label: 'No reminder' },
];
export const isChoice = (type: QuestionType) => type !== 'short' && type !== 'long';

export function useQuestionPolls(standupId: number) {
  return useQuery({ queryKey: ['question-polls', standupId], queryFn: () => api<{ polls: QuestionPollSummary[] }>(`/standups/${standupId}/question-polls`), select: (d) => d.polls });
}

export function useQuestionPoll(id: number) {
  return useQuery({ queryKey: ['question-poll', id], queryFn: () => api<QuestionPoll>(`/question-polls/${id}`) });
}

export function useSendPoll(standupId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: PollDraft) => api<QuestionPoll>(`/standups/${standupId}/question-polls`, { method: 'POST', body: draft }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['question-polls', standupId] }),
  });
}

export function useClosePoll(id: number, standupId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<QuestionPoll>(`/question-polls/${id}/close`, { method: 'POST' }),
    onSuccess: (poll) => {
      client.setQueryData(['question-poll', id], poll);
      return client.invalidateQueries({ queryKey: ['question-polls', standupId] });
    },
  });
}

/** "Sent by Asha · 3 of 8 answered · closes Fri 24 Oct, 17:00 Asia/Kolkata" */
export function pollMeta(p: QuestionPollSummary): string {
  return `Sent by ${p.from} · ${p.answered} of ${p.asked} answered · ${p.open ? `closes ${p.closesLabel}` : `closed ${p.closedLabel ?? p.closesLabel}`}`;
}

export const RESULTS_LABEL: Record<QuestionPollSummary['results'], string> = { everyone: 'Everyone, after it closes', managers: 'Managers only' };
