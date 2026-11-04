import type { ClientSnapshot, GameClient } from './net/client';

declare global {
  interface Window {
    __game?: {
      readonly client: GameClient;
      snapshot(): ClientSnapshot;
    };
  }
}

export {};
