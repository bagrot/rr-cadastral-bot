const path = require('path');
const os = require('os');
const fs = require('fs');
const config = require('./config');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (firstError) {
    try {
      return require('playwright-core');
    } catch {}

    const fallback = path.join(os.homedir(), 'Desktop', 'бот для площадей', 'node_modules', 'playwright');
    try {
      return require(fallback);
    } catch {
      throw firstError;
    }
  }
}

const { chromium } = loadPlaywright();

const CAD_RE = /(?<![\d:])\d{2}:\d{2}:\d{6,8}:\d+(?![\d:])/g;
const ABSENT = 'Отсутствует';
const NO_INFO = 'Отсутствует информация';
const NOT_CHECKED_RESIDENTIAL = 'Не проверялось (жилое)';
let resetNspdScrollOnNextObject = true;
let lastRosreestrApiRequestAt = 0;
let rosreestrApiDynamicIntervalMs = Math.max(1000, Number(config.rosreestrApiMinIntervalMs) || 1350);
let consecutiveRosreestrFailures = 0;
let attachedBrowser = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rnd(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function humanPause(label = '') {
  const ms = rnd(config.rosreestrHumanPauseMinMs, config.rosreestrHumanPauseMaxMs);
  if (label) console.log(`  Пауза ${Math.round(ms / 100) / 10} сек: ${label}`);
  await sleep(ms);
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function oneLine(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function safe(value) {
  const text = normalizeText(value);
  return text || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findCadastralNumbers(text) {
  return Array.from(new Set(String(text || '').match(CAD_RE) || []));
}

function cadastralQuarter(cadastral) {
  const parts = oneLine(cadastral).split(':');
  return parts.length === 4 ? parts.slice(0, 3).join(':') : '';
}

function belongsToBuildingQuarter(cadastral, buildingCad) {
  const objectQuarter = cadastralQuarter(cadastral);
  const buildingQuarter = cadastralQuarter(buildingCad);
  return Boolean(objectQuarter && buildingQuarter && objectQuarter === buildingQuarter);
}

function maybeArea(value) {
  const area = oneLine(value).replace(/\s*кв\.?\s*м\.?/i, '').trim();
  return /^\d+(?:\.\d+)?$/.test(area) ? area.replace('.', ',') : area;
}

function commonPropertyValue(raw, fieldExists = true) {
  if (!fieldExists) return NO_INFO;
  const value = oneLine(raw).toLowerCase();
  if (!value) return NO_INFO;
  if (['да', 'true', '1', 'yes'].includes(value)) return 'да';
  if (['нет', 'false', '0', 'no'].includes(value)) return 'нет';
  return value;
}

function parseLocalizedNumber(value) {
  const match = oneLine(value).replace(/\s/g, '').match(/-?\d+(?:[,.]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : NaN;
}

function formatLocalizedNumber(value) {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 10000) / 10000).replace('.', ',');
}

function buildStatus(statusRaw, hasRights) {
  const status = oneLine(statusRaw).toLowerCase();
  if (status.includes('погаш')) return 'Погашено';
  if (status.includes('актуаль')) {
    return hasRights ? 'Актуально с собственностью' : 'Актуально без собственности';
  }
  return oneLine(statusRaw) || (hasRights ? 'Актуально с собственностью' : 'Актуально без собственности');
}

function splitLinesForCell(values) {
  const lines = values.map(oneLine).filter(Boolean);
  return lines.length ? lines.join('\n') : '';
}

function parseRowRanges(value) {
  const rows = [];
  const seen = new Set();
  for (const part of String(value || '').split(',')) {
    const text = oneLine(part);
    if (!text) continue;
    const range = text.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = text.match(/^\d+$/);
    let from;
    let to;
    if (range) {
      from = Number(range[1]);
      to = Number(range[2]);
    } else if (single) {
      from = Number(text);
      to = from;
    } else {
      throw new Error(`Неверный диапазон строк: "${text}". Пример: 2-122, 123-127`);
    }
    if (from > to) [from, to] = [to, from];
    from = Math.max(2, from);
    to = Math.max(2, to);
    for (let row = from; row <= to; row++) {
      if (!seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => a - b);
  return rows;
}

function parseRightsFromText(text) {
  const full = normalizeText(text);
  const rights = [];
  const variants = [
    'Общая долевая собственность',
    'Общая совместная собственность',
    'Собственность'
  ];
  const typePart = variants.join('|');
  const rx = new RegExp(`(${typePart})\\s*(?:N|№)\\s*([^\\n]+?)\\s+от\\s+(\\d{2}\\.\\d{2}\\.\\d{4})`, 'giu');

  for (const match of full.matchAll(rx)) {
    rights.push({
      type: oneLine(match[1]),
      number: oneLine(match[2]).replace(/^[N№]\s*/i, ''),
      date: oneLine(match[3])
    });
  }

  if (rights.length) return rights;

  const label = 'Вид, номер и дата государственной регистрации права';
  const idx = full.indexOf(label);
  const chunk = idx >= 0 ? full.slice(idx + label.length, idx + label.length + 1800) : full;
  const compact = chunk.replace(/\n+/g, ' ');
  const loose = new RegExp(`(${typePart})\\s*(?:N|№)?\\s*([^\\n]*?)\\s+от\\s+(\\d{2}\\.\\d{2}\\.\\d{4})`, 'iu');
  const looseMatch = compact.match(loose);
  if (looseMatch) {
    rights.push({
      type: oneLine(looseMatch[1]),
      number: oneLine(looseMatch[2]).replace(/^[N№]\s*/i, ''),
      date: oneLine(looseMatch[3])
    });
  }

  return rights;
}

async function getContext() {
  const retries = Math.max(1, Number(config.cdpConnectRetries) || 3);
  const attemptTimeout = Math.max(5000, Number(config.cdpAttemptTimeoutMs) || 30000);
  for (let attempt = 1; attempt <= retries; attempt++) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: attemptTimeout });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Chrome не вернул рабочий контекст вкладок.');
      attachedBrowser = browser;
      return { browser, context };
    } catch (error) {
      if (browser) await browser.close().catch(() => {});
      if (attempt >= retries) throw error;
      console.log(`  Chrome 9222 не ответил полностью, переподключение ${attempt + 1}/${retries}...`);
      await sleep(1200 * attempt);
    }
  }
  throw new Error('Не удалось подключиться к Chrome 9222.');
}

async function findOrOpenPage(context, predicate, url, label) {
  const existing = context.pages().find(predicate);
  if (existing) return existing;
  console.log(`Открываю вкладку: ${label}`);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
  return page;
}

async function preparePages(context, options = {}) {
  const sheets = await findOrOpenPage(
    context,
    (p) => p.url().includes('docs.google.com/spreadsheets'),
    config.sheetsUrl,
    'Google Sheets'
  );
  const nspd = options.needNspd === false ? null : await findOrOpenPage(
    context,
    (p) => p.url().includes('nspd.gov.ru/map'),
    config.nspdUrl,
    'НСПД'
  );
  const rosreestr = options.needRosreestr === false ? null : await findOrOpenPage(
    context,
    (p) => p.url().includes('lk.rosreestr.ru/eservices/real-estate-objects-online'),
    config.rosreestrUrl,
    'Росреестр'
  );
  const gis = options.needGis === false ? null : await findOrOpenPage(
    context,
    (p) => p.url().includes('dom.gosuslugi.ru'),
    config.gisUrl,
    'ГИС ЖКХ'
  );

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://docs.google.com' });
  } catch {}
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://nspd.gov.ru' });
  } catch {}

  return { sheets, nspd, rosreestr, gis };
}

async function gotoCell(sheetsPage, a1) {
  await sheetsPage.bringToFront();
  await sheetsPage.mouse.click(200, 200).catch(() => {});
  await sleep(80);
  await sheetsPage.keyboard.press('Control+J');
  await sleep(130);
  await sheetsPage.keyboard.press('Control+A');
  await sleep(40);
  await sheetsPage.keyboard.type(a1);
  await sleep(40);
  await sheetsPage.keyboard.press('Enter');
  await sleep(220);
  await sheetsPage.keyboard.press('Escape').catch(() => {});
  await sleep(80);
}

async function readClipboardTextFromPage(page) {
  return page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '__CLIPBOARD_DENIED__';
    }
  });
}

async function readActiveCell(sheetsPage) {
  for (let i = 0; i < config.sheetReadRetries; i++) {
    await sheetsPage.keyboard.press('Escape').catch(() => {});
    await sleep(30);
    await sheetsPage.keyboard.press('Control+C');
    await sleep(config.sheetReadDelayMs + i * 80);
    const text = await readClipboardTextFromPage(sheetsPage);
    if (text && text !== '__CLIPBOARD_DENIED__') return normalizeText(text);
    if (text === '__CLIPBOARD_DENIED__') {
      throw new Error('Chrome запретил чтение буфера обмена для Google Sheets.');
    }
  }
  return '';
}

async function readCell(sheetsPage, a1) {
  await gotoCell(sheetsPage, a1);
  return readActiveCell(sheetsPage);
}

function parseClipboardTable(text) {
  const rows = [[]];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === '\t' && !quoted) {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (ch === '\n' && !quoted) {
      rows[rows.length - 1].push(cell);
      rows.push([]);
      cell = '';
    } else {
      cell += ch;
    }
  }
  rows[rows.length - 1].push(cell);
  while (rows.length > 1 && rows[rows.length - 1].every((value) => value === '')) rows.pop();
  return rows;
}

async function readRange(sheetsPage, a1) {
  return parseClipboardTable(await readCell(sheetsPage, a1));
}

async function readRequiredCellWithWait(sheetsPage, a1, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let value = '';
  while (Date.now() < deadline) {
    value = oneLine(await readCell(sheetsPage, a1).catch(() => ''));
    if (value) return value;
    console.log(`  Google Sheets ещё загружается: жду ячейку ${a1}...`);
    await sleep(1000);
  }
  return value;
}

