import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { flagStates, giveawayRules } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { adminChannel } from '../discord/channels.js';
import { ruleLabel } from '../giveaway/labels.js';
import { audit, getGiveaway, getOpenGiveaway, getRules, type Giveaway } from '../giveaway/service.js';
import { listRecentPosts, resolvePost } from '../instagram/api.js';
import { runCommentSync } from '../instagram/sync.js';
import { isAdmin } from '../lib/permissions.js';
import { actOnFlag, dashboardHome, isOpen, resolveUrl, syncFlags, type ActiveFlag, type FlagState, type Severity } from './flags.js';

const ephemeral = MessageFlags.Ephemeral;
const COLOR: Record<Severity, number> = { blocking: 0xe5484d, warning: 0xf5a524, info: 0x3e8ed0 };
const ICON: Record<Severity, string> = { blocking: '🛑', warning: '⚠️', info: 'ℹ️' };
const TITLE: Record<Severity, string> = { blocking: 'Blocking', warning: 'Needs attention', info: 'Heads-up' };
const GREEN = 0x30a46c;

export const FLAG_BUTTON = /^flag:(snooze|dismiss):(\d+)$/;
export const POST_BUTTON = /^flagpost:(use|skip):(\d+):(\d+|x):(\d+)$/;

const linkButton = (label: string, url: string) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);

function alertMessage(f: ActiveFlag): MessageCreateOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton('Resolve', resolveUrl(f)));
  if (f.severity === 'warning') row.addComponents(new ButtonBuilder().setCustomId(`flag:snooze:${f.state.id}`).setLabel('Snooze 24h').setStyle(ButtonStyle.Secondary));
  if (f.severity === 'info') row.addComponents(new ButtonBuilder().setCustomId(`flag:dismiss:${f.state.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
  return {
    embeds: [new EmbedBuilder().setColor(COLOR[f.severity]).setTitle(`${ICON[f.severity]} ${TITLE[f.severity]}`).setDescription(f.message).setTimestamp(new Date())],
    components: [row],
    allowedMentions: { parse: [] },
  };
}

/** Rewrites a flag's alert (e.g. "✅ Resolved") and removes its buttons. */
async function markAlert(client: Client, state: FlagState, title: string, color: number) {
  if (!state.alertChannelId || !state.alertMessageId) return;
  try {
    const channel = await client.channels.fetch(state.alertChannelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(state.alertMessageId);
    const embed = message.embeds[0] ? EmbedBuilder.from(message.embeds[0]).setTitle(title).setColor(color) : new EmbedBuilder().setTitle(title).setColor(color);
    await message.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error('Updating a flag alert failed:', (err as Error).message);
  }
}

/**
 * Every minute: posts an alert for each new flag (once), and marks alerts resolved when their
 * flag clears. At midnight Eastern, posts the digest of everything still open.
 */
export async function runFlagJob(client: Client) {
  const now = new Date();
  const { active, resolved } = await syncFlags(client, now);

  for (const s of resolved) await markAlert(client, s, '✅ Resolved', GREEN);

  const channel = await adminChannel(client);
  if (!channel) return;
  for (const f of active) {
    if (!f.alert || f.state.alertedAt || !isOpen(f, now)) continue;
    const sent = await channel.send(alertMessage(f));
    await db.update(flagStates).set({ alertedAt: now, alertChannelId: sent.channelId, alertMessageId: sent.id }).where(eq(flagStates.id, f.state.id));
  }

  await maybePostDigest(client, active, now);
}

const etParts = (d: Date) =>
  Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));

/** The midnight (Eastern) digest: all open flags in one message. Skipped when there are none. */
async function maybePostDigest(client: Client, active: ActiveFlag[], now: Date) {
  const et = etParts(now);
  if (et.hour !== '00') return;
  const key = `flag_digest:${et.year}-${et.month}-${et.day}`;
  if (await getSetting(key)) return;
  await setSetting(key, { at: now.toISOString() });

  const open = active.filter(f => isOpen(f, now));
  if (!open.length) return;
  const order: Severity[] = ['blocking', 'warning', 'info'];
  const lines = order.flatMap(sev => {
    const group = open.filter(f => f.severity === sev);
    return group.length ? [`**${ICON[sev]} ${TITLE[sev]} (${group.length})**`, ...group.map(f => `• ${f.message} [Resolve](${resolveUrl(f)})`), ''] : [];
  });
  const description = lines.join('\n').slice(0, 4000);
  const channel = await adminChannel(client);
  await channel?.send({
    embeds: [new EmbedBuilder().setColor(COLOR[open.some(f => f.severity === 'blocking') ? 'blocking' : open.some(f => f.severity === 'warning') ? 'warning' : 'info']).setTitle(`📋 Daily flags: ${open.length} open`).setDescription(description)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton('Open dashboard', dashboardHome()))],
    allowedMentions: { parse: [] },
  });
}

/** Snooze / Dismiss buttons on flag alerts. */
export async function handleFlagButton(interaction: ButtonInteraction) {
  if (!isAdmin(interaction)) return void interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
  const [, action, id] = interaction.customId.match(FLAG_BUTTON)!;
  await interaction.deferReply({ flags: ephemeral });
  const result = await actOnFlag(Number(id), action as 'snooze' | 'dismiss', `discord:${interaction.user.username}`, interaction.client);
  if ('error' in result) return void interaction.editReply(`ℹ️ ${result.error}`);
  await markAlert(interaction.client, { ...result.flag.state, alertChannelId: interaction.channelId, alertMessageId: interaction.message.id }, action === 'snooze' ? '😴 Snoozed for 24 hours' : '🙈 Dismissed', 0x8b8d98);
  await interaction.editReply(action === 'snooze' ? "😴 Snoozed. If it's still true in 24 hours, it comes back." : '🙈 Dismissed.');
}

// ---------------------------------------------------------------------------
// New-post suggestion: while an open giveaway has a comment rule without a post, check our
// Instagram for new posts and offer to use one.

const suggestedKey = (gid: number) => `post_suggested:${gid}`;
/** Posts from a day before the start count as "new" (e.g. the announcement post went up just before). */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function runPostSuggestions(client: Client) {
  if (!client.isReady() || !env.IG_ACCESS_TOKEN) return;
  const g = await getOpenGiveaway();
  if (!g || g.testMode) return;
  const missing = (await getRules(g.id)).filter(r => r.platform === 'instagram' && r.action === 'comment' && !r.options.post);
  if (!missing.length) return;

  const suggested = (await getSetting<string[]>(suggestedKey(g.id))) ?? [];
  const from = (g.startsAt ?? g.createdAt).getTime() - LOOKBACK_MS;
  const posts = (await listRecentPosts(6)).filter(p => new Date(p.postedAt).getTime() >= from && !suggested.includes(p.id));
  if (!posts.length) return;
  await setSetting(suggestedKey(g.id), [...suggested, ...posts.map(p => p.id)]);

  const channel = await adminChannel(client);
  if (!channel) return;
  for (const p of posts.reverse()) {
    const caption = (p.caption ?? '').replace(/\s+/g, ' ').slice(0, 140);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...missing.slice(0, 4).map(r => new ButtonBuilder().setCustomId(`flagpost:use:${g.id}:${r.id}:${p.id}`).setLabel(`Use for Rule #${r.position}`).setStyle(ButtonStyle.Primary)),
      new ButtonBuilder().setCustomId(`flagpost:skip:${g.id}:x:${p.id}`).setLabel('Not this one').setStyle(ButtonStyle.Secondary),
    );
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR.info)
          .setTitle('📸 New post!')
          .setURL(p.permalink)
          .setDescription(
            [
              caption ? `“${caption}${(p.caption ?? '').length > 140 ? '…' : ''}”` : null,
              p.permalink,
              '',
              `**${g.name}** has ${missing.length === 1 ? 'a comment rule' : 'comment rules'} without a post:`,
              ...missing.map(r => `• Rule #${r.position}: ${ruleLabel(r)}`),
              '',
              'Use this post?',
            ]
              .filter(l => l !== null)
              .join('\n'),
          )
          .setThumbnail(p.thumbnailUrl ?? null),
      ],
      components: [row],
      allowedMentions: { parse: [] },
    });
  }
}

