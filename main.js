const {
  Plugin, ItemView, Notice, MarkdownRenderer, Component,
  Modal, PluginSettingTab, Setting, Platform, Menu, setIcon
} = require('obsidian');

const VIEW_TYPE = 'gongkao-note-roamer';
const GROUP_MODES = {
  paper: '按卷子',
  topic: '按专题',
  module: '按模块',
  region: '按地区',
  mistake: '按错因',
  status: '按状态'
};
const STUDY_MODES = {
  intensive: { name: '卷子精读', short: '精读', description: '把整套卷铺开阅读，可上下连续或左右分页，并逐题分析。' },
  guess: { name: '蒙题训练', short: '蒙题', description: '每题独立限时，提交后总结蒙题线索和技巧。' },
  exam: { name: '考试模式', short: '考试', description: '卷面配窄答题卡，整场倒计时，交卷前隐藏答案与学习工具。' }
};
const PAPER_VIEW_MODES = {
  vertical: { name: '上下连续', description: '整套卷纵向铺开，鼠标滚轮或上下滑动连续浏览。' },
  horizontal: { name: '左右分页', description: '每次一题；鼠标滚轮、按钮或左右滑动均可翻页。' }
};
const DEFAULT_SETTINGS = {
  guessSeconds: 60,
  examMinutes: 120,
  collectionQuestionCount: 20,
  dictionaryPluginId: 'obsidian-multidimensional-table',
  collapseSidebarsOnWindows: false
};

const asArray = value => Array.isArray(value)
  ? value.map(item => String(item == null ? '' : item))
  : (value == null || value === '' ? [] : [String(value)]);
