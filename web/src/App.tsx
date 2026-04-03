import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import AuthGate from './components/AuthGate';

// Lazy-loaded pages for code splitting
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ConfigPage = lazy(() => import('./pages/ConfigPage'));
const WorkflowPage = lazy(() => import('./pages/WorkflowPage'));
const TeamPage = lazy(() => import('./pages/TeamPage'));
const MailboxPage = lazy(() => import('./pages/MailboxPage'));
const MonitorPage = lazy(() => import('./pages/MonitorPage'));
const ProcessesPage = lazy(() => import('./pages/ProcessesPage'));
const InstructionsPage = lazy(() => import('./pages/InstructionsPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/config" element={<ConfigPage />} />
                <Route path="/instructions" element={<InstructionsPage />} />
                <Route path="/workflows" element={<WorkflowPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/mailbox" element={<MailboxPage />} />
                <Route path="/processes" element={<ProcessesPage />} />
                <Route path="/monitor" element={<MonitorPage />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthGate>
    </QueryClientProvider>
  );
}
