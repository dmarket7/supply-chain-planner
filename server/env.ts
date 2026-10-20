export interface Env {
  DATABASE_URL: string;
  NEON_AUTH_URL: string;
}

export interface AppVariables {
  userId: string;
  /** Email (or name) from the token, for "who did this" labels. */
  userLabel: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
