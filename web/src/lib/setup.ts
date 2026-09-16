import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, chatHealth, type ChatHealth, type Settings, type StandupSummary, type Verification } from './api';

/** Which setup screens are done, read from the server so progress survives a reload. */
export interface SetupProgress {
  settings: Settings;
  health: ChatHealth;
  standups: number;
}

export const STEPS = [
  { id: 'project', path: '/setup/project', title: 'Create a Google Cloud project', hint: 'Enable the Chat API, note the project number', minutes: 4 },
  { id: 'service-account', path: '/setup/service-account', title: 'Service account', hint: 'Create a key and paste it here — we verify it', minutes: 3 },
  { id: 'chat-app', path: '/setup/chat-app', title: 'Configure the Chat app', hint: 'Paste our endpoint, we listen for the first event', minutes: 5 },
  { id: 'sign-in', path: '/setup/sign-in', title: 'Sign-in for your team', hint: 'Google or SAML. Optional — token access works meanwhile', minutes: 2, optional: true },
  { id: 'template', path: '/setup/template', title: 'Create your first standup', hint: 'Pick a template, add people, run it now', minutes: 2 },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export function projectNumberOf(audience: string): string {
  return audience.split(/[\s,]+/).find((a) => /^\d+$/.test(a)) ?? '';
}

export function stepDone(p: SetupProgress, id: StepId): boolean {
  switch (id) {
    case 'project':
      return projectNumberOf(p.settings.chat.audience) !== '';
    case 'service-account':
      return p.settings.chat.serviceAccount.set;
    case 'chat-app':
      return p.health.lastEventAt !== null;
    case 'sign-in':
      return p.settings.setup.signInConfigured;
    case 'template':
      return p.standups > 0;
  }
}

/** Where "Start" should land: the first unfinished required step, or the standup step when Chat already works. */
export function nextStep(p: SetupProgress): (typeof STEPS)[number] {
  return STEPS.find((s) => !('optional' in s) && !stepDone(p, s.id)) ?? STEPS[4];
}

export function useSetupProgress() {
  return useQuery<SetupProgress>({
    queryKey: ['setup-progress'],
    queryFn: async () => {
      const [settings, health, standups] = await Promise.all([api<Settings>('/settings'), chatHealth(), api<{ standups: StandupSummary[] }>('/standups')]);
      return { settings, health, standups: standups.standups.length };
    },
  });
}

/** PATCH /settings, then refresh everything setup reads. */
export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<Settings>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['setup-progress'] }),
  });
}

export function useVerify(name: 'project' | 'service-account' | 'chat-event' | 'saml') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<Verification>(`/verify/${name}`, { method: 'POST' }),
    onSuccess: (v) => {
      if (name === 'chat-event' && v.state === 'pass') void client.invalidateQueries({ queryKey: ['setup-progress'] });
    },
  });
}

/** Values the Chat API configuration page asks for, derived from where the app is served. */
export function chatAppValues(origin: string) {
  return {
    appName: 'AsyncUp',
    avatarUrl: `${origin}/app/logo-256.png`,
    description: 'Async daily standups for your team',
    endpointUrl: `${origin}/chat/events`,
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Every IANA zone the browser knows, with the workspace default first. */
export function timezoneOptions(preferred: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];
  // Engines list 'Etc/UTC' but not always plain 'UTC', which is the install default.
  return [...new Set([preferred, 'UTC', ...all])];
}
