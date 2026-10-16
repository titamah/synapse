import { GIVEAWAY } from './service.js';

export const IDS = {
  enterModal: 'giveaway:enter-modal',
  igInput: 'giveaway:ig',
} as const;

export const followReminder = `Don't forget to follow **@${GIVEAWAY.igHandle}** on Instagram!`;