function tableClipboardPayload(rows) {
  const htmlRows = rows.map((row) => {
    const color = row.backgroundColor || (row.commonProperty ? config.commonPropertyColor : '');
    const bg = color ? `background-color:${color};` : '';
    const cells = row.cells.map((cell) => {
      const html = escapeHtml(cell).replace(/\n/g, '<br>');
      return `<td style="mso-number-format:'\\@';white-space:normal;${bg}">${html}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  const html = `<!doctype html><html><body><table>${htmlRows.join('')}</table></body></html>`;
  const text = rows
    .map((row) => row.cells.map((cell) => String(cell ?? '').replace(/\t/g, ' ')).join('\t'))
    .join('\n');
  return { html, text };
}

async function writeClipboard(page, payload) {
  await page.evaluate(async ({ html, text }) => {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
  }, payload);
}

async function pasteRows(sheetsPage, a1, rows) {
  await gotoCell(sheetsPage, a1);
  await writeClipboard(sheetsPage, tableClipboardPayload(rows));
  await sleep(80);
  await sheetsPage.keyboard.press('Control+V');
  await sleep(config.sheetPasteWaitMs);
}

async function writeBuildingArea(sheetsPage, area) {
  if (!area) return;
  console.log(`Пишу площадь МКД в O2: ${area}`);
  await pasteRows(sheetsPage, 'O2', [{ cells: [area], commonProperty: false }]);
}

async function writeBuildingYear(sheetsPage, year) {
  if (!year) return;
  console.log(`Пишу год постройки в M2: ${year}`);
  await pasteRows(sheetsPage, 'M2', [{ cells: [year], commonProperty: false }]);
}

async function writeRosreestrBuildingArea(sheetsPage, area) {
  if (!area) return;
  console.log(`Пишу площадь МКД из Росреестра в P2: ${area}`);
  await pasteRows(sheetsPage, 'P2', [{ cells: [area], commonProperty: false }]);
}

async function writeGisArea(sheetsPage, area) {
  if (!area) return;
  console.log(`Пишу площадь из ГИС ЖКХ в Q2: ${area}`);
  await pasteRows(sheetsPage, 'Q2', [{ cells: [area], commonProperty: false }]);
}

function sheetCellsForRecord(record) {
  return [
    record.seq,
    record.cadastral,
    record.purpose,
    record.floor,
    record.area,
    record.ownershipForm,
    record.commonPropertyText || NO_INFO,
    record.roomNumber,
    record.rightType,
    record.rightDate,
    record.rightNumber,
    record.status
  ];
}

function isNonResidentialRecord(record) {
  return /нежил/i.test(oneLine(record.purpose));
}

function rowBackgroundColor(record) {
  if (record.commonProperty) return config.commonPropertyColor;
  if (isNonResidentialRecord(record) && /без собственности/i.test(oneLine(record.status))) {
    return config.nonResidentialNoOwnershipColor;
  }
  return '';
}

async function writeRecordRow(sheetsPage, rowNumber, record) {
  await pasteRows(sheetsPage, `A${rowNumber}`, [{
    cells: sheetCellsForRecord(record),
    commonProperty: Boolean(record.commonProperty),
    backgroundColor: rowBackgroundColor(record)
  }]);
}

async function getBodyText(page) {
  return page.evaluate(() => {
    const parts = [];
    const visit = (root) => {
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
        node = walker.nextNode();
      }
      const elements = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
      for (const el of elements) {
        if (el.shadowRoot) {
          visit(el.shadowRoot);
        }
      }
    };
    visit(document);
    return parts.join('\n');
  });
}

function getValueAfterLabelFromText(text, labels) {
  const lines = normalizeText(text).split('\n').map((x) => oneLine(x)).filter(Boolean);
  for (const label of labels) {
    const wanted = oneLine(label).toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      if (low === wanted && lines[i + 1]) return lines[i + 1];
      if (low.startsWith(`${wanted} `)) {
        const rest = line.slice(label.length).trim();
        if (/\d/.test(rest)) return rest;
      }
    }
  }
  return '';
}

async function getVisibleField(page, labels) {
  const text = await getBodyText(page);
  return getValueAfterLabelFromText(text, labels);
}

async function clickFirstVisibleText(page, texts, timeout = 5000) {
  for (const text of texts) {
    const loc = page.getByText(text, { exact: true }).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ force: true, timeout }).catch(() => {});
      await sleep(config.afterClickWaitMs);
      return true;
    }
  }
  return false;
}

async function firstVisibleLocator(page, selector, timeout = config.pageReadyTimeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      const box = await item.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return item;
    }
    await sleep(250);
  }
  throw new Error(`Не найден видимый элемент: ${selector}`);
}

async function searchBuildingOnNspd(nspdPage, buildingCad) {
  await nspdPage.bringToFront();
  await nspdPage.goto(config.nspdUrl, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });

  console.log(`Ищу МКД на НСПД: ${buildingCad}`);
  const input = await firstVisibleLocator(nspdPage, 'm-sidebar m-search-field input, m-search-field input');
  await input.click({ force: true });
  await input.fill(buildingCad, { force: true });
  await sleep(250);

  const submit = await firstVisibleLocator(nspdPage, 'm-sidebar m-search-field button[type="submit"], m-search-field button[type="submit"]', 5000)
    .catch(() => null);
  if (submit) {
    await submit.click({ force: true }).catch(async () => {
      await input.press('Enter').catch(() => nspdPage.keyboard.press('Enter'));
    });
  } else {
    await input.press('Enter').catch(() => nspdPage.keyboard.press('Enter'));
  }

  await nspdPage.getByText(buildingCad).first().waitFor({ timeout: config.nspdSearchWaitMs });
  const result = nspdPage.getByText(new RegExp(`(?:Здание|ОКС|Объект).*${buildingCad.replace(/:/g, '\\:')}`)).first();
  if (await result.count().catch(() => 0)) {
    await result.click({ force: true });
  } else {
    await nspdPage.getByText(buildingCad).first().click({ force: true });
  }
  await sleep(1400);
  await nspdPage.getByText(buildingCad).first().waitFor({ timeout: config.nspdCardWaitMs }).catch(() => {});
}

async function parseBuildingArea(nspdPage) {
  const area = await getVisibleField(nspdPage, ['Площадь общая', 'Площадь']);
  return maybeArea(area);
}

async function parseBuildingYear(nspdPage) {
  const raw = await getVisibleField(nspdPage, ['Завершение строительства', 'Год постройки', 'Год ввода в эксплуатацию']);
  const match = oneLine(raw).match(/\b(18|19|20)\d{2}\b/);
  return match ? match[0] : oneLine(raw);
}

async function openNspdObjectsTab(nspdPage) {
  await clickFirstVisibleText(nspdPage, ['Объекты']);
  await sleep(300);
}

async function expandNspdObjectGroups(nspdPage) {
  const names = ['Помещения (список)', 'Машино-места (список)', 'Машино места (список)'];
  for (const name of names) {
    const loc = nspdPage.getByText(name, { exact: true }).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ force: true }).catch(() => {});
      await sleep(500);
    }
  }
}

async function collectVisibleCadastralsFromNspd(nspdPage, buildingCad) {
  const text = await getBodyText(nspdPage);
  return findCadastralNumbers(text).filter((cad) => cad !== buildingCad);
}

async function findBestLeftScroller(page) {
  return page.evaluateHandle(() => {
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.left < window.innerWidth * 0.45 &&
        r.width > 120 &&
        r.height > 160 &&
        el.scrollHeight > el.clientHeight + 80 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none';
    });
    candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || document.scrollingElement || document.body;
  });
}

async function collectNspdObjectCadastrals(nspdPage, buildingCad) {
  await openNspdObjectsTab(nspdPage);
  await expandNspdObjectGroups(nspdPage);

  const scroller = await findBestLeftScroller(nspdPage);
  const found = new Set();
  let stablePasses = 0;
  let lastSize = 0;

  console.log('Собираю список помещений и машино-мест на НСПД...');
  for (let pass = 0; pass < config.nspdMaxScrollPasses; pass++) {
    for (const cad of await collectVisibleCadastralsFromNspd(nspdPage, buildingCad)) {
      found.add(cad);
    }

    await expandNspdObjectGroups(nspdPage);

    const atBottom = await scroller.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollTop + Math.max(240, el.clientHeight * 0.75);
      return Math.abs(el.scrollTop - before) < 2 || el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    }).catch(() => true);

    if (found.size === lastSize) stablePasses += 1;
    else stablePasses = 0;
    lastSize = found.size;

    if (pass % 10 === 0) console.log(`  Найдено кадастровых: ${found.size}`);
    if (atBottom && stablePasses >= 4) break;
    if (found.size >= config.maxObjectsPerRun) break;
    await sleep(config.nspdScrollPauseMs);
  }

  const result = Array.from(found);
  console.log(`Всего собрано с НСПД: ${result.length}`);
  return result;
}

async function scrollNspdObjectIntoView(nspdPage, cadastral) {
  const scroller = await findBestLeftScroller(nspdPage);
  if (resetNspdScrollOnNextObject) {
    await scroller.evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await sleep(150);
    resetNspdScrollOnNextObject = false;
  }

  for (let pass = 0; pass < config.nspdMaxScrollPasses; pass++) {
    const loc = nspdPage.locator(`button:has-text("${cadastral}")`).first();
    if (await loc.count().catch(() => 0)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return loc;
    }
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollTop + Math.max(240, el.clientHeight * 0.75);
    }).catch(() => {});
    await sleep(config.nspdScrollPauseMs);
  }
  return null;
}

async function waitForNspdObjectCard(cardPage, cadastral) {
  const started = Date.now();
  while (Date.now() - started < config.nspdCardWaitMs) {
    const body = await getBodyText(cardPage).catch(() => '');
    if (body.includes(cadastral) && /Помещение|Машино-место|Машино место/i.test(body)) return true;
    await sleep(250);
  }
  return false;
}

async function openNspdObjectCard(context, nspdPage, cadastral) {
  await openNspdObjectsTab(nspdPage);
  let loc = await scrollNspdObjectIntoView(nspdPage, cadastral);
  if (!loc) return { page: null, opened: false, reason: 'NOT_VISIBLE_IN_LIST' };

  for (let attempt = 1; attempt <= config.nspdObjectOpenRetries; attempt++) {
    const newPagePromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
    await loc.click({ force: true }).catch(() => {});
    const newPage = await newPagePromise;
    await sleep(500);

    const cardPage = newPage || nspdPage;
    await cardPage.bringToFront().catch(() => {});
    await cardPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});

    if (await waitForNspdObjectCard(cardPage, cadastral)) {
      return { page: cardPage, opened: true, samePage: cardPage === nspdPage };
    }

    if (newPage) await newPage.close().catch(() => {});
    await nspdPage.bringToFront().catch(() => {});
    if (attempt < config.nspdObjectOpenRetries) {
      resetNspdScrollOnNextObject = true;
      loc = await scrollNspdObjectIntoView(nspdPage, cadastral);
      if (!loc) return { page: null, opened: false, reason: 'NOT_VISIBLE_IN_LIST_AFTER_RETRY' };
      await sleep(500);
    }
  }

  resetNspdScrollOnNextObject = true;
  return { page: null, opened: false, reason: 'CARD_NOT_OPENED' };
}

async function closeNspdObjectCard(nspdPage, cardInfo) {
  if (!cardInfo?.page) return;
  if (!cardInfo.samePage) {
    await cardInfo.page.close().catch(() => {});
    await nspdPage.bringToFront().catch(() => {});
    return;
  }
  await clickFirstVisibleText(cardInfo.page, ['Закрыть карточку', 'Назад к найденные объекты', 'Назад в найденные объекты'], 2000)
    .catch(() => {});
  await nspdPage.bringToFront().catch(() => {});
}

async function parseNspdObjectCard(cardPage, cadastral) {
  const body = await getBodyText(cardPage);
  const kind = getValueAfterLabelFromText(body, ['Вид объекта недвижимости']) ||
    (body.includes('Машино-место') ? 'Машино-место' : 'Помещение');
  const address = getValueAfterLabelFromText(body, ['Адрес', 'Адрес (местоположение)']);
  const purpose = getValueAfterLabelFromText(body, [
    'Назначение помещения',
    'Назначение',
    'Вид жилого помещения',
    'Вид объекта недвижимости'
  ]);
  const floor = getValueAfterLabelFromText(body, ['Номер/тип этажа', 'Этаж', 'Номер этажа']);
  const area = maybeArea(getValueAfterLabelFromText(body, ['Площадь общая', 'Площадь, кв.м', 'Площадь']));
  const ownershipForm = getValueAfterLabelFromText(body, ['Форма собственности']);
  const commonRaw = getValueAfterLabelFromText(body, [
    'Общее имущество собственников помещений в многоквартирном доме',
    'Общее имущество собственников помещений'
  ]);
  const hasCommonField = body.includes('Общее имущество собственников помещений в многоквартирном доме') ||
    body.includes('Общее имущество собственников помещений');
  const commonText = commonPropertyValue(commonRaw, hasCommonField);

  return {
    cadastral,
    purpose: purpose || kind,
    floor,
    area,
    ownershipForm,
    roomNumber: oneLine(address),
    commonPropertyText: commonText,
    commonProperty: commonText === 'да',
    foundOnNspd: true
  };
}

function emptyRecord(seq, cadastral) {
  return {
    seq,
    cadastral,
    purpose: '',
    floor: '',
    area: '',
    ownershipForm: '',
    commonPropertyText: NO_INFO,
    roomNumber: '',
    rightType: '',
    rightDate: '',
    rightNumber: '',
    status: '',
    commonProperty: false,
    foundOnNspd: false
  };
}

async function ensureRosreestrSearchPage(rosPage) {
  await rosPage.bringToFront();
  if (!rosPage.url().includes('real-estate-objects-online')) {
    await rosPage.goto(config.rosreestrUrl, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
  }
  const back = rosPage.getByText(/ВЕРНУТЬСЯ К РЕЗУЛЬТАТАМ ПОИСКА/i).first();
  if (await back.count().catch(() => 0)) {
    await back.click({ force: true }).catch(() => {});
    await sleep(700);
  }
}

async function getRosreestrInput(rosPage) {
  return firstVisibleLocator(
    rosPage,
    'input[placeholder="Введите адрес или кадастровый номер объекта"]',
    config.pageReadyTimeoutMs
  );
}

async function waitRosreestrOutcome(rosPage, cadastral) {
  const started = Date.now();
  let sawZero = false;
  await sleep(900);
  while (Date.now() - started < config.rosreestrOutcomeWaitMs) {
    const exactLink = rosPage.locator(`a:has-text("${cadastral}")`).first();
    if (await exactLink.count().catch(() => 0)) return 'FOUND';
    const body = await getBodyText(rosPage).catch(() => '');
    if (body.includes(cadastral) && /Найдено результатов:\s*[1-9]/i.test(body)) return 'FOUND';
    if (/Найдено результатов:\s*0/i.test(body)) {
      if (!sawZero) {
        sawZero = true;
        await sleep(2200);
      } else {
        return 'NOT_FOUND';
      }
    }
    if (/Подождите|загрузка|идет загрузка/i.test(body)) {
      await sleep(500);
    } else {
      await sleep(350);
    }
  }
  return 'UNKNOWN';
}

async function waitForRosreestrCardOpened(rosPage) {
  const back = rosPage.getByText(/ВЕРНУТЬСЯ К РЕЗУЛЬТАТАМ ПОИСКА/i).first();
  const status = rosPage.getByText('Статус объекта', { exact: true }).first();
  const started = Date.now();
  while (Date.now() - started < config.rosreestrCardWaitMs) {
    if (await back.count().catch(() => 0)) return true;
    if (await status.count().catch(() => 0)) return true;
    await sleep(200);
  }
  return false;
}

async function openRosreestrCardFromResults(rosPage, cadastral) {
  const link = rosPage.locator(`a:has-text("${cadastral}")`).first();
  const fallback = rosPage.locator('table a').first();

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await link.count().catch(() => 0)) {
      await link.click({ force: true }).catch(() => {});
    } else if (await fallback.count().catch(() => 0)) {
      await fallback.click({ force: true }).catch(() => {});
    } else {
      return false;
    }

    await sleep(300);
    if (await waitForRosreestrCardOpened(rosPage)) {
      await sleep(350);
      return true;
    }
  }
  return false;
}

async function searchRosreestrAndOpenCard(rosPage, cadastral) {
  for (let attempt = 1; attempt <= config.rosreestrNotFoundRetryCount; attempt++) {
    await ensureRosreestrSearchPage(rosPage);
    const input = await getRosreestrInput(rosPage);
    await input.fill('', { force: true });
    await sleep(100);
    await input.fill(cadastral.replace(/\s+/g, ''), { force: true });
    await sleep(250);

    const btn = rosPage.getByRole('button', { name: /Найти/i }).first();
    await btn.click({ force: true }).catch(async () => {
      await rosPage.keyboard.press('Enter');
    });

    const outcome = await waitRosreestrOutcome(rosPage, cadastral);
    if (outcome === 'FOUND') {
      const opened = await openRosreestrCardFromResults(rosPage, cadastral);
      if (opened) return true;
    }

    console.log(`  Росреестр: попытка ${attempt} не дала карточку (${outcome}).`);
    await sleep(config.rosreestrBetweenRetriesMs);
  }
  return false;
}

async function parseRosreestrCard(rosPage, cadastral) {
  const body = await getBodyText(rosPage);
  const statusRaw = getValueAfterLabelFromText(body, ['Статус объекта']);
  const rights = parseRightsFromText(body);
  const hasRights = rights.length > 0;
  const objectKind = getValueAfterLabelFromText(body, ['Вид объекта недвижимости']);
  const address = getValueAfterLabelFromText(body, ['Адрес (местоположение)', 'Адрес']);

  return {
    cadastral,
    purpose: getValueAfterLabelFromText(body, ['Назначение помещения', 'Назначение', 'Вид жилого помещения']) || objectKind,
    floor: getValueAfterLabelFromText(body, ['Этаж', 'Номер/тип этажа', 'Номер этажа']),
    area: maybeArea(getValueAfterLabelFromText(body, ['Площадь, кв.м', 'Площадь'])),
    ownershipForm: getValueAfterLabelFromText(body, ['Форма собственности']),
    roomNumber: oneLine(address),
    rightType: splitLinesForCell(rights.map((x) => x.type)),
    rightDate: splitLinesForCell(rights.map((x) => x.date)),
    rightNumber: splitLinesForCell(rights.map((x) => x.number)),
    status: buildStatus(statusRaw, hasRights)
  };
}

function mergeRecordWithRosreestr(base, ros) {
  const baseArea = oneLine(base.area);
  const shouldReplaceArea = !baseArea || /^общая$/i.test(baseArea);
  return {
    ...base,
    purpose: base.purpose || ros.purpose || '',
    floor: base.floor || ros.floor || '',
    area: shouldReplaceArea ? (ros.area || base.area || '') : base.area,
    ownershipForm: base.ownershipForm || ros.ownershipForm || '',
    roomNumber: base.roomNumber || ros.roomNumber || '',
    rightType: ros.rightType || base.rightType || '',
    rightDate: ros.rightDate || base.rightDate || '',
    rightNumber: ros.rightNumber || base.rightNumber || '',
    status: ros.status || base.status || ''
  };
}

function formatRuDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()]
    .map((part, index) => index < 2 ? String(part).padStart(2, '0') : String(part))
    .join('.');
}

function purposeFromRosreestrCode(element) {
  const direct = safe(element?.purposeDesc || element?.purposeName || '');
  if (direct) return direct;
  const code = String(element?.purpose || '');
  if (code === '206001000000') return 'Нежилое';
  if (code === '206002000000') return 'Жилое\nквартира';
  return '';
}

const ROSREESTR_OWNERSHIP_FORMS = Object.freeze({
  '01': 'Частная',
  '02': 'Государственная федеральная',
  '03': 'Государственная субъекта РФ',
  '04': 'Муниципальная',
  '05': 'Иная публичная'
});

function ownershipFormFromRosreestr(element, rights = []) {
  const direct = safe(element?.ownershipTypeDesc || '');
  if (direct) return direct;

  // В ответе /account-back/on форма собственности находится не у объекта,
  // а внутри каждой записи rights[].ownershipType. Используем тот же справочник,
  // которым Росреестр подписывает эти коды в своей карточке объекта.
  const codes = [element?.ownershipType, ...rights.map((right) => right?.ownershipType)]
    .map(oneLine)
    .filter(Boolean);
  const labels = [...new Set(codes)].map((code) => ROSREESTR_OWNERSHIP_FORMS[code] || `Код ${code}`);
  return splitLinesForCell(labels);
}

function recordFromRosreestrApi(seq, cadastral, element) {
  const rights = Array.isArray(element?.rights) ? element.rights : [];
  const address = element?.address?.readableAddress || '';
  const objectKind = /кв\b|квартира/i.test(address) ? 'Помещение' : '';
  const hasRights = rights.length > 0;
  const cancelled = Boolean(element?.cancelDate) || ['0', '2', '3'].includes(String(element?.status ?? ''));
  return {
    ...emptyRecord(seq, cadastral),
    purpose: purposeFromRosreestrCode(element),
    floor: safe(element?.floor || element?.levelFloor || element?.undergroundFloor || ''),
    area: maybeArea(element?.area || element?.mainCharacters?.find?.((x) => x?.code === '05')?.value || ''),
    ownershipForm: ownershipFormFromRosreestr(element, rights),
    roomNumber: oneLine(address),
    commonPropertyText: NOT_CHECKED_RESIDENTIAL,
    rightType: splitLinesForCell(rights.map((x) => x.rightTypeDesc || x.rightType)),
    rightDate: splitLinesForCell(rights.map((x) => formatRuDate(x.rightRegDate))),
    rightNumber: splitLinesForCell(rights.map((x) => x.rightNumber)),
    status: cancelled ? 'Погашено' : (hasRights ? 'Актуально с собственностью' : 'Актуально без собственности'),
    rosreestrFound: true
  };
}

async function waitForRosreestrApiSlot() {
  const minInterval = rosreestrApiInterval();
  const remaining = lastRosreestrApiRequestAt + minInterval - Date.now();
  if (remaining > 0) await sleep(remaining);
  lastRosreestrApiRequestAt = Date.now();
}

function rosreestrApiIntervalFloor() {
  return Math.max(1000, Number(config.rosreestrApiMinIntervalMs) || 1350);
}

function rosreestrApiInterval() {
  return Math.max(rosreestrApiIntervalFloor(), rosreestrApiDynamicIntervalMs);
}

async function fetchRosreestrObjectApi(rosPage, cadastral) {
  if (!rosPage || !/^https:\/\/lk\.rosreestr\.ru\//i.test(rosPage.url())) {
    return { outcome: 'AUTH_REQUIRED', status: 401, attempt: 0, detail: 'Открыта страница входа ЕСИА вместо личного кабинета Росреестра' };
  }
  const retries = Math.max(1, Number(config.rosreestrApiRetryCount) || 6);
  for (let attempt = 1; attempt <= retries; attempt++) {
    await waitForRosreestrApiSlot();
    let result;
    try {
      result = await rosPage.evaluate(async (cad) => {
        const response = await fetch('/account-back/on', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({ filterType: 'cadastral', cadNumbers: [cad] })
        });
        return { status: response.status, text: await response.text() };
      }, cadastral);
    } catch (error) {
      result = { status: 0, text: '', transportError: error.message || String(error) };
    }

    if (result.status === 200) {
      let payload;
      try {
        payload = JSON.parse(result.text);
      } catch {
        payload = null;
      }
      if (!payload) {
        result.status = 502;
      } else {
        rosreestrApiDynamicIntervalMs = Math.max(rosreestrApiIntervalFloor(), rosreestrApiDynamicIntervalMs - 100);
        const elements = Array.isArray(payload.elements) ? payload.elements : [];
        const exact = elements.find((item) => oneLine(item?.cadNumber) === cadastral);
        if (exact) return { outcome: 'FOUND', element: exact, attempt };
        if (elements.length === 0 && Number(payload.count || 0) === 0) {
          return { outcome: 'NOT_FOUND', attempt };
        }
        return { outcome: 'MISMATCH', attempt, received: elements.map((x) => x?.cadNumber).filter(Boolean) };
      }
    }

    if ([401, 403].includes(result.status)) {
      return { outcome: 'AUTH_REQUIRED', status: result.status, attempt };
    }
    if (attempt < retries && (result.status === 0 || result.status === 429 || result.status >= 500)) {
      rosreestrApiDynamicIntervalMs = Math.min(10000, Math.ceil(Math.max(rosreestrApiDynamicIntervalMs, rosreestrApiIntervalFloor()) * 1.45));
      const base = Number(config.rosreestrApiBackoffMs) || 1800;
      const delay = Math.min(20000, base * attempt + rnd(300, 900));
      console.log(`  Росреестр API: временная ошибка ${result.status || 'сети'}, повтор ${attempt + 1}/${retries} через ${Math.round(delay / 100) / 10} сек.`);
      await sleep(delay);
      continue;
    }
    return { outcome: 'ERROR', status: result.status, attempt, detail: result.transportError || oneLine(result.text).slice(0, 160) };
  }
  return { outcome: 'ERROR', status: 0, attempt: retries };
}

async function reloadRosreestrAfterMassFailure(rosPage) {
  console.log(`\nРосреестр: ${consecutiveRosreestrFailures} технических отказа подряд — перезагружаю страницу.`);
  try {
    await rosPage.reload({ waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
  } catch (error) {
    console.log(`  Росреестр: страница не перезагрузилась (${error.message || error}).`);
  }
  await sleep(Math.max(2000, Number(config.rosreestrReloadWaitMs) || 5000));
  const url = rosPage.url();
  if (!/^https:\/\/lk\.rosreestr\.ru\//i.test(url)) {
    console.log(`  Росреестр: после перезагрузки выполнен выход из аккаунта (${url}). Войдите через ЕСИА и повторите запуск.`);
    return false;
  }
  console.log('  Росреестр: страница перезагружена, проверяю авторизацию повторным запросом.');
  rosreestrApiDynamicIntervalMs = Math.max(rosreestrApiIntervalFloor(), Number(config.rosreestrAfterReloadIntervalMs) || 3500);
  return true;
}

async function fetchRosreestrObjectApiWithRecovery(rosPage, cadastral) {
  let result = await fetchRosreestrObjectApi(rosPage, cadastral);
  if (result.outcome === 'FOUND' || result.outcome === 'NOT_FOUND') {
    consecutiveRosreestrFailures = 0;
    return result;
  }
  if (result.outcome === 'AUTH_REQUIRED') {
    console.log('  Росреестр: авторизация отсутствует или завершилась. Требуется вход через ЕСИА.');
    return result;
  }

  consecutiveRosreestrFailures += 1;
  const threshold = Math.max(2, Number(config.rosreestrMassFailureReloadThreshold) || 3);
  console.log(`  Росреестр: технический отказ ${consecutiveRosreestrFailures}/${threshold} (HTTP ${result.status || 0}${result.detail ? `, ${result.detail}` : ''}).`);
  if (consecutiveRosreestrFailures < threshold) return result;

  const stayedLoggedIn = await reloadRosreestrAfterMassFailure(rosPage);
  if (!stayedLoggedIn) return { outcome: 'AUTH_REQUIRED', status: 401, attempt: 0 };
  consecutiveRosreestrFailures = 0;
  result = await fetchRosreestrObjectApi(rosPage, cadastral);
  if (result.outcome === 'AUTH_REQUIRED') {
    console.log('  Росреестр: перезагрузка завершила сессию. Войдите через ЕСИА и повторите запуск — данные продолжатся с контрольной точки.');
    return result;
  }
  if (result.outcome === 'FOUND' || result.outcome === 'NOT_FOUND') {
    console.log('  Росреестр: после перезагрузки снова отвечает, продолжаю сбор.');
    consecutiveRosreestrFailures = 0;
  } else {
    consecutiveRosreestrFailures = 1;
    console.log(`  Росреестр: после перезагрузки запрос всё ещё не проходит (HTTP ${result.status || 0}).`);
  }
  return result;
}

function checkpointPath() {
  return path.join(__dirname, config.jobStateFile || 'last-job-state.json');
}

function saveCheckpoint(data) {
  try {
    const target = checkpointPath();
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    console.log(`  Не удалось сохранить контрольную точку: ${error.message || error}`);
  }
}

function loadCheckpoint() {
  try {
    const target = checkpointPath();
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

async function nspdFetchJson(nspdPage, url, label = '') {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = await nspdPage.evaluate(async ({ requestUrl, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(requestUrl, { credentials: 'include', signal: controller.signal });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
      } catch (error) {
        return { ok: false, status: 0, text: error?.name || String(error) };
      } finally {
        clearTimeout(timer);
      }
    }, { url, requestUrl: url, timeoutMs: Math.max(5000, Number(config.nspdSearchWaitMs) || 12000) });

    if (result.ok) return JSON.parse(result.text);

    const retryableServerError = result.status === 0 || (result.status >= 500 && result.status <= 599);
    if ((result.status === 429 || retryableServerError) && attempt < 6) {
      const waitMs = (result.status === 429 ? 2500 : 900) * attempt + rnd(500, 1200);
      const reason = result.status === 0 ? 'не ответила вовремя' : (result.status === 429 ? 'ограничила запросы' : 'вернула временную ошибку');
      console.log(`  НСПД ${reason} (${result.status})${label ? `: ${label}` : ''}. Жду ${Math.round(waitMs / 100) / 10} сек, попытка ${attempt + 1}/6.`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`NSPD API ${result.status}: ${url}`);
  }
  throw new Error(`NSPD API failed: ${url}`);
}

async function searchNspdFeatureByCad(nspdPage, cadastral) {
  const url = `https://nspd.gov.ru/api/geoportal/v2/search/geoportal?thematicSearchId=1&query=${encodeURIComponent(cadastral)}`;
  const data = await nspdFetchJson(nspdPage, url, cadastral);
  const features = data?.data?.features || [];
  return features.find((feature) => {
    const options = feature?.properties?.options || {};
    return [
      options.cad_number,
      options.cad_num,
      options.parent_cad_number,
      feature?.properties?.externalKey,
      feature?.properties?.label,
      feature?.properties?.descr
    ].includes(cadastral);
  }) || null;
}

async function getNspdBuildingInfo(nspdPage, buildingCad) {
  const feature = await searchNspdFeatureByCad(nspdPage, buildingCad);
  if (!feature) throw new Error(`НСПД API не нашел МКД ${buildingCad}.`);
  const options = feature.properties?.options || {};
  return {
    geomId: feature.id,
    categoryId: feature.properties?.category,
    area: maybeArea(options.build_record_area || options.area || ''),
    feature
  };
}

async function collectNspdObjectCadastralsApi(nspdPage, buildingInfo) {
  const url = `https://nspd.gov.ru/api/geoportal/v1/tab-group-data?tabClass=objectsList&categoryId=${buildingInfo.categoryId}&geomId=${buildingInfo.geomId}`;
  const data = await nspdFetchJson(nspdPage, url, 'список объектов');
  const groups = data?.object || [];
  const result = [];
  for (const group of groups) {
    const title = oneLine(group.title);
    if (!/список/i.test(title)) continue;
    for (const value of group.value || []) {
      for (const cad of findCadastralNumbers(value)) result.push(cad);
    }
  }
  return Array.from(new Set(result));
}

async function getNspdBuildingBundle(nspdPage, buildingCad, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const cache = loadNspdCache();
  const cached = cache.buildings[buildingCad];
  if (!forceRefresh && nspdCacheEntryIsFresh(cached) && cached?.buildingInfo && Array.isArray(cached?.cadastralList)) {
    console.log(`Кэш НСПД: использую свежий список дома (${cached.cadastralList.length} объектов).`);
    return { buildingInfo: cached.buildingInfo, cadastralList: cached.cadastralList, cached: true };
  }
  try {
    const buildingInfo = await getNspdBuildingInfo(nspdPage, buildingCad);
    const cadastralList = await collectNspdObjectCadastralsApi(nspdPage, buildingInfo);
    cache.buildings[buildingCad] = {
      fetchedAt: new Date().toISOString(),
      status: 200,
      buildingInfo,
      cadastralList
    };
    saveNspdCache();
    return { buildingInfo, cadastralList, cached: false };
  } catch (error) {
    if (cached?.buildingInfo && Array.isArray(cached?.cadastralList)) {
      console.log(`НСПД временно недоступна: использую последний список дома из кэша (${cached.cadastralList.length} объектов).`);
      return { buildingInfo: cached.buildingInfo, cadastralList: cached.cadastralList, cached: true, stale: true };
    }
    throw error;
  }
}

function recordFromNspdFeature(seq, cadastral, feature) {
  const options = feature?.properties?.options || {};
  const kind = oneLine(options.type || options.params_type || feature?.properties?.categoryName || '');
  const address = oneLine(options.readable_address || '');
  const commonSource = options.common_property ?? options.service_common_property;
  const commonText = commonPropertyValue(commonSource, commonSource !== undefined && commonSource !== null);
  const purpose = safe(options.purpose || options.params_type || kind);
  const nonResidential = /нежил/i.test(oneLine(purpose));
  return {
    ...emptyRecord(seq, cadastral),
    purpose,
    floor: Array.isArray(options.floor) ? options.floor.map(oneLine).filter(Boolean).join('\n') : safe(options.floor),
    area: maybeArea(options.area || ''),
    ownershipForm: safe(options.ownership_type || ''),
    roomNumber: address,
    commonPropertyText: nonResidential ? commonText : NOT_CHECKED_RESIDENTIAL,
    commonProperty: nonResidential && commonText === 'да',
    nspdCommonPropertyText: commonText,
    foundOnNspd: Boolean(feature)
  };
}

async function nspdApiFallbackRecord(nspdPage, seq, cadastral) {
  const feature = await searchNspdFeatureByCad(nspdPage, cadastral).catch((e) => {
    console.log(`  НСПД API: не удалось добрать ${cadastral} (${e.message || e}).`);
    return null;
  });
  if (!feature) return null;
  const record = recordFromNspdFeature(seq, cadastral, feature);
  console.log(`  НСПД API: добрал поля, площадь=${record.area || '-'}, этаж=${record.floor || '-'}, адрес=${record.roomNumber || '-'}`);
  return record;
}

let nspdCacheMemory = null;

function nspdCachePath() {
  return path.join(__dirname, config.nspdCacheFile || 'nspd-cache.json');
}

function loadNspdCache() {
  if (nspdCacheMemory) return nspdCacheMemory;
  try {
    const target = nspdCachePath();
    const parsed = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
    nspdCacheMemory = parsed?.version === 1 && parsed.objects ? parsed : { version: 1, objects: {}, buildings: {} };
  } catch {
    nspdCacheMemory = { version: 1, objects: {}, buildings: {} };
  }
  return nspdCacheMemory;
}

function saveNspdCache() {
  try {
    const target = nspdCachePath();
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(loadNspdCache()), 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    console.log(`  Кэш НСПД не сохранён: ${error.message || error}`);
  }
}

function nspdCacheEntryIsFresh(entry) {
  if (!entry?.fetchedAt) return false;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  const ttlHours = entry.status === 404
    ? Math.max(0, Number(config.nspdMissingCacheTtlHours) || 3)
    : Math.max(0, Number(config.nspdCacheTtlHours) || 24);
  return Number.isFinite(age) && age >= 0 && age < ttlHours * 60 * 60 * 1000;
}

async function searchNspdFeaturesCached(nspdPage, cadastrals, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const cache = loadNspdCache();
  const output = new Array(cadastrals.length);
  const misses = [];
  for (let i = 0; i < cadastrals.length; i++) {
    const cadastral = cadastrals[i];
    const entry = cache.objects[cadastral];
    if (!forceRefresh && nspdCacheEntryIsFresh(entry)) {
      output[i] = { cadastral, feature: entry.feature || null, status: entry.status || 200, cached: true };
    } else {
      misses.push({ cadastral, index: i });
    }
  }

  const hits = cadastrals.length - misses.length;
  if (hits) console.log(`  Кэш НСПД: ${hits}/${cadastrals.length}, запросить осталось ${misses.length}.`);
  if (!misses.length) return output;

  const fetched = await searchNspdFeaturesBatch(nspdPage, misses.map((item) => item.cadastral));
  const fetchedAt = new Date().toISOString();
  for (let i = 0; i < misses.length; i++) {
    const item = misses[i];
    const result = fetched[i] || { cadastral: item.cadastral, feature: null, status: 0 };
    output[item.index] = result;
    if (result.status === 200 || result.status === 404) {
      cache.objects[item.cadastral] = { fetchedAt, status: result.status, feature: result.feature || null };
    }
  }
  saveNspdCache();
  return output;
}

async function searchNspdFeaturesBatch(nspdPage, cadastrals) {
  return nspdPage.evaluate(async ({ items, concurrency, requestSpacingMs }) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let blockedUntil = 0;
    let nextRequestAt = Date.now();
    const waitForRequestSlot = async () => {
      const now = Date.now();
      const slot = Math.max(now, blockedUntil, nextRequestAt);
      nextRequestAt = slot + requestSpacingMs;
      if (slot > now) await wait(slot - now);
    };
    const pickFeature = (data, cadastral) => {
      const features = data?.data?.features || [];
      return features.find((feature) => {
        const options = feature?.properties?.options || {};
        return [
          options.cad_number,
          options.cad_num,
          options.parent_cad_number,
          feature?.properties?.externalKey,
          feature?.properties?.label,
          feature?.properties?.descr
        ].includes(cadastral);
      }) || null;
    };

    async function fetchOne(cadastral) {
      const url = `https://nspd.gov.ru/api/geoportal/v2/search/geoportal?thematicSearchId=1&query=${encodeURIComponent(cadastral)}`;
      for (let attempt = 1; attempt <= 5; attempt++) {
        await waitForRequestSlot();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let response;
        let text;
        try {
          response = await fetch(url, { credentials: 'include', signal: controller.signal });
          text = await response.text();
        } catch (error) {
          clearTimeout(timer);
          if (attempt < 5) {
            const cooldown = 900 * attempt + Math.floor(Math.random() * 700);
            blockedUntil = Math.max(blockedUntil, Date.now() + cooldown);
            await wait(cooldown);
            continue;
          }
          return { cadastral, feature: null, status: 0, error: error?.name || String(error) };
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) {
          const data = JSON.parse(text);
          return { cadastral, feature: pickFeature(data, cadastral), status: response.status };
        }
        if ((response.status === 429 || (response.status >= 500 && response.status <= 599)) && attempt < 5) {
          const base = response.status === 429 ? 1200 : 700;
          const cooldown = base * attempt + Math.floor(Math.random() * 700);
          blockedUntil = Math.max(blockedUntil, Date.now() + cooldown);
          await wait(cooldown);
          continue;
        }
        return { cadastral, feature: null, status: response.status, error: text.slice(0, 200) };
      }
      return { cadastral, feature: null, status: 0, error: 'retry limit' };
    }

    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fetchOne(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }, {
    items: cadastrals,
    concurrency: Math.max(1, Math.min(config.nspdApiConcurrency || 4, cadastrals.length)),
    requestSpacingMs: Math.max(0, Number(config.nspdApiRequestSpacingMs) || 180)
  });
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pasteRecordRowsInChunks(sheetsPage, startRow, records, chunkSize = 80, nspdColumnsOnly = false) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const rows = chunk.map((record) => ({
      cells: nspdColumnsOnly ? sheetCellsForRecord(record).slice(0, 8) : sheetCellsForRecord(record),
      commonProperty: Boolean(record.commonProperty),
      backgroundColor: rowBackgroundColor(record)
    }));
    await pasteRows(sheetsPage, `A${startRow + i}`, rows);
    console.log(`  Записано строк НСПД: ${Math.min(i + chunk.length, records.length)}/${records.length}`);
  }
}

async function returnRosreestrToResults(rosPage) {
  const back = rosPage.getByText(/ВЕРНУТЬСЯ К РЕЗУЛЬТАТАМ ПОИСКА/i).first();
  if (await back.count().catch(() => 0)) {
    await back.click({ force: true }).catch(() => {});
    await sleep(800);
  }
}

async function clearRowsAfterRecords(sheetsPage, firstRow, rowsToClear = 10, columnCount = 12) {
  const blankRows = Array.from({ length: rowsToClear }, () => ({
    cells: Array.from({ length: columnCount }, () => ''),
    commonProperty: false
  }));
  console.log(`Очищаю возможный старый хвост с A по ${columnCount === 8 ? 'H' : 'L'} со строки ${firstRow}.`);
  await pasteRows(sheetsPage, `A${firstRow}`, blankRows);
}

async function fillRosreestrBuildingArea(sheetsPage, rosPage, buildingCad) {
  if (config.rosreestrUseApi !== false) {
    return fillRosreestrBuildingAreaFast(sheetsPage, rosPage, buildingCad, false);
  }
  if (config.rosreestrUseApi !== false) {
    return fillRosreestrBuildingAreaFast(sheetsPage, rosPage, buildingCad, false);
  }
  console.log(`\nПеред объектами ищу МКД в Росреестре для P2: ${buildingCad}`);
  await humanPause('перед запросом МКД в Росреестре');
  const found = await searchRosreestrAndOpenCard(rosPage, buildingCad);
  if (!found) {
    console.log('  Росреестр: МКД не найден или карточка не открылась, P2 пока оставляю как есть.');
    return;
  }

  const data = await parseRosreestrCard(rosPage, buildingCad);
  if (data.area) {
    await writeRosreestrBuildingArea(sheetsPage, data.area);
  } else {
    console.log('  Росреестр: карточка МКД открылась, но площадь не прочиталась.');
  }
  await returnRosreestrToResults(rosPage);
}

async function setInputNearLabel(page, label, value) {
  return page.evaluate(({ labelText, inputValue }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, div, span, td, th')).filter((el) =>
      isVisible(el) && norm(el.innerText || el.textContent).includes(labelText)
    );
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
    if (!labels.length || !inputs.length) return false;

    let best = null;
    let bestScore = Infinity;
    for (const labelEl of labels) {
      const lr = labelEl.getBoundingClientRect();
      for (const input of inputs) {
        const ir = input.getBoundingClientRect();
        const vertical = Math.abs((lr.top + lr.height / 2) - (ir.top + ir.height / 2));
        const rightBonus = ir.left >= lr.left ? 0 : 500;
        const score = vertical * 10 + Math.abs(ir.left - lr.right) + rightBonus;
        if (score < bestScore) {
          bestScore = score;
          best = input;
        }
      }
    }
    if (!best) return false;
    best.scrollIntoView({ block: 'center', inline: 'center' });
    const proto = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    best.focus();
    if (setter) setter.call(best, inputValue);
    else best.value = inputValue;
    best.dispatchEvent(new Event('input', { bubbles: true }));
    best.dispatchEvent(new Event('change', { bubbles: true }));
    best.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    return true;
  }, { labelText: label, inputValue: value });
}

async function clickControlNearLabel(page, label) {
  return page.evaluate(({ labelText }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, div, span, td, th')).filter((el) =>
      isVisible(el) && norm(el.innerText || el.textContent).includes(labelText)
    );
    const controls = Array.from(document.querySelectorAll('input, textarea, .select2-choice, .ui-select-container, [role="combobox"], button')).filter(isVisible);
    if (!labels.length || !controls.length) return false;
    let best = null;
    let bestScore = Infinity;
    for (const labelEl of labels) {
      const lr = labelEl.getBoundingClientRect();
      for (const control of controls) {
        const cr = control.getBoundingClientRect();
        const vertical = Math.abs((lr.top + lr.height / 2) - (cr.top + cr.height / 2));
        const rightBonus = cr.left >= lr.left ? 0 : 500;
        const score = vertical * 10 + Math.abs(cr.left - lr.right) + rightBonus;
        if (score < bestScore) {
          bestScore = score;
          best = control;
        }
      }
    }
    if (!best) return false;
    best.scrollIntoView({ block: 'center', inline: 'center' });
    best.click();
    return true;
  }, { labelText: label });
}

async function ensureGisSubjectMoscow(gisPage) {
  const body = await getBodyText(gisPage).catch(() => '');
  if (/Субъект РФ[\s\S]{0,80}Москва/i.test(body)) return;

  const clicked = await clickControlNearLabel(gisPage, 'Субъект РФ').catch(() => false);
  if (!clicked) return;
  await sleep(300);
  await gisPage.keyboard.press('Control+A').catch(() => {});
  await gisPage.keyboard.type('Москва', { delay: 35 }).catch(() => {});
  await sleep(700);
  const option = gisPage.getByText('Москва', { exact: true }).last();
  if (await option.count().catch(() => 0)) {
    await option.click({ force: true }).catch(() => {});
  } else {
    await gisPage.keyboard.press('Enter').catch(() => {});
  }
  await sleep(700);
}

function extractNumberAfterLabel(text, labelRx) {
  const lines = normalizeText(text).split('\n').map((x) => oneLine(x)).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!labelRx.test(lines[i])) continue;
    const sameLineValue = parseLocalizedNumber(lines[i].replace(labelRx, ''));
    if (Number.isFinite(sameLineValue)) return sameLineValue;
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const value = parseLocalizedNumber(lines[j]);
      if (Number.isFinite(value)) return value;
    }
  }
  return NaN;
}

