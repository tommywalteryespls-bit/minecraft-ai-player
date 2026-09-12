export interface BrowserVoiceReply {
  success: boolean;
  stage?: 'availability' | 'transcription' | 'planning' | 'tts';
  reason?: string;
  transcript?: string;
  reply?: string;
  audioBase64?: string;
  mimeType?: 'audio/mpeg';
  tools?: string[];
  /** A deterministic stop request was accepted, rather than a new planned task. */
  stopped?: boolean;
}
