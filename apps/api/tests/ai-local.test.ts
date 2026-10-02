import { describe, expect, it } from 'vitest';
import { classify, composeDraft, extractTasks, parseDeadline, replyOptions } from '../src/ai/local.js';

// Thursday 2026-10-01 12:00 UTC
const NOW = new Date('2026-10-01T12:00:00Z');

describe('deadline parsing', () => {
  it('understands relative and named days', () => {
    expect(parseDeadline('by Friday', NOW)?.toISOString()).toBe('2026-10-02T17:00:00.000Z');
    expect(parseDeadline('tomorrow please', NOW)?.toISOString()).toBe('2026-10-02T17:00:00.000Z');
    expect(parseDeadline('by EOD', NOW)?.toISOString()).toBe('2026-10-01T17:00:00.000Z');
    expect(parseDeadline('due 2026-11-05', NOW)?.toISOString()).toBe('2026-11-05T17:00:00.000Z');
    expect(parseDeadline('no date here', NOW)).toBeNull();
  });
  it('a weekday that is today means next week', () => {
    expect(parseDeadline('by Thursday', NOW)?.toISOString()).toBe('2026-10-08T17:00:00.000Z');
  });
});

describe('task extraction', () => {
  it('detects the example from the brief', () => {
    const [t] = extractTasks('Javed, please send the security report by Friday.', { now: NOW });
    expect(t).toMatchObject({ title: 'Send the security report', owner: 'Javed' });
    expect(t!.deadline?.toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });
  it('detects requests to the reader and commitments by the sender', () => {
    const r = extractTasks('Thanks for the call. Can you share the AWS account list? I will send the invoice tomorrow.', { userName: 'Javed', now: NOW });
    expect(r.map((x) => [x.title, x.owner])).toEqual([['Share the AWS account list', 'Javed'], ['Send the invoice', 'sender']]);
  });
  it('ignores greetings and plain statements', () => {
    expect(extractTasks('Hi Javed, hope you are well. The weather is nice.')).toEqual([]);
  });
});

describe('classification', () => {
  it('marks outage language urgent', () => {
    const c = classify({ source: 'gmail', subject: 'URGENT: prod down', body: 'Payments are down. Need a decision ASAP.', now: NOW });
    expect(c.priority).toBe('urgent');
  });
  it('treats automated mail as low priority FYI', () => {
    const c = classify({ source: 'gmail', subject: 'Invoice', body: 'Your invoice is ready. Unsubscribe here.', senderAddress: 'no-reply@x.com', now: NOW });
    expect(c).toMatchObject({ category: 'fyi', priority: 'low' });
  });
  it('VIP questions rank high and ask for a reply', () => {
    const c = classify({ source: 'gmail', body: 'Could you confirm the date?', senderName: 'Rahul', isVip: true, now: NOW });
    expect(c).toMatchObject({ category: 'needs_reply', priority: 'high', requiredAction: 'Reply to Rahul' });
  });
  it('ticket notifications are tasks, not replies', () => {
    expect(classify({ source: 'jira', body: 'Please rotate the keys today.', now: NOW }).category).toBe('task');
  });
});

describe('reply suggestions', () => {
  it('returns all seven styles, with the sender name and signature', () => {
    const r = replyOptions({ senderName: 'Rahul Mehta', userName: 'Javed Khan', subject: 'Report', body: 'Please send the report by Friday.', channel: 'email' });
    expect(r.map((x) => x.style)).toEqual(['short', 'professional', 'detailed', 'decline', 'accept', 'clarify', 'follow_up']);
    expect(r[1]!.body).toContain('Hi Rahul');
    expect(r[1]!.body).toContain('Javed Khan');
  });
  it('omits the email signature on chat channels', () => {
    expect(replyOptions({ senderName: 'Sam', userName: 'Javed Khan', body: 'ok?', channel: 'slack' })[0]!.body).not.toContain('Best regards');
  });
});

describe('composer', () => {
  it('handles the examples from the brief', () => {
    expect(composeDraft("Write an email to the engineering team about today's deployment delay.", 'Javed')).toMatchObject({ channel: 'email', to: 'engineering team' });
    const reply = composeDraft("Reply to Rahul and tell him we'll share the report tomorrow", 'Javed');
    expect(reply.to).toBe('Rahul');
    expect(reply.body).toContain("we'll share the report tomorrow");
    expect(composeDraft('Write a Slack update about the Jira sprint', 'Javed').channel).toBe('slack');
    expect(composeDraft('Draft a WhatsApp follow-up for the client', 'Javed').channel).toBe('whatsapp');
  });
  it('always says it is a draft', () => {
    expect(composeDraft('email Sam about lunch', 'J').notes[0]).toMatch(/Nothing is sent/);
  });
});