function parseGisAreaSum(text) {
  const residential = extractNumberAfterLabel(text, /^2\.15\.1\.\s*Общая площадь жилых помещений/i);
  const nonResidential = extractNumberAfterLabel(text, /^2\.15\.2\.\s*Общая площадь нежилых помещений/i);
  if (!Number.isFinite(residential) && !Number.isFinite(nonResidential)) return '';
  return formatLocalizedNumber((Number.isFinite(residential) ? residential : 0) + (Number.isFinite(nonResidential) ? nonResidential : 0));
}

function formatGisAreaPair(residential, nonResidential) {
  if (!Number.isFinite(residential) && !Number.isFinite(nonResidential)) return '';
  console.log(`  ГИС ЖКХ: жилая=${Number.isFinite(residential) ? residential : '-'}, нежилая=${Number.isFinite(nonResidential) ? nonResidential : '-'}.`);
  return formatLocalizedNumber((Number.isFinite(residential) ? residential : 0) + (Number.isFinite(nonResidential) ? nonResidential : 0));
}

async function readGisNumberNearRow(gisPage, rowNumber, label) {
  return gisPage.evaluate(({ rowPrefix, labelText }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const parseValueCell = (text) => {
      const cleaned = norm(text)
        .replace(/кв\.?\s*м\.?/gi, '')
        .replace(/\s/g, '')
        .trim();
      if (!/^\d+(?:[,.]\d+)?$/.test(cleaned)) return NaN;
      const n = Number(cleaned.replace(',', '.'));
      return Number.isFinite(n) ? n : NaN;
    };
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const textMatches = (el) => {
      const text = norm(el.innerText || el.textContent).toLowerCase();
      return text.includes(rowPrefix.toLowerCase()) && text.includes(labelText.toLowerCase());
    };
    const elements = Array.from(document.querySelectorAll('td, th, div, span, label'))
      .filter((el) => isVisible(el) && textMatches(el))
      .sort((a, b) => norm(a.innerText || a.textContent).length - norm(b.innerText || b.textContent).length);

    for (const el of elements) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });

      const row = el.closest('tr');
      if (row) {
        const rowText = norm(row.innerText || row.textContent).toLowerCase();
        if (!rowText.includes(rowPrefix.toLowerCase()) || !rowText.includes(labelText.toLowerCase())) continue;
        const cells = Array.from(row.querySelectorAll('td, th'));
        const index = Math.max(0, cells.findIndex((cell) => cell === el || cell.contains(el)));
        for (let i = index + 1; i < cells.length; i++) {
          const value = parseValueCell(cells[i].innerText || cells[i].textContent);
          if (Number.isFinite(value)) return value;
        }
      }
    }
    return null;
  }, { rowPrefix: rowNumber, labelText: label });
}

