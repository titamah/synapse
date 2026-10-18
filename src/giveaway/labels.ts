import type { EngineRule } from './engine.js';

const PLATFORM_LABELS: Record<string, string> = { discord: 'Discord', instagram: 'Instagram' };

const ACTION_LABELS: Record<string, string> = {
  'discord:enter': 'entered with /giveaway enter',
  'discord:member': 'is in the server',
  'instagram:follow': 'follows @BostonBlerds',
  'instagram:comment': 'commented on a giveaway post',
  'instagram:story': 'mentioned @BostonBlerds in their Story',
  'instagram:tag': 'posted and tagged @BostonBlerds',
};

/** Short label for a requirement, e.g. "Instagram: follows @BostonBlerds". */
export function ruleLabel(r: Pick<EngineRule, 'platform' | 'action' | 'options'>) {
  let label = `${PLATFORM_LABELS[r.platform] ?? r.platform}: ${ACTION_LABELS[`${r.platform}:${r.action}`] ?? r.action}`;
  if (r.options.requireTag) label += ' (tagging a friend)';
  if (r.options.captionIncludes) label += ` (caption includes "${r.options.captionIncludes}")`;
  return label;
}

const fmt = (d: Date) =>
  d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Full description of a rule for the dashboard and export headers. */
export function describeRule(r: EngineRule) {
  const parts: string[] = [ruleLabel(r)];
  if (r.type === 'required') {
    parts.push(r.min > 1 ? `required ×${r.min}` : 'required');
    if (r.check) parts.push(r.check === 'winners' ? 'checked for winners' : 'checked for everyone');
  } else {
    parts.push(`bonus ×${r.weight}`, `max ${r.maxCount}`);
    if (r.frequency) parts.push(`1 per ${r.frequency}`);
  }
  if (r.windowStart || r.windowEnd) parts.push(`${r.windowStart ? fmt(r.windowStart) : 'start'}–${r.windowEnd ? fmt(r.windowEnd) : 'end'}`);
  return `#${r.position} ${parts.join(', ')}`;
}
