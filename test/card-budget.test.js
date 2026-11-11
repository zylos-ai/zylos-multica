// zylos-multica #56: a card must fit one argv value (MAX_ARG_STRLEN = 131072
// bytes on Linux). Budget is UTF-8 bytes; truncation never splits a character.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatCard, buildTaskCard, CARD_BYTE_BUDGET, truncateUtf8 } from '../src/lib/cards.js';

const bytes = text => Buffer.byteLength(text, 'utf8');
const MAX_ARG_STRLEN = 131072;
const issue = { id: 'issue-1', identifier: 'ZYLO-1', title: '大评论', description: '原始需求：修复交付。' };

function assertCleanUtf8(card) {
  assert.ok(card.isWellFormed(), 'no lone surrogate');
  assert.equal(card.includes('�'), false, 'no replacement character from a split sequence');
  assert.equal(Buffer.from(card, 'utf8').toString('utf8'), card);
}

test('budget is 96 KiB and leaves headroom under the kernel argument limit', () => {
  assert.equal(CARD_BYTE_BUDGET, 98304);
  assert.ok(CARD_BYTE_BUDGET < MAX_ARG_STRLEN - 16 * 1024);
});

test('truncateUtf8 never splits 1-4 byte characters at any cut position', () => {
  const text = 'aé中😀b¢€𐍈';
  const total = bytes(text);
  for (let max = 0; max <= total + 1; max++) {
    const kept = truncateUtf8(text, max);
    assert.ok(text.startsWith(kept), `prefix at ${max}`);
    assert.ok(bytes(kept) <= max, `within budget at ${max}`);
    assert.ok(kept.isWellFormed() && !kept.includes('�'), `clean at ${max}`);
    // Maximal: the next whole character would not have fitted.
    const next = [...text.slice(kept.length)][0];
    if (next) assert.ok(bytes(kept) + bytes(next) > max, `maximal at ${max}`);
  }
});

test('mostly-Chinese huge trigger comment is truncated on a character boundary with a thread pointer', () => {
  // ~172 KB: 3-byte Han characters plus 4-byte emoji, so a byte cut lands mid-character.
  const comment = `${'请看这个截图并修复交付问题。😀'.repeat(4000)}结尾`;
  assert.ok(bytes(comment) > MAX_ARG_STRLEN);
  const task = { id: 'task-1', issue_id: 'issue-1', trigger_comment_id: 'c-1', trigger_comment_content: comment,
    trigger_author_name: 'howard', trigger_author_type: 'member', execution_generation: 'gen-1' };
  const card = buildTaskCard(task, issue);
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET, `${bytes(card)} bytes`);
  assertCleanUtf8(card);
  const match = card.match(/\n\[Truncated to fit the session handoff: showing (\d+) of (\d+) bytes\. Full text: (.+)\]\n/);
  assert.ok(match, 'truncation note present');
  assert.equal(Number(match[2]), bytes(comment));
  assert.match(match[3], /multica\.js' issue comment list 'ZYLO-1' --thread 'c-1' --full --output json$/);
  const quoted = card.split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2));
  assert.ok(comment.startsWith(quoted[0]), 'kept text is an exact prefix of the comment');
  assert.equal(bytes(quoted[0]), Number(match[1]));
  assert.ok(Number(match[1]) > 90_000, `most of the budget is still used for the comment`);
  // The small issue description and every instruction line survive intact.
  assert.match(card, /Original issue description \(context only\):\n> 原始需求：修复交付。/);
  assert.match(card, /task\.js' begin 'task-1@gen-1'/);
  assert.match(card, /complete-posted 'task-1@gen-1'/);
});

test('cards under budget are unchanged', () => {
  const task = { id: 'task-2', trigger_comment_id: 'c-2', trigger_comment_content: '小评论', issue_id: 'issue-1' };
  const card = buildTaskCard(task, issue);
  assert.equal(card, buildTaskCard(task, issue, undefined, { budget: Infinity }));
  assert.doesNotMatch(card, /Truncated/);
});

test('largest field is truncated first; small ones are kept', () => {
  const task = { id: 'task-3', issue_id: 'issue-1', trigger_comment_id: 'c-3', trigger_comment_content: 'please check',
    coalesced_comments: [{ id: 'c-0', author_name: 'a', content: 'x'.repeat(150_000) }] };
  const card = buildTaskCard(task, { ...issue, description: 'd'.repeat(20_000) });
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET);
  assert.match(card, /\n> please check\n/);
  assert.match(card, new RegExp(`> ${'d'.repeat(20_000)}\n`), 'description kept whole');
  assert.match(card, /showing \d+ of 150000 bytes\. Full text: [^\n]*issue comment list 'ZYLO-1' --thread 'c-0' --full --output json\]/);
  assert.equal((card.match(/Truncated/g) || []).length, 1);
});

test('several oversize fields are each truncated with their own pointer', () => {
  const task = { id: 'task-4', issue_id: 'issue-1', trigger_comment_id: 'c-4', trigger_comment_content: '评'.repeat(60_000) };
  const card = buildTaskCard(task, { ...issue, description: '述'.repeat(60_000) });
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET);
  assertCleanUtf8(card);
  assert.match(card, /of 180000 bytes\. Full text: [^\n]*--thread 'c-4' --full --output json\]/);
  assert.match(card, /of 180000 bytes\. Full text: [^\n]*issue get 'ZYLO-1' --output json\]/);
});