async function readGisAreaFromDom(gisPage) {
  const residential = await readGisNumberNearRow(gisPage, '2.15.1', 'Общая площадь жилых помещений').catch(() => null);
  const nonResidential = await readGisNumberNearRow(gisPage, '2.15.2', 'Общая площадь нежилых помещений').catch(() => null);
  return formatGisAreaPair(
    Number.isFinite(residential) ? residential : NaN,
    Number.isFinite(nonResidential) ? nonResidential : NaN
  );
}

async function searchInPage(page, query) {
  await page.bringToFront();
  await page.keyboard.press('Control+F').catch(() => {});
  await sleep(200);
  await page.keyboard.press('Control+A').catch(() => {});
  await sleep(80);
  await page.keyboard.type(query, { delay: 15 }).catch(() => {});
  await sleep(700);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
}

async function readGisAreaByPageSearch(gisPage) {
  const residentialQueries = ['Общая площадь жилых помещений'];
  const nonResidentialQueries = ['Общая площадь нежилых помещений'];
  let residential = NaN;
  let nonResidential = NaN;

  for (const query of residentialQueries) {
    console.log(`  ГИС ЖКХ: ищу по странице "${query}".`);
    await searchInPage(gisPage, query);
    residential = await readGisNumberNearRow(gisPage, '2.15.1', 'Общая площадь жилых помещений').catch(() => null);
    if (Number.isFinite(residential)) break;
    const text = await getBodyText(gisPage).catch(() => '');
    residential = extractNumberAfterLabel(text, /^2\.15\.1\.\s*Общая площадь жилых помещений/i);
    if (Number.isFinite(residential)) break;
  }

  for (const query of nonResidentialQueries) {
    console.log(`  ГИС ЖКХ: ищу по странице "${query}".`);
    await searchInPage(gisPage, query);
    nonResidential = await readGisNumberNearRow(gisPage, '2.15.2', 'Общая площадь нежилых помещений').catch(() => null);
    if (Number.isFinite(nonResidential)) break;
    const text = await getBodyText(gisPage).catch(() => '');
    nonResidential = extractNumberAfterLabel(text, /^2\.15\.2\.\s*Общая площадь нежилых помещений/i);
    if (Number.isFinite(nonResidential)) break;
  }

  return formatGisAreaPair(residential, nonResidential);
}

