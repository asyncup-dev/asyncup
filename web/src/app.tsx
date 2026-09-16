import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider, type AnyRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Settings } from './lib/api';
import { useMe } from './lib/auth';
import { BlockersPage } from './pages/blockers';
import { MePage } from './pages/me';
import { Placeholder } from './pages/placeholder';
import { ReportsPage } from './pages/reports';
import { ChatSettings } from './pages/settings/chat';
import { DangerSettings } from './pages/settings/danger';
import { GeneralSettings } from './pages/settings/general';
import { SettingsLayout } from './pages/settings/layout';
import { McpSettings } from './pages/settings/mcp';
import { SignInSettings } from './pages/settings/sign-in';
import { TokenSettings } from './pages/settings/tokens';
import { TeamPage } from './pages/team';
import { SignInPage } from './pages/sign-in';
import { ChatAppPage } from './pages/setup/chat-app';
import { CreateStandupPage } from './pages/setup/create';
import { SetupGuard } from './pages/setup/layout';
import { LivePage } from './pages/setup/live';
import { ProjectPage } from './pages/setup/project';
import { ServiceAccountPage } from './pages/setup/service-account';
import { SignInSetupPage } from './pages/setup/sign-in';
import { TemplatePage } from './pages/setup/template';
import { WelcomePage } from './pages/setup/welcome';
import { HistoryPage } from './pages/standup/history';
import { StandupLayout } from './pages/standup/layout';
import { OverviewPage } from './pages/standup/overview';
import { InsightsPage } from './pages/standup/insights';
import { StandupSettingsPage } from './pages/standup/settings';
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

/** Admins who have not finished setup land in the walkthrough; everyone else on their list. */
function Home() {
  const me = useMe();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings'), enabled: me.data?.kind === 'admin' });
  if (me.data?.kind === 'member') return <Navigate to="/me" replace />;
  if (me.data?.kind === 'admin') {
    if (settings.isPending) return <p className="muted">Loading…</p>;
    if (settings.data && !settings.data.setup.complete) return <Navigate to="/setup" replace />;
  }
  return <Navigate to="/standups" replace />;
}

export function buildRouter(): AnyRouter {
  const root = createRootRoute({ component: Outlet });
  const signIn = createRoute({ getParentRoute: () => root, path: '/sign-in', component: Public });
  const setup = createRoute({ getParentRoute: () => root, id: 'setup', component: SetupGuard });
  const setupRoutes = [
    createRoute({ getParentRoute: () => setup, path: '/setup', component: WelcomePage }),
    createRoute({ getParentRoute: () => setup, path: '/setup/project', component: ProjectPage }),
    createRoute({ getParentRoute: () => setup, path: '/setup/service-account', component: ServiceAccountPage }),
    createRoute({ getParentRoute: () => setup, path: '/setup/chat-app', component: ChatAppPage }),
    createRoute({ getParentRoute: () => setup, path: '/setup/sign-in', component: SignInSetupPage }),
    createRoute({ getParentRoute: () => setup, path: '/setup/template', component: TemplatePage }),
    createRoute({
      getParentRoute: () => setup,
      path: '/setup/create',
      validateSearch: (s: Record<string, unknown>) => ({ template: typeof s.template === 'string' ? s.template : undefined }),
      component: CreateStandupPage,
    }),
    createRoute({
      getParentRoute: () => setup,
      path: '/setup/live',
      validateSearch: (s: Record<string, unknown>) => ({ standup: Number(s.standup) || undefined }),
      component: LivePage,
    }),
  ];
  const shell = createRoute({ getParentRoute: () => root, id: 'shell', component: Protected });
  const home = createRoute({ getParentRoute: () => shell, path: '/', component: Home });
  const standups = createRoute({ getParentRoute: () => shell, path: '/standups', component: StandupsPage });
  const standup = createRoute({ getParentRoute: () => shell, path: '/standups/$id', component: StandupLayout });
  const standupTabs = [
    createRoute({ getParentRoute: () => standup, path: '/', component: OverviewPage }),
    createRoute({ getParentRoute: () => standup, path: '/history', component: HistoryPage }),
    createRoute({ getParentRoute: () => standup, path: '/insights', component: InsightsPage }),
    createRoute({ getParentRoute: () => standup, path: '/settings', component: StandupSettingsPage }),
  ];
  const blockers = createRoute({ getParentRoute: () => shell, path: '/blockers', component: BlockersPage });
  const reports = createRoute({ getParentRoute: () => shell, path: '/reports', component: ReportsPage });
  const team = createRoute({ getParentRoute: () => shell, path: '/team', component: TeamPage });
  const settings = createRoute({ getParentRoute: () => shell, path: '/settings', component: SettingsLayout });
  const settingsPages = [
    createRoute({ getParentRoute: () => settings, path: '/', component: GeneralSettings }),
    createRoute({ getParentRoute: () => settings, path: '/chat', component: ChatSettings }),
    createRoute({ getParentRoute: () => settings, path: '/sign-in', component: SignInSettings }),
    createRoute({ getParentRoute: () => settings, path: '/mcp', component: McpSettings }),
    createRoute({ getParentRoute: () => settings, path: '/tokens', component: TokenSettings }),
    createRoute({ getParentRoute: () => settings, path: '/danger', component: DangerSettings }),
  ];
  const mine = createRoute({ getParentRoute: () => shell, path: '/me', component: MePage });
  const routeTree = root.addChildren([signIn, setup.addChildren(setupRoutes), shell.addChildren([home, standups, standup.addChildren(standupTabs), mine, blockers, reports, team, settings.addChildren(settingsPages)])]);
  return createRouter({ routeTree, basepath: '/app', defaultNotFoundComponent: () => <Placeholder title="Not found" /> });
}

export function App({ router = buildRouter(), client = new QueryClient() }: { router?: AnyRouter; client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
