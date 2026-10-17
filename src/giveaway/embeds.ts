import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatDuration } from './announcementRules.js';
import type { Giveaway } from './service.js';

const YELLOW = 0xffff00;
const BLUE = 0x0088ff;

export const EXTEND_BUTTON_PREFIX = 'admin:extend:';

/** Discord renders <t:…:R> as a live countdown ("in 4 hours") in every member's app. */
const ts = (d: Date, style: 'F' | 'R' | 'f' = 'F') => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

/** Every giveaway embed carries "Giveaway #id" in its footer; "Post to giveaway channel" reads it back. */
export const GIVEAWAY_FOOTER = /Giveaway #(\d+)/;

function base(g: Giveaway) {
  return new EmbedBuilder()
    .setColor(YELLOW)
    .setFooter({ text: `Giveaway #${g.id} · ${g.name ?? 'Giveaway'}` })
    .setTimestamp(new Date());
}

const enterLine = (g: Giveaway) => `Enter with \`/giveaway enter\`${g.entryChannel ? ` in #${g.entryChannel}` : ''}.`;

export function startedEmbed(g: Giveaway) {
  return base(g)
    .setTitle(`🎉 ${g.name} is live!`)
    .setDescription([`Ends ${ts(g.endsAt)} (${ts(g.endsAt, 'R')}).`, enterLine(g)].join('\n'));
}

export function countdownEmbed(g: Giveaway, hoursLeft?: number) {
  return base(g)
    .setTitle(hoursLeft ? `⏳ ${formatDuration(hoursLeft)} left in ${g.name}` : `⏳ ${g.name}`)
    .setDescription([`Ends ${ts(g.endsAt, 'R')}, at ${ts(g.endsAt, 'f')}.`, enterLine(g)].join('\n'));
}

export function milestoneEmbed(g: Giveaway, entrants: number) {
  return base(g)
    .setTitle(`🎯 ${entrants} entrant${entrants === 1 ? "" : "s"} in ${g.name}!`)
    .setDescription([`Ends ${ts(g.endsAt, 'R')}.`, enterLine(g)].join('\n'));
}

export function capacityEmbed(g: Giveaway, percent: number, entrants: number) {
  return base(g)
    .setTitle(`📈 ${g.name} is ${percent}% full`)
    .setDescription([`${entrants} of ${g.maxParticipants} spots taken.`, enterLine(g)].join('\n'));
}

export function extendedEmbed(g: Giveaway, change: { endsAt?: Date; maxParticipants?: number }) {
  const lines: string[] = [];
  if (change.endsAt) lines.push(`Now ends ${ts(change.endsAt)} (${ts(change.endsAt, 'R')}).`);
  if (change.maxParticipants) lines.push(`Now open to ${change.maxParticipants} entrants.`);
  lines.push(enterLine(g));
  return base(g).setColor(BLUE).setTitle(`⏰ ${g.name} has been extended`).setDescription(lines.join('\n'));
}

export function closedEmbed(g: Giveaway, stats: { entrants: number; entries: number }) {
  const why = g.closeReason === 'cap' ? 'All spots are filled.' : g.closeReason === 'early' ? 'Closed early.' : 'Time is up.';
  return base(g)
    .setColor(BLUE)
    .setTitle(`🔒 ${g.name} is closed`)
    .setDescription(`${why} ${stats.entrants} entrants, ${stats.entries} entries. Thanks for playing!`);
}

/** Admin-only button row for the #community-updates copy. Never reposted publicly. */
export function extendRow(g: Giveaway) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${EXTEND_BUTTON_PREFIX}${g.id}`).setLabel('Extend').setEmoji('⏰').setStyle(ButtonStyle.Secondary),
  );
}