async function scrollGisPassportToArea(gisPage) {
  await gisPage.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(400);

  const viaDom = await readGisAreaFromDom(gisPage);
  if (viaDom) return viaDom;

  const viaSearch = await readGisAreaByPageSearch(gisPage);
  if (viaSearch) return viaSearch;

  for (let pass = 0; pass < 80; pass++) {
    const text = await getBodyText(gisPage).catch(() => '');
    const area = parseGisAreaSum(text);
    if (area) return area;
    const domArea = await readGisAreaFromDom(gisPage);
    if (domArea) return domArea;

    const section = gisPage.getByText(/2\.15\.\s*Площадь здания/i).first();
    if (await section.count().catch(() => 0)) {
      await section.scrollIntoViewIfNeeded().catch(() => {});
      await section.click({ force: true, timeout: 800 }).catch(() => {});
    }

    const state = await gisPage.evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const scrollables = Array.from(document.querySelectorAll('*'))
        .filter((el) => isVisible(el) && el.scrollHeight > el.clientHeight + 80)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const el = scrollables[0] || document.scrollingElement || document.documentElement;
      const before = el.scrollTop;
      el.scrollTop = before + Math.max(450, Math.floor(el.clientHeight * 0.75));
      window.scrollBy(0, Math.max(450, Math.floor(window.innerHeight * 0.75)));
      const after = el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      return { moved: Math.abs(after - before) > 2, atBottom: after >= max - 4 };
    }).catch(() => ({ moved: false, atBottom: false }));

    await sleep(350);
    if (pass % 10 === 0) console.log(`  ГИС ЖКХ: пролистываю электронный паспорт, шаг ${pass + 1}.`);
    if (state.atBottom && !state.moved) break;
  }

  return readGisAreaByPageSearch(gisPage);
}

