import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIssuePropertyRows, encodeIssuePropertyValue, issuePropertyNeedsMembers, validateIssuePropertyValue } from '../src/lib/business-properties.js';

const id = '12345678-1234-1234-1234-123456789abc';
const ref = `member:${id}`;
const options = [{ id: 'a', name: 'One, first' }, { id: 'b', name: 'Two' }];
const definition = (type) => ({ id: type, name: type, type, config: { options } });
const cases = [
  ['text', ' keep  spacing ', ' keep  spacing ', '   '],
  ['multi_text', '["One, first","two","two"]', ['One, first', 'two'], '["ok",null]'],
  ['url', ' https://example.com/x ', 'https://example.com/x', 'ftp://example.com'],
  ['multi_url', '[" https://example.com ","https://example.com"]', ['https://example.com'], '["https://example.com",""]'],
  ['number', '1e2', 100, '0x10'],
  ['checkbox', 'false', false, 'False'],
  ['date', '2024-02-29', '2024-02-29', '2023-02-29'],
  ['select', 'tWo', 'b', 'tw'],
  ['multi_select', 'Two,a,Two', ['a', 'b'], 'unknown'],
  ['actor', `member:${id.toUpperCase()}`, ref, 'member:invalid'],
  ['multi_actor', `${ref},${ref}`, [ref], 'member:invalid'],
];
for (const [type, raw, expected, invalid] of cases) {
  test(`${type}: CLI encoding and canonical validation`, async () => {
    assert.deepEqual(await encodeIssuePropertyValue(definition(type), raw), expected);
    await assert.rejects(encodeIssuePropertyValue(definition(type), invalid));
    await assert.rejects(encodeIssuePropertyValue({ ...definition(type), archived: true }, raw), /archived/);
    assert.throws(() => validateIssuePropertyValue(definition(type), null));
  });
}

test('text uses rune count, preserves spacing, strips NUL, and repairs invalid surrogates', () => {
  assert.equal(validateIssuePropertyValue(definition('text'), '\u{1f600}'.repeat(2000)), '\u{1f600}'.repeat(2000));
  assert.throws(() => validateIssuePropertyValue(definition('text'), '\u{1f600}'.repeat(2001)), /2000/);
  assert.equal(validateIssuePropertyValue(definition('text'), ' a\0b\ud800 '), ' ab\ufffd ');
});

test('URL length is UTF-8 bytes and canonicalization preserves original URL spelling', () => {
  assert.equal(validateIssuePropertyValue(definition('url'), ' https://EXAMPLE.com/%2f '), 'https://EXAMPLE.com/%2f');
  for (const bad of ['https://', 'https://example.com/a b', 'https://example.com/%zz', 'https://example.com/' + '\u00e9'.repeat(1100)]) {
    assert.throws(() => validateIssuePropertyValue(definition('url'), bad));
  }
});

test('lists enforce input limit before deduplication and reject wrong shapes', () => {
  for (const type of ['multi_text', 'multi_url', 'multi_actor']) {
    const item = type === 'multi_actor' ? ref : type === 'multi_url' ? 'https://example.com' : 'text';
    assert.throws(() => validateIssuePropertyValue(definition(type), Array(21).fill(item)), /20/);
    for (const bad of [[], 'not-array', [false]]) assert.throws(() => validateIssuePropertyValue(definition(type), bad));
  }
  assert.deepEqual(validateIssuePropertyValue(definition('multi_select'), ['b', 'a', 'b']), ['a', 'b']);
  assert.throws(() => validateIssuePropertyValue(definition('multi_select'), ['a', 'unknown']));
});

test('dates reject normalized overflows and respect century leap rules', () => {
  for (const bad of ['2024-13-01', '2024-00-01', '2024-04-31', '1900-02-29', '2024-1-01', '2024-01-01T00:00:00Z']) {
    assert.throws(() => validateIssuePropertyValue(definition('date'), bad));
  }
  assert.equal(validateIssuePropertyValue(definition('date'), '2000-02-29'), '2000-02-29');
});

test('numeric types and booleans reject coercion, nonfinite values, and malformed JSON numbers', async () => {
  for (const bad of [NaN, Infinity, '1', true]) assert.throws(() => validateIssuePropertyValue(definition('number'), bad));
  for (const bad of ['', ' 1 ', '01', '+1', 'NaN', '1e999']) await assert.rejects(encodeIssuePropertyValue(definition('number'), bad));
  for (const bad of ['true', 1]) assert.throws(() => validateIssuePropertyValue(definition('checkbox'), bad));
});

test('actor names use the supplied member directory and canonicalize all official UUID spellings', async () => {
  const calls = [];
  assert.deepEqual(await encodeIssuePropertyValue(definition('multi_actor'), 'Piper, Piper', async (name) => { calls.push(name); return ref; }), [ref]);
  assert.deepEqual(calls, ['Piper', 'Piper']);
  for (const spelling of [id.replaceAll('-', ''), `{${id.toUpperCase()}}`, `urn:uuid:${id}`]) {
    assert.equal(validateIssuePropertyValue(definition('actor'), `member:${spelling}`), ref);
  }
  await assert.rejects(encodeIssuePropertyValue(definition('actor'), 'Piper'), /resolution/);
  assert.throws(() => validateIssuePropertyValue(definition('actor'), `agent:${id}`));
  let resolved = false;
  await assert.rejects(encodeIssuePropertyValue({ ...definition('actor'), archived: true }, 'Piper', () => { resolved = true; return ref; }), /archived/);
  assert.equal(resolved, false);
});

test('list output matches upstream rows, catalog order, optional fields and display fallbacks', () => {
  const catalog = ['select', 'multi_select', 'actor', 'multi_actor', 'checkbox', 'multi_text', 'text', 'multi_url'].map(definition);
  catalog[0].archived = true;
  const bag = { unknown: 'ignored as official list does', select: 'a', multi_select: ['b', 'removed', 7], actor: ref,
    multi_actor: [ref, 'member:missing'], checkbox: false, multi_text: [ref, { foo: true }], text: 'plain', multi_url: [] };
  const rows = buildIssuePropertyRows(catalog, bag, { [ref]: 'Piper' });
  assert.deepEqual(rows.map((row) => row.property_id), catalog.map((property) => property.id));
  assert.deepEqual(rows[0], { property_id: 'select', name: 'select', type: 'select', value: 'a', display: 'One, first', archived: true });
  assert.deepEqual(rows[1].display_values, ['Two', 'removed', '7']);
  assert.equal(rows[2].display, 'Piper');
  assert.deepEqual(rows[3].display_values, ['Piper', 'member:missing']);
  assert.equal(rows[4].display, '\u2717');
  assert.equal(buildIssuePropertyRows([definition('checkbox')], { checkbox: true })[0].display, '\u2713');
  assert.deepEqual(rows[5].display_values, [ref, '{"foo":true}']);
  assert.equal(Object.hasOwn(rows[6], 'archived'), false);
  assert.equal(Object.hasOwn(rows[7], 'display_values'), false);
  assert.equal(rows[7].display, '');
  assert.equal(buildIssuePropertyRows([definition('actor')], { actor: ref })[0].display, ref);
});

test('member display fetching is necessary only for present actor values', () => {
  assert.equal(issuePropertyNeedsMembers([definition('actor')], {}), false);
  assert.equal(issuePropertyNeedsMembers([definition('actor')], { actor: ref }), true);
  assert.equal(issuePropertyNeedsMembers([definition('multi_actor')], { multi_actor: [] }), true);
  assert.equal(issuePropertyNeedsMembers([definition('text')], { text: ref }), false);
});
