import { importJWK, SignJWT } from 'jose';

// Publicly disclosed synthetic fixture material; never trusted by normal runtime. gitleaks:allow
export const BOOKER_PREVIEW_JWK = Object.freeze({
  "kty": "RSA",
  "n": "9RZFokpV7Se0VFnNVHYSNtYiosEkPHt-lkXcsNVd_HAp3rQ74egnOdcY6Qh4OyRqw_1N-DRsrF84bgavj-410NO9h3MdPLEydSuXnGBNyUuXrYMHiBcp9rUMIgYfOmXnBeqk_SDt93lMKmqtyoIrTkFgxbnJTDck1PO6y9JuIMyZ8cMRJi-Un_kFe5fU1F0J7KccgSVQMt1WsjPhLr85HEwQGHn81ufCXEEUxXmWag3-gk6gnSxBiMIr2JMH05awyXDvZLEf_UlaJJlJ7EQWLXxq_iWIv_EZGNGlN4GILrViJu49zuqPlzQOpf9RPJjaKOFmXpb2I-9RZLok1egZmw",
  "e": "AQAB",
  "d": "bDFHzivooMetSKtYBFgXFFQVeCmxGG4f5LC0iu-2DNFq-mAwKzrzzgnRelX91YXvB9QTjmV-L93dKF0VNYGgCi7e9SNxHbDPqH_07thonlsbe0JjmcU4BivITmDLelkv0iHScdgOlPfcEsGDNOmfum0MDl1EqruRK9zocj_T0_ABNus9fzlv6TwsHgiDhs06CQeWhBFV1mHgAt66n2-nhV5XOQ0I3B33gKWWQEo64_OyN8AbEqbA34J-9atkS_vhHPapzIPSvm3MNofJHmGRsa5D3AXqCLvJ6a0Fy-PS0df4yBcE1KdIoYJIDdiQEM27KCpx9z8WNZiMe6fDim8e6Q",
  "p": "_4tWp5VK4eLvZKNPPCu3OzEtc1NJXQDXYTkfUHepuH5nNrKrXqflj52Wqj_TUUrLWPGKnt-C50yntjTWF0zx-Lu94PlzctnuUOeK1aESC3QMBAEBDj7dSOYR3MlZYyEDwpnA378Ny1miH3OglJPAn5EkuWBaeDclT2_mpFVDYl8",
  "q": "9YYo1yk_8_k3armJrpU6I4SJkN26Kq3Kr-zHUjc8hDWIyGDXOnnOw7KheJVp29bh0su4pY7RgMJp4Xn8r3ntJy9aUL8qLjO_UiX88ifCamcKeFRiG9p6Dbf-F0N7sjgCh5kAMiGhIhCBNJhzjLtpMAmGczte_1_ga6kP21dFKkU",
  "dp": "ojFSIrOC_7QFtZ5hoBMvDQa9jkECg2ERUsfqtCv_MPYplHH6iu2NqoWfJxezjBkoz58fGI9MinoAyIjoiYlw2ypt7ejl-bOQqxEK8WR2C4bwSWpJvTzxPl-oXrX9YgmGVXE5Fcoxeyu81rGQ7jyJOb3pzS72vO5jY_PmM89aIYk",
  "dq": "5FnPuDWkRmw-b2N6u0YNWaVWMMcX88PJpI-q3juDbE9CFWOEKd3KQVbtOPJ2D0Iuq9hPtqM7FO88fLnxGt9igzRWYo05VNlKEsREGpCCEGYfZcTNrqwnIoVCrC5WaG4RZD4X4YhHjiAdm2ZC6dwQO95QDvJkK03nsxn9JnpnWKU",
  "qi": "OL5N80y2IcS4_VskmAfxWbI3EYavQBcCfCxNOOEugnWReKcWNtN0PkRIn6RGXgdhDRgDSY2_syPOgC3mj5cEIqJYUCGSB_Lsu_X5ZtMCVx1cxapRsaWFNaoUlggjGD0c3A1l0DAHkAS2xeSVvHvYmRX4kokLR0b4yo1-8_x9v38",
  "kid": "booker-preview-rs256-v1",
  "alg": "RS256",
  "use": "sig"
});
export const BOOKER_PREVIEW_ISSUER = 'https://booker-preview.invalid/';
export const BOOKER_PREVIEW_SUBJECT = 'synthetic-booker-owner';
export const BOOKER_PREVIEW_CLIENT_ID = 'synthetic-booker-client';
export const BOOKER_PREVIEW_UNIVERSE_ID = 'synthetic-booker-1566';
export const BOOKER_PREVIEW_PUBLIC_JWK = Object.freeze(Object.fromEntries(
  ['kty', 'n', 'e', 'kid', 'alg', 'use'].map(name => [name, BOOKER_PREVIEW_JWK[name]])));
const signingKey = importJWK(BOOKER_PREVIEW_JWK, 'RS256');

/** This public test key has no authority outside the PR1566 contained fixture. */
export async function signBookerPreviewToken({ resource, readOnly = false, claims = {} }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: BOOKER_PREVIEW_ISSUER, sub: BOOKER_PREVIEW_SUBJECT,
    client_id: BOOKER_PREVIEW_CLIENT_ID, aud: resource, iat: now, exp: now + 300,
    scope: 'arcanos:booker:read' + (readOnly ? '' : ' arcanos:booker:generate'), ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: BOOKER_PREVIEW_JWK.kid })
    .sign(await signingKey);
}