async function fillGisArea(sheetsPage, gisPage, buildingCad) {
  if (config.gisUseApi !== false) {
    return fillGisAreaFast(sheetsPage, gisPage, buildingCad, false);
  }
  if (config.gisUseApi !== false) {
    return fillGisAreaFast(sheetsPage, gisPage, buildingCad, false);
  }
  console.log(`\nИщу МКД в ГИС ЖКХ для Q2: ${buildingCad}`);
  await gisPage.bringToFront();
  if (!gisPage.url().includes('dom.gosuslugi.ru')) {
    await gisPage.goto(config.gisUrl, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
  }
  await gisPage.waitForLoadState('domcontentloaded', { timeout: config.pageReadyTimeoutMs }).catch(() => {});
  await sleep(1200);

  await ensureGisSubjectMoscow(gisPage);
  const filledCad = await setInputNearLabel(gisPage, 'Кадастровый номер', buildingCad).catch(() => false);
  if (!filledCad) {
    console.log('  ГИС ЖКХ: не нашел поле кадастрового номера, Q2 пока оставляю как есть.');
    return;
  }
  await sleep(500);

  const findButton = gisPage.getByRole('button', { name: /^Найти$/i }).last();
  if (await findButton.count().catch(() => 0)) {
    await findButton.click({ force: true }).catch(() => {});
  } else {
    await gisPage.keyboard.press('Enter').catch(() => {});
  }

  await gisPage.getByText(buildingCad, { exact: true }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(1200);

  const passportLink = gisPage.getByText('Электронные паспорта дома', { exact: true }).first();
  if (!(await passportLink.count().catch(() => 0))) {
    console.log('  ГИС ЖКХ: результат найден не полностью или нет ссылки на электронный паспорт.');
    return;
  }
  await passportLink.scrollIntoViewIfNeeded().catch(() => {});
  const pagesBeforePassportClick = new Set(gisPage.context().pages());
  const newPassportPagePromise = gisPage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await passportLink.click({ force: true }).catch(() => {});

  await sleep(800);
  const sourceYesButton = gisPage.getByRole('button', { name: /^Да$/i }).first();
  if (await sourceYesButton.count().catch(() => 0)) {
    await sourceYesButton.click({ force: true }).catch(() => {});
  }

  let passportPage = await newPassportPagePromise;
  if (!passportPage) {
    await sleep(1200);
    passportPage = gisPage.context().pages().find((page) => !pagesBeforePassportClick.has(page)) || gisPage;
  }
  await passportPage.bringToFront().catch(() => {});
  await passportPage.waitForLoadState('domcontentloaded', { timeout: config.pageReadyTimeoutMs }).catch(() => {});
  await sleep(800);

  const yesButton = passportPage.getByRole('button', { name: /^Да$/i }).first();
  if (await yesButton.count().catch(() => 0)) {
    await yesButton.click({ force: true }).catch(() => {});
  }
  await sleep(config.gisPassportWaitMs || 5000);

  const area = await scrollGisPassportToArea(passportPage);
  if (area) {
    await writeGisArea(sheetsPage, area);
  } else {
    console.log('  ГИС ЖКХ: паспорт открылся, но строки 2.15.1/2.15.2 не прочитались.');
  }
}

async function fillRosreestrBuildingAreaFast(sheetsPage, rosPage, buildingCad, dryRun = false) {
  console.log(`\nРосреестр API: получаю площадь МКД ${buildingCad}.`);
  const result = await fetchRosreestrObjectApiWithRecovery(rosPage, buildingCad);
  if (result.outcome !== 'FOUND') {
    console.log(`  Площадь РР не обновлена: ${result.outcome}${result.status ? ` (${result.status})` : ''}.`);
    return result;
  }
  const area = maybeArea(result.element?.area || '');
  if (area && !dryRun) await writeRosreestrBuildingArea(sheetsPage, area);
  console.log(`  Площадь РР: ${area || 'не указана'}.`);
  return result;
}

async function fetchGisBuildingApi(gisPage, buildingCad) {
  await gisPage.bringToFront();
  if (!gisPage.url().includes('/#!/houses')) {
    await gisPage.goto(config.gisUrl, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
  }
  const prefix = buildingCad.split(':')[0];
  const regionName = config.gisRegionByCadPrefix?.[prefix] || 'Москва';
  const regionSelect = gisPage.locator('select[name="region"]').first();
  await regionSelect.waitFor({ state: 'attached', timeout: config.pageReadyTimeoutMs });
  const optionExists = await regionSelect.evaluate((select, wanted) =>
    Array.from(select.options).some((item) => item.textContent.trim() === wanted), regionName);
  if (!optionExists) return { outcome: 'UNSUPPORTED_REGION', regionName };
  await regionSelect.selectOption({ label: regionName }).catch(() => {});
  const input = gisPage.locator('input[name="cadastreNumber"]').first();
  await input.waitFor({ state: 'visible', timeout: config.pageReadyTimeoutMs });
  await input.fill(buildingCad);
  const responsePromise = gisPage.waitForResponse(
    (response) => response.url().includes('/houses/public/searchByAddress'),
    { timeout: 20000 }
  ).catch(() => null);
  await gisPage.getByRole('button', { name: /^Найти$/i }).last().click({ force: true });
  const response = await responsePromise;
  if (!response) return { outcome: 'TIMEOUT' };
  const result = { status: response.status(), text: await response.text().catch(() => '') };
  if (result.status !== 200) return { outcome: 'ERROR', status: result.status };
  let payload;
  try { payload = JSON.parse(result.text); } catch { return { outcome: 'PARSE_ERROR' }; }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const exact = items.find((item) => oneLine(item?.cadastreNumber) === buildingCad) || (items.length === 1 ? items[0] : null);
  if (!exact) return { outcome: Number(payload.total || 0) === 0 ? 'NOT_FOUND' : 'MISMATCH' };
  return { outcome: 'FOUND', item: exact, regionName };
}

async function readGisPassportViaResultLink(gisPage) {
  const link = gisPage.getByText('Электронные паспорта дома', { exact: true }).first();
  if (!(await link.count().catch(() => 0))) return '';
  const pagesBefore = new Set(gisPage.context().pages());
  const popupPromise = gisPage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await link.click({ force: true }).catch(() => {});
  await sleep(500);
  const sourceYes = gisPage.getByRole('button', { name: /^Да$/i }).first();
  if (await sourceYes.count().catch(() => 0)) await sourceYes.click({ force: true }).catch(() => {});
  let passportPage = await popupPromise;
  if (!passportPage) {
    await sleep(900);
    passportPage = gisPage.context().pages().find((page) => !pagesBefore.has(page)) || gisPage;
  }
  await passportPage.waitForLoadState('domcontentloaded', { timeout: config.pageReadyTimeoutMs }).catch(() => {});
  const yes = passportPage.getByRole('button', { name: /^Да$/i }).first();
  if (await yes.count().catch(() => 0)) await yes.click({ force: true }).catch(() => {});
  await sleep(config.gisPassportWaitMs || 5000);
  const area = await scrollGisPassportToArea(passportPage);
  if (passportPage !== gisPage) await passportPage.close().catch(() => {});
  return area;
}

async function fillGisAreaFast(sheetsPage, gisPage, buildingCad, dryRun = false) {
  console.log(`\nГИС ЖКХ API: ищу МКД ${buildingCad}.`);
  const result = await fetchGisBuildingApi(gisPage, buildingCad);
  if (result.outcome !== 'FOUND') {
    console.log(`  ГИС ЖКХ: площадь не обновлена (${result.outcome}).`);
    return result;
  }
  if (!result.item?.guid) return { outcome: 'NO_GUID' };
  const passport = await gisPage.context().newPage();
  let area = '';
  try {
    const url = `https://dom.gosuslugi.ru/#!/passport/show?houseGuid=${encodeURIComponent(result.item.guid)}&houseTypeCode=1`;
    await passport.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageReadyTimeoutMs });
    const deadline = Date.now() + Math.max(5000, config.gisPassportWaitMs || 5000) + 7000;
    while (Date.now() < deadline) {
      const text = await getBodyText(passport).catch(() => '');
      area = parseGisAreaSum(text);
      if (area) break;
      await sleep(400);
    }
  } finally {
    await passport.close().catch(() => {});
  }
  if (!area) {
    console.log('  ГИС ЖКХ: прямой паспорт не ответил, использую ссылку результата.');
    area = await readGisPassportViaResultLink(gisPage).catch(() => '');
  }
  if (area && !dryRun) await writeGisArea(sheetsPage, area);
  console.log(`  Площадь ГИС ЖКХ: ${area || 'не прочиталась'}.`);
  return { ...result, area };
}

async function runFastFull(sheets, nspd, rosPage, gisPage, buildingCad, startRow, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const maxItems = Math.max(0, Number(options.maxItems) || 0);
  const forceRefreshNspd = Boolean(options.forceRefreshNspd);
  const mode = 'fast-full-turbo-v3';
  console.log('\nТурбо-сбор: НСПД даёт список дома, Росреестр — основные поля, затем НСПД проверяет ОДИ только у нежилых.');

  const bundle = await getNspdBuildingBundle(nspd, buildingCad, { forceRefresh: forceRefreshNspd });
  const buildingInfo = bundle.buildingInfo;
  const buildingOptions = buildingInfo.feature?.properties?.options || {};
  const buildingArea = buildingInfo.area;
  const buildingYear = safe(buildingOptions.year_built || buildingOptions.year_commisioning || '');
  if (!dryRun) {
    await writeBuildingArea(sheets, buildingArea);
    await writeBuildingYear(sheets, buildingYear);
  }

  const cadastralList = bundle.cadastralList;
  if (!cadastralList.length) throw new Error('НСПД API вернул пустой список помещений/машино-мест.');
  const filteredList = cadastralList.filter((cadastral) => belongsToBuildingQuarter(cadastral, buildingCad));
  const rejectedList = cadastralList.filter((cadastral) => !belongsToBuildingQuarter(cadastral, buildingCad));
  if (rejectedList.length) {
    console.log(`Фильтр квартала: пропущено ${rejectedList.length} чужих кадастров до Росреестра: ${rejectedList.slice(0, 5).join(', ')}${rejectedList.length > 5 ? '…' : ''}`);
  }
  if (!filteredList.length) throw new Error(`В списке НСПД нет объектов из квартала дома ${cadastralQuarter(buildingCad)}.`);
  const skipObjects = startRow - 2;
  let workList = filteredList.slice(skipObjects);
  if (maxItems > 0) workList = workList.slice(0, maxItems);
  console.log(`Объектов в задании: ${workList.length} из ${filteredList.length} после фильтра квартала.`);

  const listSignature = `v3:${workList.length}:${workList[0] || ''}:${workList[workList.length - 1] || ''}`;
  const previous = !dryRun ? loadCheckpoint() : null;
  const canResume = previous?.mode === mode && previous?.status !== 'complete' &&
    previous?.buildingCad === buildingCad && previous?.startRow === startRow &&
    previous?.listSignature === listSignature && Array.isArray(previous?.records);
  const records = canResume ? previous.records : workList.map((cadastral, index) => ({
    row: startRow + index,
    record: emptyRecord(skipObjects + index + 1, cadastral),
    rrOutcome: ''
  }));
  const retryRows = canResume && Array.isArray(previous.retryRows) ? previous.retryRows : [];
  if (!canResume && !dryRun) {
    await pasteRecordRowsInChunks(sheets, startRow, records.map((item) => item.record), config.sheetWriteChunkSize || 100, false);
    await clearRowsAfterRecords(sheets, startRow + records.length, 10, 12);
    saveCheckpoint({ mode, stage: 'rr', buildingCad, startRow, listSignature, rrCompleted: 0, nspdOdiCompleted: 0, total: records.length, retryRows, records, status: 'running' });
  }
  console.log(`\nСписок НСПД готов: создано ${records.length} строк. Запускаю Росреестр без подробного обхода НСПД.`);

  const rrAlreadyFinished = canResume && ['odi', 'done'].includes(previous.stage);
  const rrResumeAt = rrAlreadyFinished ? records.length : (canResume && previous.stage === 'rr'
    ? Math.min(Number(previous.rrCompleted) || 0, records.length)
    : 0);
  if (rrResumeAt > 0 && rrResumeAt < records.length) console.log(`Возобновляю Росреестр со строки ${records[rrResumeAt]?.row || startRow}.`);
  const pendingRrWrites = [];
  const rrWriteChunkSize = Math.max(5, Number(config.rosreestrSheetWriteChunkSize) || 25);
  for (let index = rrResumeAt; index < records.length; index++) {
    const item = records[index];
    const cadastral = item.record.cadastral;
    const result = await fetchRosreestrObjectApiWithRecovery(rosPage, cadastral);
    if (result.outcome === 'AUTH_REQUIRED') {
      if (!dryRun) {
        await flushTurboRosreestrWrites(sheets, pendingRrWrites);
        saveCheckpoint({ mode, stage: 'rr', buildingCad, startRow, listSignature, rrCompleted: index, nspdOdiCompleted: 0, total: records.length, retryRows, records, status: 'running' });
      }
      throw new Error('Нужна авторизация в Росреестре. Войдите через ЕСИА во вкладке Росреестра и повторите запуск — этап продолжится с этой строки.');
    }
    if (result.outcome === 'FOUND') {
      const rrRecord = recordFromRosreestrApi(item.record.seq, cadastral, result.element);
      item.record = mergeRecordWithRosreestr(item.record, rrRecord);
      if (isNonResidentialRecord(item.record)) {
        item.record.commonPropertyText = NO_INFO;
        item.record.commonProperty = false;
      } else {
        item.record.commonPropertyText = NOT_CHECKED_RESIDENTIAL;
        item.record.commonProperty = false;
      }
      item.rrOutcome = 'FOUND';
      if (!dryRun) pendingRrWrites.push(item);
    } else if (result.outcome === 'NOT_FOUND') {
      item.record.status = ABSENT;
      item.rrOutcome = 'NOT_FOUND';
      if (!dryRun) pendingRrWrites.push(item);
    } else {
      item.rrOutcome = 'ERROR';
      retryRows.push(item.row);
      console.log(`  Строка ${item.row}: техническая ошибка Росреестра, добавляю строку в список для отдельного повтора.`);
    }
    console.log(`[PROGRESS] РР ${index + 1}/${records.length} | строка ${item.row} | ${result.outcome} | повторить ${retryRows.length}`);
    const processedSinceResume = index - rrResumeAt + 1;
    if (!dryRun && (processedSinceResume % rrWriteChunkSize === 0 || index === records.length - 1)) {
      await flushTurboRosreestrWrites(sheets, pendingRrWrites);
      saveCheckpoint({ mode, stage: 'rr', buildingCad, startRow, listSignature, rrCompleted: index + 1, nspdOdiCompleted: 0, total: records.length, retryRows, records, status: 'running' });
    }
  }

  const failedItems = records.filter((item) => item.rrOutcome === 'ERROR');
  if (failedItems.length) {
    console.log(`\nРосреестр: автоматически повторяю ${failedItems.length} технически ошибочных строк после основного прохода.`);
    const retryWrites = [];
    for (let index = 0; index < failedItems.length; index++) {
      const item = failedItems[index];
      const cadastral = item.record.cadastral;
      const result = await fetchRosreestrObjectApiWithRecovery(rosPage, cadastral);
      if (result.outcome === 'AUTH_REQUIRED') {
        if (!dryRun) {
          await flushTurboRosreestrWrites(sheets, retryWrites);
          saveCheckpoint({ mode, stage: 'rr', buildingCad, startRow, listSignature, rrCompleted: records.length, nspdOdiCompleted: 0, total: records.length, retryRows, records, status: 'running' });
        }
        throw new Error('После перезагрузки Росреестра выполнен выход из аккаунта. Войдите через ЕСИА и повторите запуск — ошибочные строки будут проверены снова.');
      }
      if (result.outcome === 'FOUND') {
        const rrRecord = recordFromRosreestrApi(item.record.seq, cadastral, result.element);
        item.record = mergeRecordWithRosreestr(item.record, rrRecord);
        item.record.commonPropertyText = isNonResidentialRecord(item.record) ? NO_INFO : NOT_CHECKED_RESIDENTIAL;
        item.record.commonProperty = false;
        item.rrOutcome = 'FOUND';
        if (!dryRun) retryWrites.push(item);
      } else if (result.outcome === 'NOT_FOUND') {
        item.record.status = ABSENT;
        item.rrOutcome = 'NOT_FOUND';
        if (!dryRun) retryWrites.push(item);
      }
      console.log(`[PROGRESS] РР-повтор ${index + 1}/${failedItems.length} | строка ${item.row} | ${result.outcome}`);
      if (!dryRun && (retryWrites.length >= rrWriteChunkSize || index === failedItems.length - 1)) {
        await flushTurboRosreestrWrites(sheets, retryWrites);
        const stillFailedRows = records.filter((entry) => entry.rrOutcome === 'ERROR').map((entry) => entry.row);
        retryRows.length = 0;
        retryRows.push(...stillFailedRows);
        saveCheckpoint({ mode, stage: 'rr', buildingCad, startRow, listSignature, rrCompleted: records.length, nspdOdiCompleted: 0, total: records.length, retryRows, records, status: 'running' });
      }
    }
  }

  const odiTargets = records.filter((item) => item.rrOutcome === 'FOUND' && isNonResidentialRecord(item.record));
  const odiResumeAt = canResume && previous.stage === 'odi'
    ? Math.min(Number(previous.nspdOdiCompleted) || 0, odiTargets.length)
    : 0;
  if (!dryRun) saveCheckpoint({ mode, stage: 'odi', buildingCad, startRow, listSignature, rrCompleted: records.length, nspdOdiCompleted: odiResumeAt, total: records.length, retryRows, records, status: 'running' });
  console.log(`\nРосреестр завершён. НСПД точечно проверит ОДИ у ${odiTargets.length} нежилых объектов.`);
  const batchSize = Math.max(1, Number(config.nspdApiBatchSize) || 60);
  for (let offset = odiResumeAt; offset < odiTargets.length; offset += batchSize) {
    const batch = odiTargets.slice(offset, offset + batchSize);
    const results = await searchNspdFeaturesCached(nspd, batch.map((item) => item.record.cadastral), { forceRefresh: forceRefreshNspd });
    const pendingCommonWrites = [];
    for (let index = 0; index < batch.length; index++) {
      const result = results[index];
      if (![200, 404].includes(Number(result?.status))) {
        throw new Error(`НСПД не завершила ОДИ: ${batch[index].record.cadastral}, HTTP ${result?.status || 0}. Повторите запуск — он продолжится с контрольной точки.`);
      }
      const featureOptions = result?.feature?.properties?.options || {};
      const source = featureOptions.common_property ?? featureOptions.service_common_property;
      const value = result?.feature ? commonPropertyValue(source, source !== undefined && source !== null) : NO_INFO;
      batch[index].record.commonPropertyText = value;
      batch[index].record.commonProperty = value === 'да';
      pendingCommonWrites.push(batch[index]);
    }
    if (!dryRun) {
      await flushCommonPropertyWrites(sheets, pendingCommonWrites);
      saveCheckpoint({ mode, stage: 'odi', buildingCad, startRow, listSignature, rrCompleted: records.length, nspdOdiCompleted: offset + batch.length, total: records.length, retryRows, records, status: 'running' });
    }
    console.log(`[PROGRESS] ОДИ ${Math.min(offset + batch.length, odiTargets.length)}/${odiTargets.length}`);
  }

  if (dryRun) {
    await fillRosreestrBuildingAreaFast(sheets, rosPage, buildingCad, true);
    await fillGisAreaFast(sheets, gisPage, buildingCad, true);
    console.log(`\nТЕСТ БЕЗ ЗАПИСИ: получено ${records.length}, ошибок РР ${retryRows.length}.`);
    return { records, retryRows };
  }

  await fillRosreestrBuildingAreaFast(sheets, rosPage, buildingCad, false);
  await fillGisAreaFast(sheets, gisPage, buildingCad, false);
  if (retryRows.length) console.log(`\nПовторите технически ошибочные строки режимом «Проверить диапазон в РР»: ${Array.from(new Set(retryRows)).join(', ')}.`);
  saveCheckpoint({ mode, stage: 'done', buildingCad, startRow, listSignature, rrCompleted: records.length, nspdOdiCompleted: odiTargets.length, total: records.length, retryRows, records, status: 'complete' });
  return { records, retryRows };
}

async function runFastNspdOnly(sheets, nspd, buildingCad, startRow, runOptions = {}) {
  console.log('\nБыстрый режим только НСПД: интерфейс карты не используется.');
  const dryRun = Boolean(runOptions.dryRun);
  const maxItems = Math.max(0, Number(runOptions.maxItems) || 0);
  const forceRefreshNspd = Boolean(runOptions.forceRefreshNspd);
  const bundle = await getNspdBuildingBundle(nspd, buildingCad, { forceRefresh: forceRefreshNspd });
  const buildingInfo = bundle.buildingInfo;
  const options = buildingInfo.feature?.properties?.options || {};
  if (!dryRun) {
    await writeBuildingArea(sheets, buildingInfo.area);
    await writeBuildingYear(sheets, safe(options.year_built || options.year_commisioning || ''));
  }
  const cadastralList = bundle.cadastralList;
  if (!cadastralList.length) throw new Error('НСПД API вернул пустой список помещений/машино-мест.');
  const skipObjects = startRow - 2;
  let workList = cadastralList.slice(skipObjects);
  if (maxItems > 0) workList = workList.slice(0, maxItems);
  const records = [];
  const batchSize = Math.max(1, Number(config.nspdApiBatchSize) || 30);
  for (let offset = 0; offset < workList.length; offset += batchSize) {
    const batch = workList.slice(offset, offset + batchSize);
    const results = await searchNspdFeaturesCached(nspd, batch, { forceRefresh: forceRefreshNspd });
    const batchRecords = results.map((result, index) => {
      const cadastral = batch[index];
      const seq = skipObjects + offset + index + 1;
      return result?.feature ? recordFromNspdFeature(seq, cadastral, result.feature) : emptyRecord(seq, cadastral);
    });
    records.push(...batchRecords);
    if (!dryRun) await pasteRecordRowsInChunks(sheets, startRow + offset, batchRecords, config.sheetWriteChunkSize || 20, true);
    console.log(`[PROGRESS] НСПД ${Math.min(offset + batch.length, workList.length)}/${workList.length}`);
    if (!dryRun) saveCheckpoint({ mode: 'nspd-only', buildingCad, startRow, completed: offset + batch.length, total: workList.length, status: 'running' });
  }
  if (!dryRun) {
    await clearRowsAfterRecords(sheets, startRow + records.length, 10, 8);
    saveCheckpoint({ mode: 'nspd-only', buildingCad, startRow, completed: records.length, total: records.length, status: 'complete' });
  }
  return records;
}

async function runNspdCommonPropertyForNonResidential(sheets, nspd, buildingCad, startRow, options = {}) {
  console.log('\nОДИ нежилых: одним чтением получаю B:C и заранее фильтрую нежилые помещения.');
  const lastRow = startRow + Math.max(1, Number(config.maxObjectsPerRun) || 2000) - 1;
  const rows = await readRange(sheets, `B${startRow}:C${lastRow}`);
  const targets = selectNonResidentialSheetRows(rows, startRow);

  if (!targets.length) {
    console.log('Нежилые помещения в текущем листе не найдены. Столбец G не изменён.');
    return [];
  }

  console.log(`Фильтр завершён: найдено ${targets.length} нежилых объектов. В НСПД отправляю только их.`);
  const batchSize = Math.max(1, Number(config.nspdApiBatchSize) || 30);
  const output = [];
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize);
    const results = await searchNspdFeaturesCached(nspd, batch.map((item) => item.cadastral), { forceRefresh: Boolean(options.forceRefreshNspd) });
    const pendingWrites = [];
    for (let i = 0; i < batch.length; i++) {
      const target = batch[i];
      const feature = results[i]?.feature;
      const options = feature?.properties?.options || {};
      const source = options.common_property ?? options.service_common_property;
      const value = feature ? commonPropertyValue(source, source !== undefined && source !== null) : NO_INFO;
      const commonProperty = value === 'да';
      pendingWrites.push({ row: target.row, record: { commonPropertyText: value, commonProperty } });
      output.push({ ...target, value, found: Boolean(feature) });
      console.log(`[PROGRESS] ОДИ ${offset + i + 1}/${targets.length} | строка ${target.row}${feature ? '' : ' | карточка не найдена'}`);
    }
    await flushCommonPropertyWrites(sheets, pendingWrites);
  }
  return output;
}

