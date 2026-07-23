export {};

declare global {
  interface Window {
    openbutlerDesktop?: {
      apiBase?: string;
      channel?: "stable" | "preview";
      getRuntime: () => Promise<{
        apiBase: string;
        mode: "desktop";
        platform: string;
        appVersion: string;
        channel: "stable" | "preview";
        acceptancePackAvailable: boolean;
        backend: {
          pid: number | null;
          running: boolean;
        };
        userDataReady: boolean;
      }>;
      restartBackend: () => Promise<{running: boolean; apiBase: string; pid: number | null}>;
      chooseMineContextHome: () => Promise<{canceled: boolean; path?: string}>;
      openDataFolder: () => Promise<{ok: boolean}>;
      getMineContextStatus: () => Promise<Record<string, any>>;
      scanMineContextInstallations: () => Promise<Record<string, any>>;
      chooseMineContextInstaller: () => Promise<{canceled: boolean; selected?: boolean}>;
      downloadMineContextInstaller: () => Promise<Record<string, any>>;
      installMineContextWithApproval: () => Promise<Record<string, any>>;
      openMineContextDownloadPage: () => Promise<{ok: boolean; url: string}>;
      startMineContext: () => Promise<{ok: boolean; action: string; message: string}>;
      testMineContextModelConfig: (config: Record<string, unknown>) => Promise<Record<string, any>>;
      applyMineContextModelConfig: (config: Record<string, unknown>) => Promise<Record<string, any>>;
      showMainWindow: () => Promise<{ok: boolean}>;
      quitApp: () => Promise<{ok: boolean}>;
      getAcceptancePack: () => Promise<Record<string, any> | null>;
      saveAcceptanceFeedback: (feedback: Record<string, unknown>) => Promise<{ok: boolean; savedAt?: string; message?: string}>;
    };
  }
}
