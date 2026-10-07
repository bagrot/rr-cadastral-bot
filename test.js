const assert = require('assert');
const {
  parseRowRanges,
  parseClipboardTable,
  selectNonResidentialSheetRows,
  cadastralQuarter,
  belongsToBuildingQuarter,
  nspdCacheEntryIsFresh,
  parseRightsFromText,
  parseGisAreaSum,
  recordFromRosreestrApi,
  findCadastralNumbers,
  formatRuDate
} = require('./start');

assert.deepStrictEqual(parseRowRanges('2-4, 4, 7'), [2, 3, 4, 7]);
assert.deepStrictEqual(parseClipboardTable('77:1\t"Нежилое\nпомещение"\n77:2\tЖилое'), [
  ['77:1', 'Нежилое\nпомещение'],
  ['77:2', 'Жилое']
]);
assert.deepStrictEqual(selectNonResidentialSheetRows([
  ['77:06:0012020:1', 'Жилое'],
  ['77:06:0012020:2', 'Нежилое помещение'],
  ['77:06:0012020:3', 'НЕЖИЛОЕ'],
  ['', ''], ['', ''], ['', ''],
  ['77:06:0012020:4', 'Нежилое']
], 2), [
  { row: 3, cadastral: '77:06:0012020:2', typeText: 'Нежилое помещение' },
  { row: 4, cadastral: '77:06:0012020:3', typeText: 'НЕЖИЛОЕ' }
]);
assert.strictEqual(nspdCacheEntryIsFresh({ status: 200, fetchedAt: new Date().toISOString() }), true);
assert.strictEqual(nspdCacheEntryIsFresh({ status: 200, fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }), false);
assert.deepStrictEqual(findCadastralNumbers('A 77:06:0012020:1284 B'), ['77:06:0012020:1284']);
assert.strictEqual(cadastralQuarter('77:06:0012020:1284'), '77:06:0012020');
assert.strictEqual(belongsToBuildingQuarter('77:06:0012020:16927', '77:06:0012020:1284'), true);
assert.strictEqual(belongsToBuildingQuarter('77:02:0018011:8517', '77:06:0012020:1284'), false);
assert.strictEqual(formatRuDate(1327622400000), '27.01.2012');
assert.strictEqual(parseGisAreaSum('2.15.1. Общая площадь жилых помещений\n10369\n2.15.2. Общая площадь нежилых помещений\n963'), '11332');

const rights = parseRightsFromText('Вид, номер и дата государственной регистрации права\nСобственность № 77-77-06/099/2011-797 от 27.01.2012');
assert.strictEqual(rights[0].number, '77-77-06/099/2011-797');

const record = recordFromRosreestrApi(1, '77:06:0012020:16927', {
  cadNumber: '77:06:0012020:16927',
  status: '1',
  area: '748.10',
  levelFloor: '1',
  purpose: '206001000000',
  address: { readableAddress: 'Москва, дом 28, помещение 2/1' },
  rights: [{ ownershipType: '01', rightTypeDesc: 'Собственность', rightRegDate: 1327622400000, rightNumber: '77-77-06/099/2011-797' }]
});
assert.strictEqual(record.purpose, 'Нежилое');
assert.strictEqual(record.area, '748,10');
assert.strictEqual(record.ownershipForm, 'Частная');
assert.strictEqual(record.roomNumber, 'Москва, дом 28, помещение 2/1');
assert.strictEqual(record.rightDate, '27.01.2012');
assert.strictEqual(record.status, 'Актуально с собственностью');

const publicOwnershipRecord = recordFromRosreestrApi(2, '77:06:0012020:16928', {
  status: '1',
  rights: [
    { ownershipType: '02', rightTypeDesc: 'Собственность' },
    { ownershipType: '04', rightTypeDesc: 'Собственность' },
    { ownershipType: '02', rightTypeDesc: 'Собственность' }
  ]
});
assert.strictEqual(publicOwnershipRecord.ownershipForm, 'Государственная федеральная\nМуниципальная');

console.log('Все тесты пройдены.');