async function writeRosreestrResultToSheet(sheetsPage, row, rosData, hasYellowData) {
  const backgroundColor = rowBackgroundColor(rosData);
  if (hasYellowData) {
    if (rosData.ownershipForm) {
      await pasteRows(sheetsPage, `F${row}`, [{
        cells: [rosData.ownershipForm],
        commonProperty: false,
        backgroundColor: ''
      }]);
    }
    await pasteRows(sheetsPage, `I${row}`, [{
      cells: [rosData.rightType, rosData.rightDate, rosData.rightNumber, rosData.status],
      commonProperty: false,
      backgroundColor
    }]);
    return;
  }

  await pasteRows(sheetsPage, `C${row}`, [{
    cells: [
      rosData.purpose,
      rosData.floor,
      rosData.area,
      rosData.ownershipForm,
      rosData.commonPropertyText || NO_INFO,
      rosData.roomNumber,
      rosData.rightType,
      rosData.rightDate,
      rosData.rightNumber,
      rosData.status
    ],
    commonProperty: false,
    backgroundColor
  }]);
}

async function flushRosreestrWrites(sheetsPage, pending) {
  if (!pending.length) return;
  let group = [];
  const flushGroup = async () => {
    if (!group.length) return;
    await pasteRows(sheetsPage, `I${group[0].row}`, group.map(({ record }) => ({
      cells: [record.rightType, record.rightDate, record.rightNumber, record.status],
      commonProperty: false,
      backgroundColor: rowBackgroundColor(record)
    })));
    group = [];
  };
  for (const item of pending) {
    if (group.length && item.row !== group[group.length - 1].row + 1) await flushGroup();
    group.push(item);
  }
  await flushGroup();
  for (const item of pending.filter((entry) => entry.updateCommonProperty)) {
    await pasteRows(sheetsPage, `G${item.row}`, [{
      cells: [item.record.commonPropertyText],
      commonProperty: item.record.commonProperty,
      backgroundColor: item.record.commonProperty ? config.commonPropertyColor : ''
    }]);
  }
  pending.length = 0;
}

async function flushTurboRosreestrWrites(sheetsPage, pending) {
  if (!pending.length) return;
  let group = [];
  const flushGroup = async () => {
    if (!group.length) return;
    await pasteRows(sheetsPage, `C${group[0].row}`, group.map(({ record }) => ({
      cells: sheetCellsForRecord(record).slice(2),
      commonProperty: Boolean(record.commonProperty),
      backgroundColor: rowBackgroundColor(record)
    })));
    group = [];
  };
  for (const item of pending) {
    if (group.length && item.row !== group[group.length - 1].row + 1) await flushGroup();
    group.push(item);
  }
  await flushGroup();
  pending.length = 0;
}

async function flushCommonPropertyWrites(sheetsPage, pending) {
  if (!pending.length) return;
  let group = [];
  const flushGroup = async () => {
    if (!group.length) return;
    await pasteRows(sheetsPage, `G${group[0].row}`, group.map(({ record }) => ({
      cells: [record.commonPropertyText || NO_INFO],
      commonProperty: Boolean(record.commonProperty),
      backgroundColor: record.commonProperty ? config.commonPropertyColor : ''
    })));
    group = [];
  };
  for (const item of pending) {
    if (group.length && item.row !== group[group.length - 1].row + 1) await flushGroup();
    group.push(item);
  }
  await flushGroup();
  pending.length = 0;
}

async function processRosreestrSheetRow(sheetsPage, rosPage, row, options = {}) {
  const cadastral = options.cadastral !== undefined
    ? oneLine(options.cadastral)
    : oneLine(await readCell(sheetsPage, `B${row}`));
  if (!cadastral) {
    if (!options.quietEmpty) console.log(`\n[Росреестр-only] Строка ${row}: пустой кадастр, пропускаю.`);
    return { empty: true, processed: false };
  }

  const typeText = options.typeText !== undefined
    ? oneLine(options.typeText)
    : oneLine(await readCell(sheetsPage, `C${row}`));
  const hasYellowData = Boolean(typeText);
  if (options.onlyNonResidential && !/нежил/i.test(typeText)) {
    console.log(`\n[Росреестр-only] Строка ${row}: ${cadastral}, тип="${typeText || '-'}" — пропускаю, не нежилое.`);
    return { empty: false, processed: false };
  }

  console.log(`\n[Росреестр-only] Строка ${row}: ${cadastral}`);
  if (config.rosreestrUseApi !== false) {
    const result = await fetchRosreestrObjectApiWithRecovery(rosPage, cadastral);
    if (result.outcome === 'AUTH_REQUIRED') {
      throw new Error('Нужна авторизация в Росреестре. Войдите через ЕСИА и повторите запуск.');
    }
    if (result.outcome === 'FOUND') {
      const rosData = recordFromRosreestrApi(row - 1, cadastral, result.element);
      console.log(`  Росреестр API: статус=${rosData.status || '-'}, права=${rosData.rightType ? 'есть' : 'нет'}`);
      await writeRosreestrResultToSheet(sheetsPage, row, rosData, hasYellowData);
    } else if (result.outcome === 'NOT_FOUND') {
      console.log('  Росреестр API: подтверждённо не найдено.');
      await writeRosreestrResultToSheet(sheetsPage, row, {
        purpose: '', floor: '', area: '', ownershipForm: '', commonPropertyText: NO_INFO,
        roomNumber: '', rightType: '', rightDate: '', rightNumber: '', status: ABSENT
      }, hasYellowData);
    } else {
      console.log(`  Росреестр API: техническая ошибка ${result.outcome}${result.status ? ` (${result.status})` : ''}; строка не изменена.`);
      return { empty: false, processed: false, retry: true };
    }
    return { empty: false, processed: true };
  }
  await humanPause('перед запросом Росреестра');
  const foundRos = await searchRosreestrAndOpenCard(rosPage, cadastral);
  if (foundRos) {
    const rosData = await parseRosreestrCard(rosPage, cadastral);
    console.log(`  Росреестр: статус=${rosData.status || '-'}, права=${rosData.rightType ? 'есть' : 'нет'}`);
    await writeRosreestrResultToSheet(sheetsPage, row, rosData, hasYellowData);
    await returnRosreestrToResults(rosPage);
  } else {
    console.log('  Росреестр: объект не найден или карточка не открылась.');
    await writeRosreestrResultToSheet(sheetsPage, row, {
      purpose: '',
      floor: '',
      area: '',
      ownershipForm: '',
      commonPropertyText: NO_INFO,
      roomNumber: '',
      rightType: '',
      rightDate: '',
      rightNumber: '',
      status: ABSENT
    }, hasYellowData);
  }
  return { empty: false, processed: true };
}

function selectNonResidentialSheetRows(rows, startRow) {
  const targets = [];
  let emptyRows = 0;
  for (let index = 0; index < rows.length; index++) {
    const cadastral = oneLine(rows[index]?.[0]);
    const typeText = oneLine(rows[index]?.[1]);
    if (!cadastral) {
      emptyRows += 1;
      if (emptyRows >= 3) break;
      continue;
    }
    emptyRows = 0;
    if (/нежил/i.test(typeText) && findCadastralNumbers(cadastral).includes(cadastral)) {
      targets.push({ row: startRow + index, cadastral, typeText });
    }
  }
  return targets;
}

