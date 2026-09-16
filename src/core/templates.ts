import { DEFAULT_QUESTIONS, type Weekday } from './types.js';

/**
 * Starting points for a new standup. A template only seeds the
 * configuration — everything stays editable afterwards. `null` fields
 * leave the database default in place.
 */
export interface StandupTemplate {
  id: string;
  name: string;
  description: string;
  questions: string[] | null;
  days: Weekday[];
  promptTime: string;
  deadlineTime: string;
  moodEnabled: boolean;
  moodAnonymous: boolean;
  digestEnabled: boolean;
}

const WEEKDAYS_WORK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

export const TEMPLATES: readonly StandupTemplate[] = [
  {
    id: 'daily-standup',
    name: 'Daily standup',
    description: 'Yesterday, today, blockers — every weekday morning, with a weekly digest.',
    questions: [...DEFAULT_QUESTIONS],
    days: WEEKDAYS_WORK,
    promptTime: '09:30',
    deadlineTime: '11:30',
    moodEnabled: true,
    moodAnonymous: false,
    digestEnabled: true,
  },
  {
    id: 'weekly-retro',
    name: 'Weekly retro',
    description: 'Friday afternoon reflection with anonymous mood, so people answer honestly.',
    questions: ['What went well this week?', 'What did not go well?', 'What will you change next week?'],
    days: ['fri'],
    promptTime: '15:00',
    deadlineTime: '17:00',
    moodEnabled: true,
    moodAnonymous: true,
    digestEnabled: false,
  },
  {
    id: 'mood-check-in',
    name: 'Mood check-in',
    description: 'A light three-times-a-week pulse. Moods are anonymous; the team average is what gets shared.',
    questions: ['How is your week going?', 'Anything the team should know?'],
    days: ['mon', 'wed', 'fri'],
    promptTime: '10:00',
    deadlineTime: '12:00',
    moodEnabled: true,
    moodAnonymous: true,
    digestEnabled: false,
  },
  {
    id: 'sprint-planning',
    name: 'Sprint planning',
    description: 'Monday priorities and dependencies, before the planning call.',
    questions: ['What are your top priorities this sprint?', 'What do you need from someone else?', 'Any risks to flag?'],
    days: ['mon'],
    promptTime: '10:00',
    deadlineTime: '12:00',
    moodEnabled: false,
    moodAnonymous: false,
    digestEnabled: false,
  },
  {
    id: 'blocker-sweep',
    name: 'Blocker sweep',
    description: 'End-of-day check for anything stuck, so blockers get tagged before tomorrow.',
    questions: ['Anything blocking you right now?', 'Who can unblock it?'],
    days: WEEKDAYS_WORK,
    promptTime: '16:00',
    deadlineTime: '17:30',
    moodEnabled: false,
    moodAnonymous: false,
    digestEnabled: false,
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'Just the defaults — write your own questions.',
    questions: null,
    days: WEEKDAYS_WORK,
    promptTime: '09:30',
    deadlineTime: '11:30',
    moodEnabled: true,
    moodAnonymous: false,
    digestEnabled: false,
  },
];

export function templateById(id: string): StandupTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
