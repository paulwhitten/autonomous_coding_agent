import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

type ConnectionState = 'connected' | 'connecting' | 'disconnected';
type ConnectionListener = (state: ConnectionState) => void;
const connectionListeners = new Set<ConnectionListener>();
let currentState: ConnectionState = 'disconnected';

function setState(state: ConnectionState) {
  if (state === currentState) return;
  currentState = state;
  connectionListeners.forEach(fn => fn(state));
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socket.on('connect', () => setState('connected'));
    socket.on('disconnect', () => setState('disconnected'));
    socket.on('reconnect_attempt', () => setState('connecting'));
  }
  return socket;
}

export function getConnectionState(): ConnectionState {
  return currentState;
}

export function onConnectionChange(callback: ConnectionListener): () => void {
  connectionListeners.add(callback);
  callback(currentState);
  return () => { connectionListeners.delete(callback); };
}

export function onFileChange(callback: (data: { path: string; type: string }) => void): () => void {
  const s = getSocket();
  s.on('file:added', callback);
  s.on('file:changed', callback);
  s.on('file:removed', callback);
  return () => {
    s.off('file:added', callback);
    s.off('file:changed', callback);
    s.off('file:removed', callback);
  };
}

export function onA2AEvent(event: string, callback: (data: unknown) => void): () => void {
  const s = getSocket();
  s.on(event, callback);
  return () => { s.off(event, callback); };
}

export function onAgentDiscovery(callback: (data: { agents: unknown[]; total: number }) => void): () => void {
  const s = getSocket();
  s.on('agents:list', callback);
  return () => { s.off('agents:list', callback); };
}

export function onAgentHealth(callback: (data: { agentId: string; health: string; history?: Array<{ time: string; health: string }> }) => void): () => void {
  const s = getSocket();
  s.on('agents:health', callback);
  return () => { s.off('agents:health', callback); };
}
