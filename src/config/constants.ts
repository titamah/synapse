export const XP_REWARDS = {
    MESSAGE: 10,
    FORUM_POST: 25,
    POLL_VOTE: 5,
    REACTION: 5,
    EVENT_ATTENDANCE: 250,
  } as const;
  
  export const DAILY_MESSAGE_XP_LIMIT = 125;
  
  export const STREAK_MULTIPLIERS = [
    { minDays: 1, multiplier: 1.0 },
    { minDays: 25, multiplier: 1.25 },
    { minDays: 50, multiplier: 1.5 },
    { minDays: 100, multiplier: 2.0 },
  ] as const;