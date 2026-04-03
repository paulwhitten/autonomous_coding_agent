import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  GitBranch,
  Users,
  Mail,
  Activity,
  FileText,
  Play,
} from 'lucide-react';
import { LogoutButton } from './AuthGate';
import ThemeToggle from './ThemeToggle';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/config', icon: Settings, label: 'Configuration' },
  { to: '/instructions', icon: FileText, label: 'Instructions' },
  { to: '/workflows', icon: GitBranch, label: 'Workflows' },
  { to: '/team', icon: Users, label: 'Team' },
  { to: '/mailbox', icon: Mail, label: 'Mailbox' },
  { to: '/processes', icon: Play, label: 'Processes' },
  { to: '/monitor', icon: Activity, label: 'Monitor' },
];

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 dark:bg-gray-950 text-white flex flex-col border-r border-gray-800">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-lg font-bold">🤖 Agent Dashboard</h1>
          <p className="text-xs text-gray-400 mt-1">Autonomous Coding Agent</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-700 text-xs text-gray-500 flex items-center justify-between">
          <span>v1.0.0</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 text-gray-900 dark:text-gray-100">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
