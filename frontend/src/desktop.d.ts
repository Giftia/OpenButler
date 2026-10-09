import type {ModelCatalogBridge} from "./lib/modelCatalog";
import type {CaptureCapabilities, DesktopCaptureConfig, PublicWindowSource} from "./lib/captureTypes";
import type {TaskRequestCode} from "./lib/taskActivityApi";
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
    openbutlerDesktop?: Partial<ModelCatalogBridge> & {
      apiBase?: string;
      channel?: "stable" | "preview";
      requestApi?: (path: string, options?: {method?: string; body?: string | null}) => Promise<
        {ok: true; status: number; data: unknown} | {ok: false; status: number; error: string; code?: "runtime_item_not_found" | "runtime_command_not_found" | TaskRequestCode}
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
      restartBackend: () => Promise<{running: boolean; apiBase: string; pid: number | null; error_code?: string; error?: string}>;
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
      getCaptureWindows?: () => Promise<{ok: true; sources: PublicWindowSource[]} | {ok: false; error: string}>;
      getCaptureCapabilities?: () => Promise<CaptureCapabilities>;
      getCaptureDisplays?: () => Promise<Array<{id: string; label: string}>>;
      getMaskedCapturePreview?: (config: DesktopCaptureConfig) => Promise<
        {ok: true; previewDataUrl: string; masked_regions?: number; maskedRegions?: number; source_revision?: string; lock_state?: string;
          observation_mode?: "vision" | "masked_ocr_text"; post_mask_ocr_complete?: boolean;
          post_mask_ocr_text?: string; post_mask_ocr_image_digest?: string} | {ok: false; error: string; error_code?: string}
      >;
      startBuiltinCapture?: (config: DesktopCaptureConfig) => Promise<{ok: boolean; error?: string; error_code?: string}>;
      pauseBuiltinCapture?: () => Promise<{ok: boolean; active?: boolean; error?: string}>;
      getCaptureState?: () => Promise<Record<string, unknown>>;
      getMaskedEvidence?: (evidenceId: string) => Promise<
        {ok: true; dataUrl: string} | {ok: false; error: string}
      >;
      listBuiltinLocalModels?: (input: {endpoint: string; protocol: "ollama_native"}) => Promise<{ok: boolean; models: string[]; endpoint: string; error_code?: string}>;
      getBuiltinModelRoutes?: () => Promise<Record<string, unknown>>;
      useBuiltinLocalModelsForSession?: (routes: BuiltinModelRoutesInput) => Promise<Record<string, unknown> & {ok: boolean; persistence?: "session_only"; ready?: boolean; status?: Record<string, unknown>; error_code?: string}>;
      revokeBuiltinSessionModels?: () => Promise<{ok: boolean; ready?: boolean; sessionRevoked?: boolean; backendRunning?: boolean; error_code?: string}>;
      saveBuiltinModelRoutes?: (routes: BuiltinModelRoutesInput) => Promise<{ok: boolean; status?: Record<string, unknown>; error?: string}>;
    };
  }
}