async function runRosreestrOnly(sheetsPage, rosPage, startRow, options = {}) {
  console.log(options.onlyNonResidential
    ? `\nРежим Росреестр только по нежилым: начинаю со строки ${startRow}.`
    : `\nРежим только Росреестр: начинаю со строки ${startRow}.`);

  if (options.rows?.length) {
    console.log(`Диапазон строк для проверки: ${options.rows.join(', ')}`);
    for (let index = 0; index < options.rows.length; index++) {
      const row = options.rows[index];
      const result = await processRosreestrSheetRow(sheetsPage, rosPage, row, options);
      console.log(`[PROGRESS] РР ${index + 1}/${options.rows.length} | строка ${row}${result.retry ? ' | требуется повтор' : ''}`);
    }
    return;
  }

  if (options.onlyNonResidential) {
    const lastRow = startRow + Math.max(1, Number(config.maxObjectsPerRun) || 2000) - 1;
    console.log(`Одним чтением получаю B${startRow}:C${lastRow} и заранее фильтрую нежилые помещения.`);
    const sheetRows = await readRange(sheetsPage, `B${startRow}:C${lastRow}`);
    const targets = selectNonResidentialSheetRows(sheetRows, startRow);
    if (!targets.length) {
      console.log('Нежилые помещения не найдены. Запросы в Росреестр не отправлялись.');
      return;
    }
    console.log(`Фильтр завершён: найдено ${targets.length} нежилых строк. Проверяю в Росреестре только их.`);
    const retryTargets = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const result = await processRosreestrSheetRow(sheetsPage, rosPage, target.row, {
        ...options,
        onlyNonResidential: false,
        cadastral: target.cadastral,
        typeText: target.typeText
      });
      if (result.retry) retryTargets.push(target);
      console.log(`[PROGRESS] РР-нежилые ${index + 1}/${targets.length} | строка ${target.row}${result.retry ? ' | отложена' : ''}`);
    }
    if (retryTargets.length) {
      console.log(`\nПовторяю ${retryTargets.length} временно не обработанных нежилых строк.`);
      for (let index = 0; index < retryTargets.length; index++) {
        const target = retryTargets[index];
        const result = await processRosreestrSheetRow(sheetsPage, rosPage, target.row, {
          ...options,
          onlyNonResidential: false,
          cadastral: target.cadastral,
          typeText: target.typeText
        });
        console.log(`[PROGRESS] РР-повтор ${index + 1}/${retryTargets.length} | строка ${target.row}${result.retry ? ' | требуется повторный запуск' : ''}`);
      }
    }
    return;
  }

  let emptyRows = 0;
  for (let row = startRow; row < startRow + config.maxObjectsPerRun; row++) {
    const result = await processRosreestrSheetRow(sheetsPage, rosPage, row, { ...options, quietEmpty: true });
    if (result.empty) {
      emptyRows += 1;
      if (emptyRows >= 3) break;
      continue;
    }
    emptyRows = 0;
    console.log(`[PROGRESS] РР ${row - startRow + 1}/${config.maxObjectsPerRun} | строка ${row}${result.retry ? ' | требуется повтор' : ''}`);
  }
}

async function main() {
  const startRowArg = Number(process.argv[2]);
  const startRow = Number.isFinite(startRowArg) && startRowArg >= 2 ? Math.floor(startRowArg) : 2;
  const skipObjects = startRow - 2;
  const rosOnly = process.argv.includes('--ros-only');
  const nspdOnly = process.argv.includes('--nspd-only');
  const nspdCommonNonResidentialOnly = process.argv.includes('--nspd-common-nonres');
  const rosNonResidentialOnly = process.argv.includes('--ros-nonres-only');
  const rangesArgIndex = process.argv.findIndex((arg) => arg === '--ros-ranges');
  const rangesArgInline = process.argv.find((arg) => arg.startsWith('--ros-ranges='));
  const rangesText = rangesArgInline ? rangesArgInline.slice('--ros-ranges='.length) : (rangesArgIndex >= 0 ? process.argv[rangesArgIndex + 1] : '');
  const rosRangeRows = rangesText ? parseRowRanges(rangesText) : [];
  const rosRangesOnly = rosRangeRows.length > 0;
  const dryRun = process.argv.includes('--dry-run');
  const forceRefreshNspd = process.argv.includes('--refresh-nspd');
  const maxItemsArg = process.argv.find((arg) => arg.startsWith('--max-items='));
  const maxItems = maxItemsArg ? Math.max(0, Number(maxItemsArg.slice('--max-items='.length)) || 0) : 0;

  console.log(`Стартовая строка: ${startRow}`);
  console.log('Подключаюсь к Chrome 9222...');
  const { context } = await getContext();
  const { sheets, nspd, rosreestr, gis } = await preparePages(context, {
    needNspd: nspdOnly || nspdCommonNonResidentialOnly || (!rosOnly && !rosNonResidentialOnly && !rosRangesOnly),
    needRosreestr: !nspdOnly && !nspdCommonNonResidentialOnly,
    needGis: !nspdOnly && !nspdCommonNonResidentialOnly && !rosNonResidentialOnly && !rosRangesOnly
  });

  const buildingCad = await readRequiredCellWithWait(sheets, 'N2');
  const buildingCadCell = 'N2';
  if (!buildingCad) throw new Error('Ячейка N2 пустая. Нужен кадастровый номер МКД.');
  if (!findCadastralNumbers(buildingCad).includes(buildingCad)) {
    throw new Error(`В N2 некорректный кадастровый номер: "${buildingCad}".`);
  }
  console.log(`Кадастр МКД из ${buildingCadCell}: ${buildingCad}`);

  if (rosOnly) {
    await fillRosreestrBuildingArea(sheets, rosreestr, buildingCad);
    await fillGisArea(sheets, gis, buildingCad);
    await runRosreestrOnly(sheets, rosreestr, startRow);
    console.log('\nГотово.');
    return;
  }

  if (rosNonResidentialOnly || rosRangesOnly) {
    await runRosreestrOnly(sheets, rosreestr, startRow, {
      onlyNonResidential: rosNonResidentialOnly,
      rows: rosRangeRows
    });
    console.log('\nГотово.');
    return;
  }

  if (!nspdOnly && !nspdCommonNonResidentialOnly && config.rosreestrUseApi !== false) {
    await runFastFull(sheets, nspd, rosreestr, gis, buildingCad, startRow, { dryRun, maxItems, forceRefreshNspd });
    console.log('\nГотово.');
    return;
  }

  if (nspdOnly) {
    await runFastNspdOnly(sheets, nspd, buildingCad, startRow, { dryRun, maxItems, forceRefreshNspd });
    console.log('\nГотово.');
    return;
  }

  if (nspdCommonNonResidentialOnly) {
    await runNspdCommonPropertyForNonResidential(sheets, nspd, buildingCad, startRow, { forceRefreshNspd });
    console.log('\nГотово.');
    return;
  }

  console.log('Открываю МКД на НСПД и беру площадь/список объектов из карточки...');
  await searchBuildingOnNspd(nspd, buildingCad);
  resetNspdScrollOnNextObject = true;
  const buildingArea = await parseBuildingArea(nspd);
  await writeBuildingArea(sheets, buildingArea);
  const buildingYear = await parseBuildingYear(nspd);
  await writeBuildingYear(sheets, buildingYear);

  let cadastralList = [];
  try {
    const buildingInfo = await getNspdBuildingInfo(nspd, buildingCad);
    cadastralList = await collectNspdObjectCadastralsApi(nspd, buildingInfo);
  } catch (e) {
    console.log(`  НСПД API: список объектов не получился (${e.message || e}). Перехожу на сбор через интерфейс.`);
  }
  if (!cadastralList.length) {
    cadastralList = await collectNspdObjectCadastrals(nspd, buildingCad);
  }
  if (!cadastralList.length) {
    throw new Error('Не удалось собрать список помещений/машино-мест с НСПД.');
  }

  const workList = cadastralList.slice(skipObjects);
  console.log(`К обработке в этом запуске: ${workList.length} объектов (пропущено ${skipObjects}).`);

  console.log(config.nspdUseApiForObjectDetails
    ? '\nЭтап 1/2: быстро собираю поля НСПД через API и заполняю A:H.'
    : '\nЭтап 1/2: кликаю карточки НСПД и заполняю A:H.');
  const records = [];
  let pendingSheetRows = [];
  let pendingStartRow = startRow;
  if (config.nspdUseApiForObjectDetails) {
    const batchSize = config.nspdApiBatchSize || 30;
    for (let offset = 0; offset < workList.length; offset += batchSize) {
      const batch = workList.slice(offset, offset + batchSize);
      console.log(`\n[НСПД API] Пачка ${offset + 1}-${offset + batch.length} из ${workList.length}`);
      const batchResults = await searchNspdFeaturesBatch(nspd, batch);
      const batchRecords = [];

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const cadastral = batch[j];
        const seq = skipObjects + offset + j + 1;
        const row = startRow + offset + j;
        let record = emptyRecord(seq, cadastral);
        if (result?.feature) {
          record = { ...record, ...recordFromNspdFeature(seq, cadastral, result.feature) };
          console.log(`  ${offset + j + 1}/${workList.length}: ${cadastral}, площадь=${record.area || '-'}, этаж=${record.floor || '-'}, адрес=${record.roomNumber || '-'}`);
        } else {
          console.log(`  ${offset + j + 1}/${workList.length}: ${cadastral}, НСПД API не вернул карточку (${result?.status || 'UNKNOWN'}).`);
        }
        records.push({ row, record });
        batchRecords.push(record);
      }

      await pasteRecordRowsInChunks(sheets, startRow + offset, batchRecords, 10, nspdOnly);
    }
  } else {
    for (let i = 0; i < workList.length; i++) {
      const cadastral = workList[i];
      const seq = skipObjects + i + 1;
      const row = startRow + i;
      let record = emptyRecord(seq, cadastral);

      console.log(`\n[НСПД ${i + 1}/${workList.length}] Строка ${row}: кликаю ${cadastral}`);
      const card = await openNspdObjectCard(context, nspd, cadastral);
      if (card.opened) {
        try {
          const nspdData = await parseNspdObjectCard(card.page, cadastral);
          record = { ...record, ...nspdData };
          console.log(`  НСПД: площадь=${record.area || '-'}, этаж=${record.floor || '-'}, адрес=${record.roomNumber || '-'}, общее имущество=${record.commonProperty ? 'да' : 'нет'}`);
        } catch (e) {
          console.log(`  НСПД: не разобрал карточку (${e.message || e}).`);
          const fallback = await nspdApiFallbackRecord(nspd, seq, cadastral);
          if (fallback) record = { ...record, ...fallback };
        } finally {
          await closeNspdObjectCard(nspd, card);
        }
      } else {
        console.log(`  НСПД: карточка не открылась (${card.reason}). Пробую добрать желтые поля через НСПД API.`);
        const fallback = await nspdApiFallbackRecord(nspd, seq, cadastral);
        if (fallback) record = { ...record, ...fallback };
      }

      if ((i + 1) % 10 === 0 || i === workList.length - 1) {
        console.log(`  Получено из НСПД: ${i + 1}/${workList.length}`);
      }

      records.push({ row, record });
      pendingSheetRows.push(record);

      if (pendingSheetRows.length >= 10 || i === workList.length - 1) {
        await pasteRecordRowsInChunks(sheets, pendingStartRow, pendingSheetRows, 10, nspdOnly);
        pendingSheetRows = [];
        pendingStartRow = row + 1;
      }
    }
  }

  await clearRowsAfterRecords(sheets, startRow + records.length, 10, nspdOnly ? 8 : 12);

  if (nspdOnly) {
    console.log('\nРежим только НСПД: A:H, M2 и O2 заполнены. Росреестр и ГИС ЖКХ пропущены.');
    console.log('\nГотово.');
    return;
  }

  await fillRosreestrBuildingArea(sheets, rosreestr, buildingCad);
  await fillGisArea(sheets, gis, buildingCad);

  console.log('\nЭтап 2/2: дозаполняю I:L через Росреестр.');
  for (let i = 0; i < records.length; i++) {
    const { row } = records[i];
    let { record } = records[i];
    const cadastral = record.cadastral;
    console.log(`\n[Росреестр ${i + 1}/${records.length}] Строка ${row}: ${cadastral}`);
    await humanPause('перед запросом Росреестра');
    const foundRos = await searchRosreestrAndOpenCard(rosreestr, cadastral);
    if (foundRos) {
      const rosData = await parseRosreestrCard(rosreestr, cadastral);
      record = mergeRecordWithRosreestr(record, rosData);
      records[i].record = record;
      console.log(`  Росреестр: статус=${record.status || '-'}, права=${record.rightType ? 'есть' : 'нет'}`);
      await writeRecordRow(sheets, row, record);
      await returnRosreestrToResults(rosreestr);
    } else {
      console.log('  Росреестр: объект не найден или карточка не открылась.');
      record.status = record.status || ABSENT;
      records[i].record = record;
      await writeRecordRow(sheets, row, record);
    }
  }

  console.log('\nГотово.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nОШИБКА:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }).finally(async () => {
    if (attachedBrowser) await attachedBrowser.close().catch(() => {});
  });
}

module.exports = {
  parseRowRanges,
  parseClipboardTable,
  selectNonResidentialSheetRows,
  cadastralQuarter,
  belongsToBuildingQuarter,
  nspdCacheEntryIsFresh,
  parseRightsFromText,
  parseGisAreaSum,
  recordFromRosreestrApi,
  recordFromNspdFeature,
  findCadastralNumbers,
  formatRuDate
};
