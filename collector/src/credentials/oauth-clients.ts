/**
 * Public OAuth clients Kuota signs in with (the same public device-code clients
 * the vendors' CLIs use). Spec: docs/specs/2026-10-02-standalone-credentials-design.md.
 * Client IDs are public identifiers, not secrets.
 */
export const GROK_OAUTH = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  deviceEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
} as const;

export const KIMI_OAUTH = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  deviceEndpoint: "https://auth.kimi.com/api/oauth/device_authorization",
  tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
} as const;
