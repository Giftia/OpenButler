import type {MaskRect} from "./maskGeometry";
export type CaptureObservationMode = "vision" | "masked_ocr_text";

export type PublicWindowIdentity = {
  window_id: string;
  owner_pid: number;
  owner_process_start: string;
  owner_process_name: string;
  wm_class: string;
  window_title: string;
  content_bounds: {x: number; y: number; width: number; height: number};
};
export type PublicWindowSource = {id: string; label: string; source_identity: PublicWindowIdentity};
export type CaptureCapabilities = {
  public_window: {supported: boolean; platform: string; lock_state: string; lock_protection_supported: boolean; reason?: string};
  full_desktop: {supported: boolean; reason?: string};
};
export type PublicWindowCaptureConfig = {
  capture_scope: "dedicated_public_window";
  display_id: string;
  source_identity: PublicWindowIdentity;
  excluded_apps: string[];
  masks: MaskRect[];
  interval_seconds: number;
  session_duration_seconds: number;
  observation_mode: CaptureObservationMode;
  confirmed: true;
};
export type DisplayCaptureConfig = {
  display_id: string;
  excluded_apps: string[];
  masks: MaskRect[];
  confirmed: true;
};
export type DesktopCaptureConfig = DisplayCaptureConfig | PublicWindowCaptureConfig;
