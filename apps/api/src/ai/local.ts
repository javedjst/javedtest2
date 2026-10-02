/**
 * Free, offline "AI". Rule based classifiers and templates so the whole product works with no API
 * key and no cost. The Anthropic provider upgrades quality; this engine is also the fallback when
 * the API is down or a model response fails validation.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type Category = 'needs_reply' | 'fyi' | 'approval' | 'meeting' | 'task' | 'waiting';

export interface ClassifyInput {
  source: string;
  subject?: string | null;
  body: string;
  senderName?: string | null;
  senderAddress?: string | null;
  isVip?: boolean;
  kind?: string;
  now?: Date;
}

export interface Classification {
  priority: Priority;
  category: Category;
  requiredAction: string | null;
  deadline: Date | null;
  summary: string;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 17, 0, 0));

/** Understands: today, tonight, EOD, tomorrow, weekday names, next week, in N days, ISO dates. All UTC. */
export function parseDeadline(text: string, now = new Date()): Date | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!, 17));
  if (/\b(eod|end of (the )?day|today|tonight|asap|by close of business|cob)\b/.test(t)) return endOfDay(now);
  if (/\btomorrow\b/.test(t)) return endOfDay(new Date(now.getTime() + 86_400_000));
  const inDays = t.match(/\bin (\d{1,2}) days?\b/);
  if (inDays) return endOfDay(new Date(now.getTime() + +inDays[1]! * 86_400_000));
  if (/\bnext week\b/.test(t)) return endOfDay(new Date(now.getTime() + 7 * 86_400_000));
  if (/\bend of (the )?week\b/.test(t)) return nextWeekday(5, now);
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b${DAYS[i]}\\b`).test(t)) return nextWeekday(i, now);
  return null;
}

function nextWeekday(target: number, now: Date): Date {
  let diff = (target - now.getUTCDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return endOfDay(new Date(now.getTime() + diff * 86_400_000));
}

const URGENT = /\b(urgent|asap|immediately|critical|outage|production (is )?down|sev ?[01]|p[01]\b|security incident|breach|blocker|escalat)/i;
const QUESTION = /\?|\b(please|can you|could you|would you|let me know|thoughts|need you to|waiting (for|on) you|kindly)\b/i;
const APPROVAL = /\b(approve|approval|sign[- ]?off|review requested|requested your review|please review)\b/i;
const MEETING = /\b(meeting|invite|invitation|schedule|reschedule|calendar|call at|sync up|catch up)\b/i;
const FYI = /\b(unsubscribe|no[- ]?reply|newsletter|fyi|for your information|digest|receipt|automated message)\b/i;

export function classify(input: ClassifyInput): Classification {
  const now = input.now ?? new Date();
  const text = `${input.subject ?? ''}\n${input.body}`;
  const automated = FYI.test(text) || /no-?reply|notifications?@/i.test(input.senderAddress ?? '');

  let category: Category = 'fyi';
  if (APPROVAL.test(text)) category = 'approval';
  else if (MEETING.test(text) && !automated) category = 'meeting';
  else if (QUESTION.test(text) && !automated) category = 'needs_reply';
  else if (extractTasks(text, { now }).length > 0) category = 'task';
  if (input.kind === 'approval') category = 'approval';
  // Ticket and code notifications are work items, not conversations to reply to.
  if (category === 'needs_reply' && ['jira', 'github', 'confluence'].includes(input.source)) category = 'task';
  const securityAlert = /\b(vulnerab|cve-?\d*|security alert|leaked|exposed secret)/i.test(text);
  if (securityAlert && category === 'fyi') category = 'task';

  const deadline = parseDeadline(text, now);
  const hoursToDeadline = deadline ? (deadline.getTime() - now.getTime()) / 3_600_000 : Infinity;

  let priority: Priority = 'normal';
  if (URGENT.test(text) || hoursToDeadline <= 8) priority = 'urgent';
  else if (input.isVip && category !== 'fyi') priority = 'high';
  else if (category === 'approval' || hoursToDeadline <= 72) priority = 'high';
  else if (category === 'fyi') priority = 'low';

  const requiredAction =
    category === 'needs_reply' ? `Reply to ${input.senderName ?? 'sender'}`
    : category === 'approval' ? 'Review and approve or reject'
    : category === 'meeting' ? 'Respond to meeting request'
    : category === 'task' ? (securityAlert ? 'Triage the security finding' : 'Complete the requested task')
    : null;

  return { priority, category, requiredAction, deadline, summary: summarize(input.subject, input.body) };
}

export function summarize(subject: string | null | undefined, body: string): string {
  const clean = body.replace(/\s+/g, ' ').replace(/^(hi|hello|hey|dear)[^,.!]{0,40}[,.!]\s*/i, '').trim();
  const first = clean.split(/(?<=[.!?])\s+/)[0] ?? '';
  const s = first.length >= 12 ? first : clean;
  const out = s.length > 160 ? `${s.slice(0, 157)}...` : s;
  return out || subject || '(no content)';
}

// ------------------------------------------------------------------ task extraction
export interface ExtractedTask {
  title: string;
  owner: string | null;
  deadline: Date | null;
  sentence: string;
}

const DEADLINE_TAIL = /\s*\b(?:(?:by|before|until|on|due)\s+)?(eod|end of (the )?day|today|tonight|tomorrow|next week|end of (the )?week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b.*$/i;
const STOP_WORDS = new Set(['hi', 'hello', 'hey', 'thanks', 'thank', 'dear', 'regards', 'best']);

export function extractTasks(text: string, opts: { userName?: string; now?: Date } = {}): ExtractedTask[] {
  const now = opts.now ?? new Date();
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: ExtractedTask[] = [];
  for (const sentence of sentences) {
    if (sentence.length > 240) continue;
    let owner: string | null = null;
    let action: string | null = null;

    let m = sentence.match(/^([A-Z][a-z]+),?\s+(?:can you |could you |would you |please )+(.+)$/) ?? sentence.match(/^([A-Z][a-z]+),?\s+(.+)$/);
    if (m && !STOP_WORDS.has(m[1]!.toLowerCase()) && /^(please |can you |could you )?(send|share|review|update|prepare|fix|create|schedule|submit|check|finish|complete|write|upload|book|follow|confirm|draft|deploy|rotate|patch)\b/i.test(m[2]!)) {
      owner = m[1]!;
      action = m[2]!;
    }
    if (!action) {
      m = sentence.match(/\b(?:please|can you|could you|need you to|make sure you|don't forget to)\s+(.+)$/i);
      if (m) { action = m[1]!; owner = opts.userName ?? 'you'; }
    }
    if (!action) {
      m = sentence.match(/\b(?:I will|I'll|I am going to|I'm going to)\s+(.+)$/i);
      if (m) { action = m[1]!; owner = 'sender'; }
    }
    if (!action) {
      m = sentence.match(/^(?:action item|todo|to-do|action):?\s*(.+)$/i);
      if (m) action = m[1]!;
    }
    if (!action) {
      m = sentence.match(/^([A-Z][a-z]+) (?:will|to) (.+)$/);
      if (m && !STOP_WORDS.has(m[1]!.toLowerCase())) { owner = m[1]!; action = m[2]!; }
    }
    if (!action) continue;

    const deadline = parseDeadline(sentence, now);
    let title = action.replace(DEADLINE_TAIL, '').replace(/[.!?]+$/, '').replace(/\?$/, '').trim();
    title = title.replace(/^(please\s+)/i, '').replace(/\s+(please|thanks)$/i, '');
    if (title.length < 4) continue;
    title = title[0]!.toUpperCase() + title.slice(1);
    out.push({ title, owner, deadline, sentence });
  }
  return out;
}

// ------------------------------------------------------------------ replies
export type ReplyStyle = 'short' | 'professional' | 'detailed' | 'decline' | 'accept' | 'clarify' | 'follow_up';
export interface ReplyOption { style: ReplyStyle; label: string; body: string }

export interface ReplyInput {
  senderName?: string | null;
  userName: string;
  subject?: string | null;
  body: string;
  channel: string;
  signature?: string;
}

const first = (n?: string | null) => (n ?? '').trim().split(/\s+/)[0] || 'there';

export function replyOptions(i: ReplyInput): ReplyOption[] {
  const name = first(i.senderName);
  const informal = ['slack', 'whatsapp', 'teams'].includes(i.channel);
  const greet = informal ? `Hi ${name},` : `Hi ${name},`;
  const sign = informal ? '' : `\n\nBest regards,\n${i.userName}`;
  const topic = (i.subject ?? 'this').replace(/^(re|fwd?):\s*/i, '');
  const tasks = extractTasks(i.body, { userName: i.userName });
  const ask = tasks[0]?.title.toLowerCase();
  const when = tasks[0]?.deadline ? ` by ${tasks[0].deadline.toUTCString().slice(0, 16)}` : '';
  const ack = ask ? `I'll ${ask}${when}.` : `I'll look into it and get back to you.`;
  return [
    { style: 'short', label: 'Short reply', body: informal ? `${greet} got it. ${ack}` : `${greet}\n\nThanks, got it. ${ack}${sign}` },
    { style: 'professional', label: 'Professional reply', body: `${greet}\n\nThank you for your message regarding ${topic}. ${ack} I will keep you updated on progress.${sign}` },
    { style: 'detailed', label: 'Detailed reply', body: `${greet}\n\nThanks for reaching out about ${topic}. Here is where things stand:\n\n- I have reviewed your note and understand what is needed${ask ? `: ${ask}` : ''}.\n- Next step: ${ask ?? 'I will confirm scope and owners'}${when}.\n- I will send an update as soon as it is done, and flag early if anything blocks it.\n\nLet me know if you want to change priority or scope.${sign}` },
    { style: 'decline', label: 'Decline politely', body: `${greet}\n\nThank you for thinking of me for ${topic}. I do not have the capacity to take this on right now. ${informal ? '' : 'I would suggest looping in someone on the team who can help, and I am happy to share context. '}I appreciate your understanding.${sign}` },
    { style: 'accept', label: 'Accept', body: `${greet}\n\nYes, that works for me. ${ask ? `I will ${ask}${when}.` : 'Please go ahead.'} Thanks for coordinating.${sign}` },
    { style: 'clarify', label: 'Ask for clarification', body: `${greet}\n\nBefore I proceed with ${topic}, could you clarify a few points?\n\n1. What is the expected outcome and format?\n2. What is the deadline, and is it fixed?\n3. Who else needs to be involved?\n\nThanks, this will help me get it right the first time.${sign}` },
    { style: 'follow_up', label: 'Follow-up', body: `${greet}\n\nFollowing up on ${topic}. Do you have an update, or is there anything you need from me to move it forward?${sign}` },
  ];
}

export function followUpDraft(opts: { recipient: string; subject: string; daysWaiting: number; userName: string; channel: string }): string {
  const informal = ['slack', 'whatsapp', 'teams'].includes(opts.channel);
  const body = `Hi ${first(opts.recipient)},\n\nJust checking in on "${opts.subject}". I sent this ${opts.daysWaiting} days ago and wanted to make sure it did not get buried. Could you let me know where it stands?`;
  return informal ? body : `${body}\n\nThanks,\n${opts.userName}`;
}

// ------------------------------------------------------------------ composer
export interface Draft {
  channel: 'email' | 'slack' | 'whatsapp' | 'teams' | 'jira';
  to: string | null;
  subject: string | null;
  body: string;
  notes: string[];
}

/** Turns "Write an email to the engineering team about today's deployment delay" into a draft. */
export function composeDraft(instruction: string, userName: string): Draft {
  const text = instruction.trim();
  const lower = text.toLowerCase();
  const channel: Draft['channel'] = /\bslack\b/.test(lower) ? 'slack' : /\bwhatsapp\b/.test(lower) ? 'whatsapp' : /\bteams\b/.test(lower) ? 'teams' : /\b(jira|ticket)\b/.test(lower) && /\bcreate|summari[sz]e\b/.test(lower) ? 'jira' : 'email';

  const replyTo = text.match(/^reply to ([A-Za-z][\w .'-]*?)(?: and (?:tell|let|say|inform)\s+(?:him|her|them|\w+)\s+(?:that\s+)?(.+))?$/i);
  const toMatch = text.match(/\bto (?:the )?([A-Za-z][\w .'@-]*?)(?= about | regarding | on | that |$)/i);
  const aboutMatch = text.match(/\b(?:about|regarding|on)\s+(.+)$/i);

  const notes = ['Draft only. Nothing is sent until you approve it.'];
  let to: string | null = null;
  let message: string;
  let subject: string | null = null;

  if (replyTo) {
    to = replyTo[1]!.trim();
    message = (replyTo[2] ?? 'thanks for your message').replace(/[.]+$/, '');
    message = message.replace(/\bwe'll\b/i, "we'll").replace(/^we/i, 'we');
    subject = 'Re: your message';
  } else {
    to = toMatch?.[1]?.trim() ?? null;
    message = aboutMatch?.[1]?.replace(/[.]+$/, '') ?? text;
    subject = aboutMatch ? message[0]!.toUpperCase() + message.slice(1) : 'Update';
  }

  const greetTo = to ? (to.toLowerCase().includes('team') ? to : first(to)) : 'all';
  let body: string;
  if (replyTo) {
    body = `Hi ${first(to)},\n\nQuick note: ${message[0]!.toLowerCase() + message.slice(1)}.\n\nThanks,\n${userName}`;
  } else if (channel === 'slack' || channel === 'teams') {
    body = `Update: ${message}.\nI will share more details as they come in. Shout if you have questions.`;
  } else if (channel === 'whatsapp') {
    body = `Hi ${greetTo}, quick follow-up on ${message}. Let me know if you need anything from my side.`;
  } else if (channel === 'jira') {
    subject = message[0]!.toUpperCase() + message.slice(1);
    body = `Summary: ${subject}\n\nDescription:\n${text}\n\nAcceptance criteria:\n- [ ] To be defined by assignee`;
    notes.push('Creating the ticket is a medium risk action and runs through the approval policy.');
  } else {
    body = `Hi ${greetTo},\n\nI wanted to give you a quick update on ${message}.\n\nWhat happened: [add detail]\nImpact: [add detail]\nNext steps: [owner and ETA]\n\nPlease reach out if you have questions.\n\nThanks,\n${userName}`;
    notes.push('Placeholders in [brackets] need your input. Connect an AI key for fully written drafts.');
  }
  if (!to && channel !== 'jira') notes.push('No recipient detected. Add one before sending.');
  return { channel, to, subject, body, notes };
}
