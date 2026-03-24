import type { ChatCompletionMessageParam, ChatCompletionResponseFormat, ImageSize } from '../types.js';

/**
 * Chat completion request parameters
 */
export interface ChatParams {
  /** User prompt/message */
  prompt: string;
  /** System prompt (optional, ARCANOS routing message will be prepended) */
  systemPrompt?: string;
  /** Model to use (defaults to configured default model) */
  model?: string;
  /** Maximum tokens for completion */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Top-p sampling */
  top_p?: number;
  /** Frequency penalty */
  frequency_penalty?: number;
  /** Presence penalty */
  presence_penalty?: number;
  /** Response format */
  responseFormat?: ChatCompletionResponseFormat;
  /** User identifier */
  user?: string;
  /** Conversation history */
  messages?: ChatCompletionMessageParam[];
  /** Whether to include ARCANOS routing message (default: true) */
  includeRoutingMessage?: boolean;
}

/**
 * Vision request parameters
 */
export interface VisionParams {
  /** User prompt describing the image */
  prompt: string;
  /** Base64-encoded image data */
  imageBase64: string;
  /** MIME type for image (default: image/png) */
  mimeType?: string;
  /** Model to use (defaults to vision model) */
  model?: string;
  /** Maximum tokens for completion */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Image detail level */
  detail?: 'low' | 'high' | 'auto';
}

/**
 * Transcription request parameters
 */
export interface TranscriptionParams {
  /** Audio file data */
  audioFile: File | Blob | Buffer;
  /** Filename for the audio file */
  filename: string;
  /** Model to use (defaults to transcription model) */
  model?: string;
  /** Language code (optional) */
  language?: string;
  /** Response format */
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  /** Temperature */
  temperature?: number;
}

/**
 * Image generation request parameters
 */
export interface ImageParams {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Image size */
  size?: ImageSize;
  /** Model to use (defaults to image generation model) */
  model?: string;
  /** Quality setting */
  quality?: 'standard' | 'hd';
  /** Number of images to generate */
  n?: number;
  /** Response format */
  responseFormat?: 'url' | 'b64_json';
}

/**
 * Embedding request parameters
 */
export interface EmbeddingParams {
  /** Text to embed */
  input: string | string[];
  /** Model to use */
  model: string;
  /** User identifier */
  user?: string;
}
