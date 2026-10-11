#!/usr/bin/env node
/**
 * Convert a Quran recitation .srt file into the lyrics JSON used by the player.
 *
 * The SRT is only used for timing and for deciding which words belong to which cue.
 * The Arabic text itself, with all harakat, comes from quran.com, and the "id" and "en"
 * translations come from quran.com as well.
 *
 * Usage:
 *   node tools/srt-to-lyrics.js <input.srt> --chapter <1-114|name> --audio <path> [options]
 *
 * Options:
 *   --chapter <n>    Surah number or name e.g. 2 / Al-Baqarah (required)
 *   --audio <path>   Audio path stored in JSON, e.g. /mohmed-hesham/Al-Baqarah.opus (required)
 *   --title <text>   Title (default: input file name without extension)
 *   --out <file>     Output file (default: <input>.json next to the srt)
 *   --script <name>  quran.com Arabic script: uthmani (default), uthmani_simple, indopak, ...
 *   --id <n>         quran.com translation resource for "id" (default 33, Kemenag RI)
 *   --en <n>         quran.com translation resource for "en" (default 20, Saheeh International)
 *   --merge-max-words <n>  Verses with more than one cue and at most n words become one line
 *                    (default 25, 0 = never merge).
 *   --lead <sec>     Show every line this many seconds before its cue start (default 0)
 *
 * How it works
 *  1. Each cue is mapped to a verse by the Arabic-Indic verse number that ends the verse's
 *     last cue.
 *  2. The cue's letters are aligned (approximate string matching, so spelling and diacritic
 *     differences do not matter) to the verse text from quran.com, and the cue text is
 *     replaced by those exact quran.com words. Words the SRT left out between cues, or at
 *     the start/end of a verse, are filled in from quran.com so every verse is complete.
 *     A cue that cannot be aligned keeps its SRT text and is reported.
 *  3. Translation: verse translation is split at sentence boundaries only (never inside a
 *     sentence, quote or bracket). Each cue gets the whole sentence(s) overlapping its
 *     position in the verse, widened by half a cue. No sentence is dropped. A single-sentence
 *     verse gives its full translation to every cue.
 *  4. Short verses with several cues are merged into one line (start of the first cue).
 *
 * Requires Node 18+ (global fetch).
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.quran.com/api/v4';
const END_OF_AYAH = '۝';
const TAAWUDH_AR = 'أَعُوذُ بِٱللَّهِ مِنَ ٱلشَّيْطَٰنِ ٱلرَّجِيمِ';

const INTRO = {
  taawudh: {
    id: 'Aku berlindung kepada Allah dari setan yang terkutuk',
    en: 'I seek refuge in Allah from the accursed Satan',
  },
  basmalah: {
    id: 'Dengan nama Allah Yang Maha Pengasih, Maha Penyayang',
    en: 'In the name of Allah, the Entirely Merciful, the Especially Merciful',
  },
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function parseSrt(content) {
  return content
    .replace(/^﻿/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length >= 3)
    .map((lines) => {
      const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->/);
      if (!m) throw new Error(`Bad timestamp: ${lines[1]}`);
      const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      return { start, text: lines.slice(2).join(' ') };
    });
}

// ---- Arabic helpers ---------------------------------------------------------------------

// Comparison key: no diacritics/marks/signs/digits, alef and yaa variants unified.
const arabicKey = (text) =>
  text
    .replace(/[ؐ-ًؚ-ٰٟـۖ-ۭ࣓-ࣿ]/g, '')
    .replace(/[ٱآأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩۝۞۩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const markCount = (text) => (text.match(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g) || []).length;

const isDigit = (c) => c >= '٠' && c <= '٩';
const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

// "... ٱلْمُتَّقِينَ ٢" -> { body: "...", number: 2 }; number is null when there is none.
function splitTrailingNumber(text) {
  const t = text.trimEnd();
  let i = t.length;
  while (i > 0 && isDigit(t[i - 1])) i--;
  if (i === t.length) return { body: t, number: null };
  const number = Number([...t.slice(i)].map((d) => d.charCodeAt(0) - 0x0660).join(''));
  const body = t.slice(0, i).trimEnd().replace(/۝$/, '').trimEnd();
  return { body, number };
}

function introKind(body) {
  const t = arabicKey(body);
  if (t.startsWith('اعوذ بالله')) return 'taawudh';
  if (t === 'بسم الله الرحمن الرحيم') return 'basmalah';
  return null;
}

// Verse text -> words. A word is the letters plus any stop/recitation sign that follows it,
// so cutting by words never separates a sign from its word.
function toWords(verseText) {
  const words = [];
  let pending = '';
  for (const token of verseText.split(/\s+/).filter(Boolean)) {
    const key = arabicKey(token);
    if (key) {
      words.push({ text: pending ? `${pending} ${token}` : token, key });
      pending = '';
    } else if (words.length) {
      words[words.length - 1].text += ` ${token}`;
    } else {
      pending = pending ? `${pending} ${token}` : token;
    }
  }
  let offset = 0;
  words.forEach((w) => {
    w.from = offset;
    offset += w.key.length;
    w.to = offset;
  });
  return words;
}

// Approximate substring search (Sellers). Finds where `pattern` fits best in `text`, with the
// start not before `lo`. Ties go to the match starting closest to `near`.
function alignCue(pattern, text, lo, near) {
  const m = pattern.length;
  const n = text.length;
  const INF = 1e9;
  let prev = new Array(n + 1);
  let prevStart = new Array(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j >= lo ? 0 : INF;
    prevStart[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    const curStart = new Array(n + 1);
    cur[0] = lo === 0 ? i : INF;
    curStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      let best = prev[j - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1);
      let start = prevStart[j - 1];
      if (prev[j] + 1 < best) {
        best = prev[j] + 1;
        start = prevStart[j];
      }
      if (cur[j - 1] + 1 < best) {
        best = cur[j - 1] + 1;
        start = curStart[j - 1];
      }
      cur[j] = best;
      curStart[j] = start;
    }
    prev = cur;
    prevStart = curStart;
  }
  let pick = null;
  for (let j = 0; j <= n; j++) {
    if (prev[j] >= INF) continue;
    const cand = { cost: prev[j], start: prevStart[j], end: j };
    const better =
      !pick ||
      cand.cost < pick.cost ||
      (cand.cost === pick.cost && Math.abs(cand.start - near) < Math.abs(pick.start - near));
    if (better) pick = cand;
  }
  return pick;
}

// ---- quran.com --------------------------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');

async function getJson(url, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quran.com API ${res.status} (${what})`);
  return res.json();
}

async function resolveChapter(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const { chapters } = await getJson(`${API}/chapters`, 'chapters');
  const hit = chapters.find((c) => norm(c.name_simple) === norm(value));
  if (!hit) throw new Error(`Cannot resolve surah "${value}"; pass --chapter <number>`);
  return hit.id;
}

async function fetchTranslations(resource, chapter) {
  const { translations } = await getJson(
    `${API}/quran/translations/${resource}?chapter_number=${chapter}`,
    `translation ${resource}`
  );
  return translations.map((t) =>
    t.text
      .replace(/<sup[^>]*>.*?<\/sup>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

async function fetchArabic(chapter, script) {
  const { verses } = await getJson(
    `${API}/quran/verses/${script}?chapter_number=${chapter}`,
    `arabic ${script}`
  );
  return verses.map((v) => v[`text_${script}`]);
}

// ---- Translation splitting --------------------------------------------------------------

// Split a translation into whole sentences. Never splits inside quotes/brackets and never
// alters the text: if re-joining the pieces differs from the original, return it unsplit.
function splitSentences(text) {
  const openers = '([{“˹';
  const closers = ')]}”˺';
  const out = [];
  let start = 0;
  let depth = 0;
  let straightQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') straightQuote = !straightQuote;
    else if (openers.includes(c)) depth++;
    else if (closers.includes(c)) depth = Math.max(0, depth - 1);
    if (!/[.!?]/.test(c) || depth > 0 || straightQuote) continue;
    let end = i + 1;
    while (end < text.length && /[)\]}”˺"'’]/.test(text[end])) end++;
    if (end < text.length && !/\s/.test(text[end])) continue;
    let next = end;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next < text.length && !/[A-ZÀ-ɏ"“(\[˹]/.test(text[next])) continue;
    out.push(text.slice(start, end).trim());
    start = next;
    i = next - 1;
  }
  if (start < text.length) out.push(text.slice(start).trim());
  const parts = out.filter(Boolean);
  return parts.join(' ') === text.replace(/\s+/g, ' ').trim() ? parts : [text];
}

// Give each cue the whole sentences that overlap its position in the verse (by Arabic length),
// widened by half a cue on each side because length-based alignment is only approximate.
// Guarantees: every sentence appears in at least one cue, order is kept, no sentence is cut.
function distribute(sentences, weights) {
  const k = weights.length;
  const s = sentences.length;
  if (s <= 1 || k <= 1) return weights.map(() => sentences.join(' '));
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const cTotal = sentences.reduce((a, t) => a + t.length, 0);
  const sBound = [0];
  sentences.forEach((t) => sBound.push(sBound[sBound.length - 1] + t.length / cTotal));
  let cum = 0;
  return weights.map((w) => {
    const from = cum / wTotal;
    const to = (cum + w) / wTotal;
    cum += w;
    const margin = (to - from) / 2;
    const picked = sentences.filter((_, j) => sBound[j] < to + margin && sBound[j + 1] > from - margin);
    return (picked.length ? picked : [sentences[Math.min(s - 1, Math.floor(((from + to) / 2) * s))]]).join(' ');
  });
}

// ---- Output -----------------------------------------------------------------------------

// Same layout as lyrics/Remember-Your-Sins.json: languages inline, lines expanded.
function format(o) {
  const j = (v) => JSON.stringify(v);
  const langs = o.languages.map(
    (l) => `    { "code": ${j(l.code)}, "name": ${j(l.name)}, "dir": ${j(l.dir)} }`
  );
  const lines = o.lines.map((l) =>
    [
      '    {',
      `      "start": ${l.start},`,
      `      "text": ${j(l.text)},`,
      '      "translation": {',
      `        "id": ${j(l.translation.id)},`,
      `        "en": ${j(l.translation.en)}`,
      '      }',
      '    }',
    ].join('\n')
  );
  return [
    '{',
    `  "title": ${j(o.title)},`,
    `  "audio": ${j(o.audio)},`,
    `  "lang": ${j(o.lang)},`,
    `  "dir": ${j(o.dir)},`,
    '  "languages": [',
    langs.join(',\n'),
    '  ],',
    '  "lines": [',
    lines.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input || !args.chapter || !args.audio) {
    console.error('Usage: node tools/srt-to-lyrics.js <input.srt> --chapter <n|name> --audio <path> [--title t] [--out f]');
    process.exit(1);
  }
  const script = args.script || 'uthmani';
  const mergeMax = Number(args['merge-max-words'] ?? 25);
  const lead = Number(args.lead ?? 0);
  const chapter = await resolveChapter(args.chapter);
  const cues = parseSrt(fs.readFileSync(input, 'utf8'));
  const [idTr, enTr, arabic] = await Promise.all([
    fetchTranslations(args.id || 33, chapter),
    fetchTranslations(args.en || 20, chapter),
    fetchArabic(chapter, script),
  ]);
  if (idTr.length !== enTr.length || idTr.length !== arabic.length) {
    throw new Error('Verse count mismatch between Arabic text and translations');
  }

  // Pass 1: map each cue to a verse (or intro).
  let next = 1;
  const lines = [];
  const byVerse = new Map();
  for (const cue of cues) {
    const { body, number } = splitTrailingNumber(cue.text);
    const intro = number === null && next === 1 && chapter !== 1 ? introKind(body) : null;
    const line = { start: cue.start, srt: body, last: number !== null };
    lines.push(line);
    if (intro) {
      line.translation = INTRO[intro];
      line.text = intro === 'taawudh' ? TAAWUDH_AR : (await fetchArabic(1, script))[0];
      continue;
    }
    const verse = number ?? next;
    if (number !== null && number !== next) {
      console.warn(`warn: cue at ${cue.start}s has verse number ${number}, expected ${next}`);
    }
    if (!arabic[verse - 1]) throw new Error(`Verse ${verse} not found in chapter ${chapter}`);
    line.verse = verse;
    if (!byVerse.has(verse)) byVerse.set(verse, []);
    byVerse.get(verse).push(line);
    if (number !== null) next = number + 1;
  }

  // Pass 2: Arabic text from quran.com, then translations.
  const stats = { aligned: 0, failed: 0, spelling: [], fewerMarks: 0, filledWords: 0, merged: 0, split: 0 };
  for (const [verse, verseLines] of byVerse) {
    const words = toWords(arabic[verse - 1]);
    const verseKey = words.map((w) => w.key).join('');
    let prevStart = 0;
    let prevEnd = 0;

    // Align each cue to a word range [a, b] of the verse.
    verseLines.forEach((l) => {
      const pattern = arabicKey(l.srt).replace(/ /g, '');
      l.range = null;
      if (!pattern) return;
      const lo = Math.max(prevStart, prevEnd - 120);
      const hit = alignCue(pattern, verseKey, lo, prevEnd);
      if (!hit || hit.end <= hit.start || hit.cost > Math.max(2, pattern.length * 0.2)) return;
      const a = words.findIndex((w) => w.to > hit.start);
      let b = words.length - 1;
      while (b > 0 && words[b].from >= hit.end) b--;
      if (a < 0 || b < a) return;
      l.range = { a, b };
      l.cost = hit.cost;
      prevStart = hit.start;
      prevEnd = hit.end;
    });

    // Fill words the SRT left out: verse start, gaps between cues, verse end.
    const ok = verseLines.filter((l) => l.range);
    if (ok.length) {
      const before = ok.reduce((n, l) => n + l.range.b - l.range.a + 1, 0);
      ok[0].range.a = 0;
      ok[ok.length - 1].range.b = words.length - 1;
      for (let i = 0; i + 1 < ok.length; i++) {
        if (ok[i + 1].range.a > ok[i].range.b + 1) ok[i].range.b = ok[i + 1].range.a - 1;
      }
      const after = ok.reduce((n, l) => n + l.range.b - l.range.a + 1, 0);
      stats.filledWords += Math.max(0, after - before);
    }

    for (const l of verseLines) {
      if (!l.range) {
        stats.failed++;
        console.warn(`warn: verse ${verse}: cue at ${Math.floor(l.start)}s not aligned to quran.com, SRT text kept`);
        l.text = l.srt;
        continue;
      }
      stats.aligned++;
      l.text = words.slice(l.range.a, l.range.b + 1).map((w) => w.text).join(' ');
      if (l.cost > 0 && stats.spelling.length < 5) stats.spelling.push(`${verse}: ${l.srt}  ->  ${l.text}`);
      if (markCount(l.srt) < markCount(l.text)) stats.fewerMarks++;
    }

    // Merge a short multi-cue verse into one line.
    const allAligned = verseLines.every((l) => l.range);
    if (mergeMax > 0 && verseLines.length > 1 && allAligned && words.length <= mergeMax) {
      verseLines[0].text = words.map((w) => w.text).join(' ');
      verseLines[0].last = true;
      verseLines[0].translation = { id: idTr[verse - 1], en: enTr[verse - 1] };
      verseLines.slice(1).forEach((l) => (l.drop = true));
      stats.merged++;
      continue;
    }

    const weights = verseLines.map((l) =>
      l.range ? l.range.b - l.range.a + 1 : Math.max(1, l.srt.split(/\s+/).length)
    );
    const idParts = distribute(splitSentences(idTr[verse - 1]), weights);
    const enParts = distribute(splitSentences(enTr[verse - 1]), weights);
    if (verseLines.length > 1 && idParts.some((p) => p !== idTr[verse - 1])) stats.split++;
    verseLines.forEach((l, i) => {
      l.translation = { id: idParts[i], en: enParts[i] };
    });
  }

  const finalLines = lines
    .filter((l) => !l.drop)
    .map((l) => ({
      start: Math.max(0, Math.floor(l.start - lead)),
      text: l.last ? `${l.text} ${END_OF_AYAH}${toArabicDigits(l.verse)}` : l.text,
      translation: l.translation,
    }));

  if (next - 1 !== idTr.length) {
    console.warn(`warn: last verse ${next - 1} != chapter verse count ${idTr.length}`);
  }

  console.log(`Arabic text from quran.com (${script}): ${stats.aligned} cues aligned, ${stats.failed} kept from SRT`);
  console.log(`  cues where SRT had fewer harakat/marks than quran.com: ${stats.fewerMarks}`);
  console.log(`  words missing in SRT filled in from quran.com: ${stats.filledWords}`);
  if (stats.spelling.length) {
    console.log('  cues whose letters differ from quran.com (SRT -> quran.com), first ones:');
    stats.spelling.forEach((s) => console.log(`    ${s}`));
  }
  console.log(`Verses merged into one line: ${stats.merged}`);
  console.log(`Verses with translation split across cues: ${stats.split}`);

  const out = {
    title: args.title || path.basename(input, path.extname(input)),
    audio: args.audio,
    lang: 'ar',
    dir: 'rtl',
    languages: [
      { code: 'id', name: 'Indonesia', dir: 'ltr' },
      { code: 'en', name: 'English', dir: 'ltr' },
    ],
    lines: finalLines,
  };
  const outPath = args.out || input.replace(/\.srt$/i, '') + '.json';
  fs.writeFileSync(outPath, format(out), 'utf8');
  console.log(`Wrote ${outPath} (${finalLines.length} lines, ${next - 1} verses)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
