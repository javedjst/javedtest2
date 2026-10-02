import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { randomToken } from '../security/crypto.js';
import { UNTRUSTED_NOTICE, scanUntrusted, wrapUntrusted } from '../security/sanitize.js';
import * as local from './local.js';

/**
 * AiService: one entry point for every model call. Properties enforced here, not in callers:
 *  - untrusted text is always wrapped and scanned before it reaches a model
 *  - the model only ever returns data (JSON validated by zod); it never receives credentials or tools
 *  - any failure falls back to the free local engine
 */

const client = config.AI_PROVIDER !== 'local' && config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;

export const aiMode = (): 'anthropic' | 'local' => (client ? 'anthropic' : 'local');

async function ask(system: string, user: string, maxTokens = 1200): Promise<string> {
  if (!client) throw new Error('no model');
  const res = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: `${system}\n\n${UNTRUSTED_NOTICE}`,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.map((b: { type: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return schema.parse(JSON.parse(raw.slice(start, end + 1)));
}

const ReplySchema = z.object({ options: z.array(z.object({ style: z.enum(['short', 'professional', 'detailed', 'decline', 'accept', 'clarify', 'follow_up']), label: z.string(), body: z.string() })).min(1) });

export interface ReplyContext {
  userName: string;
  userStyle?: string;
  senderName?: string | null;
  subject?: string | null;
  body: string;
  channel: string;
  history?: string[];
  knowledge?: string[];
}

export async function suggestReplies(ctx: ReplyContext): Promise<{ options: local.ReplyOption[]; engine: string; flags: string[] }> {
  const scan = scanUntrusted(ctx.body);
  const fallback = () => ({ options: local.replyOptions({ ...ctx }), engine: 'local', flags: scan.flags });
  if (!client) return fallback();
  try {
    const nonce = randomToken(8);
    const prompt = [
      `You draft replies for ${ctx.userName}. Writing style: ${ctx.userStyle ?? 'concise, warm, direct'}. Channel: ${ctx.channel}.`,
      'Return JSON only: {"options":[{"style","label","body"}]} with styles short, professional, detailed, decline, accept, clarify, follow_up.',
      'Do not invent facts, dates or commitments that are not in the context. Use [brackets] for unknowns.',
      ctx.history?.length ? wrapUntrusted('thread-history', ctx.history.join('\n---\n'), nonce) : '',
      ctx.knowledge?.length ? wrapUntrusted('company-knowledge', ctx.knowledge.join('\n---\n'), nonce) : '',
      wrapUntrusted(`message from ${ctx.senderName ?? 'sender'}`, `Subject: ${ctx.subject ?? ''}\n\n${ctx.body}`, nonce),
    ].filter(Boolean).join('\n\n');
    const out = parseJson(await ask('You are a careful executive assistant.', prompt, 2000), ReplySchema);
    return { options: out.options, engine: 'anthropic', flags: scan.flags };
  } catch {
    return fallback();
  }
}

const DraftSchema = z.object({ channel: z.enum(['email', 'slack', 'whatsapp', 'teams', 'jira']), to: z.string().nullable(), subject: z.string().nullable(), body: z.string() });

export async function composeDraft(instruction: string, userName: string, knowledge: string[] = []): Promise<local.Draft & { engine: string }> {
  const fallback = () => ({ ...local.composeDraft(instruction, userName), engine: 'local' });
  if (!client) return fallback();
  try {
    const nonce = randomToken(8);
    const raw = await ask(
      'You write workplace messages. Return JSON only: {"channel","to","subject","body"}. Use [brackets] for facts you do not know.',
      `Author: ${userName}\nInstruction: ${instruction}\n\n${wrapUntrusted('company-knowledge', knowledge.join('\n---\n'), nonce)}`,
    );
    const d = parseJson(raw, DraftSchema);
    return { ...d, notes: ['Draft only. Nothing is sent until you approve it.'], engine: 'anthropic' };
  } catch {
    return fallback();
  }
}

export async function answerWithSources(question: string, sources: { title: string; url?: string | null; text: string }[]): Promise<{ answer: string; engine: string }> {
  const lead = (s: { text: string }) => local.summarize(null, s.text);
  const fallback = () => ({
    engine: 'local',
    answer: sources.length
      ? `Here is what I found:\n${sources.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}: ${lead(s)}`).join('\n')}`
      : 'I could not find anything you have access to that matches. Try different keywords or connect more sources.',
  });
  if (!client || sources.length === 0) return fallback();
  try {
    const nonce = randomToken(8);
    const ctx = sources.map((s, i) => wrapUntrusted(`source ${i + 1}: ${s.title}`, s.text.slice(0, 3000), nonce)).join('\n');
    const answer = await ask('Answer using only the sources. Cite as [1], [2]. Say so if the sources do not answer the question.', `Question: ${question}\n\n${ctx}`);
    return { answer, engine: 'anthropic' };
  } catch {
    return fallback();
  }
}

export { local };
