import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import type { Command } from "../types/discord.js";

export const CommunityCodeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("communitycode")
    .setDescription("BB-BOT posts the community code in a channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.guild?.channels.fetch("1471304960862851122");

    const welcomeText = `**⚡️ Welcome to the official Boston Blerds server.**

Plug into the culture. Respect the community. Protect the vibe. This space exists to create a safe, creative, and fun home for blerds and blerd allies to connect over anime, manga, gaming, cosplay, tech, and culture. If you’re here, you’re part of the squad — so act like it.

--`

    const rulesEmbed =  new EmbedBuilder()
      .setTitle("Boston Blerd Community Code")
      .setColor(0xFFFF00)
      .setDescription(
        `**🧠 1. Respect the Vibe — Zero Tolerance for Toxicity**
Treat all members with respect. No harassment, bullying, hate speech, racism, sexism, homophobia, transphobia, targeting, defamation, or discriminatory behavior of any kind.
This includes:
    •    Slurs or coded hate language
    •    Personal attacks or dogpiling
    •    Threats or intimidation
    •    Mocking someone’s identity, interests, or background
    •    Stirring drama for attention
We're here for good vibes. Violations may result in warnings, mutes, kicks, or bans.
 
**🚫 2. Keep It PG — No NSFW or Graphic Content**
This is a community space; keep it welcoming.
No posting or linking:
    •    Sexual content or nudity
    •    Porn or fetish content
    •    Graphic or extreme violence
    •    Shock content or disturbing media
    •    Explicit or obscene material
“It's just a joke” isn't a defense — protect the space.

**💬 3. Disagree Without Being Disagreeable**
We welcome discussion, debate, and hot takes, but keep it respectful.
The rule:
Attack ideas, not people.
If you share an opinion:
    •    Be ready to explain it
    •    Be ready for disagreement
    •    Don’t escalate into personal insults
You can:
    •    Mute
    •    Ignore
    •    Block
    •    Walk away
Mods won’t referee personal feelings, but they will step in if behavior breaks rules.
 
**🚯 4. No Spam, No Noise, No Clout Farming**
Don’t flood channels with:
    •    Repeated messages
    •    Random links
    •    Unrelated videos
    •    Loud audio spam
    •    Meme dumping outside meme channels
Also prohibited:
    •    Promoting competitor servers
    •    Affiliate links without permission
    •    Sneaky advertising in bios or DMs
    •    Recruiting without staff approval
This server is a community hub, not a billboard.
 
**📣 5. Self-Promo = Earned Privilege, Not Free Real Estate**
Self-promotion includes:
    •    Social media links
    •    Streaming/content channels
    •    Personal brands or shops
    •    Discord invites
    •    Events or projects you’re running
Promo Rules:
    •    Only post in approved promo channels
    •    Follow posting limits
    •    No reposting the same promo repeatedly
    •    No DM promo without consent
    •    Must provide value to the community, not just self-benefit
Abusing promo = losing promo privileges.
 
**🎯 6. Stay On Topic — Respect Channel Purposes**
Each channel exists for a reason.
This means:
    •    Keep anime talk in anime channels
    •    Gaming talk in gaming channels
    •    Event convo in event channels
    •    Memes in meme channels
Off-topic content may be:
    •    Moved
    •    Deleted
    •    Redirected
Help keep the server readable and enjoyable for everyone!
 
**🛡️ 7. Protect the Server — No Scams, Bots, or Impersonation**
Admins/Mods will NEVER DM you randomly about:
    •    Crypto
    •    Investments
    •    Giveaways
    • “Business opportunities”
    •    Surprise “partnerships”
If someone impersonates staff:
📸 Screenshot their name + tag
📩 Report immediately
Scammers get the permaban speedrun. Don’t lose your loot.
 
**🔐 8. No Doxxing, No Creeping, No Privacy Violations**
Do NOT:
    •    Share private information
    •    Leak screenshots without consent
    •    Pressure people for personal details
    •    Track, stalk, or harass members
    •    Weaponize screenshots or personal info
People deserve safety and privacy — online and offline.
 
**⚖️ 9. Moderator Authority — Respect the System**
Mods/Admins exist to protect the community, not debate power.
If a mod:
    •    Issues a warning
    •    Deletes content
    •    Restricts access
Comply first, appeal later calmly and respectfully.
Public arguments with moderators may result in penalties.
 
**🚨 10. Enforcement & Accountability**
Consequences may include:
    •    Verbal or written warnings
    •    Message deletion
    •    Temporary mutes
    •    Temporary bans
    •    Permanent bans
Severity depends on intent, impact, and repeat behavior.`
      )

    await (channel as TextChannel).send({
      content: welcomeText,
      embeds: [rulesEmbed],
    });

    await interaction.editReply(`Posted ✅ in ${channel}.`);
  },
};
