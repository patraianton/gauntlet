// Glob matching over POSIX relative paths (SPEC 23.1).
//
// Syntax:
//   **        any number of whole path segments (also zero) when it is a whole segment;
//             inside a segment (a**b) it acts like *
//   *         any characters except '/'
//   ?         one character except '/'
//   [abc] [a-z] [!abc] [^abc]   one character from (or not from) a class, never '/'
//   {a,b,c}   alternatives (may nest)
//   \x        not an escape: backslashes are treated as '/' (Windows input)
// Dotfiles are matched by * and ** like any other name (material globs must not
// silently drop hidden files). The whole path must match. A leading "./" is ignored.
// Matching is case-insensitive on win32 by default; pass { nocase } to override.

const cache = new Map();

function esc(ch) {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? '\\' + ch : ch;
}

function expandBraces(glob) {
  // Returns a list of brace-free globs.
  const open = findTopBrace(glob);
  if (!open) return [glob];
  const { start, end, parts } = open;
  const pre = glob.slice(0, start);
  const post = glob.slice(end + 1);
  const out = [];
  for (const part of parts) for (const g of expandBraces(pre + part + post)) out.push(g);
  return out;
}

function findTopBrace(s) {
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      if (s.indexOf(']', i + 2) !== -1) inClass = true;
      continue;
    }
    if (ch !== '{') continue;
    let depth = 0;
    const parts = [];
    let last = i + 1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          parts.push(s.slice(last, j));
          if (parts.length < 2) break; // "{a}" is literal
          return { start: i, end: j, parts };
        }
      } else if (c === ',' && depth === 1) {
        parts.push(s.slice(last, j));
        last = j + 1;
      }
    }
  }
  return null;
}

function segmentToRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') {
      while (seg[i + 1] === '*') i++;
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const close = seg.indexOf(']', i + 2);
      if (close === -1) {
        re += '\\[';
        continue;
      }
      let body = seg.slice(i + 1, close);
      let neg = false;
      if (body[0] === '!' || body[0] === '^') {
        neg = true;
        body = body.slice(1);
      }
      body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\^/g, '\\^');
      re += neg ? `(?!/)[^${body}]` : `[${body}]`;
      i = close;
    } else {
      re += esc(ch);
    }
  }
  return re;
}

function singleGlobToRe(glob) {
  const segs = glob.split('/');
  let re = '';
  let needSep = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      if (last) {
        // trailing **: everything below (at least one more segment), or anything at all if alone
        re += needSep ? '(?:/.+)' : '.*';
      } else {
        // zero or more whole segments, each followed by '/'
        re += needSep ? '(?:/(?:[^/]+/)*)' : '(?:[^/]+/)*';
        needSep = false;
        continue;
      }
    } else {
      if (needSep) re += '/';
      re += segmentToRe(seg);
    }
    needSep = true;
  }
  return re;
}

function normaliseGlob(glob) {
  let g = String(glob).replace(/\\/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  g = g.replace(/\/{2,}/g, '/');
  return g;
}

export function globToRegExp(glob, opts = {}) {
  const nocase = opts.nocase ?? process.platform === 'win32';
  const key = `${nocase ? 'i' : 's'}\0${glob}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = normaliseGlob(glob);
  const alts = expandBraces(g).map(singleGlobToRe);
  const re = new RegExp(`^(?:${alts.join('|')})$`, nocase ? 'iu' : 'u');
  cache.set(key, re);
  return re;
}

function normaliseRel(rel) {
  let r = String(rel).replace(/\\/g, '/');
  while (r.startsWith('./')) r = r.slice(2);
  return r;
}

export function matchGlob(rel, glob, opts = {}) {
  return globToRegExp(glob, opts).test(normaliseRel(rel));
}

/**
 * Files matched by at least one include glob and by no exclude glob, input order kept.
 * include undefined/null = everything; include [] = nothing.
 */
export function selectFiles(rels, include, exclude, opts = {}) {
  const inc = include == null ? null : include.map((g) => globToRegExp(g, opts));
  const exc = (exclude ?? []).map((g) => globToRegExp(g, opts));
  return rels.filter((rel) => {
    const r = normaliseRel(rel);
    if (inc && !inc.some((re) => re.test(r))) return false;
    return !exc.some((re) => re.test(r));
  });
}