/** "Use for Rule #n" / "Not this one" on a new-post suggestion. */
export async function handlePostButton(interaction: ButtonInteraction) {
  if (!isAdmin(interaction)) return void interaction.reply({ content: '🔒 Admins only.', flags: ephemeral });
  const [, action, gidText, ruleText, mediaId] = interaction.customId.match(POST_BUTTON)!;
  const done = (line: string) => {
    const embed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder();
    return interaction.message.edit({ embeds: [embed.setFooter({ text: line })], components: [] }).catch(() => undefined);
  };
  if (action === 'skip') {
    await done(`Skipped by ${interaction.user.username}`);
    return void interaction.reply({ content: 'Skipped.', flags: ephemeral });
  }

  await interaction.deferReply({ flags: ephemeral });
  const g = await getGiveaway(Number(gidText));
  const rule = g && (await getRules(g.id)).find(r => r.id === Number(ruleText));
  if (!g || !rule) return void interaction.editReply('That giveaway or rule no longer exists.');
  if (rule.options.post) {
    await done(`Rule #${rule.position} already has a post`);
    return void interaction.editReply(`Rule #${rule.position} already has a post: ${rule.options.post.permalink}`);
  }
  const post = await resolvePost(mediaId!).catch(() => null);
  if (!post) return void interaction.editReply("Couldn't load that post from Instagram. Try again, or set it in the dashboard.");

  await db
    .update(giveawayRules)
    .set({ options: { ...rule.options, post: { id: post.id, permalink: post.permalink, postedAt: post.postedAt } } })
    .where(eq(giveawayRules.id, rule.id));
  const by = `discord:${interaction.user.username}`;
  await audit(g.id, by, 'giveaway.updated', { fields: ['rules'], ruleId: rule.id, post: post.permalink, via: 'new-post suggestion' });
  // Read its comments now (back to the start), instead of waiting for the next scheduled read.
  void runCommentSync((await getGiveaway(g.id)) as Giveaway, 'post-set').catch(err => console.error('Comment sync failed:', err));

  await done(`✅ Set as the post for Rule #${rule.position} by ${interaction.user.username}`);
  await interaction.editReply(`✅ Rule #${rule.position} now counts comments on ${post.permalink}. Comments since the start are being read now.`);
}
