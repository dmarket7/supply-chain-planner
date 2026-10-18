export interface Env {
  DATABASE_URL: string;
  NEON_AUTH_URL: string;
  /** Optional; enables carrier tracking through Ship24. */
  SHIP24_API_KEY?: string;
}

export interface AppVariables {
  userId: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
