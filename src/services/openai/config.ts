import { ImageSize } from './types.js';

const VALID_IMAGE_SIZES: ImageSize[] = [
  '256x256',
  '512x512',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '1792x1024',
  '1024x1792',
  'auto'
];

export const DEFAULT_ROUTING_MAX_TOKENS = 4096;
export const ROUTING_MAX_TOKENS = Number(process.env.ROUTING_MAX_TOKENS ?? DEFAULT_ROUTING_MAX_TOKENS);

const DEFAULT_IMAGE_GENERATION_MODEL = 'gpt-image-1';
export const IMAGE_GENERATION_MODEL = process.env.IMAGE_MODEL || DEFAULT_IMAGE_GENERATION_MODEL;

const resolveDefaultImageSize = (): ImageSize => {
  const configuredSize = (process.env.IMAGE_DEFAULT_SIZE || '').trim() as ImageSize;
  if (configuredSize && VALID_IMAGE_SIZES.includes(configuredSize)) {
    return configuredSize;
  }
  return '1024x1024';
};

export const DEFAULT_IMAGE_SIZE = resolveDefaultImageSize();

export const OPENAI_REQUEST_LOG_CONTEXT = { module: 'openai' } as const;
