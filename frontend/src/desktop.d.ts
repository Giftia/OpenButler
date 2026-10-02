export {};

type BuiltinModelRoute = {
  protocol: string;
  mode: "local" | "custom";
  endpoint: string;
  model: string;
  api_key?: string;
};

type BuiltinModelRoutesInput = {
  image: BuiltinModelRoute;
  text: BuiltinModelRoute;
  external_consent: boolean;
  masked_data_consent: boolean;
};

declare global {
  interface Window {
    openbutlerDesktop?: {
      apiBase?: string;
      channel?: "stable" | "preview";
      requestApi?: (path: string, options?: {method?: string; body?: string | null}) => Promise<
        {ok: true; status: number; data: unknown} | {ok: false; status: number; error: string; code?: "runtime_item_not_found"}
      >;
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
      getCaptureDisplays?: () => Promise<Array<{id: string; label: string}>>;
      getMaskedCapturePreview?: (config: {display_id: string; excluded_apps: string[]; masks: Array<{x: number; y: number; width: number; height: number}>; confirmed: true}) => Promise<
        {ok: true; previewDataUrl: string; masked_regions?: number; maskedRegions?: number} | {ok: false; error: string}
      >;
      startBuiltinCapture?: (config: {display_id: string; excluded_apps: string[]; masks: Array<{x: number; y: number; width: number; height: number}>; confirmed: true}) => Promise<{ok: boolean; error?: string}>;
      pauseBuiltinCapture?: () => Promise<{ok: boolean; error?: string}>;
      getCaptureState?: () => Promise<Record<string, unknown>>;
      getMaskedEvidence?: (evidenceId: string) => Promise<
        {ok: true; dataUrl: string} | {ok: false; error: string}
      >;
      getBuiltinModelRoutes?: () => Promise<Record<string, unknown>>;
      saveBuiltinModelRoutes?: (routes: BuiltinModelRoutesInput) => Promise<{ok: boolean; status?: Record<string, unknown>; error?: string}>;
    };
  }
}
