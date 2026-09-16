import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setStoredToken, type AuthMethods, type Me } from './api';

/** null = signed out. Anything but a 401 is a real error and surfaces. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useAuthMethods() {
  return useQuery<AuthMethods>({ queryKey: ['auth-methods'], queryFn: () => api<AuthMethods>('/auth/methods'), staleTime: Infinity, retry: false });
}

export function useSignOut() {
  const client = useQueryClient();
  return async () => {
    setStoredToken(null);
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    client.setQueryData(['me'], null);
  };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
