export interface Env {
  DATABASE_URL: string;
  NEON_AUTH_URL: string;
}

export interface AppVariables {
  userId: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
