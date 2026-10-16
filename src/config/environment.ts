import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'Discord token is required'),
  CLIENT_ID: z.string().min(1, 'Discord client ID is required'),
  SERVER_ID: z.string().min(1, 'Discord Server ID is required'),

  // Members with a role of this name (case-insensitive) can use every slash command.
  ADMIN_ROLE_NAME: z.string().min(1).default('admin'),

  // /giveaway enter only works in the channel with this name.
  GIVEAWAY_CHANNEL_NAME: z.string().min(1).default('gta-giveaway'),

  DATABASE_URL: z.string().min(1, 'Database URL is required'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(z.prettifyError(parsed.error));
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;
