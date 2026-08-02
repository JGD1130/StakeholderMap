import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanAirtableChoiceLabel,
  normalizeAirtableChoiceValue,
  normalizeAirtableMultipleChoiceValue,
  airtableMultipleChoiceErrorMatchesValue
} from '../airtableChoiceValues.js';

const ROOM_TYPE_FIELD = {
  type: 'singleSelect',
  options: {
    choices: [
      { name: 'Meeting Room' },
      { name: 'Storage Room - General' },
      { name: 'Director "A" Office' }
    ]
  }
};

test('removes serialized outer quotes from choice labels', () => {
  assert.equal(cleanAirtableChoiceLabel('"Meeting Room"'), 'Meeting Room');
  assert.equal(cleanAirtableChoiceLabel('""Meeting Room""'), 'Meeting Room');
  assert.equal(cleanAirtableChoiceLabel('\u201cMeeting Room\u201d'), 'Meeting Room');
});

test('uses the exact existing Airtable option name', () => {
  assert.equal(
    normalizeAirtableChoiceValue('"meeting room"', ROOM_TYPE_FIELD),
    'Meeting Room'
  );
  assert.equal(
    normalizeAirtableChoiceValue('storage room - general', ROOM_TYPE_FIELD),
    'Storage Room - General'
  );
});

test('preserves quotes that are part of the option name', () => {
  assert.equal(
    normalizeAirtableChoiceValue('Director "A" Office', ROOM_TYPE_FIELD),
    'Director "A" Office'
  );
});

test('normalizes every value for multiple-select fields', () => {
  const multipleField = {
    ...ROOM_TYPE_FIELD,
    type: 'multipleSelects'
  };
  assert.deepEqual(
    normalizeAirtableChoiceValue(['"Meeting Room"', 'storage room - general'], multipleField),
    ['Meeting Room', 'Storage Room - General']
  );
  assert.deepEqual(
    normalizeAirtableChoiceValue('"Meeting Room"', multipleField),
    ['Meeting Room']
  );
});

test('coerces a failed multiple-choice scalar retry into an Airtable array', () => {
  assert.deepEqual(
    normalizeAirtableMultipleChoiceValue('""Meeting Room""'),
    ['Meeting Room']
  );
  assert.deepEqual(normalizeAirtableMultipleChoiceValue(''), []);
});

test('matches a multiple-choice error only to the rejected field value', () => {
  const error = JSON.stringify({
    error: {
      type: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
      message: 'Insufficient permissions to create new select option \\"Meeting Room\\"'
    }
  });
  assert.equal(airtableMultipleChoiceErrorMatchesValue(error, 'Meeting Room'), true);
  assert.equal(airtableMultipleChoiceErrorMatchesValue(error, 'Courthouse'), false);
});
