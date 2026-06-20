import { useState, useEffect } from 'react';
import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import { onConnectionChange } from '../lib/socket';

export default function ConnectionStatus() {
  const [state, setState] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');

  useEffect(() => {
    return onConnectionChange(setState);
  }, []);

  if (state === 'connected') return null;

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium ${
      state === 'connecting'
        ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
    }`}>
      {state === 'connecting' ? (
        <>
          <Loader2 size={12} className="animate-spin" />
          Reconnecting…
        </>
      ) : (
        <>
          <WifiOff size={12} />
          Disconnected
        </>
      )}
    </div>
  );
}
