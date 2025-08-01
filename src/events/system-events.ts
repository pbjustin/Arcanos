import { EventEmitter } from 'events';

const systemEmitter = new EventEmitter();

export function onServerSleep(listener: () => void): void {
  systemEmitter.on('server-sleep', listener);
}

export function emitServerSleep(): void {
  systemEmitter.emit('server-sleep');
}

export { systemEmitter };
