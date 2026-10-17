import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { settings } from './schema.js';

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function setSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await db
    .insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: new Date() } });
}
