export interface Env {
  DATABASE_URL: string;
  NEON_AUTH_URL: string;
  /** FedEx Track API project credentials (developer.fedex.com); both enable FedEx tracking. */
  FEDEX_CLIENT_ID?: string;
  FEDEX_CLIENT_SECRET?: string;
  /** `sandbox` (default) or `production`. */
  FEDEX_ENV?: string;
}

export interface AppVariables {
  userId: string;
  /** Email (or name) from the token, for "who did this" labels. */
  userLabel: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