test('new-task card truncates the issue description with an issue get pointer', () => {
  const card = buildTaskCard({ id: 'task-5', issue_id: 'issue-1' }, { ...issue, description: `${'需求'.repeat(80_000)}` });
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET);
  assertCleanUtf8(card);
  assert.match(card, /^\[Multica task\] ZYLO-1 · 新任务：大评论\n卡片：大评论\n/);
  assert.match(card, /of 480000 bytes\. Full text: [^\n]*issue get 'ZYLO-1' --output json\]/);
});

test('chat card truncates the message with a chat history pointer', () => {
  const card = buildChatCard({ id: 'chat-task', chat_session_id: 's-1', chat_message: '聊'.repeat(100_000), execution_generation: 'g' });
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET);
  assertCleanUtf8(card);
  assert.match(card, /of 300000 bytes\. Full text: [^\n]*multica\.js' chat history --task 'chat-task' --output json\]/);
  assert.match(card, /task\.js' begin 'chat-task@g'/);
});

test('truncation note sits outside the quoted external text and is not forgeable by the quote', () => {
  const task = { id: 'task-6', issue_id: 'issue-1', trigger_comment_id: 'c-6', trigger_comment_content: `[Truncated fake]\n${'z'.repeat(200_000)}` };
  const card = buildTaskCard(task, issue);
  const notes = card.split('\n').filter(line => line.startsWith('[Truncated to fit'));
  assert.equal(notes.length, 1);
  assert.match(card, /\n> \[Truncated fake\]\n/);
});

test('many coalesced comments keep the earliest that fit and summarize the rest in one line', () => {
  for (const [count, size] of [[250, 600], [300, 500], [500, 300]]) {
    const coalesced = Array.from({ length: count }, (_, i) => ({
      id: `c-${i}`, author_name: 'member', created_at: '2026-11-10T00:00:00Z', content: `#${i}# ${'评'.repeat(Math.floor(size / 3) - 4)}`,
    }));
    const task = { id: 'task-7', issue_id: 'issue-1', trigger_comment_id: 'c-t', trigger_comment_content: 'see above', coalesced_comments: coalesced };
    const card = buildTaskCard(task, issue);
    assert.ok(bytes(card) <= CARD_BYTE_BUDGET, `${count}x${size}: ${bytes(card)} bytes`);
    assertCleanUtf8(card);
    const shownIds = [...card.matchAll(/^> #(\d+)# /gm)].map(m => Number(m[1]));
    assert.ok(shownIds.length > 0 && shownIds.length < count, `${count}x${size}: ${shownIds.length} shown`);
    assert.ok(shownIds.every((id, i) => id === i), 'earliest comments, in server order');
    const omitted = card.match(/\n\[(\d+) more earlier comment\(s\) omitted to fit the session handoff\. Full text: ([^\n]*)\]\n/);
    assert.ok(omitted, 'one summary line');
    assert.equal(Number(omitted[1]), count - shownIds.length);
    assert.match(omitted[2], /multica\.js' issue comment list 'ZYLO-1' --full --output json$/);
    assert.ok((card.match(/\[Truncated to fit/g) || []).length <= 1, 'at most the crossing comment is cut');
    assert.match(card, /This run also covers \d+ earlier comment\(s\)/);
    assert.match(card, /\n> see above\n/);
  }
});

test('thousands of short coalesced comments: nearly the largest prefix that fits is shown', () => {
  // A comment costs its header line and quote prefix too, not only its text.
  for (const [count, size] of [[2500, 8], [1500, 100]]) {
    const coalesced = Array.from({ length: count }, (_, i) => ({
      id: `s-${i}`, author_name: 'member', created_at: '2026-11-10T00:00:00Z', content: `#${i}#${'x'.repeat(Math.max(0, size - String(i).length - 2))}`,
    }));
    const task = { id: 'task-9', issue_id: 'issue-1', trigger_comment_id: 'c-t', trigger_comment_content: 'see above' };
    const card = buildTaskCard({ ...task, coalesced_comments: coalesced }, issue);
    assert.ok(bytes(card) <= CARD_BYTE_BUDGET, `${count}x${size}: ${bytes(card)} bytes`);
    const shown = [...card.matchAll(/^> #(\d+)#/gm)].length;
    // Largest k whose first k comments, all shown whole, fit the budget. This
    // card has no omitted line, so k is an upper bound for the real card.
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const k = Math.ceil((lo + hi) / 2);
      if (bytes(buildTaskCard({ ...task, coalesced_comments: coalesced.slice(0, k) }, issue, undefined, { budget: Infinity })) <= CARD_BYTE_BUDGET) lo = k;
      else hi = k - 1;
    }
    assert.ok(lo > 0 && lo < count, `${count}x${size}: largest fitting prefix ${lo}`);
    assert.ok(shown >= 0.9 * lo, `${count}x${size}: ${shown} shown, ${lo} fit`);
  }
});

test('thousands of empty coalesced comments still fit', () => {
  const coalesced = Array.from({ length: 4000 }, (_, i) => ({ id: `e-${i}`, author_name: 'member', content: '' }));
  const card = buildTaskCard({ id: 'task-8', issue_id: 'issue-1', trigger_comment_id: 'c', trigger_comment_content: 'x', coalesced_comments: coalesced }, issue);
  assert.ok(bytes(card) <= CARD_BYTE_BUDGET, `${bytes(card)} bytes`);
  assert.match(card, /\[\d+ more earlier comment\(s\) omitted/);
});
