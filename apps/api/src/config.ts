import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().default('http://localhost:3000/api'),
  DATABASE_URL: z.string().default('postgres://aiwork_app:aiwork_app_dev@localhost:5432/aiworkhub'),
  MIGRATION_DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aiworkhub'),
  // 32 byte key, base64. In production this is a KMS wrapped key, never an env var (see docs/SECURITY.md).
  MASTER_KEY: z.string().default('ZGV2LW9ubHktbWFzdGVyLWtleS1jaGFuZ2UtbWUhIQ=='),
  MASTER_KEY_ID: z.string().default('dev-1'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  DEV_AUTH: z.enum(['true', 'false']).default('false'),
  // AI. With no key the local rule based engine answers, so the product works with zero cost.
  AI_PROVIDER: z.enum(['auto', 'anthropic', 'local']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production') {
    if (cfg.DEV_AUTH === 'true') throw new Error('DEV_AUTH must be false in production');
    if (cfg.MASTER_KEY === Env.shape.MASTER_KEY._def.defaultValue()) {
      throw new Error('MASTER_KEY must be set in production');
    }
  }
  return cfg;
}

export const config = loadConfig();
