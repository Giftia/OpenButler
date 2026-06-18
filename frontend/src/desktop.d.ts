export {};

declare global {
  interface Window {
    openbutlerDesktop?: {
      apiBase?: string;
      getRuntime: () => Promise<{
        apiBase: string;
        mode: "desktop";
        platform: string;
        appVersion: string;
        backend: {
          pid: number | null;
          running: boolean;
        };
        userDataReady: boolean;
      }>;
      restartBackend: () => Promise<{running: boolean; apiBase: string; pid: number | null}>;
      chooseMineContextHome: () => Promise<{canceled: boolean; path?: string}>;
      openDataFolder: () => Promise<{ok: boolean}>;
    };
  }
}
