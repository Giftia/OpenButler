export type PrivacyMode = "basic" | "strict";

export type EventItem = {
  id: string;
  timestamp: string;
  event_type: string;
  source: string;
  subject: string;
  title: string;
  summary: string;
  object_label?: string | null;
  location?: string | null;
  score?: number | null;
  evidence_chain: Array<Record<string, unknown>>;
  payload: Record<string, unknown>;
};

export type PluginManifest = {
  id: string;
  name: string;
  stage: "preprocessor" | "timeline_processor" | "butler_tool" | string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  privacy_level: PrivacyMode | "strict_local" | string;
  model_requirements: {
    provider: "cloud" | "local" | "edge" | string;
    modalities?: string[];
    min_context?: number;
  };
  permissions: string[];
  prompt_template: string;
  version: string;
  runtime: {
    available: boolean;
    blocked_reasons: string[];
  };
};
