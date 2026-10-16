import { GuildMember, type Interaction } from 'discord.js';
import { env } from '../config/environment.js';

/**
 * The real admin gate. Discord's default member permissions only hide commands,
 * and server owners can override them in Integrations settings, so every
 * command is checked here too.
 */
export function isAdmin(interaction: Interaction): boolean {
  const member = interaction.member;
  if (!interaction.guild || !(member instanceof GuildMember)) return false;
  if (interaction.guild.ownerId === member.id) return true;

  const roleName = env.ADMIN_ROLE_NAME.toLowerCase();
  return member.roles.cache.some(role => role.name.toLowerCase() === roleName);
}