const text = value => String(value == null ? '' : value);
const cleanList = value => asArray(value)
  .flatMap(item => item.split(/[，,]/))
  .map(item => item.replace(/^#/, '').trim())
  .filter(Boolean);
const clampNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function temporaryInkPointerAllowed(pointerType, enabled) {
  if (!enabled) return false;
  const type = text(pointerType).trim().toLowerCase();
  return type === 'pen' || type === 'mouse';
}

function normalizeTemporaryInkPoint(clientX, clientY, rect = {}, pressure = 0.5) {
  const width = Math.max(1, Number(rect.width) || 1);
  const height = Math.max(1, Number(rect.height) || 1);
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const normalizedPressure = Number.isFinite(Number(pressure)) && Number(pressure) > 0
    ? Math.min(1, Math.max(0.1, Number(pressure)))
    : 0.5;
  return {
    x: Math.min(1, Math.max(0, (Number(clientX) - left) / width)),
    y: Math.min(1, Math.max(0, (Number(clientY) - top) / height)),
    pressure: normalizedPressure
  };
}

function addTemporaryInkStroke(strokesByPath, path, stroke) {
  if (!(strokesByPath instanceof Map) || !text(path).trim() || !stroke?.points?.length) return 0;
  const strokes = [...(strokesByPath.get(path) || []), stroke];
  strokesByPath.set(path, strokes);
  return strokes.length;
}

function undoTemporaryInkStroke(strokesByPath, path) {
  if (!(strokesByPath instanceof Map)) return 0;
  const strokes = [...(strokesByPath.get(path) || [])];
  if (strokes.length) strokes.pop();
  if (strokes.length) strokesByPath.set(path, strokes);
  else strokesByPath.delete(path);
  return strokes.length;
}

function clearTemporaryInkForPath(strokesByPath, path) {
  if (!(strokesByPath instanceof Map)) return false;
  return strokesByPath.delete(path);
}

function studyModeClickAction(previous = {}, key, now = Date.now(), threshold = 420) {
  const sameMode = text(previous.key).trim() === text(key).trim();
  const elapsed = Number(now) - Number(previous.at || 0);
  const start = Boolean(sameMode && elapsed >= 0 && elapsed <= threshold);
  return {
    start,
    next: start ? { key: '', at: 0 } : { key, at: Number(now) || Date.now() }
  };
}

function findMetadataContainer(host) {
  if (!host?.querySelector) return null;
  return host.querySelector(
    '.markdown-preview-view .metadata-container, .markdown-source-view .metadata-container, .metadata-container'
  );
}

function metadataNativeCollapsed(container) {
  if (!container) return null;
  if (container.classList?.contains?.('is-collapsed')) return true;
  const expanded = container.getAttribute?.('aria-expanded')
    ?? container.querySelector?.('[aria-expanded]')?.getAttribute?.('aria-expanded');
  if (expanded === 'true') return false;
  if (expanded === 'false') return true;
  return null;
}

function metadataIsCollapsed(container) {
  if (!container) return null;
  if (container.classList?.contains?.('gkr-metadata-collapsed')) return true;
  const tracked = container.getAttribute?.('data-gkr-metadata-expanded');
  if (tracked === 'true') return false;
  if (tracked === 'false') return true;
  const nativeState = metadataNativeCollapsed(container);
  if (nativeState !== null) return nativeState;
  return null;
}

function metadataToggleTarget(container) {
  return container?.querySelector?.(
    '.metadata-properties-heading, .metadata-properties-title, .collapse-indicator, [aria-expanded]'
  ) || null;
}

function setMetadataCollapsed(container, collapsed) {
  if (!container?.classList) return false;
  const desired = Boolean(collapsed);
  const nativeState = metadataNativeCollapsed(container);
  const target = metadataToggleTarget(container);
  if (nativeState !== null && nativeState !== desired && typeof target?.click === 'function') target.click();
  if (nativeState !== null) container.classList.toggle('is-collapsed', desired);
  container.classList.toggle('gkr-metadata-collapsed', desired);
  container.setAttribute?.('data-gkr-metadata-expanded', String(!desired));
  return true;
}
const formatTime = totalSeconds => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const uniqueStrings = values => [...new Set(asArray(values).map(value => text(value).trim()).filter(Boolean))];

function internalLinkTarget(dataHref, href = '') {
  return text(dataHref || href).trim();
}

function shouldCollapseRoamerSidebars(platform = {}, collapseOnWindows = false) {
  const isMobile = Boolean(platform.isMobile || platform.isMobileApp || platform.isPhone || platform.isTablet);
  return isMobile || Boolean(platform.isWin && collapseOnWindows);
}

function correctAnswerKeys(value) {
  return new Set(text(value).toUpperCase().match(/[A-H]/g) || []);
}

function singleCorrectAnswerKey(value) {
  const keys = [...correctAnswerKeys(value)];
  return keys.length === 1 ? keys[0] : '';
}

function guessChoicePresentation(choice, selectedChoice, correctAnswer, revealed) {
  const selected = text(choice).toUpperCase() === text(selectedChoice).toUpperCase();
  const correct = Boolean(revealed && singleCorrectAnswerKey(correctAnswer) === text(choice).toUpperCase());
  return {
    selected,
    correct,
    wrong: Boolean(revealed && selected && !correct),
    canAdvance: correct,
    disabled: Boolean(revealed && !correct)
  };
}

function guessChoiceAction(clickedChoice, selectedChoice, correctAnswer, revealed) {
  const clicked = text(clickedChoice).trim().toUpperCase();
  const selected = text(selectedChoice).trim().toUpperCase();
  if (!clicked) return 'ignore';
  if (revealed) return singleCorrectAnswerKey(correctAnswer) === clicked ? 'advance' : 'ignore';
  return selected === clicked ? 'submit' : 'select';
}

function canUseGuessNextButton(revealed, correctAnswer) {
  return Boolean(revealed && !singleCorrectAnswerKey(correctAnswer));
}

function collectionIdentity(question) {
  return text(question.sourceQid || question.questionId || question.path).trim();
}

function normalizedIntensiveStatus(value) {
  const status = text(value).trim().toLowerCase();
  return ['completed', 'complete', 'done', '已完成', '完成'].includes(status) ? 'completed' : 'pending';
}

function applyIntensiveFrontmatter(fm, completed, now = new Date().toISOString()) {
  fm.intensive_status = completed ? 'completed' : 'pending';
  fm.intensive_updated_at = now;
  if (completed) fm.intensive_completed_at = now;
  else delete fm.intensive_completed_at;
  return fm;
}

function collectionProgress(items) {
  const total = items?.length || 0;
  const completed = (items || []).filter(item => item.intensiveDone).length;
  const percent = total ? Math.round(completed / total * 100) : 0;
  return {
    total,
    completed,
    percent,
    status: percent === 100 && total ? 'completed' : completed ? 'in-progress' : 'not-started',
    label: percent === 100 && total ? '精读完成' : completed ? '精读中' : '未开始精读'
  };
}

function selectSessionQuestions(items, mode, requestedCount, random = Math.random) {
  const source = [...(items || [])];
  if (mode === 'paper') return source;
  const count = Math.min(source.length, Math.max(1, Math.floor(Number(requestedCount) || 1)));
  if (count >= source.length) return source;
  for (let index = source.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [source[index], source[swapIndex]] = [source[swapIndex], source[index]];
  }
  return source.slice(0, count);
}

function wheelPageDirection({ deltaX = 0, deltaY = 0, scrollTop = 0, scrollHeight = 0, clientHeight = 0, threshold = 48 } = {}) {
  const delta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  if (Math.abs(delta) < threshold) return 0;
  const atTop = scrollTop <= 1;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  if (delta < 0 && atTop) return -1;
  if (delta > 0 && atBottom) return 1;
  return 0;
}

function horizontalPageMotion(direction, reducedMotion = false) {
  const forward = direction >= 0;
  if (reducedMotion) {
    return {
      exit: [{ opacity: 1 }, { opacity: 0.72 }],
      enter: [{ opacity: 0.72 }, { opacity: 1 }],
      exitDuration: 90,
      enterDuration: 130
    };
  }
  return {
    exit: [
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      { transform: `translate3d(${forward ? '-14%' : '14%'}, 0, 0)`, opacity: 0.18 }
    ],
    enter: [
      { transform: `translate3d(${forward ? '16%' : '-16%'}, 0, 0)`, opacity: 0.28 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ],
    exitDuration: 135,
    enterDuration: 210
  };
}

function noPhysicalBlankLines(value) {
  return text(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n[\t ]*\n+/g, '<br>\n')
    .trim();
}

function markdownForDisplay(value) {
  return text(value)
    .replace(/\r\n?/g, '\n')
    .replace(/(<\/(?:p|div|table|figure|blockquote|ul|ol)>|<br\s*\/?\s*>)\s*\n(?=(?:#{1,6}\s|[-*+]\s|>\s|\|))/gi, '$1\n\n')
    .replace(/^##\s+题目\s*\n?/gm, '')
    .trim();
}

function vaultImagePath(src, sourcePath) {
  if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) return null;
  let decoded;
  try { decoded = decodeURIComponent(src.split(/[?#]/)[0]); } catch { decoded = src.split(/[?#]/)[0]; }
  decoded = decoded.replace(/\\/g, '/');
  const parts = decoded.startsWith('/') ? [] : sourcePath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function resolveRenderedImages(app, parent, sourcePath) {
  for (const image of parent.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    const path = vaultImagePath(src, sourcePath);
    if (!path) continue;
    let file = app.vault.getAbstractFileByPath(path);
    if (!file) file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file || !('extension' in file)) {
      image.setAttribute('alt', image.getAttribute('alt') || `图片文件未找到：${path}`);
      image.setAttribute('title', `图片文件未找到：${path}。请检查 iCloud 下载及目录结构。`);
      continue;
    }
    image.setAttribute('src', app.vault.getResourcePath(file));
  }
}

function hideWikiLinkPreview(value) {
  return text(value).replace(/(^|[^!])\[\[([^\]]+)\]\]/gm, (match, prefix, inside) => {
    const parts = text(inside).split('|');
    const target = parts.shift()?.trim() || '';
    const alias = parts.join('|').trim();
    const targetWithoutHeading = target.split('#')[0];
    const fallback = targetWithoutHeading.split('/').pop()?.replace(/\.md$/i, '') || target;
    return prefix + (alias || fallback);
  });
}

function markdownForStudyMode(value, studyMode, linkPreviewEnabled) {
  if (!['guess', 'exam'].includes(text(studyMode))) return text(value);
  return linkPreviewEnabled ? text(value) : hideWikiLinkPreview(value);
}

function hideAnswerMarkers(value) {
  return text(value)
    .replace(/(?:[\t \u3000]*✅)+(?=[\t ]*(?:<br\s*\/?\s*>)?[\t ]*$)/gim, '')
    .trim();
}

function wikiLink(path, alias = '') {
  const target = text(path).replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\[\[|\]\]$/g, '').trim();
  const cleanAlias = text(alias).replace(/[\[\]|\r\n]+/g, ' ').trim();
  return target ? `[[${target}${cleanAlias ? `|${cleanAlias}` : ''}]]` : '';
}

function titleSimilarity(left, right) {
  const normalize = value => text(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.78 + 0.2 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const pairs = value => {
    const result = new Set();
    for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
    return result;
  };
  const aPairs = pairs(a);
  const bPairs = pairs(b);
  if (!aPairs.size || !bPairs.size) return 0;
  let overlap = 0;
  for (const pair of aPairs) if (bPairs.has(pair)) overlap += 1;
  return 2 * overlap / (aPairs.size + bPairs.size);
}

function findPotentialLinkCandidates(query, files, app, currentPath = '') {
  const selected = text(query).trim();
  if (!selected) return [];
  const candidates = [];
  for (const file of files || []) {
    if (!file || file.path === currentPath) continue;
    const fm = frontmatter(file, app);
    const names = uniqueStrings([file.basename, fm.title, ...asArray(fm.aliases), ...asArray(fm.keywords)]);
    const score = Math.max(...names.map(name => titleSimilarity(selected, name)), 0);
    if (score < 0.45) continue;
    candidates.push({
      type: text(fm.note_type || fm.entity_type).includes('lexicon') ? '词典' : '笔记',
      title: text(fm.title || file.basename).trim() || file.basename,
      path: file.path,
      score,
      file,
      fm
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN')).slice(0, 20);
}

function findUnlinkedOccurrence(source, selection) {
  let index = source.indexOf(selection);
  while (index >= 0) {
    const open = source.lastIndexOf('[[', index);
    const close = source.lastIndexOf(']]', index);
    if (open <= close) return index;
    index = source.indexOf(selection, index + selection.length);
  }
  return -1;
}

function insertWikiLinkInQuestionSource(source, selection, targetPath, section = '题目') {
  const normalized = text(source).replace(/\r\n?/g, '\n');
  const selected = text(selection).trim();
  if (!selected || /[\r\n]/.test(selected)) return { changed: false, reason: '选中文字必须位于同一行。', content: normalized };
  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\n---\n?/);
  const bodyStart = frontmatterMatch ? frontmatterMatch[0].length : 0;
  const sourceMatch = /^##\s+来源\s*$/m.exec(normalized.slice(bodyStart));
  const contentEnd = sourceMatch ? bodyStart + sourceMatch.index : normalized.length;
  const content = normalized.slice(bodyStart, contentEnd);
  const separator = /^\?\s*$/m.exec(content);
  if (!separator) return { changed: false, reason: '没有找到题目与答案的 ? 分隔符。', content: normalized };
  const isAnswer = section === '答案解析';
  const segmentStart = bodyStart + (isAnswer ? separator.index + separator[0].length : 0);
  const segmentEnd = bodyStart + (isAnswer ? content.length : separator.index);
  const segment = normalized.slice(segmentStart, segmentEnd);
  const link = wikiLink(targetPath, selected);
  if (!link) return { changed: false, reason: '目标笔记路径无效。', content: normalized };
  if (segment.includes(link)) return { changed: false, alreadyLinked: true, content: normalized, link };
  const relativeIndex = findUnlinkedOccurrence(segment, selected);
  if (relativeIndex < 0) return { changed: false, reason: '没有在对应题目区找到完全一致的原文。', content: normalized };
  const absoluteIndex = segmentStart + relativeIndex;
  return {
    changed: true,
    content: normalized.slice(0, absoluteIndex) + link + normalized.slice(absoluteIndex + selected.length),
    link
  };
}

function questionSectionRanges(source) {
  const normalized = text(source).replace(/\r\n?/g, '\n');
  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\n---\n?/);
  const bodyStart = frontmatterMatch ? frontmatterMatch[0].length : 0;
  const sourceMatch = /^##\s+来源\s*$/m.exec(normalized.slice(bodyStart));
  const contentEnd = sourceMatch ? bodyStart + sourceMatch.index : normalized.length;
  const content = normalized.slice(bodyStart, contentEnd);
  const separator = /^\?\s*$/m.exec(content);
  if (!separator) return { normalized, ranges: [] };
  return {
    normalized,
    ranges: [
      { section: '题目', start: bodyStart, end: bodyStart + separator.index },
      { section: '答案解析', start: bodyStart + separator.index + separator[0].length, end: contentEnd }
    ]
  };
}

function protectedMarkdownRanges(value) {
  const ranges = [];
  const source = text(value);
  const patterns = [
    /!?\[\[[^\]]*?\]\]/g,
    /!?\[[^\]]*?\]\([^\n)]*?\)/g,
    /`[^`\n]*`/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges.sort((left, right) => left[0] - right[0]);
}

function findUnlinkedOccurrences(source, query) {
  const value = text(source);
  const term = text(query).trim();
  if (!term || /[\r\n]/.test(term)) return [];
  const protectedRanges = protectedMarkdownRanges(value);
  const result = [];
  let index = value.indexOf(term);
  let rangeIndex = 0;
  while (index >= 0) {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex][1] <= index) rangeIndex += 1;
    const protectedRange = protectedRanges[rangeIndex];
    const overlapsProtected = Boolean(protectedRange && index < protectedRange[1] && index + term.length > protectedRange[0]);
    if (!overlapsProtected) result.push(index);
    index = value.indexOf(term, index + term.length);
  }
  return result;
}

function scanQuestionSourceForTerm(source, query) {
  const { normalized, ranges } = questionSectionRanges(source);
  const sections = { '题目': 0, '答案解析': 0 };
  for (const range of ranges) sections[range.section] = findUnlinkedOccurrences(normalized.slice(range.start, range.end), query).length;
  return { total: sections['题目'] + sections['答案解析'], sections };
}

function linkAllOccurrencesInQuestionSource(source, query, targetPath) {
  const { normalized, ranges } = questionSectionRanges(source);
  const term = text(query).trim();
  const link = wikiLink(targetPath, term);
  if (!ranges.length || !term || !link || /[\r\n]/.test(term)) {
    return { changed: false, content: normalized, total: 0, sections: { '题目': 0, '答案解析': 0 } };
  }
  const replacements = [];
  const sections = { '题目': 0, '答案解析': 0 };
  for (const range of ranges) {
    const indexes = findUnlinkedOccurrences(normalized.slice(range.start, range.end), term);
    sections[range.section] = indexes.length;
    for (const index of indexes) replacements.push(range.start + index);
  }
  let content = normalized;
  for (const index of replacements.sort((left, right) => right - left)) {
    content = content.slice(0, index) + link + content.slice(index + term.length);
  }
  return { changed: replacements.length > 0, content, total: replacements.length, sections, link };
}

function questionsForBacklinkScope(questions, origin, scope, topic = '') {
  const source = questions || [];
  if (scope === 'question') return source.filter(item => item.path === origin.path);
  if (scope === 'paper') {
    const identity = text(origin.paperId || origin.paperTitle).trim();
    if (!identity) return source.filter(item => item.path === origin.path);
    return source.filter(item => text(item.paperId || item.paperTitle).trim() === identity);
  }
  if (scope === 'topic') {
    const selectedTopic = text(topic).trim();
    return selectedTopic ? source.filter(item => item.topics?.includes(selectedTopic)) : [];
  }
  return [...source];
}

function pluginStoragePath(manifest = {}, filename = '') {
  const id = text(manifest.id || 'gongkao-note-roamer').trim().replace(/[^a-z0-9-_]/gi, '') || 'gongkao-note-roamer';
  const leaf = text(filename).trim().replace(/[\\/]+/g, '-');
  return `.obsidian/${id}-${leaf}`;
}

function lexiconPotentialTermIndex(entries = []) {
  const byTerm = new Map();
  let skippedShort = 0;
  for (const entry of entries || []) {
    if (!entry?.path || !text(entry.title).trim()) continue;
    const names = uniqueStrings([entry.title, ...asArray(entry.aliases)]);
    for (const name of names) {
      const term = text(name).trim();
      if (Array.from(term).length < 2 || /[\r\n]/.test(term)) {
        skippedShort += 1;
        continue;
      }
      const key = term.toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
      const bucket = byTerm.get(key) || { spellings: new Set(), entries: new Map() };
      bucket.spellings.add(term);
      bucket.entries.set(entry.path, entry);
      byTerm.set(key, bucket);
    }
  }
  const terms = [];
  const ambiguous = [];
  for (const bucket of byTerm.values()) {
    const spellings = [...bucket.spellings].sort((left, right) => left.length - right.length || left.localeCompare(right, 'zh-CN'));
    const linkedEntries = [...bucket.entries.values()];
    if (linkedEntries.length !== 1) {
      ambiguous.push({ term: spellings[0], entries: linkedEntries });
      continue;
    }
    terms.push({ term: spellings[0], entry: linkedEntries[0] });
  }
  terms.sort((left, right) => right.term.length - left.term.length || left.term.localeCompare(right.term, 'zh-CN'));
  return { terms, ambiguous, skippedShort };
}

function dedupeCollectionQuestions(questions = [], mode = 'topic') {
  const byIdentity = new Map();
  const pathRank = path => {
    const value = text(path).replace(/\\/g, '/');
    if (value.startsWith('题库/')) return 0;
    if (value.includes('/题库/')) return 2;
    return 1;
  };
  for (const question of questions || []) {
    const identity = mode === 'paper'
      ? text(question.questionId || `${question.paperId || question.paperTitle}:${question.questionNo}`).trim()
      : collectionIdentity(question);
    const key = identity || question.path;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, question);
      continue;
    }
    const currentRank = pathRank(question.path);
    const existingRank = pathRank(existing.path);
    if (currentRank < existingRank || (currentRank === existingRank && question.path.length < existing.path.length)) {
      byIdentity.set(key, question);
    }
  }
  return [...byIdentity.values()];
}

async function scanCollectionPotentialLinks(questions = [], entries = [], readSource, onProgress = null) {
  const index = lexiconPotentialTermIndex(entries);
  const groups = new Map();
  const sourceQuestions = questions || [];
  for (let questionIndex = 0; questionIndex < sourceQuestions.length; questionIndex += 1) {
    const question = sourceQuestions[questionIndex];
    const source = await readSource(question);
    for (const item of index.terms) {
      if (!source.includes(item.term)) continue;
      const match = scanQuestionSourceForTerm(source, item.term);
      if (!match.total) continue;
      const id = `${item.entry.path}\u0000${item.term}`;
      const group = groups.get(id) || {
        id,
        query: item.term,
        candidate: {
          type: '词典', title: item.entry.title, path: item.entry.path,
          score: 1, entry: item.entry, file: item.entry.file
        },
        occurrences: [],
        total: 0
      };
      const originalNumber = question.questionNo === 999999 ? '?' : question.questionNo;
      group.occurrences.push({
        path: question.path,
        total: match.total,
        sections: match.sections,
        label: `${question.paperTitle || question.name} · 第 ${originalNumber} 题`,
        summary: `题目 ${match.sections['题目']} 处 · 答案解析 ${match.sections['答案解析']} 处`
      });
      group.total += match.total;
      groups.set(id, group);
    }
    onProgress?.({ completed: questionIndex + 1, total: sourceQuestions.length });
  }
  const candidates = [...groups.values()].sort((left, right) =>
    right.total - left.total
    || left.candidate.title.localeCompare(right.candidate.title, 'zh-CN')
    || left.query.localeCompare(right.query, 'zh-CN'));
  return { candidates, ambiguous: index.ambiguous, skippedShort: index.skippedShort, entryCount: entries.length };
}

function activeTextSelectionWithin(element) {
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(anchor && element?.contains?.(anchor) && (!focus || element.contains(focus)));
}

function horizontalSwipeDirection({ startX, startY, endX, endY, width, duration = 0, edge = 30, hasSelection = false, selectableLongPress = false } = {}) {
  if (![startX, startY, endX, endY, width].every(Number.isFinite)) return 0;
  if (hasSelection || selectableLongPress) return 0;
  if (startX <= edge || startX >= width - edge) return 0;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  if (duration > 420 || Math.abs(deltaX) < 82 || Math.abs(deltaX) < Math.abs(deltaY) * 1.55) return 0;
  return deltaX < 0 ? 1 : -1;
}

function frontmatter(file, app) {
  return app.metadataCache.getFileCache(file)?.frontmatter || {};
}

function normalizeQuestion(file, app) {
  const fm = frontmatter(file, app);
  const noteType = text(fm.note_type || fm.type || '').toLowerCase();
  const topics = cleanList(fm.topics || fm.topic);
  const mistakes = cleanList(fm.mistakes || fm.mistake);
  const questionNo = Number(fm.question_no ?? fm.questionNo ?? fm.题号);
  const paperId = text(fm.paper_id || fm.paperId || fm.试卷id).trim();
  const paperTitle = text(fm.paper_title || fm.paperTitle || fm.试卷 || paperId).trim();
  const year = Number(fm.year || fm.年份);
  return {
    file,
    path: file.path,
    name: file.basename,
    noteType,
    topics,
    mistakes,
    questionNo: Number.isFinite(questionNo) ? questionNo : 999999,
    questionId: text(fm.question_id || fm.questionId).trim(),
    sourceQid: text(fm.source_qid || fm.sourceQid).trim(),
    paperId,
    paperTitle,
    year: Number.isFinite(year) ? year : 0,
    region: text(fm.region || fm.地区).trim(),
    status: text(fm.status || fm.state || '').trim(),
    module: text(fm.module || fm.major_module || '').trim(),
    subject: text(fm.subject || fm.科目 || '').trim(),
    reviewReady: Boolean(fm.review_ready),
    intensiveDone: normalizedIntensiveStatus(fm.intensive_status || fm.intensiveStatus) === 'completed',
    fm
  };
}

function stripFrontmatter(source) {
  const normalized = text(source).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return normalized;
  const after = normalized.indexOf('\n', end + 4);
  return after < 0 ? '' : normalized.slice(after + 1);
}

function removeDisplayNoise(markdown) {
  const lines = text(markdown).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines[0]?.match(/^#\s+/)) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines[0] && /^#\S+(?:\s+#\S+|[、,，]\S+)*\s*$/.test(lines[0].trim())) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join('\n').trim();
}

function parseOptions(markdown) {
  const options = [];
  for (const line of text(markdown).split('\n')) {
    const match = line.match(/^\s*(?:[-*+]\s*)?(?:\*\*)?([A-H])(?:\*\*)?[\.．、]\s*(.+?)\s*$/i);
    if (match) options.push({
      key: match[1].toUpperCase(),
      label: match[2]
        .replace(/(?:　|\s)*✅\s*$/, '')
        .replace(/(?:\s*<br\s*\/?\s*>)+\s*$/i, '')
        .trim()
    });
  }
  return options;
}

function questionStem(markdown) {
  return text(markdown).split('\n')
    .filter(line => !/^\s*(?:[-*+]\s*)?(?:\*\*)?[A-H](?:\*\*)?[\.．、]\s*.+$/i.test(line))
    .join('\n')
    .trim();
}

function optionNeedsMarkdown(value) {
  return /(?:!\[\[|\[\[|!\[[^\]]*\]\(|<[^>]+>|\$|`|\*\*|__|~~)/.test(text(value));
}

function detectCorrectAnswer(answerMarkdown, fm = {}) {
  const rawCandidates = [fm.correct_answer, fm.correctAnswer, fm.answer, fm.答案];
  for (const raw of rawCandidates) {
    if (!Array.isArray(raw) || !raw.length) continue;
    const values = raw.map(value => text(value).trim().toUpperCase());
    if (values.every(value => /^[A-H]$/.test(value))) return [...new Set(values)].join('');
  }
  const candidates = rawCandidates.flatMap(asArray)
    .map(value => text(value).trim().toUpperCase()).filter(Boolean);
  for (const candidate of candidates) {
    if (/^[A-H](?:\s*[,，、]\s*[A-H])*$/.test(candidate)) {
      return [...new Set(candidate.match(/[A-H]/g))].join('');
    }
  }
  const explicit = text(answerMarkdown).match(/(?:正确答案|标准答案|答案)\s*[:：]?\s*([A-H](?:\s*[,，、]\s*[A-H])*)/i);
  if (!explicit) return '';
  return [...new Set(explicit[1].toUpperCase().match(/[A-H]/g) || [])].join('');
}

function parseQuestionDocument(source, fm = {}) {
  const body = stripFrontmatter(source);
  const sourceMatch = body.match(/^##\s+来源\s*$/m);
  const contentEnd = sourceMatch ? sourceMatch.index : body.length;
  const sourceMarkdown = sourceMatch ? body.slice(sourceMatch.index).trim() : '';
  const content = body.slice(0, contentEnd).trim();
  const separator = /^\?\s*$/m.exec(content);
  const questionMarkdown = removeDisplayNoise(separator ? content.slice(0, separator.index) : content);
  const answerMarkdown = separator
    ? content.slice(separator.index + separator[0].length).trim()
    : '';
  const options = parseOptions(questionMarkdown);
  return {
    questionMarkdown,
    stemMarkdown: questionStem(questionMarkdown),
    answerMarkdown,
    sourceMarkdown,
    options,
    correctAnswer: detectCorrectAnswer(answerMarkdown, fm),
    hasAnswerSection: Boolean(separator)
  };
}

function keysForQuestion(question, mode) {
  if (mode === 'paper') return [question.paperId || '未归卷'];
  if (mode === 'topic') return question.topics.length ? question.topics : ['未分类专题'];
  if (mode === 'module') return [question.module || '未标模块'];
  if (mode === 'region') return [question.region || '未标地区'];
  if (mode === 'status') return [question.status || '未标状态'];
  return question.mistakes.length ? question.mistakes : ['未分类错因'];
}

function buildCollections(questions, mode) {
  const groups = new Map();
  for (const question of questions) {
    for (const rawKey of keysForQuestion(question, mode)) {
      const key = text(rawKey).replace(/^#/, '').trim();
      if (!key) continue;
      const current = groups.get(key) || {
        key,
        title: mode === 'paper' ? (question.paperTitle || key) : key,
        items: [],
        identityIndexes: new Map()
      };
      const identity = mode === 'paper' ? question.path : collectionIdentity(question);
      if (identity && current.identityIndexes.has(identity)) {
        const existingIndex = current.identityIndexes.get(identity);
        if (question.intensiveDone && !current.items[existingIndex]?.intensiveDone) current.items[existingIndex] = question;
        continue;
      }
      current.items.push(question);
      if (identity) current.identityIndexes.set(identity, current.items.length - 1);
      groups.set(key, current);
    }
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => {
      if (mode === 'paper') return a.questionNo - b.questionNo || a.path.localeCompare(b.path);
      return b.year - a.year || a.paperTitle.localeCompare(b.paperTitle, 'zh-CN') || a.questionNo - b.questionNo;
    });
  }
  return [...groups.values()]
    .map(({ identityIndexes, ...group }) => group)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

function mergeFrontmatterFields(original, patch) {
  const next = { ...original };
  for (const key of ['topics', 'mistakes', 'status', 'review_ready']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  return next;
}

function buildLexiconPayload(question, parsed, selection, section) {
  const context = section === '答案解析' ? parsed.answerMarkdown : parsed.questionMarkdown;
  return {
    text: noPhysicalBlankLines(selection),
    context: noPhysicalBlankLines(text(context).slice(0, 1600)),
    sourcePath: question.path,
    sourceSection: section,
    sourceTitle: question.name,
    tags: ['漫游收集']
  };
}

function timerSnapshot(now, start, deadline) {
  return {
    elapsedSeconds: Math.max(0, Math.floor((now - start) / 1000)),
    remainingSeconds: deadline == null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)),
    expired: deadline != null && now >= deadline
  };
}

function sessionSurfaceForMode(mode) {
  if (mode === 'intensive') return 'paper';
  if (mode === 'exam') return 'exam';
  return 'single';
}

function roamerReturnDescriptor(state = {}) {
  if (state.screen === 'review') return { short: '返回考试复盘', full: '返回漫游中的考试复盘' };
  if (state.screen === 'results') return { short: '返回考试成绩', full: '返回漫游中的考试成绩' };
  if (state.studyMode === 'exam') return { short: '返回考试', full: '返回漫游考试' };
  if (state.studyMode === 'guess') return { short: '返回蒙题', full: '返回漫游蒙题' };
  if (state.studyMode === 'intensive' && state.groupMode === 'paper') {
    return { short: '返回卷子精读', full: '返回漫游中的卷子精读' };
  }
  if (state.studyMode === 'intensive' && state.groupMode === 'topic') {
    return { short: '返回专题精读', full: '返回漫游中的专题精读' };
  }
  if (state.studyMode === 'intensive') return { short: '返回精读', full: '返回漫游精读' };
  return { short: '返回漫游', full: '返回考公笔记漫游' };
}

class ConfirmModal extends Modal {
  constructor(app, title, message, onConfirm) {
    super(app);
    this.titleText = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gkr-modal');
    contentEl.createEl('h2', { text: this.titleText });
    contentEl.createEl('p', { text: this.message, cls: 'gkr-muted-copy' });
    const actions = contentEl.createDiv({ cls: 'gkr-modal-actions' });
    const cancel = actions.createEl('button', { text: '继续作答' });
    cancel.addEventListener('click', () => this.close());
    const confirm = actions.createEl('button', { text: '确认交卷', cls: 'mod-cta' });
    confirm.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }
  onClose() { this.contentEl.empty(); }
}

class MetadataModal extends Modal {
  constructor(app, question, onSave) {
    super(app);
    this.question = question;
    this.onSave = onSave;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gkr-modal');
    contentEl.createEl('h2', { text: '补充题目元数据' });
    contentEl.createEl('p', { text: this.question.name, cls: 'gkr-muted-copy' });
    const makeInput = (label, value, placeholder) => {
      const row = contentEl.createDiv({ cls: 'gkr-field' });
      row.createEl('label', { text: label });
      return row.createEl('input', { type: 'text', value, placeholder });
    };
    const topics = makeInput('专题（逗号分隔）', this.question.topics.join('，'), '例如：资料分析，增长率');
    const mistakes = makeInput('错因（逗号分隔）', this.question.mistakes.join('，'), '例如：审题遗漏，计算错误');
    const statusRow = contentEl.createDiv({ cls: 'gkr-field' });
    statusRow.createEl('label', { text: '学习状态' });
    const status = statusRow.createEl('select');
    const statusOptions = [['new', '新题'], ['learning', '学习中'], ['wrong', '错题'], ['mastered', '已掌握']];
    if (this.question.status && !statusOptions.some(([value]) => value === this.question.status)) {
      statusOptions.unshift([this.question.status, `保留现有状态：${this.question.status}`]);
    }
    statusOptions.forEach(([value, label]) => {
      const option = status.createEl('option', { text: label, value });
      option.selected = this.question.status === value;
    });
    const reviewRow = contentEl.createDiv({ cls: 'gkr-check-field' });
    const reviewReady = reviewRow.createEl('input', { type: 'checkbox' });
    reviewReady.checked = this.question.reviewReady;
    reviewRow.createEl('span', { text: '允许复习插件读取（review_ready）' });
    const actions = contentEl.createDiv({ cls: 'gkr-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await this.onSave({
          topics: cleanList(topics.value),
          mistakes: cleanList(mistakes.value),
          status: status.value,
          review_ready: reviewReady.checked
        });
        this.close();
      } catch (error) {
        save.disabled = false;
        new Notice(`保存失败：${error.message}`);
      }
    });
  }
  onClose() { this.contentEl.empty(); }
}

class KnowledgeLinkModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.query = text(options.selection).trim();
    this.renderVersion = 0;
    this.scope = options.initialScope || 'question';
    this.topic = options.initialTopic || options.topics?.[0] || '';
    this.selectedOccurrencePaths = new Set();
  }

  async onOpen() {
    this.modalEl.addClass('gkr-knowledge-modal');
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createDiv({ cls: 'gkr-knowledge-head' });
    head.createSpan({ text: 'LINK / CAPTURE', cls: 'gkr-kicker' });
    head.createEl('h2', { text: '关联知识' });
    head.createEl('p', { text: '可以先修正没有选全的检索词，再关联已有词条或直接新建。当前题处理完后，再由你决定是否扫描整卷或当前专题。', cls: 'gkr-muted-copy' });
    if (!this.options.initialCandidate) {
      const searchRow = contentEl.createDiv({ cls: 'gkr-knowledge-search' });
      this.inputEl = searchRow.createEl('input', {
        type: 'search',
        value: this.query,
        placeholder: '输入词语、概念或方法关键词',
        attr: { 'aria-label': '查找潜在双链' }
      });
      const createButton = searchRow.createEl('button', { text: '直接新建词条', cls: 'mod-cta' });
      createButton.type = 'button';
      createButton.addEventListener('click', () => this.createEntry());
      this.inputEl.addEventListener('input', () => {
        this.query = this.inputEl.value.trim();
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.renderCandidates(), 160);
      });
    }
    this.resultsEl = contentEl.createDiv({ cls: 'gkr-knowledge-results' });
    if (this.options.initialCandidate) await this.renderOccurrencePlanner(this.options.initialCandidate, this.query);
    else await this.renderCandidates();
  }

  async createEntry() {
    const query = this.inputEl?.value.trim() || this.query;
    if (!query) {
      new Notice('请先输入要建立的词条名称。');
      return;
    }
    this.close();
    await this.options.onCreate(query);
  }

  async renderCandidates() {
    const version = ++this.renderVersion;
    const query = this.inputEl?.value.trim() || this.query;
    this.resultsEl.empty();
    if (!query) {
      this.resultsEl.createEl('p', { text: '输入关键词后显示潜在双链。', cls: 'gkr-muted-copy' });
      return;
    }
    this.resultsEl.createDiv({ cls: 'gkr-knowledge-loading', text: '正在查找已有词条与笔记…' });
    const candidates = await this.options.findCandidates(query);
    if (version !== this.renderVersion) return;
    this.resultsEl.empty();
    if (!candidates.length) {
      const empty = this.resultsEl.createDiv({ cls: 'gkr-knowledge-empty' });
      empty.createEl('strong', { text: '没有发现可靠的潜在双链' });
      empty.createEl('p', { text: '可以新建词条；保存后会自动把选中文字替换为双链。' });
      return;
    }
    const summary = this.resultsEl.createDiv({ cls: 'gkr-knowledge-summary' });
    summary.createEl('strong', { text: `发现 ${candidates.length} 个候选` });
    summary.createSpan({ text: '同名和高相似项优先' });
    const list = this.resultsEl.createDiv({ cls: 'gkr-link-candidate-list' });
    for (const candidate of candidates) {
      const row = list.createDiv({ cls: 'gkr-link-candidate' });
      const score = row.createDiv({ cls: 'gkr-link-score' });
      score.createSpan({ text: candidate.type || '笔记' });
      score.createEl('strong', { text: `${Math.round((candidate.score || 0) * 100)}%` });
      const copy = row.createDiv({ cls: 'gkr-link-copy' });
      copy.createEl('strong', { text: candidate.title });
      copy.createSpan({ text: candidate.path, cls: 'gkr-muted' });
      const link = row.createEl('button', { text: '关联当前词', cls: 'gkr-link-action' });
      link.type = 'button';
      link.addEventListener('click', async () => {
        link.disabled = true;
        try {
          await this.options.onLink(candidate, query);
          this.close();
        } catch (error) {
          link.disabled = false;
          new Notice(`关联失败：${error.message}`);
        }
      });
    }
  }

  async renderOccurrencePlanner(candidate, query) {
    this.candidate = candidate;
    this.query = text(query).trim();
    this.resultsEl.empty();
    const planner = this.resultsEl.createDiv({ cls: 'gkr-backlink-planner' });
    const selected = planner.createDiv({ cls: 'gkr-backlink-target' });
    selected.createSpan({ text: candidate.type || '词典' });
    const selectedCopy = selected.createDiv();
    selectedCopy.createEl('strong', { text: candidate.title });
    selectedCopy.createSpan({ text: candidate.path, cls: 'gkr-muted' });

    const termField = planner.createDiv({ cls: 'gkr-backlink-field' });
    termField.createEl('label', { text: '要补链接的完整原文' });
    const termInput = termField.createEl('input', {
      type: 'text', value: this.query,
      attr: { 'aria-label': '补链接检索词', placeholder: '可修正未选完整的词语' }
    });

    const scopes = planner.createDiv({ cls: 'gkr-backlink-scopes', attr: { role: 'group', 'aria-label': '扫描范围' } });
    const scopeDefinitions = [
      ['question', '本题'], ['paper', '当前卷'], ['topic', '当前专题'], ['all', '全部题库']
    ];
    const scopeButtons = new Map();
    for (const [key, label] of scopeDefinitions) {
      const button = scopes.createEl('button', { text: label, cls: this.scope === key ? 'is-active' : '' });
      button.type = 'button';
      button.setAttribute('aria-pressed', String(this.scope === key));
      if (key === 'topic' && !this.options.topics?.length) button.disabled = true;
      button.addEventListener('click', () => {
        this.scope = key;
        for (const [scopeKey, scopeButton] of scopeButtons) {
          scopeButton.toggleClass('is-active', scopeKey === key);
          scopeButton.setAttribute('aria-pressed', String(scopeKey === key));
        }
        void scan();
      });
      scopeButtons.set(key, button);
    }

    let topicSelect = null;
    if (this.options.topics?.length) {
      topicSelect = planner.createEl('select', { cls: 'gkr-backlink-topic', attr: { 'aria-label': '选择专题' } });
      for (const topic of this.options.topics) {
        const option = topicSelect.createEl('option', { value: topic, text: topic });
        option.selected = topic === this.topic;
      }
      topicSelect.addEventListener('change', () => {
        this.topic = topicSelect.value;
        if (this.scope === 'topic') void scan();
      });
    }

    const status = planner.createDiv({ cls: 'gkr-backlink-status' });
    const candidatesEl = planner.createDiv({ cls: 'gkr-backlink-occurrences' });
    const actions = planner.createDiv({ cls: 'gkr-backlink-actions' });
    const back = actions.createEl('button', { text: '返回候选' });
    back.type = 'button';
    back.addEventListener('click', () => this.renderCandidates());
    const selectAll = actions.createEl('button', { text: '全选' });
    selectAll.type = 'button';
    const clear = actions.createEl('button', { text: '清空' });
    clear.type = 'button';
    const apply = actions.createEl('button', { text: '批量建立双链', cls: 'mod-cta' });
    apply.type = 'button';

    let occurrences = [];
    let scanVersion = 0;
    const syncApplyState = () => {
      const count = this.selectedOccurrencePaths.size;
      apply.disabled = count === 0;
      apply.setText(count ? `批量建立双链（${count}题）` : '批量建立双链');
    };
    const renderOccurrences = () => {
      candidatesEl.empty();
      if (!occurrences.length) {
        candidatesEl.createEl('p', { text: '此范围没有发现尚未建立双链的完全一致原文。', cls: 'gkr-muted-copy' });
        syncApplyState();
        return;
      }
      for (const occurrence of occurrences) {
        const label = candidatesEl.createEl('label', { cls: 'gkr-backlink-occurrence' });
        const checkbox = label.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.selectedOccurrencePaths.has(occurrence.path);
        const copy = label.createDiv({ cls: 'gkr-backlink-occurrence__copy' });
        copy.createEl('strong', { text: occurrence.label });
        copy.createSpan({ text: occurrence.summary, cls: 'gkr-muted' });
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) this.selectedOccurrencePaths.add(occurrence.path);
          else this.selectedOccurrencePaths.delete(occurrence.path);
          syncApplyState();
        });
      }
      syncApplyState();
    };
    const scan = async () => {
      const version = ++scanVersion;
      const term = termInput.value.trim();
      this.query = term;
      status.setText(term ? '正在扫描题目与答案解析…' : '请输入完整检索词。');
      candidatesEl.empty();
      occurrences = term ? await this.options.scanOccurrences(candidate, term, this.scope, this.topic) : [];
      if (version !== scanVersion) return;
      this.selectedOccurrencePaths = new Set(occurrences.map(item => item.path));
      const hitCount = occurrences.reduce((sum, item) => sum + item.total, 0);
      status.setText(occurrences.length
        ? `发现 ${occurrences.length} 道题、${hitCount} 处未链接原文。请勾选确认后再写入。`
        : '没有发现可补链接的原文。');
      status.toggleClass('is-warning', this.scope === 'all' && occurrences.length > 200);
      renderOccurrences();
    };
    let scanTimer = null;
    termInput.addEventListener('input', () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => void scan(), 220);
    });
    selectAll.addEventListener('click', () => {
      this.selectedOccurrencePaths = new Set(occurrences.map(item => item.path));
      renderOccurrences();
    });
    clear.addEventListener('click', () => {
      this.selectedOccurrencePaths.clear();
      renderOccurrences();
    });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const result = await this.options.applyOccurrences(candidate, termInput.value.trim(), [...this.selectedOccurrencePaths]);
        new Notice(`已为 ${result.files} 道题补上 ${result.links} 处双链；可用命令“撤销最近一次批量回链”恢复。`, 6500);
        this.close();
      } catch (error) {
        apply.disabled = false;
        new Notice(`批量回链失败：${error.message}`, 6000);
      }
    });
    await scan();
  }

  onClose() {
    clearTimeout(this.searchTimer);
    this.renderVersion += 1;
    this.contentEl.empty();
  }
}

class BacklinkFollowupModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    this.modalEl.addClass('gkr-backlink-followup-modal');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '继续补齐题库双链？' });
    contentEl.createEl('p', {
      text: `“${this.options.query}”已经关联到当前题目。可以继续扫描整套卷或当前专题；下一步只显示候选，不会直接改文件。`,
      cls: 'gkr-muted-copy'
    });
    const scopeList = contentEl.createDiv({ cls: 'gkr-followup-scopes' });
    if (this.options.hasPaper) {
      const paper = scopeList.createEl('button', { cls: 'gkr-followup-scope' });
      paper.type = 'button';
      const paperIcon = paper.createSpan({ attr: { 'aria-hidden': 'true' } });
      if (typeof setIcon === 'function') setIcon(paperIcon, 'files');
      const copy = paper.createDiv();
      copy.createEl('strong', { text: '扫描整套卷' });
      copy.createSpan({ text: '查找本卷题目与答案解析中的相同原文' });
      paper.addEventListener('click', () => this.choose('paper'));
    }
    if (this.options.topic) {
      const topic = scopeList.createEl('button', { cls: 'gkr-followup-scope' });
      topic.type = 'button';
      const topicIcon = topic.createSpan({ attr: { 'aria-hidden': 'true' } });
      if (typeof setIcon === 'function') setIcon(topicIcon, 'tags');
      const copy = topic.createDiv();
      copy.createEl('strong', { text: '扫描当前专题' });
      copy.createSpan({ text: this.options.topic });
      topic.addEventListener('click', () => this.choose('topic'));
    }
    const actions = contentEl.createDiv({ cls: 'gkr-followup-actions' });
    const later = actions.createEl('button', { text: '暂不补链' });
    later.type = 'button';
    later.addEventListener('click', () => this.close());
  }

  choose(scope) {
    this.close();
    this.options.onChoose(scope);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CollectionPotentialLinksModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.selected = new Set();
    this.result = null;
  }

  onOpen() {
    this.modalEl.addClass('gkr-potential-links-modal');
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createDiv({ cls: 'gkr-potential-head' });
    head.createSpan({ text: 'POTENTIAL LINKS', cls: 'gkr-kicker' });
    head.createEl('h2', { text: '查找潜在链接' });
    head.createEl('p', {
      text: `使用词典中已有词条，检查“${this.options.collectionTitle}”的题目与答案解析。只列出尚未建立双链的同名文字。`,
      cls: 'gkr-muted-copy'
    });
    this.statusEl = contentEl.createDiv({ cls: 'gkr-potential-status', text: '正在读取词典与题目…' });
    this.resultsEl = contentEl.createDiv({ cls: 'gkr-potential-results' });
    const footer = contentEl.createDiv({ cls: 'gkr-potential-footer' });
    const selectionTools = footer.createDiv({ cls: 'gkr-potential-selection-tools' });
    const selectAll = selectionTools.createEl('button', { text: '全选' });
    selectAll.type = 'button';
    selectAll.disabled = true;
    selectAll.addEventListener('click', () => {
      this.selected = new Set((this.result?.candidates || []).map(item => item.id));
      this.renderCandidates();
    });
    const clear = selectionTools.createEl('button', { text: '清空' });
    clear.type = 'button';
    clear.disabled = true;
    clear.addEventListener('click', () => {
      this.selected.clear();
      this.renderCandidates();
    });
    const actions = footer.createDiv({ cls: 'gkr-potential-actions' });
    const close = actions.createEl('button', { text: '关闭' });
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    this.applyButton = actions.createEl('button', { text: '建立所选双链', cls: 'mod-cta' });
    this.applyButton.type = 'button';
    this.applyButton.disabled = true;
    this.applyButton.addEventListener('click', () => this.applySelected());
    this.selectAllButton = selectAll;
    this.clearButton = clear;
    void this.scan();
  }

  async scan() {
    try {
      this.result = await this.options.scan(progress => {
        this.statusEl?.setText(`正在检查 ${progress.completed} / ${progress.total} 道题…`);
      });
      this.selectAllButton.disabled = !this.result.candidates.length;
      this.clearButton.disabled = !this.result.candidates.length;
      const totalLinks = this.result.candidates.reduce((sum, item) => sum + item.total, 0);
      const ambiguity = this.result.ambiguous.length
        ? `；跳过 ${this.result.ambiguous.length} 个对应多个词条的同名词`
        : '';
      this.statusEl.setText(this.result.candidates.length
        ? `找到 ${this.result.candidates.length} 组候选、${totalLinks} 处未链接原文${ambiguity}。请预览并勾选后再写入。`
        : `没有找到未链接的已有词条${ambiguity}。`);
      this.renderCandidates();
    } catch (error) {
      this.statusEl.setText(`查找失败：${error.message || '未知错误'}`);
      this.statusEl.addClass('is-error');
      this.resultsEl.empty();
    }
  }

  renderCandidates() {
    this.resultsEl.empty();
    const candidates = this.result?.candidates || [];
    if (!candidates.length) {
      this.resultsEl.createEl('p', { text: '当前范围没有可建立的潜在链接。', cls: 'gkr-muted-copy' });
      this.syncApplyState();
      return;
    }
    for (const candidate of candidates) {
      const row = this.resultsEl.createDiv({ cls: `gkr-potential-row ${this.selected.has(candidate.id) ? 'is-selected' : ''}` });
      const checkbox = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `选择词条${candidate.candidate.title}` } });
      checkbox.checked = this.selected.has(candidate.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(candidate.id);
        else this.selected.delete(candidate.id);
        row.toggleClass('is-selected', checkbox.checked);
        this.syncApplyState();
      });
      const copy = row.createDiv({ cls: 'gkr-potential-copy' });
      const titleLine = copy.createDiv({ cls: 'gkr-potential-title' });
      titleLine.createEl('strong', { text: candidate.candidate.title });
      if (candidate.query !== candidate.candidate.title) titleLine.createSpan({ text: `匹配：${candidate.query}` });
      copy.createSpan({
        text: `${candidate.occurrences.length} 道题 · ${candidate.total} 处未链接原文`,
        cls: 'gkr-muted'
      });
      const details = copy.createEl('details', { cls: 'gkr-potential-details' });
      details.createEl('summary', { text: '查看所在题目' });
      const occurrences = details.createDiv({ cls: 'gkr-potential-occurrences' });
      for (const occurrence of candidate.occurrences) {
        const item = occurrences.createDiv();
        item.createEl('strong', { text: occurrence.label });
        item.createSpan({ text: occurrence.summary });
      }
    }
    this.syncApplyState();
  }

  syncApplyState() {
    const count = this.selected.size;
    this.applyButton.disabled = count === 0;
    this.applyButton.setText(count ? `建立所选双链（${count}组）` : '建立所选双链');
  }

  async applySelected() {
    const selected = (this.result?.candidates || []).filter(item => this.selected.has(item.id));
    if (!selected.length) return;
    this.applyButton.disabled = true;
    this.statusEl.setText(`正在为 ${selected.length} 组候选建立双链…`);
    try {
      const result = await this.options.apply(selected);
      new Notice(`已为 ${result.files} 道题建立 ${result.links} 处双链；可用命令“撤销最近一次批量回链”恢复。`, 6500);
      this.close();
    } catch (error) {
      this.statusEl.setText(`写入失败：${error.message || '未知错误'}`);
      this.statusEl.addClass('is-error');
      this.syncApplyState();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class RoamerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.groupMode = 'paper';
    this.studyMode = 'intensive';
    this.paperViewMode = 'vertical';
    this.filters = { year: '', subject: '', module: '', status: '' };
    this.allQuestions = [];
    this.collection = null;
    this.collectionItems = [];
    this.questions = [];
    this.requestedQuestionCount = plugin.settings.collectionQuestionCount;
    this.index = 0;
    this.answers = new Map();
    this.marked = new Set();
    this.revealed = new Set();
    this.docCache = new Map();
    this.renderComponents = [];
    this.cachedSelection = null;
    this.refreshTimer = null;
    this.clockTimer = null;
    this.sessionStartedAt = 0;
    this.questionStartedAt = 0;
    this.examDeadline = 0;
    this.guessSeconds = plugin.settings.guessSeconds;
    this.examMinutes = plugin.settings.examMinutes;
    this.linkPreviewEnabled = false;
    this.sessionFinished = false;
    this.answerCardOpen = false;
    this.sessionElapsedSeconds = 0;
    this.examTimedOut = false;
    this.paperScrollTop = 0;
    this.paperTransitioning = false;
    this.hoverPopover = null;
    this.lexiconEditorController = null;
    this.lexiconEditorPath = '';
    this.lexiconEditorVisible = false;
    this.lastStudyModeClick = { key: '', at: 0 };
    this.temporaryInkEnabled = false;
    this.temporaryInkStrokes = new Map();
    this.temporaryInkControllers = [];
    this.temporaryInkToolbar = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '考公笔记漫游'; }
  getIcon() { return 'scan-line'; }

  async onOpen() {
    this.plugin.lastRoamerLeaf = this.leaf;
    this.plugin.applyRoamerFocusMode();
    this.renderShell();
    await this.refreshQuestions();
    this.sessionSaveTimer = window.setInterval(() => {
      this.plugin.persistLearningSession(this).catch(error => console.error('漫游进度保存失败', error));
    }, 5000);
    this.sessionVisibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.plugin.persistLearningSession(this).catch(console.error);
    };
    document.addEventListener('visibilitychange', this.sessionVisibilityHandler);
  }

  async onClose() {
    clearInterval(this.sessionSaveTimer);
    document.removeEventListener('visibilitychange', this.sessionVisibilityHandler);
    await this.plugin.persistLearningSession(this);
    clearTimeout(this.refreshTimer);
    clearInterval(this.clockTimer);
    this.resetTemporaryInkSession();
    this.unloadRenderComponents();
    this.lexiconEditorController?.destroy?.();
    this.lexiconEditorController = null;
    if (this.plugin.lastRoamerLeaf === this.leaf) this.plugin.lastRoamerLeaf = null;
  }

  getNavigationState() {
    return {
      screen: this.screen || 'home',
      groupMode: this.groupMode,
      studyMode: this.studyMode,
      paperViewMode: this.paperViewMode,
      filters: { ...this.filters },
      collection: this.collection ? { ...this.collection } : null,
      collectionPaths: this.collectionItems.map(question => question.path),
      questionPaths: this.questions.map(question => question.path),
      requestedQuestionCount: this.requestedQuestionCount,
      index: this.index,
      answers: [...this.answers.entries()].map(([path, value]) => [path, { ...value }]),
      marked: [...this.marked],
      revealed: [...this.revealed],
      sessionStartedAt: this.sessionStartedAt,
      questionStartedAt: this.questionStartedAt,
      examDeadline: this.examDeadline,
      guessSeconds: this.guessSeconds,
      examMinutes: this.examMinutes,
      linkPreviewEnabled: this.linkPreviewEnabled,
      sessionFinished: this.sessionFinished,
      answerCardOpen: this.answerCardOpen,
      sessionElapsedSeconds: this.sessionElapsedSeconds,
      examTimedOut: this.examTimedOut,
      paperScrollTop: this.paperViewport?.scrollTop ?? this.paperScrollTop ?? 0,
      lexiconEditorPath: this.lexiconEditorPath,
      lexiconEditorVisible: this.lexiconEditorVisible
    };
  }

  async restoreNavigationState(state = {}) {
    const byPath = new Map(this.allQuestions.map(question => [question.path, question]));
    this.groupMode = state.groupMode || this.groupMode;
    this.studyMode = state.studyMode || this.studyMode;
    this.paperViewMode = state.paperViewMode || this.paperViewMode;
    this.filters = { ...this.filters, ...(state.filters || {}) };
    this.collection = state.collection ? { ...state.collection } : this.collection;
    this.collectionItems = (state.collectionPaths || []).map(path => byPath.get(path)).filter(Boolean);
    this.questions = (state.questionPaths || []).map(path => byPath.get(path)).filter(Boolean);
    this.requestedQuestionCount = Number(state.requestedQuestionCount) || this.requestedQuestionCount;
    this.index = Math.min(Math.max(0, Number(state.index) || 0), Math.max(0, this.questions.length - 1));
    this.answers = new Map((state.answers || []).map(([path, value]) => [path, { ...value }]));
    this.marked = new Set(state.marked || []);
    this.revealed = new Set(state.revealed || []);
    this.sessionStartedAt = Number(state.sessionStartedAt) || 0;
    this.questionStartedAt = Number(state.questionStartedAt) || 0;
    this.examDeadline = Number(state.examDeadline) || 0;
    this.guessSeconds = Number(state.guessSeconds) || this.guessSeconds;
    this.examMinutes = Number(state.examMinutes) || this.examMinutes;
    this.linkPreviewEnabled = Boolean(state.linkPreviewEnabled);
    this.sessionFinished = Boolean(state.sessionFinished);
    this.answerCardOpen = Boolean(state.answerCardOpen);
    this.sessionElapsedSeconds = Number(state.sessionElapsedSeconds) || 0;
    this.examTimedOut = Boolean(state.examTimedOut);
    this.paperScrollTop = Number(state.paperScrollTop) || 0;
    const screen = state.screen || 'home';
    if (screen === 'reader' && this.questions.length) await this.renderActiveSession();
    else if (screen === 'review' && this.questions.length) await this.openExamReview(this.index);
    else if (screen === 'results' && this.questions.length) this.renderExamResults(this.examTimedOut);
    else if (screen === 'setup' && this.collection) this.renderSessionSetup();
    else this.renderHome();
    if (state.lexiconEditorPath) {
      if (!this.lexiconEditorController || this.lexiconEditorPath !== state.lexiconEditorPath) {
        await this.openLexiconEditor({ path: state.lexiconEditorPath }, this.dictionaryPlugin(), {
          visible: state.lexiconEditorVisible !== false
        });
      } else {
        this.lexiconEditorVisible = state.lexiconEditorVisible !== false;
        this.syncLexiconEditorVisibility();
      }
    }
  }

  unloadRenderComponents() {
    this.renderComponents.forEach(component => component.unload());
    this.renderComponents = [];
    this.destroyTemporaryInkControllers();
  }

  destroyTemporaryInkControllers() {
    this.temporaryInkControllers.forEach(controller => controller.destroy?.());
    this.temporaryInkControllers = [];
    this.temporaryInkToolbar = null;
  }

  resetTemporaryInkSession() {
    this.destroyTemporaryInkControllers();
    this.temporaryInkStrokes.clear();
    this.temporaryInkEnabled = false;
  }

  currentTemporaryInkPath() {
    return this.questions[this.index]?.path || '';
  }

  redrawTemporaryInk(path = '') {
    this.temporaryInkControllers
      .filter(controller => !path || controller.path === path)
      .forEach(controller => controller.redraw?.());
    this.syncTemporaryInkToolbar();
  }

  syncTemporaryInkToolbar() {
    const toolbar = this.temporaryInkToolbar;
    if (!toolbar) return;
    const activePath = this.currentTemporaryInkPath();
    const count = (this.temporaryInkStrokes.get(activePath) || []).length;
    toolbar.toggle.toggleClass('is-active', this.temporaryInkEnabled);
    toolbar.toggle.setAttribute('aria-pressed', String(this.temporaryInkEnabled));
    toolbar.toggle.setAttribute('aria-label', this.temporaryInkEnabled ? '关闭临时草稿' : '打开临时草稿');
    toolbar.label?.setText(this.temporaryInkEnabled ? '书写中' : '草稿');
    toolbar.undo.disabled = count === 0;
    toolbar.clear.disabled = count === 0;
    toolbar.count?.setText(count ? `${count} 笔` : '退出即清空');
  }

  renderTemporaryInkTools(parent) {
    if (!['guess', 'exam'].includes(this.studyMode)) return null;
    const group = parent.createDiv({ cls: 'gkr-ink-tools', attr: { role: 'group', 'aria-label': '临时草稿工具' } });
    const toggle = this.button(group, '', () => {
      this.temporaryInkEnabled = !this.temporaryInkEnabled;
      this.syncTemporaryInkToolbar();
      new Notice(this.temporaryInkEnabled
        ? '临时草稿已开启：Apple Pencil 或鼠标可书写，手指仍可滚动和答题。'
        : '临时草稿已暂停；已有笔迹仍暂时保留。', 2600);
    }, `gkr-ink-button gkr-ink-toggle ${this.temporaryInkEnabled ? 'is-active' : ''}`);
    const toggleIcon = toggle.createSpan({ cls: 'gkr-ink-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(toggleIcon, 'pencil');
    const label = toggle.createSpan({ text: this.temporaryInkEnabled ? '书写中' : '草稿', cls: 'gkr-ink-label' });
    toggle.setAttribute('title', '临时草稿：只在本次作答中保留');

    const undo = this.button(group, '', () => {
      const path = this.currentTemporaryInkPath();
      undoTemporaryInkStroke(this.temporaryInkStrokes, path);
      this.redrawTemporaryInk(path);
    }, 'gkr-ink-button gkr-ink-icon-button');
    const undoIcon = undo.createSpan({ cls: 'gkr-ink-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(undoIcon, 'undo-2');
    undo.setAttribute('aria-label', '撤销本题上一笔');
    undo.setAttribute('title', '撤销本题上一笔');

    const clear = this.button(group, '', () => {
      if (clear.dataset.confirming !== 'true') {
        clear.dataset.confirming = 'true';
        clear.addClass('is-confirming');
        clear.setAttribute('aria-label', '再次点击确认清空本题草稿');
        clear.setAttribute('title', '再次点击确认清空本题草稿');
        clear._gkrConfirmTimer = setTimeout(() => {
          clear.dataset.confirming = 'false';
          clear.removeClass('is-confirming');
          clear.setAttribute('aria-label', '清空本题草稿');
          clear.setAttribute('title', '清空本题草稿');
        }, 2200);
        return;
      }
      clearTimeout(clear._gkrConfirmTimer);
      clear.dataset.confirming = 'false';
      clear.removeClass('is-confirming');
      const path = this.currentTemporaryInkPath();
      clearTemporaryInkForPath(this.temporaryInkStrokes, path);
      this.redrawTemporaryInk(path);
    }, 'gkr-ink-button gkr-ink-icon-button gkr-ink-clear');
    const clearIcon = clear.createSpan({ cls: 'gkr-ink-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(clearIcon, 'eraser');
    clear.setAttribute('aria-label', '清空本题草稿');
    clear.setAttribute('title', '清空本题草稿');
    const count = group.createSpan({ text: '退出即清空', cls: 'gkr-ink-count' });
    this.temporaryInkToolbar = { group, toggle, label, undo, clear, count };
    this.syncTemporaryInkToolbar();
    return group;
  }

  mountTemporaryInk(surface, question, index = this.index) {
    if (!surface || !question?.path || !['guess', 'exam'].includes(this.studyMode)) return null;
    surface.addClass('gkr-ink-surface');
    const canvas = surface.createEl('canvas', { cls: 'gkr-temporary-ink-canvas', attr: { 'aria-hidden': 'true' } });
    const path = question.path;
    let activeStroke = null;
    let activePointerId = null;
    let suppressClickUntil = 0;
    let resizeObserver = null;
    let mutationObserver = null;
    let intersectionObserver = null;
    let visible = true;

    const surfaceSize = () => ({
      width: Math.max(1, surface.scrollWidth || surface.clientWidth || 1),
      height: Math.max(1, surface.scrollHeight || surface.clientHeight || 1)
    });
    const drawStroke = (context, stroke, width, height) => {
      const points = stroke?.points || [];
      if (!points.length) return;
      context.save();
      context.strokeStyle = stroke.color || '#7c3aed';
      context.fillStyle = stroke.color || '#7c3aed';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      if (points.length === 1) {
        const point = points[0];
        context.beginPath();
        context.arc(point.x * width, point.y * height, Math.max(1.1, stroke.width / 2), 0, Math.PI * 2);
        context.fill();
        context.restore();
        return;
      }
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const previous = points[pointIndex - 1];
        const point = points[pointIndex];
        context.lineWidth = Math.max(1.4, stroke.width * (0.72 + ((previous.pressure + point.pressure) / 2) * 0.56));
        context.beginPath();
        context.moveTo(previous.x * width, previous.y * height);
        context.lineTo(point.x * width, point.y * height);
        context.stroke();
      }
      context.restore();
    };
    const redraw = () => {
      if (!canvas.isConnected) return;
      const strokes = this.temporaryInkStrokes.get(path) || [];
      const { width, height } = surfaceSize();
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if ((!visible || !strokes.length) && !activeStroke) {
        canvas.width = 1;
        canvas.height = 1;
        return;
      }
      const dpr = Math.min(3, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      strokes.forEach(stroke => drawStroke(context, stroke, width, height));
    };
    const pointFromEvent = event => normalizeTemporaryInkPoint(
      event.clientX,
      event.clientY,
      surface.getBoundingClientRect(),
      event.pressure
    );
    const stopInkEvent = event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    const onPointerDown = event => {
      if (!temporaryInkPointerAllowed(event.pointerType, this.temporaryInkEnabled)) return;
      stopInkEvent(event);
      this.index = index;
      this.paperPositionEl?.setText(`当前 ${this.index + 1} / ${this.questions.length}`);
      this.updateAnswerCardDom?.();
      const color = getComputedStyle(surface).getPropertyValue('--interactive-accent').trim()
        || getComputedStyle(surface).color
        || '#7c3aed';
      activeStroke = { color, width: event.pointerType === 'pen' ? 2.7 : 2.4, points: [pointFromEvent(event)] };
      addTemporaryInkStroke(this.temporaryInkStrokes, path, activeStroke);
      activePointerId = event.pointerId;
      try { surface.setPointerCapture?.(event.pointerId); } catch { }
      redraw();
      this.syncTemporaryInkToolbar();
    };
    const onPointerMove = event => {
      if (!activeStroke || event.pointerId !== activePointerId) return;
      stopInkEvent(event);
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
      events.forEach(coalesced => activeStroke.points.push(pointFromEvent(coalesced)));
      redraw();
    };
    const finishStroke = event => {
      if (!activeStroke || event.pointerId !== activePointerId) return;
      stopInkEvent(event);
      if (event.type === 'pointerup') activeStroke.points.push(pointFromEvent(event));
      suppressClickUntil = Date.now() + 450;
      try { surface.releasePointerCapture?.(event.pointerId); } catch { }
      activeStroke = null;
      activePointerId = null;
      redraw();
      this.syncTemporaryInkToolbar();
    };
    const suppressInkClick = event => {
      if (Date.now() > suppressClickUntil) return;
      stopInkEvent(event);
    };
    surface.addEventListener('pointerdown', onPointerDown, true);
    surface.addEventListener('pointermove', onPointerMove, true);
    surface.addEventListener('pointerup', finishStroke, true);
    surface.addEventListener('pointercancel', finishStroke, true);
    surface.addEventListener('click', suppressInkClick, true);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => redraw());
      resizeObserver.observe(surface);
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(() => redraw());
      mutationObserver.observe(surface, { childList: true, subtree: true, characterData: true });
    }
    if (typeof IntersectionObserver === 'function') {
      intersectionObserver = new IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        redraw();
      }, { root: this.paperViewport?.contains?.(surface) ? this.paperViewport : null, rootMargin: '160px' });
      intersectionObserver.observe(surface);
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(redraw);
    else setTimeout(redraw, 0);
    const controller = {
      path,
      redraw,
      destroy: () => {
        resizeObserver?.disconnect?.();
        mutationObserver?.disconnect?.();
        intersectionObserver?.disconnect?.();
        surface.removeEventListener('pointerdown', onPointerDown, true);
        surface.removeEventListener('pointermove', onPointerMove, true);
        surface.removeEventListener('pointerup', finishStroke, true);
        surface.removeEventListener('pointercancel', finishStroke, true);
        surface.removeEventListener('click', suppressInkClick, true);
        canvas.remove();
      }
    };
    this.temporaryInkControllers.push(controller);
    return controller;
  }

  scheduleRefresh(file = null) {
    if (file?.path) this.docCache.delete(file.path);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshQuestions(), 350);
  }

  async refreshQuestions() {
    this.allQuestions = this.app.vault.getMarkdownFiles()
      .map(file => normalizeQuestion(file, this.app))
      .filter(question => question.noteType === 'question' || question.paperId || question.questionNo !== 999999);
    if (this.screen === 'home') this.renderHome();
  }

  renderShell() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('gkr-root');
    this.rootEl = root;
    const header = root.createDiv({ cls: 'gkr-header' });
    this.headerEl = header;
    const brand = header.createDiv({ cls: 'gkr-brand' });
    brand.createSpan({ text: 'STUDY / ROAM', cls: 'gkr-kicker' });
    brand.createEl('h2', { text: '考公笔记漫游' });
    const actions = header.createDiv({ cls: 'gkr-header-actions' });
    this.button(actions, '刷新', () => this.refreshQuestions(), 'gkr-quiet');
    this.button(actions, '首页', async () => { await this.plugin.persistLearningSession(this); this.renderHome(); }, 'gkr-quiet');
    this.workspaceEl = root.createDiv({ cls: 'gkr-workspace' });
    this.body = this.workspaceEl.createDiv({ cls: 'gkr-body' });
    this.lexiconDockEl = this.workspaceEl.createEl('aside', {
      cls: 'gkr-lexicon-dock',
      attr: { 'aria-label': '词条编辑栏', 'aria-hidden': 'true' }
    });
    this.lexiconDockHost = this.lexiconDockEl.createDiv({ cls: 'gkr-lexicon-dock-host' });
    this.lexiconReopenButton = this.button(this.workspaceEl, '', () => this.showLexiconEditor(), 'gkr-lexicon-reopen');
    this.lexiconReopenButton.setAttribute('aria-label', '重新展开词条编辑栏');
    this.lexiconReopenButton.setAttribute('title', '展开词条编辑栏');
    const reopenIcon = this.lexiconReopenButton.createSpan({ cls: 'gkr-lexicon-reopen-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(reopenIcon, 'panel-right-open');
    this.lexiconReopenButton.createSpan({ text: '编辑词条', cls: 'gkr-lexicon-reopen-label' });
    this.syncLexiconEditorVisibility();
    this.renderHome();
  }

  syncLexiconEditorVisibility() {
    if (!this.workspaceEl || !this.lexiconDockEl || !this.lexiconReopenButton) return;
    const hasEditor = Boolean(this.lexiconEditorPath || this.lexiconEditorController);
    const visible = hasEditor && this.lexiconEditorVisible;
    this.workspaceEl.toggleClass('has-lexicon-editor', visible);
    this.lexiconDockEl.toggleAttribute('hidden', !visible);
    this.lexiconDockEl.setAttribute('aria-hidden', String(!visible));
    this.lexiconReopenButton.toggleAttribute('hidden', !hasEditor || visible);
  }

  hideLexiconEditor() {
    this.lexiconEditorVisible = false;
    this.syncLexiconEditorVisibility();
  }

  showLexiconEditor() {
    if (!this.lexiconEditorController && this.lexiconEditorPath) {
      void this.openLexiconEditor({ path: this.lexiconEditorPath }, this.dictionaryPlugin());
      return;
    }
    this.lexiconEditorVisible = Boolean(this.lexiconEditorController);
    this.syncLexiconEditorVisibility();
  }

  async openLexiconEditor(entry, dictionary = this.dictionaryPlugin(), options = {}) {
    if (!entry?.path) return;
    this.lexiconEditorPath = entry.path;
    this.lexiconEditorVisible = options.visible !== false;
    this.syncLexiconEditorVisibility();
    if (!dictionary || typeof dictionary.mountLexiconEditor !== 'function') {
      this.lexiconDockHost?.empty();
      this.lexiconDockHost?.createDiv({
        cls: 'gkr-lexicon-dock-error',
        text: '词条已保存，但当前考公词典版本还不支持漫游内嵌编辑。请升级考公词典。'
      });
      this.syncLexiconEditorVisibility();
      return;
    }
    try {
      this.lexiconEditorController?.destroy?.();
      this.lexiconDockHost.empty();
      this.lexiconEditorController = await dictionary.mountLexiconEditor(this.lexiconDockHost, entry, {
        onClose: () => this.hideLexiconEditor(),
        onSaved: saved => {
          this.lexiconEditorPath = saved.path;
          this.syncLexiconEditorVisibility();
        },
        onArchived: saved => {
          this.lexiconEditorPath = saved.path;
          this.syncLexiconEditorVisibility();
        },
        onOpenPath: file => this.plugin.openFileFromRoamer(file, this.leaf)
      });
      this.lexiconEditorPath = this.lexiconEditorController?.draft?.path || entry.path;
      this.syncLexiconEditorVisibility();
    } catch (error) {
      this.lexiconEditorController = null;
      this.lexiconDockHost.empty();
      this.lexiconDockHost.createDiv({ cls: 'gkr-lexicon-dock-error', text: `词条编辑栏加载失败：${error.message || '未知错误'}` });
      new Notice(`词条已保存，但编辑栏加载失败：${error.message || '未知错误'}`);
    }
  }

  button(parent, label, handler, className = '') {
    const button = parent.createEl('button', { text: label, cls: className });
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  filteredQuestions() {
    return this.allQuestions.filter(question => {
      if (this.filters.year && String(question.year) !== this.filters.year) return false;
      if (this.filters.subject && question.subject !== this.filters.subject) return false;
      if (this.filters.module && question.module !== this.filters.module) return false;
      if (this.filters.status && question.status !== this.filters.status) return false;
      return true;
    });
  }

  availableValues(field) {
    return [...new Set(this.allQuestions.map(question => text(question[field])).filter(Boolean))]
      .sort((a, b) => field === 'year' ? Number(b) - Number(a) : a.localeCompare(b, 'zh-CN'));
  }

  renderHome() {
    clearInterval(this.clockTimer);
    this.resetTemporaryInkSession();
    this.unloadRenderComponents();
    this.rootEl?.removeClass('gkr-session-active');
    this.rootEl?.removeClass('gkr-link-preview-enabled');
    this.sessionFinished = false;
    this.screen = 'home';
    this.body.empty();
    this.homeEl = this.body.createDiv({ cls: 'gkr-home' });
    const intro = this.homeEl.createDiv({ cls: 'gkr-intro' });
    intro.createSpan({ text: '先组卷，再选择学习方式', cls: 'gkr-kicker' });
    intro.createEl('h3', { text: '今天想怎么漫游？' });
    intro.createEl('p', { text: '同一套题目数据，可以按试卷、专题、地区或错因重新组合。', cls: 'gkr-muted-copy' });
    const saved = this.plugin.settings.learningSession;
    if (saved?.state?.questionPaths?.length) {
      const resume = this.homeEl.createDiv({ cls: 'gkr-resume-session' });
      const state = saved.state;
      resume.createEl('strong', { text: '继续上次学习' });
      resume.createEl('p', { text: `${state.collection?.title || '上次题目集合'} · ${STUDY_MODES[state.studyMode]?.name || state.studyMode} · 第 ${(state.index || 0) + 1}/${state.questionPaths.length} 题` });
      this.button(resume, '继续学习', async () => {
        const paths = new Set(this.allQuestions.map(q => q.path));
        const missing = state.questionPaths.filter(p => !paths.has(p));
        if (missing.length) {
          const modal = new Modal(this.app);
          modal.onOpen = () => {
            modal.contentEl.createEl('h3', { text: '本次学习有缺失题目，暂未恢复' });
            modal.contentEl.createEl('p', { text: '恢复这些文件后再继续，避免静默减少题量。若题目已改名，请恢复原路径，或重新组卷。' });
            modal.contentEl.createEl('pre', { text: missing.join('\n') });
          };
          modal.open(); return;
        }
        await this.restoreNavigationState(state);
      }, 'gkr-primary');
      resume.createEl('p', { text: '每 5 秒保存进度；临时笔迹不保存。考试恢复时仍按原截止时间计时。', cls: 'gkr-muted-copy' });
    }

    const groupTabs = this.homeEl.createDiv({ cls: 'gkr-group-tabs' });
    Object.entries(GROUP_MODES).forEach(([key, label]) => {
      this.button(groupTabs, label, () => {
        this.groupMode = key;
        this.renderHome();
      }, `gkr-segment ${this.groupMode === key ? 'is-active' : ''}`);
    });

    const filters = this.homeEl.createDiv({ cls: 'gkr-filters' });
    this.renderFilter(filters, 'year', '年份');
    this.renderFilter(filters, 'subject', '科目');
    this.renderFilter(filters, 'module', '模块');
    this.renderFilter(filters, 'status', '状态');
    if (Object.values(this.filters).some(Boolean)) {
      this.button(filters, '清除筛选', () => {
        this.filters = { year: '', subject: '', module: '', status: '' };
        this.renderHome();
      }, 'gkr-filter-reset');
    }

    const questions = this.filteredQuestions();
    const groups = buildCollections(questions, this.groupMode);
    const summary = this.homeEl.createDiv({ cls: 'gkr-list-heading' });
    summary.createEl('strong', { text: `${groups.length} 个集合` });
    summary.createSpan({ text: `${questions.length} 道题`, cls: 'gkr-muted' });
    const grid = this.homeEl.createDiv({ cls: 'gkr-collection-grid' });
    if (!groups.length) {
      const empty = grid.createDiv({ cls: 'gkr-empty' });
      empty.createEl('strong', { text: '当前筛选下没有题目' });
      empty.createEl('p', { text: '检查 YAML 字段，或清除上方筛选条件。' });
      return;
    }
    groups.forEach(group => {
      const card = this.button(grid, '', () => this.openCollection(group), 'gkr-collection-card');
      const main = card.createDiv({ cls: 'gkr-card-main' });
      main.createEl('strong', { text: group.title });
      main.createSpan({ text: this.collectionSubtitle(group), cls: 'gkr-muted' });
      const progress = collectionProgress(group.items);
      const progressMeta = main.createDiv({ cls: `gkr-collection-progress is-${progress.status}` });
      progressMeta.createSpan({ text: progress.label });
      progressMeta.createSpan({ text: `${progress.completed}/${progress.total} · ${progress.percent}%` });
      const progressTrack = main.createDiv({
        cls: 'gkr-collection-progress-track',
        attr: { role: 'progressbar', 'aria-label': `${group.title}精读进度`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress.percent) }
      });
      progressTrack.createDiv({ cls: 'gkr-collection-progress-value', attr: { style: `transform:scaleX(${progress.percent / 100})` } });
      const count = card.createDiv({ cls: 'gkr-card-count' });
      count.createEl('b', { text: String(group.items.length) });
      count.createSpan({ text: '题' });
      card.setAttribute('aria-label', `${group.title}，${group.items.length}题，${progress.label}，完成${progress.percent}%`);
    });
  }

  renderFilter(parent, field, label) {
    const wrap = parent.createDiv({ cls: 'gkr-filter' });
    wrap.createSpan({ text: label });
    const select = wrap.createEl('select');
    select.createEl('option', { text: `全部${label}`, value: '' });
    this.availableValues(field).forEach(value => select.createEl('option', { text: value, value }));
    select.value = this.filters[field];
    select.addEventListener('change', () => {
      this.filters[field] = select.value;
      this.renderHome();
    });
  }

  collectionSubtitle(group) {
    const subjects = [...new Set(group.items.map(item => item.subject).filter(Boolean))].slice(0, 2);
    const years = group.items.map(item => item.year).filter(Boolean);
    const range = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '';
    return [range, ...subjects].filter(Boolean).join(' · ') || GROUP_MODES[this.groupMode];
  }

  openCollection(group) {
    this.collection = { key: group.key, title: group.title, sourceCount: group.items.length };
    this.collectionItems = [...group.items];
    this.linkPreviewEnabled = false;
    this.requestedQuestionCount = this.groupMode === 'paper'
      ? group.items.length
      : Math.min(group.items.length, this.plugin.settings.collectionQuestionCount);
    this.questions = [...group.items];
    this.renderSessionSetup();
  }

  renderSessionSetup() {
    this.resetTemporaryInkSession();
    this.unloadRenderComponents();
    this.rootEl?.removeClass('gkr-session-active');
    this.rootEl?.removeClass('gkr-link-preview-enabled');
    this.screen = 'setup';
    this.homeEl = null;
    this.body.empty();
    const top = this.body.createDiv({ cls: 'gkr-subbar' });
    this.button(top, '返回集合', () => this.renderHome(), 'gkr-back');
    const title = top.createDiv();
    title.createSpan({ text: GROUP_MODES[this.groupMode], cls: 'gkr-kicker' });
    title.createEl('strong', { text: this.collection.title });
    const plannedCount = this.groupMode === 'paper'
      ? this.collectionItems.length
      : Math.min(this.collectionItems.length, this.requestedQuestionCount);
    top.createSpan({
      text: this.groupMode === 'paper' ? `${plannedCount} 题 · 原卷` : `${plannedCount} / ${this.collectionItems.length} 题`,
      cls: 'gkr-count-pill'
    });
    const collectionReading = collectionProgress(this.collectionItems);
    top.createSpan({
      text: `精读 ${collectionReading.completed}/${collectionReading.total} · ${collectionReading.percent}%`,
      cls: `gkr-count-pill gkr-reading-progress-pill is-${collectionReading.status}`
    });
    this.renderCollectionPotentialLinkBar(this.body);

    const setup = this.body.createDiv({ cls: 'gkr-setup' });
    setup.createEl('h3', { text: '选择学习模式' });
    setup.createEl('p', { text: '同一组题目会按不同规则呈现，原始 Markdown 不会被拆散或复制。', cls: 'gkr-muted-copy' });
    const modes = setup.createDiv({ cls: 'gkr-study-modes' });
    Object.entries(STUDY_MODES).forEach(([key, mode]) => {
      const card = this.button(modes, '', () => {
        const wasSelected = this.studyMode === key;
        const action = studyModeClickAction(this.lastStudyModeClick, key);
        this.lastStudyModeClick = action.next;
        this.studyMode = key;
        if (action.start) {
          this.startSession();
          return;
        }
        if (!wasSelected) this.renderSessionSetup();
      }, `gkr-study-card ${this.studyMode === key ? 'is-selected' : ''}`);
      card.setAttribute('title', `单击选择${mode.name}；双击直接开始`);
      card.setAttribute('aria-label', `${mode.name}。单击选择，双击直接开始`);
      card.createSpan({ text: mode.short, cls: 'gkr-mode-mark' });
      const copy = card.createDiv();
      copy.createEl('strong', { text: mode.name });
      copy.createEl('p', { text: mode.description });
    });

    if (this.groupMode !== 'paper') {
      const countPicker = setup.createDiv({ cls: 'gkr-question-count-picker' });
      const countCopy = countPicker.createDiv({ cls: 'gkr-question-count-copy' });
      countCopy.createEl('strong', { text: '本次抽取题量' });
      countCopy.createSpan({
        text: `从去重后的 ${this.collectionItems.length} 道题中随机抽取；按卷子时不抽样。`,
        cls: 'gkr-muted'
      });
      const countControls = countPicker.createDiv({ cls: 'gkr-question-count-controls' });
      const input = countControls.createEl('input', {
        type: 'number',
        value: String(plannedCount),
        attr: { 'aria-label': '本次抽取题量' }
      });
      input.min = '1';
      input.max = String(Math.max(1, this.collectionItems.length));
      input.addEventListener('change', async () => {
        this.requestedQuestionCount = clampNumber(input.value, 20, 1, Math.max(1, this.collectionItems.length));
        this.plugin.settings.collectionQuestionCount = this.requestedQuestionCount;
        await this.plugin.saveSettings();
        this.renderSessionSetup();
      });
      [10, 20, 50].filter(value => value < this.collectionItems.length).forEach(value => {
        const quick = this.button(countControls, String(value), async () => {
          this.requestedQuestionCount = value;
          this.plugin.settings.collectionQuestionCount = value;
          await this.plugin.saveSettings();
          this.renderSessionSetup();
        }, `gkr-count-option ${plannedCount === value ? 'is-active' : ''}`);
        quick.setAttribute('aria-pressed', String(plannedCount === value));
      });
      const all = this.button(countControls, '全部', () => {
        this.requestedQuestionCount = this.collectionItems.length;
        this.renderSessionSetup();
      }, `gkr-count-option ${plannedCount === this.collectionItems.length ? 'is-active' : ''}`);
      all.setAttribute('aria-pressed', String(plannedCount === this.collectionItems.length));
    } else {
      const paperCount = setup.createDiv({ cls: 'gkr-paper-count-lock' });
      paperCount.createEl('strong', { text: `原卷共 ${this.collectionItems.length} 道题` });
      paperCount.createSpan({ text: '按卷考试不增删、不抽样，严格使用这套卷的全部题目。', cls: 'gkr-muted' });
    }

    if (this.studyMode === 'guess' || this.studyMode === 'exam') {
      const timing = setup.createDiv({ cls: 'gkr-timing' });
      const label = this.studyMode === 'guess' ? '每题限时' : '整场时间';
      const unit = this.studyMode === 'guess' ? '秒' : '分钟';
      const value = this.studyMode === 'guess' ? this.guessSeconds : this.examMinutes;
      timing.createEl('label', { text: label });
      const input = timing.createEl('input', { type: 'number', value: String(value) });
      input.min = this.studyMode === 'guess' ? '10' : '1';
      input.max = this.studyMode === 'guess' ? '900' : '600';
      timing.createSpan({ text: unit });
      input.addEventListener('change', () => {
        if (this.studyMode === 'guess') this.guessSeconds = clampNumber(input.value, 60, 10, 900);
        else this.examMinutes = clampNumber(input.value, 120, 1, 600);
        input.value = String(this.studyMode === 'guess' ? this.guessSeconds : this.examMinutes);
      });
      timing.createSpan({ text: this.studyMode === 'exam' ? '开始后才启动倒计时' : '超时后自动显示解析', cls: 'gkr-muted' });

      const previewSetting = setup.createEl('button', {
        cls: `gkr-link-preview-setting ${this.linkPreviewEnabled ? 'is-enabled' : ''}`,
        attr: {
          type: 'button',
          'aria-pressed': String(this.linkPreviewEnabled),
          'aria-label': `${this.linkPreviewEnabled ? '关闭' : '开启'}词条双链预览模式`
        }
      });
      const previewIcon = previewSetting.createSpan({ cls: 'gkr-link-preview-setting__icon', attr: { 'aria-hidden': 'true' } });
      if (typeof setIcon === 'function') setIcon(previewIcon, this.linkPreviewEnabled ? 'eye' : 'eye-off');
      const previewCopy = previewSetting.createDiv({ cls: 'gkr-link-preview-setting__copy' });
      previewCopy.createEl('strong', { text: '词条双链预览' });
      previewCopy.createSpan({
        text: this.linkPreviewEnabled
          ? '已开启：词条显示为紫色，可点击或悬浮预览'
          : '已关闭：词条按普通文字显示，不提供答题提示'
      });
      previewSetting.createSpan({ text: this.linkPreviewEnabled ? '开启' : '关闭', cls: 'gkr-link-preview-setting__state' });
      previewSetting.addEventListener('click', () => {
        this.linkPreviewEnabled = !this.linkPreviewEnabled;
        this.renderSessionSetup();
      });
    }

    if (this.studyMode === 'intensive' || this.studyMode === 'exam') {
      const viewPicker = setup.createDiv({ cls: 'gkr-view-picker' });
      const viewCopy = viewPicker.createDiv({ cls: 'gkr-view-picker-copy' });
      viewCopy.createEl('strong', { text: this.studyMode === 'exam' ? '卷面翻页方式' : '整卷阅读方式' });
      viewCopy.createSpan({
        text: PAPER_VIEW_MODES[this.paperViewMode].description,
        cls: 'gkr-muted'
      });
      const switcher = viewPicker.createDiv({ cls: 'gkr-view-switch', attr: { role: 'group', 'aria-label': '卷面阅读方式' } });
      Object.entries(PAPER_VIEW_MODES).forEach(([key, mode]) => {
        const button = this.button(switcher, mode.name, () => {
          this.paperViewMode = key;
          this.renderSessionSetup();
        }, `gkr-view-option ${this.paperViewMode === key ? 'is-active' : ''}`);
        button.setAttribute('aria-pressed', String(this.paperViewMode === key));
      });
    }

    const preview = setup.createDiv({ cls: 'gkr-paper-preview' });
    const previewHead = preview.createDiv({ cls: 'gkr-preview-head' });
    previewHead.createEl('strong', { text: '本次题目' });
    previewHead.createSpan({ text: `${plannedCount} 道`, cls: 'gkr-muted' });
    const previewList = preview.createDiv({ cls: 'gkr-preview-list' });
    if (this.groupMode === 'paper') {
      this.collectionItems.slice(0, 12).forEach((question, index) => {
        previewList.createSpan({ text: question.questionNo === 999999 ? String(index + 1) : String(question.questionNo) });
      });
      if (this.collectionItems.length > 12) previewList.createSpan({ text: `+${this.collectionItems.length - 12}` });
    } else {
      previewList.createSpan({ text: `随机 ${plannedCount}`, cls: 'gkr-preview-random' });
      previewList.createSpan({ text: '同一原题只保留一次', cls: 'gkr-preview-note' });
    }
    const footer = setup.createDiv({ cls: 'gkr-setup-footer' });
    this.button(footer, `开始${STUDY_MODES[this.studyMode].name}`, () => this.startSession(), 'gkr-primary gkr-start');
  }

  startSession() {
    this.resetTemporaryInkSession();
    this.questions = selectSessionQuestions(
      this.collectionItems,
      this.groupMode,
      this.requestedQuestionCount
    );
    this.index = 0;
    this.answers = new Map();
    this.marked = new Set();
    this.revealed = new Set();
    this.docCache = new Map();
    this.cachedSelection = null;
    this.sessionFinished = false;
    this.answerCardOpen = false;
    this.sessionElapsedSeconds = 0;
    this.examTimedOut = false;
    this.paperScrollTop = 0;
    this.rootEl?.toggleClass('gkr-link-preview-enabled', Boolean(this.linkPreviewEnabled && ['guess', 'exam'].includes(this.studyMode)));
    this.sessionStartedAt = Date.now();
    this.questionStartedAt = Date.now();
    this.examDeadline = this.studyMode === 'exam'
      ? this.sessionStartedAt + this.examMinutes * 60 * 1000
      : 0;
    this.renderActiveSession();
  }

  renderActiveSession() {
    this.rootEl?.toggleClass('gkr-link-preview-enabled', Boolean(this.linkPreviewEnabled && ['guess', 'exam'].includes(this.studyMode)));
    const surface = sessionSurfaceForMode(this.studyMode);
    if (surface === 'paper') return this.renderPaperSession(false);
    if (surface === 'exam') return this.renderPaperSession(true);
    return this.renderReader();
  }

  async readParsed(question) {
    if (this.docCache.has(question.path)) return this.docCache.get(question.path);
    const parsed = parseQuestionDocument(await this.app.vault.read(question.file), question.fm);
    this.docCache.set(question.path, parsed);
    return parsed;
  }

  async renderMarkdown(parent, markdown, sourcePath) {
    if (!text(markdown).trim()) {
      parent.createEl('p', { text: '此部分暂无内容。', cls: 'gkr-muted-copy' });
      return;
    }
    const component = new Component();
    this.renderComponents.push(component);
    const studyMarkdown = markdownForStudyMode(markdown, this.studyMode, this.linkPreviewEnabled);
    await MarkdownRenderer.render(this.app, markdownForDisplay(studyMarkdown), parent, sourcePath, component);
    resolveRenderedImages(this.app, parent, sourcePath);
    this.bindInternalLinks(parent, sourcePath, component);
  }

  bindInternalLinks(parent, sourcePath, component) {
    parent.querySelectorAll('a.internal-link').forEach(link => {
      const linktext = internalLinkTarget(link.dataset?.href, link.getAttribute('href'));
      if (!linktext) return;
      component.registerDomEvent(link, 'click', event => {
        event.preventDefault();
        event.stopPropagation();
        void this.plugin.openLinkFromRoamer(linktext, sourcePath, this.leaf);
      });
      component.registerDomEvent(link, 'mouseover', event => {
        this.app.workspace.trigger('hover-link', {
          event,
          source: VIEW_TYPE,
          hoverParent: this,
          targetEl: link,
          linktext,
          sourcePath
        });
      });
    });
  }

  async renderStaticOptions(parent, options, sourcePath) {
    if (!options.length) return;
    const list = parent.createDiv({ cls: 'gkr-static-options', attr: { role: 'list', 'aria-label': '题目选项' } });
    for (const option of options) {
      const row = list.createDiv({ cls: 'gkr-static-option', attr: { role: 'listitem' } });
      row.createSpan({ text: option.key, cls: 'gkr-choice-key' });
      const label = row.createDiv({ cls: 'gkr-choice-label gkr-markdown' });
      await this.renderOptionLabel(label, option.label, sourcePath);
    }
  }

  async renderOptionLabel(parent, label, sourcePath) {
    if (optionNeedsMarkdown(label)) await this.renderMarkdown(parent, label, sourcePath);
    else parent.createEl('p', { text: label });
  }

  async renderQuestionContent(parent, parsed, sourcePath, includeStaticOptions = false) {
    const markdown = hideAnswerMarkers(parsed.options.length ? parsed.stemMarkdown : parsed.questionMarkdown);
    await this.renderMarkdown(parent, markdown, sourcePath);
    if (includeStaticOptions) await this.renderStaticOptions(parent, parsed.options, sourcePath);
  }

  gotoQuestion(index) {
    if (index < 0 || index >= this.questions.length) return;
    this.index = index;
    this.questionStartedAt = Date.now();
    this.cachedSelection = null;
    this.renderActiveSession();
  }

  renderCompactViewSwitch(parent) {
    const switcher = parent.createDiv({ cls: 'gkr-compact-view-switch', attr: { role: 'group', 'aria-label': '卷面翻页方式' } });
    Object.entries(PAPER_VIEW_MODES).forEach(([key, mode]) => {
      const button = this.button(switcher, mode.name, () => {
        if (this.paperViewMode === key) return;
        this.paperViewMode = key;
        this.paperScrollTop = 0;
        this.renderPaperSession(this.studyMode === 'exam');
      }, `gkr-view-option ${this.paperViewMode === key ? 'is-active' : ''}`);
      button.setAttribute('aria-pressed', String(this.paperViewMode === key));
    });
  }

  async renderPaperSession(isExam, { entryDirection = 0 } = {}) {
    clearInterval(this.clockTimer);
    this.unloadRenderComponents();
    if (!this.questions.length) return;
    this.rootEl?.addClass('gkr-session-active');
    this.screen = 'reader';
    this.homeEl = null;
    this.paperIntensiveProgressEl = null;
    this.body.empty();

    const top = this.body.createDiv({ cls: `gkr-reader-top gkr-paper-top ${isExam ? 'is-exam gkr-exam-commandbar' : 'is-intensive'}` });
    this.button(top, '退出', () => this.renderSessionSetup(), 'gkr-back');
    const progress = top.createDiv({ cls: 'gkr-reader-progress gkr-paper-progress' });
    progress.createSpan({ text: isExam ? '考试中' : '整卷精读', cls: 'gkr-session-mode' });
    progress.createEl('strong', { text: this.collection?.title || '当前题组' });
    this.paperPositionEl = progress.createSpan({
      text: `当前 ${this.index + 1} / ${this.questions.length}`,
      cls: 'gkr-session-position'
    });
    if (!isExam) {
      const reading = collectionProgress(this.collectionItems);
      this.paperIntensiveProgressEl = progress.createSpan({
        text: `精读 ${reading.completed}/${reading.total} · ${reading.percent}%`,
        cls: `gkr-session-reading is-${reading.status}`
      });
    }
    const desktopSwitch = top.createDiv({ cls: 'gkr-paper-view-control' });
    this.renderCompactViewSwitch(desktopSwitch);
    const right = top.createDiv({ cls: 'gkr-reader-tools' });
    this.timerEl = right.createSpan({ cls: 'gkr-timer' });
    if (isExam) {
      this.renderTemporaryInkTools(right);
      this.button(right, '答题卡', () => {
        this.answerCardOpen = !this.answerCardOpen;
        this.body.toggleClass('gkr-card-drawer-open', this.answerCardOpen);
        this.body.querySelector('.gkr-answer-card')?.toggleClass('is-open', this.answerCardOpen);
      }, 'gkr-tool-button gkr-card-toggle');
      this.button(right, '交卷', () => this.confirmSubmitExam(), 'gkr-danger-button');
    }

    const layout = this.body.createDiv({
      cls: `gkr-paper-session-layout ${isExam ? 'is-exam' : 'is-intensive'} is-${this.paperViewMode}`
    });
    const viewport = layout.createDiv({ cls: 'gkr-paper-viewport', attr: { tabindex: '0' } });
    this.paperViewport = viewport;
    for (const eventName of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      viewport.addEventListener(eventName, event => event.stopPropagation(), { passive: true });
    }
    const paper = viewport.createEl('main', { cls: 'gkr-paper-canvas' });
    this.paperCanvas = paper;
    const paperHeader = paper.createEl('header', { cls: 'gkr-paper-document-head' });
    paperHeader.createSpan({ text: isExam ? '模拟作答' : '整卷精读', cls: 'gkr-kicker' });
    paperHeader.createEl('h3', { text: this.collection?.title || '当前题组' });
    paperHeader.createEl('p', {
      text: `${this.questions.length} 道题 · ${PAPER_VIEW_MODES[this.paperViewMode].name}${isExam ? ' · 交卷前不显示答案与解析' : ''}`
    });
    if (!isExam) {
      this.renderCollectionPotentialLinkBar(paperHeader, { inPaper: true });
    }

    if (this.paperViewMode === 'vertical') {
      for (let index = 0; index < this.questions.length; index += 1) {
        await this.renderPaperQuestion(paper, this.questions[index], index, isExam);
      }
      this.installPaperScrollTracking(viewport);
      if (this.paperScrollTop) viewport.scrollTop = this.paperScrollTop;
    } else {
      await this.renderPaperQuestion(paper, this.questions[this.index], this.index, isExam);
      this.renderPaperPager(paper);
      this.installHorizontalPaging(viewport);
    }

    if (isExam) {
      const backdrop = layout.createDiv({ cls: 'gkr-card-backdrop' });
      backdrop.addEventListener('click', () => {
        this.answerCardOpen = false;
        this.body.removeClass('gkr-card-drawer-open');
        layout.querySelector('.gkr-answer-card')?.removeClass('is-open');
      });
      this.renderAnswerCard(layout, { persistent: true });
    }
    this.updateClock();
    this.clockTimer = setInterval(() => this.updateClock(), 500);
    if (entryDirection && this.paperViewMode === 'horizontal') {
      await this.animateHorizontalPaper('enter', entryDirection);
    }
  }

  async renderPaperQuestion(parent, question, index, isExam) {
    const parsed = await this.readParsed(question);
    const article = parent.createEl('article', { cls: `gkr-paper-question ${isExam ? 'is-exam' : 'is-intensive'} ${question.intensiveDone ? 'is-intensive-done' : ''}` });
    article.dataset.gkrQuestionIndex = String(index);
    article.dataset.gkrQuestionPath = question.path;
    const head = article.createDiv({ cls: 'gkr-paper-question-head' });
    const identity = head.createDiv({ cls: 'gkr-paper-question-identity' });
    const originalNumber = question.questionNo === 999999 ? index + 1 : question.questionNo;
    identity.createSpan({ text: String(isExam ? index + 1 : originalNumber), cls: 'gkr-paper-question-no' });
    const title = identity.createDiv();
    title.createEl('strong', { text: `第 ${isExam ? index + 1 : originalNumber} 题` });
    if (isExam && originalNumber !== index + 1) title.createSpan({ text: `原卷第 ${originalNumber} 题`, cls: 'gkr-muted' });
    if (!isExam) title.createSpan({ text: question.name, cls: 'gkr-muted' });
    if (!isExam) {
      const chips = head.createDiv({ cls: 'gkr-chips gkr-paper-chips' });
      [question.region, question.subject, question.module, ...question.topics, ...question.mistakes]
        .filter(Boolean).slice(0, 6)
        .forEach(value => chips.createSpan({ text: value, cls: 'gkr-chip' }));
    }

    const questionContent = article.createDiv({ cls: 'gkr-markdown gkr-selectable gkr-paper-question-content' });
    await this.renderQuestionContent(questionContent, parsed, question.path, !isExam);
    if (!isExam) this.watchSelection(questionContent, question, '题目', parsed);

    if (isExam) {
      await this.renderAnswerControls(article, question, parsed, { rerender: false });
      const examTools = article.createDiv({ cls: 'gkr-paper-inline-tools gkr-exam-inline-tools' });
      const marked = this.marked.has(question.path);
      const markButton = this.button(examTools, marked ? '取消标记' : '标记本题', () => {
        if (this.marked.has(question.path)) this.marked.delete(question.path);
        else this.marked.add(question.path);
        markButton.setText(this.marked.has(question.path) ? '取消标记' : '标记本题');
        markButton.toggleClass('is-marked', this.marked.has(question.path));
        this.updateAnswerCardDom();
      }, `gkr-tool-button ${marked ? 'is-marked' : ''}`);
      this.mountTemporaryInk(article, question, index);
      return;
    }

    const answerSection = article.createEl('section', { cls: 'gkr-paper-answer' });
    const answerHead = answerSection.createDiv({ cls: 'gkr-answer-head' });
    answerHead.createSpan({ text: '答案与解析', cls: 'gkr-section-label' });
    answerHead.createSpan({
      text: parsed.correctAnswer ? `答案 ${parsed.correctAnswer}` : '原文未给出可可靠识别的选项答案',
      cls: parsed.correctAnswer ? 'gkr-answer-known' : 'gkr-answer-unknown'
    });
    const answerContent = answerSection.createDiv({ cls: 'gkr-markdown gkr-selectable' });
    await this.renderMarkdown(answerContent, parsed.answerMarkdown, question.path);
    this.watchSelection(answerContent, question, '答案解析', parsed);
    const tools = article.createDiv({ cls: 'gkr-paper-inline-tools' });
    const complete = this.button(tools, question.intensiveDone ? '取消精读完成' : '标记精读完成', async () => {
      complete.disabled = true;
      try {
        await this.setIntensiveDone(question, !question.intensiveDone);
        complete.setText(question.intensiveDone ? '取消精读完成' : '标记精读完成');
        complete.toggleClass('is-complete', question.intensiveDone);
        complete.setAttribute('aria-pressed', String(question.intensiveDone));
        article.toggleClass('is-intensive-done', question.intensiveDone);
        this.updateIntensiveProgressDom();
      } catch (error) {
        new Notice(`精读状态保存失败：${error.message}`);
      } finally {
        complete.disabled = false;
      }
    }, `gkr-tool-button gkr-intensive-toggle ${question.intensiveDone ? 'is-complete' : ''}`);
    complete.setAttribute('aria-pressed', String(question.intensiveDone));
    this.button(tools, '词典 / 双链', () => this.openKnowledgeWorkbench(question, parsed), 'gkr-primary gkr-main-action');
    this.button(tools, '补充元数据', () => this.openMetadata(question), 'gkr-tool-button');
    this.button(tools, '原笔记', () => this.openOriginalNote(question), 'gkr-tool-button');
  }

  async setIntensiveDone(question, completed) {
    const now = new Date().toISOString();
    await this.app.fileManager.processFrontMatter(question.file, fm => {
      applyIntensiveFrontmatter(fm, completed, now);
    });
    const update = item => {
      if (!item || item.path !== question.path) return;
      item.intensiveDone = completed;
      item.fm = applyIntensiveFrontmatter({ ...(item.fm || {}) }, completed, now);
    };
    update(question);
    this.allQuestions.forEach(update);
    this.collectionItems.forEach(update);
    this.questions.forEach(update);
    await this.plugin.notifyStudyTask(question.path, 'intensive', completed);
    new Notice(completed ? '已标记本题精读完成。' : '已取消本题精读完成。');
  }

  updateIntensiveProgressDom() {
    if (!this.paperIntensiveProgressEl) return;
    const progress = collectionProgress(this.collectionItems);
    this.paperIntensiveProgressEl.setText(`精读 ${progress.completed}/${progress.total} · ${progress.percent}%`);
    for (const status of ['not-started', 'in-progress', 'completed']) {
      this.paperIntensiveProgressEl.toggleClass(`is-${status}`, progress.status === status);
    }
  }

  renderPaperPager(parent) {
    const pager = parent.createDiv({ cls: 'gkr-paper-pager' });
    const previous = this.button(pager, '上一题', () => this.gotoPaperQuestion(this.index - 1), 'gkr-nav-button');
    previous.disabled = this.index === 0;
    pager.createSpan({ text: `${this.index + 1} / ${this.questions.length}`, cls: 'gkr-page-count' });
    const next = this.button(pager, '下一题', () => this.gotoPaperQuestion(this.index + 1), 'gkr-nav-button');
    next.disabled = this.index === this.questions.length - 1;
  }

  installHorizontalPaging(viewport) {
    let touchStartX = null;
    let touchStartY = null;
    let touchStartedAt = 0;
    let touchStartHadSelection = false;
    let touchStartedInSelectable = false;
    viewport.addEventListener('touchstart', event => {
      event.stopPropagation();
      const touch = event.touches?.[0];
      if (!touch || event.touches.length !== 1) return;
      const rect = viewport.getBoundingClientRect();
      touchStartX = touch.clientX - rect.left;
      touchStartY = touch.clientY;
      touchStartedAt = Date.now();
      touchStartHadSelection = activeTextSelectionWithin(viewport);
      touchStartedInSelectable = Boolean(event.target?.closest?.('.gkr-selectable'));
    }, { passive: true });
    viewport.addEventListener('touchmove', event => {
      event.stopPropagation();
    }, { passive: true });
    viewport.addEventListener('touchend', event => {
      event.stopPropagation();
      const touch = event.changedTouches?.[0];
      if (!touch || touchStartX == null || touchStartY == null) return;
      const rect = viewport.getBoundingClientRect();
      const direction = horizontalSwipeDirection({
        startX: touchStartX,
        startY: touchStartY,
        endX: touch.clientX - rect.left,
        endY: touch.clientY,
        width: rect.width,
        duration: Date.now() - touchStartedAt,
        hasSelection: touchStartHadSelection || activeTextSelectionWithin(viewport),
        selectableLongPress: touchStartedInSelectable && Date.now() - touchStartedAt > 260
      });
      touchStartX = null;
      touchStartY = null;
      if (direction) this.gotoPaperQuestion(this.index + direction);
    }, { passive: true });
    viewport.addEventListener('touchcancel', event => {
      event.stopPropagation();
      touchStartX = null;
      touchStartY = null;
    }, { passive: true });
    viewport.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      this.gotoPaperQuestion(this.index + (event.key === 'ArrowRight' ? 1 : -1));
    });
    viewport.addEventListener('wheel', event => {
      if (event.ctrlKey || this.paperTransitioning) return;
      const direction = wheelPageDirection({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight
      });
      if (!direction) return;
      const nextIndex = this.index + direction;
      if (nextIndex < 0 || nextIndex >= this.questions.length) return;
      event.preventDefault();
      void this.gotoPaperQuestion(nextIndex);
    }, { passive: false });
  }

  installPaperScrollTracking(viewport) {
    let scheduled = false;
    const update = () => {
      scheduled = false;
      this.paperScrollTop = viewport.scrollTop;
      const top = viewport.getBoundingClientRect().top + 96;
      let closestIndex = this.index;
      let closestDistance = Number.POSITIVE_INFINITY;
      viewport.querySelectorAll('.gkr-paper-question').forEach(article => {
        const distance = Math.abs(article.getBoundingClientRect().top - top);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = Number(article.dataset.gkrQuestionIndex);
        }
      });
      if (Number.isFinite(closestIndex) && closestIndex !== this.index) {
        this.index = closestIndex;
        if (this.paperPositionEl) this.paperPositionEl.setText(`当前 ${this.index + 1} / ${this.questions.length}`);
        this.updateAnswerCardDom();
        this.syncTemporaryInkToolbar();
      }
    };
    viewport.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(update);
      else setTimeout(update, 16);
    }, { passive: true });
  }

  async animateHorizontalPaper(phase, direction) {
    const paper = this.paperCanvas;
    if (!paper?.animate) return;
    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const motion = horizontalPageMotion(direction, reducedMotion);
    paper.style.willChange = 'transform, opacity';
    try {
      const animation = paper.animate(motion[phase], {
        duration: phase === 'exit' ? motion.exitDuration : motion.enterDuration,
        easing: phase === 'exit' ? 'cubic-bezier(.4, 0, 1, 1)' : 'cubic-bezier(.16, 1, .3, 1)',
        fill: 'forwards'
      });
      await animation.finished.catch(() => undefined);
    } finally {
      paper.style.removeProperty('will-change');
    }
  }

  async gotoPaperQuestion(index) {
    if (index < 0 || index >= this.questions.length || index === this.index) return;
    const previousIndex = this.index;
    const direction = index > previousIndex ? 1 : -1;
    this.cachedSelection = null;
    const wasDrawerOpen = this.answerCardOpen;
    this.answerCardOpen = false;
    if (this.paperViewMode === 'vertical' && this.paperViewport) {
      this.index = index;
      if (this.paperPositionEl) this.paperPositionEl.setText(`当前 ${this.index + 1} / ${this.questions.length}`);
      const target = [...this.paperViewport.querySelectorAll('.gkr-paper-question')]
        .find(element => Number(element.dataset.gkrQuestionIndex) === index);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.updateAnswerCardDom();
      this.syncTemporaryInkToolbar();
      if (wasDrawerOpen) {
        this.body.removeClass('gkr-card-drawer-open');
        this.body.querySelector('.gkr-answer-card')?.removeClass('is-open');
      }
      return;
    }
    if (this.paperTransitioning) return;
    this.paperTransitioning = true;
    try {
      await this.animateHorizontalPaper('exit', direction);
      this.index = index;
      this.paperScrollTop = 0;
      await this.renderPaperSession(this.studyMode === 'exam', { entryDirection: direction });
    } finally {
      this.paperTransitioning = false;
    }
  }

  async openOriginalNote(question) {
    const roamerLeaf = this.leaf;
    const context = await this.plugin.openFileFromRoamer(question.file, roamerLeaf);
    new Notice(`原笔记已打开；点击“${context?.descriptor?.short || '返回漫游'}”即可回到原题。`, 3500);
  }

  choosePaperAnswer(question, choice, choices) {
    const previous = this.answers.get(question.path) || {};
    this.answers.set(question.path, { ...previous, choice });
    choices.querySelectorAll('.gkr-choice').forEach(button => {
      button.toggleClass('is-chosen', button.dataset.gkrChoice === choice);
      button.setAttribute('aria-pressed', String(button.dataset.gkrChoice === choice));
    });
    this.updateAnswerCardDom();
  }

  updateAnswerCardDom() {
    const aside = this.body?.querySelector('.gkr-answer-card');
    if (!aside) return;
    const answered = this.questions.filter(question => this.answers.get(question.path)?.choice).length;
    aside.querySelector('.gkr-stat-answered')?.setText(`已答 ${answered}`);
    aside.querySelector('.gkr-stat-unanswered')?.setText(`未答 ${this.questions.length - answered}`);
    aside.querySelector('.gkr-stat-marked')?.setText(`标记 ${this.marked.size}`);
    aside.querySelector('.gkr-answer-card-current')?.setText(`${this.index + 1} / ${this.questions.length}`);
    const progress = aside.querySelector('.gkr-exam-progress-value');
    if (progress) progress.style.transform = `scaleX(${this.questions.length ? answered / this.questions.length : 0})`;
    aside.querySelectorAll('.gkr-card-number').forEach(button => {
      const index = Number(button.dataset.gkrQuestionIndex);
      const question = this.questions[index];
      if (!question) return;
      button.toggleClass('is-answered', Boolean(this.answers.get(question.path)?.choice));
      button.toggleClass('is-marked', this.marked.has(question.path));
      button.toggleClass('is-current', index === this.index);
    });
  }

  async renderReader() {
    clearInterval(this.clockTimer);
    this.unloadRenderComponents();
    this.paperViewport = null;
    const question = this.questions[this.index];
    if (!question) return;
    this.rootEl?.addClass('gkr-session-active');
    this.screen = 'reader';
    this.homeEl = null;
    this.body.empty();
    const parsed = await this.readParsed(question);
    const top = this.body.createDiv({ cls: 'gkr-reader-top' });
    this.button(top, '退出', () => this.renderSessionSetup(), 'gkr-back');
    const progress = top.createDiv({ cls: 'gkr-reader-progress' });
    progress.createSpan({ text: STUDY_MODES[this.studyMode].name, cls: 'gkr-kicker' });
    progress.createEl('strong', { text: `${this.index + 1} / ${this.questions.length}` });
    const right = top.createDiv({ cls: 'gkr-reader-tools' });
    this.timerEl = right.createSpan({ cls: 'gkr-timer' });
    if (this.studyMode === 'exam') {
      this.button(right, '答题卡', () => {
        this.answerCardOpen = !this.answerCardOpen;
        this.renderReader();
      }, 'gkr-tool-button');
      this.button(right, '交卷', () => this.confirmSubmitExam(), 'gkr-danger-button');
    } else {
      if (this.studyMode === 'guess') this.renderTemporaryInkTools(right);
      this.button(right, '原笔记', () => this.openOriginalNote(question), 'gkr-tool-button');
    }
    if (this.studyMode !== 'exam') this.renderCollectionPotentialLinkBar(this.body, { compact: true });

    const layout = this.body.createDiv({ cls: `gkr-reader-layout ${this.answerCardOpen ? 'has-card' : ''}` });
    const main = layout.createEl('main', { cls: 'gkr-reader-main' });
    const inkSurface = main.createDiv({ cls: 'gkr-reader-ink-surface' });
    const paperLine = inkSurface.createDiv({ cls: 'gkr-paper-line' });
    paperLine.createSpan({ text: question.paperTitle || question.name });
    paperLine.createSpan({ text: question.questionNo === 999999 ? '' : `第 ${question.questionNo} 题` });
    inkSurface.createEl('h3', { text: question.name, cls: 'gkr-question-title' });
    const chips = inkSurface.createDiv({ cls: 'gkr-chips' });
    [question.region, question.subject, question.module, ...question.topics, ...question.mistakes]
      .filter(Boolean).slice(0, 8)
      .forEach(value => chips.createSpan({ text: value, cls: 'gkr-chip' }));

    const questionSection = inkSurface.createEl('section', { cls: 'gkr-question-sheet' });
    questionSection.createSpan({ text: '题目', cls: 'gkr-section-label' });
    const questionContent = questionSection.createDiv({ cls: 'gkr-markdown gkr-selectable' });
    await this.renderQuestionContent(questionContent, parsed, question.path, this.studyMode === 'intensive');
    this.watchSelection(questionContent, question, '题目', parsed);

    if (this.studyMode === 'guess' || this.studyMode === 'exam') {
      await this.renderAnswerControls(inkSurface, question, parsed);
    }

    const shouldReveal = this.studyMode === 'intensive' || this.revealed.has(question.path);
    if (shouldReveal) await this.renderReaderAnswer(main, question, parsed);

    if (this.studyMode === 'exam' && this.answerCardOpen) this.renderAnswerCard(layout);
    if (this.studyMode === 'guess') this.mountTemporaryInk(inkSurface, question, this.index);
    this.renderBottomBar(question, parsed);
    this.updateClock();
    this.clockTimer = setInterval(() => this.updateClock(), 500);
  }

  async renderReaderAnswer(parent, question, parsed) {
    if (parent?.matches?.('.gkr-reader-ink-surface')) parent = parent.parentElement;
    const existing = parent.querySelector('.gkr-answer-sheet');
    if (existing) return existing;
    const answerSection = parent.createEl('section', { cls: 'gkr-answer-sheet' });
    const answerHead = answerSection.createDiv({ cls: 'gkr-answer-head' });
    answerHead.createSpan({ text: '答案与解析', cls: 'gkr-section-label' });
    answerHead.createSpan({
      text: parsed.correctAnswer ? `可判分 · ${parsed.correctAnswer}` : '原文未给出可可靠识别的选项答案',
      cls: parsed.correctAnswer ? 'gkr-answer-known' : 'gkr-answer-unknown'
    });
    const answerContent = answerSection.createDiv({ cls: 'gkr-markdown gkr-selectable' });
    await this.renderMarkdown(answerContent, parsed.answerMarkdown, question.path);
    this.watchSelection(answerContent, question, '答案解析', parsed);
    if (this.studyMode === 'guess') this.renderGuessReflection(answerSection, question);
    return answerSection;
  }

  async renderAnswerControls(parent, question, parsed, { rerender = true } = {}) {
    const state = this.answers.get(question.path) || {};
    const isGuessReader = this.studyMode === 'guess' && rerender;
    const isRevealed = isGuessReader && this.revealed.has(question.path);
    const controls = parent.createEl('section', {
      cls: `gkr-choice-section ${isRevealed ? 'is-revealed' : ''}`,
      attr: { 'data-gkr-question-path': question.path }
    });
    controls.createSpan({ text: parsed.options.length ? '选择答案' : '主观题作答状态', cls: 'gkr-section-label' });
    const choices = controls.createDiv({ cls: 'gkr-choices' });
    if (parsed.options.length) {
      for (const option of parsed.options) {
        const presentation = guessChoicePresentation(option.key, state.choice, parsed.correctAnswer, isRevealed);
        const button = this.button(choices, '', () => {
          if (isGuessReader) this.chooseGuessAnswer(question, parsed, option.key, controls);
          else if (rerender) this.chooseAnswer(question, option.key);
          else this.choosePaperAnswer(question, option.key, choices);
        }, `gkr-choice ${presentation.selected ? 'is-chosen' : ''} ${presentation.correct ? 'is-correct' : ''} ${presentation.wrong ? 'is-wrong' : ''} ${presentation.canAdvance ? 'is-next-target' : ''}`);
        button.dataset.gkrChoice = option.key;
        button.setAttribute('aria-pressed', String(presentation.selected));
        button.disabled = presentation.disabled;
        button.createSpan({ text: option.key, cls: 'gkr-choice-key' });
        const label = button.createDiv({ cls: 'gkr-choice-label gkr-markdown' });
        await this.renderOptionLabel(label, option.label, question.path);
      }
    } else {
      this.button(
        choices,
        state.choice === 'DONE' ? '已标记完成' : '标记为已作答',
        () => {
          if (isGuessReader) {
            const currentChoice = this.answers.get(question.path)?.choice;
            this.chooseGuessAnswer(question, parsed, currentChoice === 'DONE' ? '' : 'DONE', controls);
          }
          else if (rerender) this.chooseAnswer(question, state.choice === 'DONE' ? '' : 'DONE');
          else {
            const choice = this.answers.get(question.path)?.choice === 'DONE' ? '' : 'DONE';
            const previous = this.answers.get(question.path) || {};
            this.answers.set(question.path, { ...previous, choice });
            this.renderPaperSession(this.studyMode === 'exam');
          }
        },
        `gkr-subjective ${state.choice === 'DONE' ? 'is-chosen' : ''}`
      );
      controls.createEl('p', { text: '申论等主观题不自动判分；你可以在纸上或原笔记中完成后标记。', cls: 'gkr-muted-copy' });
    }
    if (isGuessReader && !isRevealed && parsed.options.length) {
      controls.createDiv({
        cls: 'gkr-guess-submit-hint',
        text: state.choice ? `已选 ${state.choice}，再点一次该选项提交` : '点一次选中；再点一次同一选项提交'
      });
    } else if (isGuessReader && !isRevealed) {
      const submit = this.button(controls, '提交作答状态', () => this.submitGuess(question, parsed, false, controls), 'gkr-primary gkr-submit-choice');
      submit.disabled = !state.choice;
    } else if (isGuessReader) {
      this.renderGuessAdvanceHint(controls, question, parsed);
    }
  }

  chooseGuessAnswer(question, parsed, choice, controls) {
    const previous = this.answers.get(question.path) || {};
    const action = guessChoiceAction(choice, previous.choice, parsed.correctAnswer, this.revealed.has(question.path));
    if (action === 'advance') {
      this.advanceAfterCorrectGuess(controls);
      return;
    }
    if (action === 'submit') return this.submitGuess(question, parsed, false, controls);
    if (action !== 'select') return;
    this.answers.set(question.path, { ...previous, choice });
    controls.querySelectorAll('.gkr-choice').forEach(button => {
      const selected = button.dataset.gkrChoice === choice;
      button.toggleClass('is-chosen', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const subjective = controls.querySelector('.gkr-subjective');
    if (subjective) {
      subjective.toggleClass('is-chosen', choice === 'DONE');
      subjective.setText(choice === 'DONE' ? '已标记完成' : '标记为已作答');
    }
    const submit = controls.querySelector('.gkr-submit-choice');
    if (submit) submit.disabled = !choice;
    const hint = controls.querySelector('.gkr-guess-submit-hint');
    if (hint) hint.setText(`已选 ${choice}，再点一次该选项提交`);
  }

  chooseAnswer(question, choice) {
    const previous = this.answers.get(question.path) || {};
    this.answers.set(question.path, { ...previous, choice });
    this.renderReader();
  }

  async submitGuess(question, parsed, timedOut, controls = null) {
    if (this.revealed.has(question.path)) return;
    const state = this.answers.get(question.path) || {};
    const elapsed = Math.max(0, Math.round((Date.now() - this.questionStartedAt) / 1000));
    const correctAnswer = singleCorrectAnswerKey(parsed.correctAnswer);
    const correct = correctAnswer && state.choice && state.choice !== 'DONE'
      ? correctAnswer === state.choice
      : null;
    const recordedAt = new Date().toISOString();
    this.answers.set(question.path, { ...state, elapsed, correct, timedOut, recordedAt });
    if (state.choice && state.choice !== 'DONE') await this.plugin.notifyStudyTask(question.path, 'answered', true);
    this.revealed.add(question.path);
    const activeControls = controls || this.body?.querySelector('.gkr-choice-section');
    if (activeControls) await this.revealGuessInPlace(activeControls, question, parsed);
    try {
      await this.appendGuessLog(question, this.answers.get(question.path));
    } catch (error) {
      new Notice(`蒙题记录未写入 YAML：${error.message}`);
    }
  }

  async revealGuessInPlace(controls, question, parsed) {
    controls.addClass('is-revealed');
    controls.querySelector('.gkr-submit-choice')?.remove();
    const state = this.answers.get(question.path) || {};
    controls.querySelectorAll('.gkr-choice').forEach(button => {
      const presentation = guessChoicePresentation(button.dataset.gkrChoice, state.choice, parsed.correctAnswer, true);
      button.toggleClass('is-chosen', presentation.selected);
      button.toggleClass('is-correct', presentation.correct);
      button.toggleClass('is-wrong', presentation.wrong);
      button.toggleClass('is-next-target', presentation.canAdvance);
      button.disabled = presentation.disabled;
    });
    const subjective = controls.querySelector('.gkr-subjective');
    if (subjective) subjective.disabled = true;
    this.renderGuessAdvanceHint(controls, question, parsed);
    await this.renderReaderAnswer(controls.parentElement, question, parsed);
    this.updateGuessBottomBar(question, parsed);
    this.updateClock();
  }

  renderGuessAdvanceHint(controls, question, parsed) {
    controls.querySelector('.gkr-guess-next-hint')?.remove();
    const hint = controls.createDiv({ cls: 'gkr-guess-next-hint', attr: { role: 'status' } });
    const correctAnswer = singleCorrectAnswerKey(parsed.correctAnswer);
    if (!correctAnswer) {
      hint.createEl('strong', { text: parsed.correctAnswer ? `答案：${parsed.correctAnswer}` : '未识别到可靠的选项答案' });
      hint.createSpan({ text: this.index < this.questions.length - 1 ? '请核对解析，然后使用“下一题”。' : '请核对解析；本组已到最后一题。' });
      return;
    }
    if (this.index >= this.questions.length - 1) {
      hint.createEl('strong', { text: `正确答案：${correctAnswer}` });
      hint.createSpan({ text: '这是本组最后一题。' });
      return;
    }
    hint.createEl('strong', { text: `正确答案：${correctAnswer}` });
    hint.createSpan({ text: '再点一次标绿的正确答案，进入下一题。' });
  }

  advanceAfterCorrectGuess(controls) {
    if (this.index < this.questions.length - 1) {
      this.gotoQuestion(this.index + 1);
      return;
    }
    this.sessionFinished = true;
    controls.querySelectorAll('.gkr-choice').forEach(button => { button.disabled = true; });
    const hint = controls.querySelector('.gkr-guess-next-hint');
    if (hint) {
      hint.empty();
      hint.createEl('strong', { text: '本组已完成' });
      hint.createSpan({ text: '可以返回重新组卷，或查看本题解析。' });
    }
    this.updateGuessBottomBar(this.questions[this.index], null, true);
  }

  updateGuessBottomBar(question, parsed, finished = false) {
    const center = this.body?.querySelector('.gkr-bottom-center');
    if (!center) return;
    center.empty();
    if (finished) {
      this.button(center, '返回组卷', () => this.renderHome(), 'gkr-primary gkr-main-action');
      return;
    }
    if (singleCorrectAnswerKey(parsed?.correctAnswer)) {
      center.createSpan({ text: '点正确答案继续', cls: 'gkr-muted' });
    } else {
      center.createSpan({ text: '核对解析后继续', cls: 'gkr-muted' });
    }
    this.button(center, '词典 / 双链', () => this.openKnowledgeWorkbench(question, parsed), 'gkr-tool-button gkr-main-action');
    const next = this.body?.querySelector('.gkr-next-question');
    if (next) next.disabled = !canUseGuessNextButton(true, parsed?.correctAnswer) || this.index >= this.questions.length - 1;
  }

  async appendGuessLog(question, state) {
    await this.app.fileManager.processFrontMatter(question.file, fm => {
      const history = Array.isArray(fm.guess_history) ? [...fm.guess_history] : [];
      history.push({
        at: state.recordedAt,
        choice: state.choice || '',
        elapsed_seconds: state.elapsed,
        correct: state.correct,
        timed_out: Boolean(state.timedOut),
        technique_summary: ''
      });
      fm.guess_history = history.slice(-20);
      fm.last_guess_choice = state.choice || '';
      fm.last_guess_elapsed_seconds = state.elapsed;
      fm.last_guess_correct = state.correct;
      fm.last_guess_at = state.recordedAt;
    });
  }

  renderGuessReflection(parent, question) {
    const state = this.answers.get(question.path) || {};
    const result = parent.createDiv({ cls: 'gkr-guess-result' });
    const verdict = state.correct === true ? '判断正确' : state.correct === false ? '判断错误' : '无法自动判分';
    result.createEl('strong', { text: `${verdict} · 用时 ${state.elapsed || 0} 秒` });
    result.createEl('p', { text: state.timedOut ? '本题已超时。把当时依赖的关键词或排除依据记下来。' : '记录你当时依赖的关键词、排除依据或直觉来源。' });
    const textarea = result.createEl('textarea', { placeholder: '例如：看到“必然”先检查绝对化表述；两个选项含义相近时不急着二选一。' });
    textarea.value = state.techniqueSummary || '';
    const save = this.button(result, '保存蒙题技巧总结', async () => {
      save.disabled = true;
      try {
        await this.saveTechniqueSummary(question, state.recordedAt, textarea.value.trim());
        this.answers.set(question.path, { ...this.answers.get(question.path), techniqueSummary: textarea.value.trim() });
        new Notice('蒙题技巧已写入题目 YAML。');
      } catch (error) {
        new Notice(`保存失败：${error.message}`);
      } finally {
        save.disabled = false;
      }
    }, 'gkr-tool-button');
  }

  async saveTechniqueSummary(question, recordedAt, summary) {
    await this.app.fileManager.processFrontMatter(question.file, fm => {
      const history = Array.isArray(fm.guess_history) ? [...fm.guess_history] : [];
      const index = history.findIndex(item => item && item.at === recordedAt);
      if (index >= 0) history[index] = { ...history[index], technique_summary: summary };
      fm.guess_history = history;
      fm.guess_technique_summary = summary;
    });
  }

  renderBottomBar(question, parsed) {
    const bar = this.body.createDiv({ cls: 'gkr-bottom-bar' });
    const left = bar.createDiv({ cls: 'gkr-bottom-side' });
    const previous = this.button(left, '上一题', () => this.gotoQuestion(this.index - 1), 'gkr-nav-button');
    previous.disabled = this.index === 0;
    const center = bar.createDiv({ cls: 'gkr-bottom-center' });
    if (this.studyMode === 'intensive') {
      this.button(center, '词典 / 双链', () => this.openKnowledgeWorkbench(question, parsed), 'gkr-primary gkr-main-action');
      this.button(center, '补充元数据', () => this.openMetadata(question), 'gkr-tool-button');
    } else if (this.studyMode === 'guess') {
      if (this.revealed.has(question.path)) {
        this.button(center, '词典 / 双链', () => this.openKnowledgeWorkbench(question, parsed), 'gkr-primary gkr-main-action');
      } else {
        center.createSpan({ text: '先作答，再查看解析', cls: 'gkr-muted' });
      }
    } else {
      const marked = this.marked.has(question.path);
      this.button(center, marked ? '取消标记' : '标记本题', () => {
        if (marked) this.marked.delete(question.path);
        else this.marked.add(question.path);
        this.renderReader();
      }, `gkr-tool-button ${marked ? 'is-marked' : ''}`);
    }
    const right = bar.createDiv({ cls: 'gkr-bottom-side gkr-align-right' });
    const next = this.button(right, '下一题', () => this.gotoQuestion(this.index + 1), 'gkr-nav-button gkr-next-question');
    const guessBlocksNext = this.studyMode === 'guess'
      && !canUseGuessNextButton(this.revealed.has(question.path), parsed.correctAnswer);
    next.disabled = this.index === this.questions.length - 1 || guessBlocksNext;
  }

  watchSelection(element, question, section, parsed = null) {
    const selectionInside = () => {
      const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
      const selected = selection?.toString().trim() || '';
      const anchor = selection?.anchorNode;
      const focus = selection?.focusNode;
      if (!selected || !anchor || !element.contains(anchor) || (focus && !element.contains(focus))) return '';
      return noPhysicalBlankLines(selected);
    };
    const remember = () => {
      setTimeout(() => {
        const selected = selectionInside();
        if (!selected) return;
        this.cachedSelection = { text: selected, path: question.path, section };
      }, 0);
    };
    element.addEventListener('pointerup', remember);
    element.addEventListener('touchend', remember);
    if (!Platform.isMobile && typeof Menu === 'function') {
      element.addEventListener('contextmenu', event => {
        const selected = selectionInside()
          || (this.cachedSelection?.path === question.path && this.cachedSelection?.section === section ? this.cachedSelection.text : '');
        if (!selected) return;
        event.preventDefault();
        this.cachedSelection = { text: selected, path: question.path, section };
        const shortTitle = selected.length > 36 ? `${selected.slice(0, 36)}…` : selected;
        const menu = new Menu();
        menu.addItem(item => item
          .setTitle('查找相同或相似词条并关联')
          .setIcon('search')
          .onClick(() => this.openKnowledgeWorkbench(question, parsed, { selected, section })));
        menu.addItem(item => item
          .setTitle(`新建词条「${shortTitle}」`)
          .setIcon('book-plus')
          .onClick(() => this.createLexiconAndLink(question, parsed, selected, section, selected)));
        menu.addSeparator();
        menu.addItem(item => item
          .setTitle('复制选中文字')
          .setIcon('copy')
          .onClick(async () => {
            try {
              if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板');
              await navigator.clipboard.writeText(selected);
              new Notice('已复制选中文字。');
            } catch (error) {
              new Notice(`复制失败：${error.message}`);
            }
          }));
        menu.showAtMouseEvent(event);
      });
    }
  }

  selectedTextForQuestion(question) {
    const liveSelection = typeof window !== 'undefined' ? window.getSelection?.().toString().trim() : '';
    const cached = this.cachedSelection?.path === question.path ? this.cachedSelection : null;
    return {
      selected: noPhysicalBlankLines(liveSelection || cached?.text || ''),
      section: cached?.section || '题目'
    };
  }

  renderCollectionPotentialLinkBar(parent, options = {}) {
    if (!parent || !this.collection || !this.collectionItems.length || !['paper', 'topic'].includes(this.groupMode)) return null;
    const scopeLabel = this.groupMode === 'paper' ? '整套卷' : '整个专题';
    const bar = parent.createDiv({
      cls: `gkr-collection-linkbar ${options.inPaper ? 'is-in-paper' : ''} ${options.compact ? 'is-compact' : ''}`
    });
    const copy = bar.createDiv({ cls: 'gkr-collection-linkbar__copy' });
    if (!options.inPaper) copy.createEl('strong', { text: this.collection.title });
    copy.createSpan({
      text: `从词典已有词条中，检查${scopeLabel}的未链接同名文字`
    });
    const button = this.button(bar, '', () => this.openCollectionPotentialLinks(), 'gkr-collection-link-button');
    const icon = button.createSpan({ cls: 'gkr-collection-link-button__icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(icon, 'link-2');
    button.createSpan({ text: '查找潜在链接' });
    button.setAttribute('aria-label', `查找${this.collection.title}中的潜在词条链接`);
    return bar;
  }

  async openCollectionPotentialLinks() {
    const dictionary = this.dictionaryPlugin();
    if (!dictionary || typeof dictionary.listLexiconEntries !== 'function') {
      new Notice('未找到可用的“考公词典”词条数据，请先启用词典插件。');
      return;
    }
    new CollectionPotentialLinksModal(this.app, {
      collectionTitle: this.collection?.title || '当前题组',
      scan: async onProgress => {
        const entries = await dictionary.listLexiconEntries();
        return scanCollectionPotentialLinks(
          this.questionsForCurrentCollection(),
          entries,
          question => this.app.vault.cachedRead?.(question.file) || this.app.vault.read(question.file),
          onProgress
        );
      },
      apply: selected => this.applyCollectionPotentialLinks(selected)
    }).open();
  }

  questionsForCurrentCollection() {
    if (this.groupMode === 'paper') {
      const origin = this.collectionItems[0];
      return origin ? dedupeCollectionQuestions(questionsForBacklinkScope(this.allQuestions, origin, 'paper'), 'paper') : [];
    }
    if (this.groupMode === 'topic') {
      const topic = text(this.collection?.key).trim();
      return topic ? dedupeCollectionQuestions(this.allQuestions.filter(question => question.topics?.includes(topic)), 'topic') : [];
    }
    return dedupeCollectionQuestions(this.collectionItems, this.groupMode);
  }

  dictionaryPlugin() {
    return this.app.plugins?.plugins?.[this.plugin.settings.dictionaryPluginId] || null;
  }

  async knowledgeCandidates(query, question) {
    const dictionary = this.dictionaryPlugin();
    const candidates = [];
    if (dictionary && typeof dictionary.listLexiconEntries === 'function') {
      const entries = await dictionary.listLexiconEntries();
      const matches = typeof dictionary.findLexiconMatches === 'function'
        ? dictionary.findLexiconMatches(query, entries)
        : { exact: [], similar: [] };
      for (const match of [...(matches.exact || []), ...(matches.similar || [])]) {
        candidates.push({
          type: '词典',
          title: match.entry.title,
          path: match.entry.path,
          score: match.score,
          entry: match.entry,
          file: match.entry.file
        });
      }
    }
    const noteCandidates = findPotentialLinkCandidates(query, this.app.vault.getMarkdownFiles(), this.app, question.path);
    const seen = new Set(candidates.map(candidate => candidate.path));
    for (const candidate of noteCandidates) {
      if (!seen.has(candidate.path)) candidates.push(candidate);
      seen.add(candidate.path);
    }
    return candidates
      .filter(candidate => candidate.path && candidate.path !== question.path)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, 20);
  }

  async scanBacklinkOccurrences(question, query, scope, topic = '') {
    const candidates = questionsForBacklinkScope(this.allQuestions, question, scope, topic);
    const results = [];
    const batchSize = scope === 'all' ? 40 : 80;
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const scanned = await Promise.all(batch.map(async item => {
        const source = await this.app.vault.read(item.file);
        const match = scanQuestionSourceForTerm(source, query);
        if (!match.total) return null;
        const originalNumber = item.questionNo === 999999 ? '?' : item.questionNo;
        return {
          path: item.path,
          total: match.total,
          sections: match.sections,
          label: `${item.paperTitle || item.name} · 第 ${originalNumber} 题`,
          summary: `题目 ${match.sections['题目']} 处 · 答案解析 ${match.sections['答案解析']} 处`
        };
      }));
      results.push(...scanned.filter(Boolean));
    }
    return results;
  }

  backlinkBackupPath() {
    return pluginStoragePath(this.plugin.manifest, 'backlink-backup.json');
  }

  async writeBacklinkBackup(files, meta = {}) {
    const payload = {
      version: 1,
      createdAt: new Date().toISOString(),
      undoneAt: null,
      meta,
      files
    };
    await this.app.vault.adapter.write(this.backlinkBackupPath(), JSON.stringify(payload, null, 2));
    return payload;
  }

  async applyBatchBacklinks(question, candidate, query, selectedPaths) {
    const selected = new Set(selectedPaths || []);
    const targets = this.allQuestions.filter(item => selected.has(item.path));
    if (!targets.length) throw new Error('请至少勾选一道题。');
    const beforeByPath = new Map();
    const changedQuestions = [];
    let linkCount = 0;
    const dictionary = this.dictionaryPlugin();
    try {
      for (const item of targets) {
        const before = await this.app.vault.read(item.file);
        const transformed = linkAllOccurrencesInQuestionSource(before, query, candidate.path);
        if (!transformed.changed) continue;
        beforeByPath.set(item.path, before);
        await this.app.vault.modify(item.file, transformed.content);
        const link = transformed.link || wikiLink(candidate.path, query);
        await this.app.fileManager.processFrontMatter(item.file, fm => {
          fm.related_terms = uniqueStrings([...(asArray(fm.related_terms)), query]);
          if (candidate.entry?.entry_id) {
            fm.knowledge_ids = uniqueStrings([...(asArray(fm.knowledge_ids)), candidate.entry.entry_id]);
            fm.lexicon_links = uniqueStrings([...(asArray(fm.lexicon_links)), link]);
          } else {
            fm.related_notes = uniqueStrings([...(asArray(fm.related_notes)), link]);
          }
        });
        changedQuestions.push(item);
        linkCount += transformed.total;
      }
      if (!changedQuestions.length) throw new Error('勾选的题目中没有可写入的未链接原文。');
      if (candidate.entry && dictionary && typeof dictionary.saveLexiconEntry === 'function') {
        const entryFile = this.app.vault.getAbstractFileByPath(candidate.path);
        if (entryFile) beforeByPath.set(candidate.path, await this.app.vault.read(entryFile));
        candidate.entry = await dictionary.saveLexiconEntry({
          ...candidate.entry,
          source_notes: uniqueStrings([
            ...(asArray(candidate.entry.source_notes)),
            ...changedQuestions.map(item => wikiLink(item.path))
          ])
        });
      }
      const backups = [];
      for (const [path, before] of beforeByPath) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        backups.push({ path, before, after: await this.app.vault.read(file) });
      }
      await this.writeBacklinkBackup(backups, {
        query,
        targetPath: candidate.path,
        questionCount: changedQuestions.length,
        linkCount
      });
      for (const item of changedQuestions) {
        this.docCache.delete(item.path);
        item.fm = frontmatter(item.file, this.app);
      }
      if (this.screen === 'reader') await this.renderActiveSession();
      return { files: changedQuestions.length, links: linkCount };
    } catch (error) {
      for (const [path, before] of [...beforeByPath].reverse()) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) continue;
        try { await this.app.vault.modify(file, before); } catch { }
      }
      throw error;
    }
  }

  async applyCollectionPotentialLinks(selectedCandidates) {
    const questionByPath = new Map(this.allQuestions.map(question => [question.path, question]));
    const beforeByPath = new Map();
    const workingByPath = new Map();
    const relationsByPath = new Map();
    let linkCount = 0;
    try {
      for (const group of selectedCandidates || []) {
        const candidate = group.candidate;
        const query = text(group.query).trim();
        if (!candidate?.path || !query) continue;
        for (const occurrence of group.occurrences || []) {
          const question = questionByPath.get(occurrence.path);
          if (!question) continue;
          let source = workingByPath.get(question.path);
          if (source == null) {
            source = await this.app.vault.read(question.file);
            beforeByPath.set(question.path, source);
          }
          const transformed = linkAllOccurrencesInQuestionSource(source, query, candidate.path);
          if (!transformed.changed) continue;
          workingByPath.set(question.path, transformed.content);
          linkCount += transformed.total;
          const relation = relationsByPath.get(question.path) || { terms: [], ids: [], links: [] };
          relation.terms.push(query);
          if (candidate.entry?.entry_id) relation.ids.push(candidate.entry.entry_id);
          relation.links.push(transformed.link || wikiLink(candidate.path, query));
          relationsByPath.set(question.path, relation);
        }
      }
      if (!workingByPath.size) throw new Error('所选候选中没有可写入的未链接原文。');
      for (const [path, content] of workingByPath) {
        const question = questionByPath.get(path);
        await this.app.vault.modify(question.file, content);
      }
      for (const [path, relation] of relationsByPath) {
        const question = questionByPath.get(path);
        await this.app.fileManager.processFrontMatter(question.file, fm => {
          fm.related_terms = uniqueStrings([...(asArray(fm.related_terms)), ...relation.terms]);
          fm.knowledge_ids = uniqueStrings([...(asArray(fm.knowledge_ids)), ...relation.ids]);
          fm.lexicon_links = uniqueStrings([...(asArray(fm.lexicon_links)), ...relation.links]);
        });
      }
      const backups = [];
      for (const [path, before] of beforeByPath) {
        if (!workingByPath.has(path)) continue;
        const question = questionByPath.get(path);
        backups.push({ path, before, after: await this.app.vault.read(question.file) });
      }
      await this.writeBacklinkBackup(backups, {
        collectionKey: this.collection?.key || '',
        collectionTitle: this.collection?.title || '',
        groupMode: this.groupMode,
        candidateCount: selectedCandidates.length,
        questionCount: workingByPath.size,
        linkCount
      });
      for (const path of workingByPath.keys()) {
        const question = questionByPath.get(path);
        this.docCache.delete(path);
        question.fm = frontmatter(question.file, this.app);
      }
      if (this.screen === 'reader') await this.renderActiveSession();
      return { files: workingByPath.size, links: linkCount };
    } catch (error) {
      for (const [path, before] of [...beforeByPath].reverse()) {
        const question = questionByPath.get(path);
        if (!question) continue;
        try { await this.app.vault.modify(question.file, before); } catch { }
      }
      throw error;
    }
  }

  async linkQuestionToCandidate(question, selection, section, candidate) {
    const readerScrollTop = this.body?.querySelector('.gkr-reader-main')?.scrollTop || 0;
    if (this.paperViewport) this.paperScrollTop = this.paperViewport.scrollTop;
    const source = await this.app.vault.read(question.file);
    const transformed = insertWikiLinkInQuestionSource(source, selection, candidate.path, section);
    if (!transformed.changed && !transformed.alreadyLinked) throw new Error(transformed.reason || '无法在题目原文中建立双链。');
    if (transformed.changed) await this.app.vault.modify(question.file, transformed.content);
    const link = transformed.link || wikiLink(candidate.path, selection);
    await this.app.fileManager.processFrontMatter(question.file, fm => {
      fm.related_terms = uniqueStrings([...(asArray(fm.related_terms)), selection]);
      if (candidate.entry?.entry_id) {
        fm.knowledge_ids = uniqueStrings([...(asArray(fm.knowledge_ids)), candidate.entry.entry_id]);
        fm.lexicon_links = uniqueStrings([...(asArray(fm.lexicon_links)), link]);
      } else {
        fm.related_notes = uniqueStrings([...(asArray(fm.related_notes)), link]);
      }
    });
    const dictionary = this.dictionaryPlugin();
    if (candidate.entry && dictionary && typeof dictionary.saveLexiconEntry === 'function') {
      const sourceLink = wikiLink(question.path);
      candidate.entry = await dictionary.saveLexiconEntry({
        ...candidate.entry,
        source_notes: uniqueStrings([...(asArray(candidate.entry.source_notes)), sourceLink])
      });
    }
    this.docCache.delete(question.path);
    question.fm = frontmatter(question.file, this.app);
    new Notice(`已建立双链：${selection} → ${candidate.title}`);
    if (this.screen === 'reader') {
      await this.renderActiveSession();
      const restore = () => {
        const reader = this.body?.querySelector('.gkr-reader-main');
        if (reader) reader.scrollTop = readerScrollTop;
        if (this.paperViewport && this.paperScrollTop) this.paperViewport.scrollTop = this.paperScrollTop;
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
      else setTimeout(restore, 0);
    }
  }

  async createLexiconAndLink(question, parsed, selection, section, title) {
    const dictionary = this.dictionaryPlugin();
    if (!dictionary) {
      new Notice('未找到“考公词典”插件，请先启用它。');
      return;
    }
    const payload = {
      ...buildLexiconPayload(question, parsed, selection, section),
      title,
      openAfterSave: false,
    };
    if (typeof dictionary.captureToLexicon === 'function') {
      const entry = await dictionary.captureToLexicon(payload);
      const query = text(title || selection).trim();
      const candidate = { type: '词典', title: entry.title, path: entry.path, score: 1, entry, file: entry.file };
      await this.linkQuestionToCandidate(question, query, section, candidate);
      new Notice('词条已直接加入收件箱；详细内容可稍后在 Windows 补充。', 4500);
      return;
    }
    if (typeof dictionary.openLexiconCapture === 'function') {
      dictionary.openLexiconCapture(payload);
      return;
    }
    new Notice('当前“考公词典”版本不支持直接收词，请升级词典插件。');
  }

  openKnowledgeWorkbench(question, parsed, override = null) {
    const { selected, section } = override || this.selectedTextForQuestion(question);
    if (!selected) {
      new Notice('请先用手指或 Apple Pencil 选中题干、选项或解析中的词。');
      return;
    }
    new KnowledgeLinkModal(this.app, {
      selection: selected,
      topics: question.topics,
      initialCandidate: override?.initialCandidate || null,
      initialScope: override?.initialScope || 'question',
      initialTopic: override?.initialTopic || (this.groupMode === 'topic' ? this.collection?.key : question.topics?.[0]) || '',
      findCandidates: query => this.knowledgeCandidates(query, question),
      scanOccurrences: (candidate, query, scope, topic) => this.scanBacklinkOccurrences(question, query, scope, topic),
      applyOccurrences: (candidate, query, paths) => this.applyBatchBacklinks(question, candidate, query, paths),
      onCreate: title => this.createLexiconAndLink(question, parsed, selected, section, title),
      onLink: (candidate, query) => this.linkQuestionToCandidate(question, query, section, candidate)
    }).open();
  }

  promptMoreBacklinks(question, candidate, query) {
    const topic = (this.groupMode === 'topic' ? this.collection?.key : '') || question.topics?.[0] || '';
    const hasPaper = Boolean(text(question.paperId || question.paperTitle).trim());
    if (!hasPaper && !topic) return;
    new BacklinkFollowupModal(this.app, {
      query,
      hasPaper,
      topic,
      onChoose: scope => this.openBacklinkPlanner(question, candidate, query, scope, topic)
    }).open();
  }

  openBacklinkPlanner(question, candidate, query, scope, topic = '') {
    new KnowledgeLinkModal(this.app, {
      selection: query,
      topics: question.topics,
      initialCandidate: candidate,
      initialScope: scope,
      initialTopic: topic,
      findCandidates: value => this.knowledgeCandidates(value, question),
      scanOccurrences: (target, value, nextScope, nextTopic) => this.scanBacklinkOccurrences(question, value, nextScope, nextTopic),
      applyOccurrences: (target, value, paths) => this.applyBatchBacklinks(question, target, value, paths),
      onCreate: title => this.createLexiconAndLink(question, null, query, '题目', title),
      onLink: (target, value) => this.linkQuestionToCandidate(question, value, '题目', target),
      onRequestMoreLinks: () => {}
    }).open();
  }

  openMetadata(question) {
    new MetadataModal(this.app, question, async patch => {
      await this.app.fileManager.processFrontMatter(question.file, fm => {
        const next = mergeFrontmatterFields(fm, patch);
        for (const key of Object.keys(fm)) delete fm[key];
        Object.assign(fm, next);
      });
      Object.assign(question, {
        topics: patch.topics,
        mistakes: patch.mistakes,
        status: patch.status,
        reviewReady: patch.review_ready
      });
      new Notice('题目元数据已更新。');
      this.renderActiveSession();
    }).open();
  }

  renderAnswerCard(parent, { persistent = false } = {}) {
    const aside = parent.createEl('aside', { cls: `gkr-answer-card ${persistent ? 'is-persistent' : ''} ${this.answerCardOpen ? 'is-open' : ''}` });
    const head = aside.createDiv({ cls: 'gkr-answer-card-head' });
    head.createEl('strong', { text: '答题卡' });
    head.createSpan({ text: `${this.index + 1} / ${this.questions.length}`, cls: 'gkr-answer-card-current' });
    const close = this.button(head, '关闭', () => {
      this.answerCardOpen = false;
      this.body.removeClass('gkr-card-drawer-open');
      aside.removeClass('is-open');
    }, 'gkr-quiet gkr-card-close');
    close.setAttribute('aria-label', '关闭答题卡');
    const stats = aside.createDiv({ cls: 'gkr-answer-stats' });
    const answered = this.questions.filter(question => this.answers.get(question.path)?.choice).length;
    stats.createSpan({ text: `已答 ${answered}`, cls: 'gkr-stat-answered' });
    stats.createSpan({ text: `未答 ${this.questions.length - answered}`, cls: 'gkr-stat-unanswered' });
    stats.createSpan({ text: `标记 ${this.marked.size}`, cls: 'gkr-stat-marked' });
    const progress = aside.createDiv({ cls: 'gkr-exam-progress-track', attr: { 'aria-label': '作答进度' } });
    const answeredPercent = this.questions.length ? answered / this.questions.length * 100 : 0;
    progress.createDiv({ cls: 'gkr-exam-progress-value', attr: { style: `transform:scaleX(${answeredPercent / 100})` } });
    const legend = aside.createDiv({ cls: 'gkr-card-legend' });
    [['当前', 'is-current'], ['已答', 'is-answered'], ['标记', 'is-marked']].forEach(([label, className]) => {
      const item = legend.createSpan();
      item.createSpan({ cls: `gkr-legend-dot ${className}` });
      item.createSpan({ text: label });
    });
    const grid = aside.createDiv({ cls: 'gkr-card-grid' });
    this.questions.forEach((question, index) => {
      const isAnswered = Boolean(this.answers.get(question.path)?.choice);
      const isMarked = this.marked.has(question.path);
      const className = `gkr-card-number ${isAnswered ? 'is-answered' : ''} ${isMarked ? 'is-marked' : ''} ${index === this.index ? 'is-current' : ''}`;
      const number = index + 1;
      const button = this.button(grid, String(number), () => {
        if (persistent) this.gotoPaperQuestion(index);
        else this.gotoQuestion(index);
      }, className);
      button.dataset.gkrQuestionIndex = String(index);
      const originalNumber = question.questionNo === 999999 ? '' : `，原卷第 ${question.questionNo} 题`;
      button.setAttribute('aria-label', `本次第 ${number} 题${originalNumber}${isAnswered ? '，已答' : '，未答'}${isMarked ? '，已标记' : ''}`);
    });
    if (persistent) {
      const footer = aside.createDiv({ cls: 'gkr-answer-card-footer' });
      const submit = this.button(footer, '交卷并查看结果', () => this.confirmSubmitExam(), 'gkr-primary gkr-submit-exam');
      submit.setAttribute('aria-label', `交卷，当前已答 ${answered} 题，共 ${this.questions.length} 题`);
    }
  }

  updateClock() {
    if (!this.timerEl || this.sessionFinished) return;
    const now = Date.now();
    if (this.studyMode === 'exam') {
      const snapshot = timerSnapshot(now, this.sessionStartedAt, this.examDeadline);
      this.timerEl.setText(`剩余 ${formatTime(snapshot.remainingSeconds)}`);
      this.timerEl.toggleClass('is-urgent', snapshot.remainingSeconds <= 300);
      if (snapshot.expired) this.finishExam(true);
      return;
    }
    if (this.studyMode === 'guess' && !this.revealed.has(this.questions[this.index].path)) {
      const deadline = this.questionStartedAt + this.guessSeconds * 1000;
      const snapshot = timerSnapshot(now, this.questionStartedAt, deadline);
      this.timerEl.setText(`本题 ${formatTime(snapshot.remainingSeconds)}`);
      this.timerEl.toggleClass('is-urgent', snapshot.remainingSeconds <= 10);
      if (snapshot.expired) {
        const question = this.questions[this.index];
        this.readParsed(question).then(parsed => this.submitGuess(question, parsed, true));
      }
      return;
    }
    const snapshot = timerSnapshot(now, this.sessionStartedAt, null);
    this.timerEl.setText(`已学习 ${formatTime(snapshot.elapsedSeconds)}`);
  }

  confirmSubmitExam() {
    const answered = this.questions.filter(question => this.answers.get(question.path)?.choice).length;
    const unanswered = this.questions.length - answered;
    new ConfirmModal(
      this.app,
      '确认交卷？',
      unanswered ? `还有 ${unanswered} 道题未作答。交卷后才会显示答案与统计。` : '所有题目均已作答。交卷后将显示答案与统计。',
      () => this.finishExam(false)
    ).open();
  }

  async finishExam(timedOut) {
    if (this.sessionFinished) return;
    this.sessionFinished = true;
    this.examTimedOut = timedOut;
    this.sessionElapsedSeconds = Math.round((Date.now() - this.sessionStartedAt) / 1000);
    clearInterval(this.clockTimer);
    for (const question of this.questions) {
      const state = this.answers.get(question.path) || {};
      const parsed = await this.readParsed(question);
      const correct = parsed.correctAnswer && state.choice && state.choice !== 'DONE'
        ? parsed.correctAnswer === state.choice
        : null;
      this.answers.set(question.path, { ...state, correct, correctAnswer: parsed.correctAnswer });
      if (state.choice && state.choice !== 'DONE') await this.plugin.notifyStudyTask(question.path, 'answered', true);
    }
    this.renderExamResults(timedOut);
  }

  renderExamResults(timedOut) {
    this.resetTemporaryInkSession();
    this.unloadRenderComponents();
    this.rootEl?.addClass('gkr-session-active');
    this.screen = 'results';
    this.homeEl = null;
    this.body.empty();
    const answered = this.questions.filter(question => this.answers.get(question.path)?.choice).length;
    const judgeable = this.questions.filter(question => this.answers.get(question.path)?.correct != null);
    const correct = judgeable.filter(question => this.answers.get(question.path).correct).length;
    const elapsed = this.sessionElapsedSeconds;
    const result = this.body.createDiv({ cls: 'gkr-results' });
    const resultHead = result.createDiv({ cls: 'gkr-results-head' });
    const resultCopy = resultHead.createDiv({ cls: 'gkr-results-head__copy' });
    resultCopy.createSpan({ text: timedOut ? 'TIME UP' : 'EXAM COMPLETE', cls: 'gkr-kicker' });
    resultCopy.createEl('h3', { text: timedOut ? '考试时间到' : '本次考试已交卷' });
    resultCopy.createEl('p', { text: this.collection.title, cls: 'gkr-muted-copy' });
    const actions = resultHead.createDiv({ cls: 'gkr-result-actions' });
    this.button(actions, '重新考试', () => this.startSession(), 'gkr-primary');
    this.button(actions, '返回模式选择', () => this.renderSessionSetup(), 'gkr-tool-button');
    this.button(actions, '返回首页', () => this.renderHome(), 'gkr-tool-button');
    const metrics = result.createDiv({ cls: 'gkr-result-metrics' });
    this.resultMetric(metrics, String(answered), `已答 / ${this.questions.length}`);
    this.resultMetric(metrics, judgeable.length ? `${Math.round(correct / judgeable.length * 100)}%` : '—', `可判分 ${judgeable.length} 题`);
    this.resultMetric(metrics, formatTime(elapsed), '实际用时');
    const list = result.createDiv({ cls: 'gkr-result-list' });
    this.questions.forEach((question, index) => {
      const state = this.answers.get(question.path) || {};
      const row = this.button(list, '', () => this.openExamReview(index), 'gkr-result-row');
      row.createSpan({ text: String(index + 1), cls: 'gkr-result-no' });
      const info = row.createDiv();
      info.createEl('strong', { text: question.name });
      info.createSpan({ text: `你的答案：${state.choice || '未答'} · 正确答案：${state.correctAnswer || '无法可靠识别'}`, cls: 'gkr-muted' });
      row.createSpan({
        text: state.correct === true ? '正确' : state.correct === false ? '错误' : '待自评',
        cls: `gkr-verdict ${state.correct === true ? 'is-correct' : state.correct === false ? 'is-wrong' : ''}`
      });
    });
  }

  resultMetric(parent, value, label) {
    const metric = parent.createDiv({ cls: 'gkr-result-metric' });
    metric.createEl('strong', { text: value });
    metric.createSpan({ text: label });
  }

  async openExamReview(index) {
    this.index = index;
    const question = this.questions[index];
    const parsed = await this.readParsed(question);
    this.unloadRenderComponents();
    this.screen = 'review';
    this.homeEl = null;
    this.body.empty();
    const top = this.body.createDiv({ cls: 'gkr-reader-top' });
    this.button(top, '返回成绩', () => this.renderExamResults(this.examTimedOut), 'gkr-back');
    top.createEl('strong', { text: `${index + 1} / ${this.questions.length}` });
    this.button(top, '原笔记', () => this.openOriginalNote(question), 'gkr-tool-button');
    const main = this.body.createEl('main', { cls: 'gkr-reader-main gkr-review-main' });
    main.createEl('h3', { text: question.name, cls: 'gkr-question-title' });
    const questionSection = main.createEl('section', { cls: 'gkr-question-sheet' });
    questionSection.createSpan({ text: '题目', cls: 'gkr-section-label' });
    const questionContent = questionSection.createDiv({ cls: 'gkr-markdown gkr-selectable' });
    await this.renderQuestionContent(questionContent, parsed, question.path, true);
    this.watchSelection(questionContent, question, '题目', parsed);
    const answerSection = main.createEl('section', { cls: 'gkr-answer-sheet' });
    answerSection.createSpan({ text: '答案与解析', cls: 'gkr-section-label' });
    const answerContent = answerSection.createDiv({ cls: 'gkr-markdown gkr-selectable' });
    await this.renderMarkdown(answerContent, parsed.answerMarkdown, question.path);
    this.watchSelection(answerContent, question, '答案解析', parsed);
    const bar = this.body.createDiv({ cls: 'gkr-bottom-bar' });
    this.button(bar, '词典 / 双链', () => this.openKnowledgeWorkbench(question, parsed), 'gkr-primary gkr-main-action');
    this.button(bar, '补充元数据', () => this.openMetadata(question), 'gkr-tool-button');
  }
}

class RoamerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '考公笔记漫游' });
    new Setting(containerEl)
      .setName('蒙题模式默认单题时间')
      .setDesc('进入集合后仍可临时修改。')
      .addText(field => field
        .setPlaceholder('60')
        .setValue(String(this.plugin.settings.guessSeconds))
        .onChange(async value => {
          this.plugin.settings.guessSeconds = clampNumber(value, 60, 10, 900);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('考试模式默认总时间')
      .setDesc('单位：分钟。开始考试前可以针对当前试卷修改。')
      .addText(field => field
        .setPlaceholder('120')
        .setValue(String(this.plugin.settings.examMinutes))
        .onChange(async value => {
          this.plugin.settings.examMinutes = clampNumber(value, 120, 1, 600);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('专题等动态组合的默认题量')
      .setDesc('按专题、模块、地区、错因或状态组题时使用；按卷子始终采用原卷全部题目。')
      .addText(field => field
        .setPlaceholder('20')
        .setValue(String(this.plugin.settings.collectionQuestionCount))
        .onChange(async value => {
          this.plugin.settings.collectionQuestionCount = clampNumber(value, 20, 1, 500);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Windows 打开漫游时收起两侧栏')
      .setDesc('默认关闭。手机和 iPad 始终会在进入漫游时收起左右侧栏，以便专注刷题。')
      .addToggle(toggle => toggle
        .setValue(Boolean(this.plugin.settings.collapseSidebarsOnWindows))
        .onChange(async value => {
          this.plugin.settings.collapseSidebarsOnWindows = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('考公词典插件 ID')
      .setDesc('默认已对接当前考公词典 0.9.1，一般不需要修改。')
      .addText(field => field
        .setValue(this.plugin.settings.dictionaryPluginId)
        .onChange(async value => {
          this.plugin.settings.dictionaryPluginId = value.trim() || DEFAULT_SETTINGS.dictionaryPluginId;
          await this.plugin.saveSettings();
        }));
  }
}

class GongkaoNoteRoamer extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.originalReturnContexts = new Map();
    this.registerView(VIEW_TYPE, leaf => new RoamerView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: '考公笔记漫游', defaultMod: true });
    this.addRibbonIcon('scan-line', '打开考公笔记漫游', () => this.activateView());
    this.addCommand({ id: 'open-gongkao-roamer', name: '打开考公笔记漫游', callback: () => this.activateView() });
    this.addCommand({ id: 'return-to-gongkao-roamer', name: '返回上次漫游位置', callback: () => this.returnToRoamer() });
    this.addCommand({ id: 'undo-latest-batch-backlink', name: '撤销最近一次批量回链', callback: () => this.undoLatestBatchBacklink() });
    this.addSettingTab(new RoamerSettingTab(this.app, this));
    this.registerEvent(this.app.metadataCache.on('changed', file => {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => leaf.view.scheduleRefresh(file));
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.syncOriginalReturnControls();
      if (leaf?.view?.getViewType?.() === VIEW_TYPE) this.applyRoamerFocusMode();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      window.setTimeout(() => this.syncOriginalReturnControls(), 0);
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncOriginalReturnControls()));
  }

  async onunload() {
    await Promise.all(this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => this.persistLearningSession(leaf.view)));
    this.clearOriginalReturnControls();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async notifyStudyTask(path, field, value) {
    const task = this.app.plugins?.plugins?.['exam-study-tasks'];
    if (typeof task?.recordRoamerProgress !== 'function') return;
    try { await task.recordRoamerProgress(path, field, value); }
    catch (error) { new Notice('学习任务联动未保存：' + error.message, 6000); }
  }

  async saveSettings() {
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    const operation = (this.settingsWriteQueue || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    this.settingsWriteQueue = operation;
    return operation;
  }

  async persistLearningSession(view) {
    if (!view?.questions?.length || !['reader', 'review', 'results'].includes(view.screen)) return;
    const state = view.getNavigationState();
    // Editor state and temporary handwriting are deliberately not durable.
    state.lexiconEditorPath = ''; state.lexiconEditorVisible = false;
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSavedLearningState) return;
    this.settings.learningSession = { schemaVersion: 1, savedAt: new Date().toISOString(), state };
    await this.saveSettings();
    this.lastSavedLearningState = serialized;
  }

  backlinkBackupPath() {
    return pluginStoragePath(this.manifest, 'backlink-backup.json');
  }

  async undoLatestBatchBacklink() {
    const adapter = this.app.vault.adapter;
    const backupPath = this.backlinkBackupPath();
    if (!(await adapter.exists(backupPath))) {
      new Notice('没有可撤销的批量回链记录。');
      return;
    }
    let backup;
    try {
      backup = JSON.parse(await adapter.read(backupPath));
    } catch (error) {
      new Notice(`回链备份无法读取：${error.message}`, 5000);
      return;
    }
    if (backup.undoneAt) {
      new Notice('最近一次批量回链已经撤销。');
      return;
    }
    let restored = 0;
    let skipped = 0;
    for (const item of backup.files || []) {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (!file) {
        skipped += 1;
        continue;
      }
      const current = await this.app.vault.read(file);
      if (current !== item.after) {
        skipped += 1;
        continue;
      }
      await this.app.vault.modify(file, item.before);
      restored += 1;
    }
    backup.undoneAt = new Date().toISOString();
    backup.undoResult = { restored, skipped };
    await adapter.write(backupPath, JSON.stringify(backup, null, 2));
    const dictionary = this.app.plugins?.plugins?.[this.settings.dictionaryPluginId];
    if (typeof dictionary?.syncAllLexiconSmartRanges === 'function') {
      try { await dictionary.syncAllLexiconSmartRanges(); } catch { }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.view.docCache?.clear?.();
      if (leaf.view.screen === 'reader') await leaf.view.renderActiveSession?.();
    }
    new Notice(`已撤销最近一次批量回链：恢复 ${restored} 个文件${skipped ? `，跳过 ${skipped} 个已被后续修改的文件` : ''}。`, 6000);
  }

  applyRoamerFocusMode() {
    if (!shouldCollapseRoamerSidebars(Platform, this.settings.collapseSidebarsOnWindows)) return;
    for (const side of ['leftSplit', 'rightSplit']) {
      const dock = this.app.workspace?.[side];
      if (!dock || dock.collapsed || typeof dock.collapse !== 'function') continue;
      try {
        dock.collapse();
      } catch (error) {
        console.warn(`考公笔记漫游：无法收起 ${side === 'leftSplit' ? '左' : '右'}侧栏`, error);
      }
    }
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    this.lastRoamerLeaf = leaf;
    this.applyRoamerFocusMode();
    return leaf;
  }

  createRoamerReturnContext(roamerLeaf) {
    const view = roamerLeaf?.view;
    const state = view instanceof RoamerView ? view.getNavigationState() : {};
    return {
      kind: 'roamer',
      roamerLeaf,
      state,
      descriptor: roamerReturnDescriptor(state),
      createdAt: Date.now()
    };
  }

  async openFileFromRoamer(file, roamerLeaf) {
    this.lastRoamerLeaf = roamerLeaf;
    const context = this.createRoamerReturnContext(roamerLeaf);
    const noteLeaf = this.app.workspace.getLeaf('tab');
    await noteLeaf.openFile(file, { active: true });
    this.mountOriginalReturnControl(noteLeaf, context);
    return context;
  }

  async openLinkFromRoamer(linktext, sourcePath, roamerLeaf) {
    this.lastRoamerLeaf = roamerLeaf;
    const context = this.createRoamerReturnContext(roamerLeaf);
    try {
      await this.app.workspace.openLinkText(linktext, sourcePath, 'tab');
      const noteLeaf = this.app.workspace.activeLeaf || this.app.workspace.getMostRecentLeaf();
      if (noteLeaf && noteLeaf !== roamerLeaf) this.mountOriginalReturnControl(noteLeaf, context);
    } catch (error) {
      console.error('考公笔记漫游：内部链接打开失败', error);
      new Notice(`链接打开失败：${error.message || linktext}`);
    }
  }

  mountOriginalReturnControl(noteLeaf, context) {
    const host = noteLeaf?.view?.containerEl || noteLeaf?.containerEl;
    if (!host) return null;
    this.removeOriginalReturnControl(noteLeaf);
    const descriptor = context?.descriptor || roamerReturnDescriptor(context?.state);
    const positionedHost = typeof window !== 'undefined'
      && typeof window.getComputedStyle === 'function'
      && window.getComputedStyle(host).position === 'static';
    if (positionedHost) host.addClass('gkr-original-return-host');
    const control = host.createDiv({ cls: 'gkr-original-return-control' });
    const button = control.createEl('button', {
      cls: 'gkr-original-return-button',
      attr: { type: 'button', 'aria-label': descriptor.full }
    });
    const icon = button.createSpan({ cls: 'gkr-original-return-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(icon, 'arrow-left');
    button.createSpan({ text: descriptor.short });
    button.addEventListener('click', () => void this.returnToRoamer(context));
    const yamlButton = control.createEl('button', {
      cls: 'gkr-original-yaml-button',
      attr: { type: 'button', 'aria-label': '展开 YAML', 'aria-expanded': 'false' }
    });
    const yamlIcon = yamlButton.createSpan({ cls: 'gkr-original-return-icon', attr: { 'aria-hidden': 'true' } });
    if (typeof setIcon === 'function') setIcon(yamlIcon, 'braces');
    const yamlLabel = yamlButton.createSpan({ text: '展开 YAML' });
    const returnAction = noteLeaf.view?.addAction?.('arrow-left', descriptor.full, () => {
      void this.returnToRoamer(context);
    });
    returnAction?.classList?.add('gkr-return-to-roamer-action');
    this.lastRoamerReturnContext = context;
    const mountedContext = {
      ...context,
      sourcePath: noteLeaf.view?.file?.path || '',
      control,
      returnAction,
      host,
      positionedHost,
      metadataContainer: null,
      metadataObserver: null,
      metadataTimer: null
    };
    const syncYamlButton = () => {
      const container = mountedContext.metadataContainer || findMetadataContainer(host);
      if (!container) return false;
      mountedContext.metadataContainer = container;
      const collapsed = metadataIsCollapsed(container) !== false;
      yamlLabel.setText(collapsed ? '展开 YAML' : '折叠 YAML');
      yamlButton.setAttribute('aria-label', collapsed ? '展开 YAML' : '折叠 YAML');
      yamlButton.setAttribute('aria-expanded', String(!collapsed));
      return true;
    };
    const prepareMetadata = () => {
      const container = findMetadataContainer(host);
      if (!container) return false;
      mountedContext.metadataContainer = container;
      setMetadataCollapsed(container, true);
      syncYamlButton();
      mountedContext.metadataObserver?.disconnect?.();
      mountedContext.metadataObserver = null;
      if (mountedContext.metadataTimer) clearTimeout(mountedContext.metadataTimer);
      mountedContext.metadataTimer = null;
      return true;
    };
    yamlButton.addEventListener('click', () => {
      const container = mountedContext.metadataContainer || findMetadataContainer(host);
      if (!container) {
        new Notice('当前笔记视图还没有显示可展开的 YAML。');
        return;
      }
      mountedContext.metadataContainer = container;
      const collapsed = metadataIsCollapsed(container) !== false;
      setMetadataCollapsed(container, !collapsed);
      syncYamlButton();
    });
    this.originalReturnContexts.set(noteLeaf, mountedContext);
    if (!prepareMetadata()) {
      if (typeof MutationObserver !== 'undefined') {
        mountedContext.metadataObserver = new MutationObserver(() => prepareMetadata());
        mountedContext.metadataObserver.observe(host, { childList: true, subtree: true });
      }
      mountedContext.metadataTimer = setTimeout(() => {
        if (!prepareMetadata()) {
          mountedContext.metadataObserver?.disconnect?.();
          mountedContext.metadataObserver = null;
          mountedContext.metadataTimer = null;
        }
      }, 3000);
    }
    return control;
  }

  removeOriginalReturnControl(noteLeaf) {
    const context = this.originalReturnContexts?.get(noteLeaf);
    if (!context) return;
    context.control?.remove();
    context.returnAction?.remove();
    context.metadataObserver?.disconnect?.();
    if (context.metadataTimer) clearTimeout(context.metadataTimer);
    context.metadataContainer?.classList?.remove?.('gkr-metadata-collapsed');
    if (context.positionedHost) context.host?.removeClass('gkr-original-return-host');
    this.originalReturnContexts.delete(noteLeaf);
  }

  syncOriginalReturnControls() {
    if (!this.originalReturnContexts?.size) return;
    const markdownLeaves = new Set(this.app.workspace.getLeavesOfType('markdown'));
    for (const [leaf, context] of [...this.originalReturnContexts]) {
      const currentPath = leaf.view?.file?.path || '';
      if (!markdownLeaves.has(leaf) || currentPath !== context.sourcePath) {
        this.removeOriginalReturnControl(leaf);
        continue;
      }
      if (!context.control?.isConnected) this.mountOriginalReturnControl(leaf, context);
    }
  }

  clearOriginalReturnControls() {
    if (!this.originalReturnContexts) return;
    for (const leaf of [...this.originalReturnContexts.keys()]) this.removeOriginalReturnControl(leaf);
  }

  async returnToRoamer(preferredContext = null) {
    const context = preferredContext?.kind === 'roamer'
      ? preferredContext
      : (this.lastRoamerReturnContext?.kind === 'roamer' ? this.lastRoamerReturnContext : null);
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    let leaf = context?.roamerLeaf && leaves.includes(context.roamerLeaf)
      ? context.roamerLeaf
      : (this.lastRoamerLeaf && leaves.includes(this.lastRoamerLeaf) ? this.lastRoamerLeaf : leaves[0]);
    if (!leaf) leaf = await this.activateView();
    await this.app.workspace.revealLeaf(leaf);
    this.lastRoamerLeaf = leaf;
    if (context?.state && leaf.view instanceof RoamerView) await leaf.view.restoreNavigationState(context.state);
    this.applyRoamerFocusMode();
    return leaf;
  }
}

GongkaoNoteRoamer.__test = {
  asArray,
  cleanList,
  normalizeQuestion,
  stripFrontmatter,
  parseOptions,
  questionStem,
  detectCorrectAnswer,
  parseQuestionDocument,
  buildCollections,
  mergeFrontmatterFields,
  buildLexiconPayload,
  timerSnapshot,
  formatTime,
  markdownForDisplay,
  vaultImagePath,
  resolveRenderedImages,
  hideWikiLinkPreview,
  markdownForStudyMode,
  hideAnswerMarkers,
  noPhysicalBlankLines,
  titleSimilarity,
  findPotentialLinkCandidates,
  insertWikiLinkInQuestionSource,
  findUnlinkedOccurrences,
  scanQuestionSourceForTerm,
  linkAllOccurrencesInQuestionSource,
  questionsForBacklinkScope,
  pluginStoragePath,
  lexiconPotentialTermIndex,
  dedupeCollectionQuestions,
  scanCollectionPotentialLinks,
  horizontalSwipeDirection,
  internalLinkTarget,
  sessionSurfaceForMode,
  optionNeedsMarkdown,
  shouldCollapseRoamerSidebars,
  roamerReturnDescriptor,
  correctAnswerKeys,
  singleCorrectAnswerKey,
  guessChoicePresentation,
  guessChoiceAction,
  canUseGuessNextButton,
  collectionIdentity,
  normalizedIntensiveStatus,
  applyIntensiveFrontmatter,
  studyModeClickAction,
  temporaryInkPointerAllowed,
  normalizeTemporaryInkPoint,
  addTemporaryInkStroke,
  undoTemporaryInkStroke,
  clearTemporaryInkForPath,
  findMetadataContainer,
  metadataIsCollapsed,
  setMetadataCollapsed,
  collectionProgress,
  selectSessionQuestions,
  wheelPageDirection,
  horizontalPageMotion,
  RoamerView
};

module.exports = GongkaoNoteRoamer;
