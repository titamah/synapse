import type { RuleAction, RuleOptions } from '../db/schema.js';

export type Rule = {
  id: number;
  position: number;
  action: RuleAction;
  maxCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  frequency: 'day' | 'week' | null;
  options: RuleOptions;
};

/** An entry this person already earned, and under which rule. */
export type PriorAward = { ruleId: number | null; at: Date };

export type ActionContext = {
  action: RuleAction;
  at: Date;
  /** For comments: did it @mention someone other than us or the commenter? */
  taggedFriend?: boolean;
  /** For tagged posts: the post's caption. */
  caption?: string;
  /** For comments: the post it's on. */
  mediaId?: string;
};

const TZ = 'America/New_York';

/** Calendar day in Eastern time, e.g. "2026-11-20". */
function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** The Monday (Eastern) of the week containing d, so weeks run Monday through Sunday. */
function weekKey(d: Date): string {
  const [y, m, day] = dayKey(d).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function periodKey(frequency: 'day' | 'week', d: Date) {
  return frequency === 'day' ? dayKey(d) : weekKey(d);
}

/**
 * Picks the rule an action should count under, or null if it earns nothing.
 * Candidates are rules for this action whose options are met and whose time window
 * (default: the whole giveaway, and never outside it) contains the action. Comments only match rules for
 * the post they're on. The most specific window wins, then list order. A rule is skipped once this person hit its max, or already earned
 * under it in the same day/week.
 */
export function chooseRule(
  rules: Rule[],
  ctx: ActionContext,
  giveawayWindow: { start: Date; end: Date },
  prior: PriorAward[],
): Rule | null {
  const candidates = rules
    .filter(r => r.action === ctx.action)
    .filter(r => !r.options.requireTag || ctx.taggedFriend)
    .filter(r => !r.options.captionIncludes || (ctx.caption ?? '').toLowerCase().includes(r.options.captionIncludes.toLowerCase()))
    .filter(r => !r.options.post || r.options.post.id === ctx.mediaId)
    .map(r => {
      // A rule's window never reaches outside the giveaway itself (e.g. after it closed early).
      const start = new Date(Math.max((r.windowStart ?? giveawayWindow.start).getTime(), giveawayWindow.start.getTime()));
      const end = new Date(Math.min((r.windowEnd ?? giveawayWindow.end).getTime(), giveawayWindow.end.getTime()));
      return { rule: r, start, end, length: end.getTime() - start.getTime() };
    })
    .filter(c => ctx.at >= c.start && ctx.at < c.end)
    .sort((a, b) => a.length - b.length || a.rule.position - b.rule.position);

  for (const { rule } of candidates) {
    const earned = prior.filter(p => p.ruleId === rule.id);
    if (earned.length >= rule.maxCount) continue;
    if (rule.frequency) {
      const period = periodKey(rule.frequency, ctx.at);
      if (earned.some(p => periodKey(rule.frequency!, p.at) === period)) continue;
    }
    return rule;
  }
  return null;
}
