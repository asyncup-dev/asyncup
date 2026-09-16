import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider, type AnyRouter } from '@tanstack/react-router';
import { useMe } from './lib/auth';
import { Placeholder } from './pages/placeholder';
import { SignInPage } from './pages/sign-in';
import { StandupsPage } from './pages/standups';
import { Shell } from './shell/shell';

/** Everything under the shell needs a signed-in principal; the sign-in page needs the opposite. */
function Protected() {
  const me = useMe();
  if (me.isPending) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (me.isError) return <div className="alert" style={{ margin: 24 }}>Could not reach the server: {me.error.message}</div>;
  if (!me.data) return <Navigate to="/sign-in" replace />;
  return <Shell me={me.data} />;
}

function Public() {
  const me = useMe();
  if (me.isPending) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (me.data) return <Navigate to={me.data.kind === 'member' ? '/me' : '/standups'} replace />;
  return <SignInPage />;
}

export function buildRouter(): AnyRouter {
  const root = createRootRoute({ component: Outlet });
  const signIn = createRoute({ getParentRoute: () => root, path: '/sign-in', component: Public });
  const shell = createRoute({ getParentRoute: () => root, id: 'shell', component: Protected });
  const home = createRoute({ getParentRoute: () => shell, path: '/', component: () => <Navigate to="/standups" replace /> });
  const standups = createRoute({ getParentRoute: () => shell, path: '/standups', component: StandupsPage });
  const stubs = (['blockers', 'reports', 'team', 'settings'] as const).map((name) =>
    createRoute({ getParentRoute: () => shell, path: `/${name}`, component: () => <Placeholder title={name[0]!.toUpperCase() + name.slice(1)} /> }),
  );
  const mine = createRoute({ getParentRoute: () => shell, path: '/me', component: () => <Placeholder title="My standups" /> });
  const routeTree = root.addChildren([signIn, shell.addChildren([home, standups, mine, ...stubs])]);
  return createRouter({ routeTree, basepath: '/app', defaultNotFoundComponent: () => <Placeholder title="Not found" /> });
}

export function App({ router = buildRouter(), client = new QueryClient() }: { router?: AnyRouter; client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
