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

  // Web server for webhooks (reached through the Cloudflare Tunnel).
  PORT: z.coerce.number().int().default(3000),
  // Any random string; entered in the Meta app's webhook settings so Meta can verify our endpoint.
  IG_VERIFY_TOKEN: z.string().optional().transform(v => v || undefined),
  // From the Meta app dashboard; used to check webhook signatures. Unset until the app exists.
  IG_APP_SECRET: z.string().optional().transform(v => v || undefined),
  // The Meta app's main secret (App settings → Basic). Meta may sign Instagram webhooks with either one.
  META_APP_SECRET: z.string().optional().transform(v => v || undefined),

  // @BostonBlerds' long-lived access token (Meta dashboard → Generate access tokens). Expires after 60 days.
  IG_ACCESS_TOKEN: z.string().optional().transform(v => v || undefined),

  // Shared secret for the admin dashboard (admin.bostonblerds.com) to call /admin/*. Any long random string.
  ADMIN_API_KEY: z.string().min(32).optional().or(z.literal('').transform(() => undefined)),

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
