/**
 * Framework-agnostic health handler.
 */

import type { HandlerResult } from "./shares.js";

export interface HealthData {
  status: "ok";
  captchaEnabled: boolean;
  maxShareBytes: number;
  maxInlineBytes: number;
  r2Enabled: boolean;
}

export function handleHealth(opts: {
  captchaEnabled: boolean;
  r2Enabled: boolean;
  maxShareBytes: number;
  maxInlineBytes: number;
}): HandlerResult<HealthData> {
  return {
    ok: true,
    status: 200,
    data: {
      status: "ok",
      captchaEnabled: opts.captchaEnabled,
      maxShareBytes: opts.maxShareBytes,
      maxInlineBytes: opts.maxInlineBytes,
      r2Enabled: opts.r2Enabled,
    },
  };
}
