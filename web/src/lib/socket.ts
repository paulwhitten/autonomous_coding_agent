import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
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
