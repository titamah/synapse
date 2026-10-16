// src/config/environment.ts
import { z } from 'zod';

const envSchema = z.object({

    DISCORD_TOKEN: z.string().min(1, 'Discord token is required'),
    CLIENT_ID: z.string().min(1, 'Discord client ID is required'),
    SERVER_ID: z.string().min(1, 'Discord Server ID is required'),
  
    POSTGRES_USER: z.string().min(1,'Postgres username is required'),
    POSTGRES_PASSWORD: z.string().min(1,'Postgres password is required'),
    POSTGRES_DB: z.string().min(1,'Postgres database is required'),

    REDIS_URL: z.string().url('Redis URL must be a valid URL'),
  
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.prettifyError(parsed.error));
    throw new Error('Invalid environment variables');
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;