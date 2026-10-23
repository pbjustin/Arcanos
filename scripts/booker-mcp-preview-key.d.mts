import type { JWK, JWTPayload } from 'jose';
export const BOOKER_PREVIEW_JWK: Readonly<JWK & { kid: string }>;
export const BOOKER_PREVIEW_PUBLIC_JWK: Readonly<JWK>;
export const BOOKER_PREVIEW_ISSUER: string;
export const BOOKER_PREVIEW_SUBJECT: string;
export const BOOKER_PREVIEW_CLIENT_ID: string;
export const BOOKER_PREVIEW_UNIVERSE_ID: string;
export function signBookerPreviewToken(options: { resource: string; readOnly?: boolean; claims?: JWTPayload }): Promise<string>;
