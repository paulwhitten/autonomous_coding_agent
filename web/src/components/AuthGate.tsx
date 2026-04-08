import { useState, useEffect } from 'react';
import { authApi, setApiKey, getApiKey, clearApiKey } from '../lib/api';
import { KeyRound, LogOut } from 'lucide-react';

interface AuthGateProps {
  children: React.ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<'loading' | 'authenticated' | 'needs-key'>('loading');
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const result = await authApi.check();
      if (!result.required || result.authenticated) {
        setState('authenticated');
      } else {
        setState('needs-key');
      }
    } catch {
      // Network error (API server not running) — let the user through
      // so the UI is usable in dev mode without the API server.
      // A real 401 is handled above via the response body.
      setState('authenticated');
    }
  };

  const submit = async () => {
    if (!keyInput.trim()) return;
    setApiKey(keyInput.trim());
    setError('');
    try {
      const result = await authApi.check();
      if (result.authenticated) {
        setState('authenticated');
      } else {
        clearApiKey();
        setError('Invalid API key');
      }
    } catch {
      clearApiKey();
      setError('Authentication failed');
    }
  };

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  if (state === 'needs-key') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 w-96">
          <div className="flex items-center gap-3 mb-6">
            <KeyRound size={24} className="text-blue-600" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Agent Dashboard</h1>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            This instance requires an API key. Set <code className="bg-gray-100 px-1 rounded">API_KEY</code> on the server.
          </p>
          {error && (
            <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
            </div>
          )}
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Enter API key"
            className="input w-full mb-3"
            autoFocus
          />
          <button
            onClick={submit}
            className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            Authenticate
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function LogoutButton() {
  const hasKey = !!getApiKey();
  if (!hasKey) return null;
  return (
    <button
      onClick={() => {
        clearApiKey();
        window.location.reload();
      }}
      className="flex items-center gap-1 text-xs text-gray-400 hover:text-white"
      title="Clear API key"
    >
      <LogOut size={12} /> Logout
    </button>
  );
}
