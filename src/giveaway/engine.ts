import type { Platform, RuleAction, RuleOptions } from '../db/schema.js';
import { MANUAL_ACTIONS } from '../db/schema.js';
import { chooseRule, type PriorAward } from './rules.js';

/** A rule as the engine sees it (one row of giveaway_rules). */
export type EngineRule = {
  id: number;
  position: number;
  platform: Platform;
  action: RuleAction;
  type: 'required' | 'bonus';
  weight: number;
  min: number;
  check: 'winners' | 'everyone' | null;
  maxCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  frequency: 'day' | 'week' | null;
  options: RuleOptions;
};

/** One recorded action by this person (removed ones are filtered out before calling). */
export type EngineActivity = {
  id: number;
  platform: Platform;
  action: RuleAction;
  at: Date;
  details: { taggedFriend?: boolean; caption?: string; mediaId?: string };
};

export type EngineOverride =
  | { kind: 'requirement_met'; ruleId: number }
  | { kind: 'manual_entry'; weight: number; label: string | null };

export type EngineInput = {
  giveaway: { start: Date; end: Date; baseWeight: number };
  rules: EngineRule[];
  person: { discordId: string | null; disqualified: boolean };
  activities: EngineActivity[];
  overrides: EngineOverride[];
  /** Is this person in the Discord server? null = unknown (bot offline), treated as yes. */
  isMember: boolean | null;
};

export type RequirementResult = {
  ruleId: number;
  met: boolean;
  /** how it was met: by their activity, an admin override, server membership, or deferred to the winner check. */
  via: 'activity' | 'override' | 'member' | 'winner-check' | null;
};

export type EngineResult = {
  eligible: boolean;
  requirements: RequirementResult[];
  /** Required rules not met yet, e.g. [ruleId] (the API turns these into labels). */
  missing: number[];
  /** Manual rules confirmed only for winners (e.g. follows); don't block eligibility. */
  winnerChecks: number[];
  breakdown: { ruleId: number; count: number; weight: number; entries: number }[];
  entries: { base: number; bonus: number; manual: number; total: number };
};

const isManual = (r: EngineRule) => MANUAL_ACTIONS.includes(r.action);

/** The rule's window, never reaching outside the giveaway. */
function windowOf(r: EngineRule, g: EngineInput['giveaway']) {
  const start = Math.max((r.windowStart ?? g.start).getTime(), g.start.getTime());
  const end = Math.min((r.windowEnd ?? g.end).getTime(), g.end.getTime());
  return { start, end };
}

/** Does this activity satisfy a required rule? (Bonus matching goes through chooseRule.) */
function satisfies(r: EngineRule, a: EngineActivity, g: EngineInput['giveaway']) {
  if (r.platform !== a.platform || r.action !== a.action) return false;
  const { start, end } = windowOf(r, g);
  const t = a.at.getTime();
  if (t < start || t >= end) return false;
  if (r.options.requireTag && !a.details.taggedFriend) return false;
  if (r.options.captionIncludes && !(a.details.caption ?? '').toLowerCase().includes(r.options.captionIncludes.toLowerCase())) return false;
  if (r.options.posts?.length && !(a.details.mediaId && r.options.posts.includes(a.details.mediaId))) return false;
  return true;
}

/**
 * One person's eligibility and entries.
 *
 * Required rules (all must be met; AND across platforms): met by an admin override, by server
 * membership (Discord member), deferred to the winner check (manual, winners only), or by their
 * first `min` matching activities. Activities used for requirements are part of the base entry
 * and don't also earn bonuses. If there are no required rules, any counted bonus action qualifies.
 *
 * Entries: baseWeight if eligible, plus each remaining activity counted under a bonus rule
 * (most specific window with room first) × that rule's weight, plus manual entries. 0 if not eligible.
 */
export function evaluatePerson(input: EngineInput): EngineResult {
  const { giveaway: g, rules, person, overrides } = input;
  const metByOverride = new Set(overrides.filter(o => o.kind === 'requirement_met').map(o => (o as { ruleId: number }).ruleId));
  const pool = [...input.activities].sort((x, y) => x.at.getTime() - y.at.getTime() || x.id - y.id);
  const used = new Set<number>();

  const required = rules.filter(r => r.type === 'required').sort((a, b) => a.position - b.position || a.id - b.id);
  const requirements: RequirementResult[] = required.map(r => {
    if (metByOverride.has(r.id)) return { ruleId: r.id, met: true, via: 'override' };
    if (r.platform === 'discord' && r.action === 'member') {
      return { ruleId: r.id, met: !!person.discordId && input.isMember !== false, via: person.discordId ? 'member' : null };
    }
    if (isManual(r)) {
      return (r.check ?? 'winners') === 'winners' ? { ruleId: r.id, met: true, via: 'winner-check' } : { ruleId: r.id, met: false, via: null };
    }
    const matches = pool.filter(a => !used.has(a.id) && satisfies(r, a, g)).slice(0, Math.max(1, r.min));
    if (matches.length < Math.max(1, r.min)) return { ruleId: r.id, met: false, via: null };
    for (const a of matches) used.add(a.id);
    return { ruleId: r.id, met: true, via: 'activity' };
  });

  // Bonuses: everything not used for a requirement, through the windowed/max/frequency engine.
  const bonusRules = rules.filter(r => r.type === 'bonus');
  const prior: PriorAward[] = [];
  const counts = new Map<number, number>();
  for (const a of pool) {
    if (used.has(a.id)) continue;
    const rule = chooseRule(
      bonusRules.filter(r => r.platform === a.platform),
      {
        action: a.action,
        at: a.at,
        ...(a.details.taggedFriend !== undefined ? { taggedFriend: a.details.taggedFriend } : {}),
        ...(a.details.caption !== undefined ? { caption: a.details.caption } : {}),
        ...(a.details.mediaId !== undefined ? { mediaId: a.details.mediaId } : {}),
      },
      { start: g.start, end: g.end },
      prior,
    );
    if (!rule) continue;
    prior.push({ ruleId: rule.id, at: a.at });
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  }
  const breakdown = bonusRules
    .filter(r => counts.has(r.id))
    .map(r => ({ ruleId: r.id, count: counts.get(r.id)!, weight: r.weight, entries: counts.get(r.id)! * r.weight }));
  const bonus = breakdown.reduce((s, b) => s + b.entries, 0);
  const manual = overrides.reduce((s, o) => s + (o.kind === 'manual_entry' ? o.weight : 0), 0);

  const missing = requirements.filter(r => !r.met).map(r => r.ruleId);
  const qualified = required.length ? missing.length === 0 : breakdown.length > 0;
  const eligible = qualified && !person.disqualified;
  const base = eligible ? g.baseWeight : 0;

  return {
    eligible,
    requirements,
    missing,
    winnerChecks: requirements.filter(r => r.via === 'winner-check').map(r => r.ruleId),
    breakdown,
    entries: { base, bonus, manual, total: eligible ? base + bonus + manual : 0 },
  };
}
