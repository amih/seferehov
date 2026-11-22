import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nliCredit, nliRecordUrl } from '../src/books.js';

test('nliCredit: only books whose details came from the National Library', () => {
  assert.equal(nliCredit({ source: 'openlibrary', details_source: 'openlibrary' }), null);
  assert.equal(nliCredit({ source: 'llm', details_source: null }), null);
  assert.deepEqual(nliCredit({ source: 'nli', source_ids: { nli: '990017713500205171' } }), { record: '990017713500205171' });
  assert.deepEqual(nliCredit({ source: 'openlibrary', details_source: 'nli, openlibrary', source_ids: {} }), { record: null });
  assert.equal(nliCredit({ source: 'openlibrary', details_source: 'online' }), null);
});

test('nliRecordUrl: catalogue record page in the reader language', () => {
  assert.equal(nliRecordUrl('990017713500205171', 'en'), 'https://www.nli.org.il/en/books/NNL_ALEPH990017713500205171/NLI');
  assert.equal(nliRecordUrl('990017713500205171', 'he'), 'https://www.nli.org.il/he/books/NNL_ALEPH990017713500205171/NLI');
});
