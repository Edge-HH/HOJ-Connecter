import * as path from 'node:path';

export interface CodeHint { fileName?: string; languageId?: string; source?: string }
export interface LanguageSuggestion { language: string; reason: string; compatible: boolean }
export function languageFamily(value: string): string | undefined {
  if (/[cg]\+\+|^cpp/i.test(value)) { return 'cpp'; }
  if (/c#|csharp/i.test(value)) { return 'csharp'; }
  if (/^(?:gnu\s+)?c(?:\s|\d|\(|$)/i.test(value)) { return 'c'; }
  if (/python|pypy/i.test(value)) { return 'python'; }
  if (/javascript|node(?:js|\.js)?/i.test(value)) { return 'javascript'; }
  if (/typescript/i.test(value)) { return 'typescript'; }
  if (/^java(?:\s|\d|$)/i.test(value)) { return 'java'; }
  if (/golang|^go(?:\s|\d|$)/i.test(value)) { return 'go'; }
  if (/rust/i.test(value)) { return 'rust'; }
  if (/ruby/i.test(value)) { return 'ruby'; }
  if (/php/i.test(value)) { return 'php'; }
  if (/kotlin/i.test(value)) { return 'kotlin'; }
  if (/pascal/i.test(value)) { return 'pascal'; }
  if (/swift/i.test(value)) { return 'swift'; }
  if (/haskell/i.test(value)) { return 'haskell'; }
  return undefined;
}
export function codeFamily(hint?: CodeHint): string | undefined {
  if (!hint) { return; }
  const extensions: Record<string, string> = { cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', c: 'c', py: 'python', js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'typescript', java: 'java', go: 'go', rs: 'rust', cs: 'csharp', rb: 'ruby', php: 'php', kt: 'kotlin', pas: 'pascal', swift: 'swift', hs: 'haskell' };
  return extensions[path.extname(hint.fileName ?? '').slice(1).toLowerCase()] ?? languageFamily(hint.languageId ?? '');
}
function cppVersion(language: string): number { return Number(language.match(/[cg]\+\+\s*(\d{2})/i)?.[1] ?? 11); }
export function suggestLanguage(available: readonly string[], preferred: string, hint?: CodeHint): LanguageSuggestion | undefined {
  const family = codeFamily(hint), preferredFamily = languageFamily(preferred);
  const candidates = family ? available.filter(l => languageFamily(l) === family) : [...available];
  if (!candidates.length) { return; }
  const source = hint?.source ?? '';
  const requiredCpp = /#\s*include\s*<(?:ranges|format|span|concepts|coroutine)>|std::(?:ranges|format|span|jthread)\b|\bconcept\s+\w+\s*=/m.test(source) ? 20 : 0;
  const pythonVersion = /\braw_input\s*\(|^\s*print\s+[^\s(]/m.test(source) ? 2 : 3;
  const rank = (language: string) => {
    let score = 0;
    if (language === preferred) { score += 100; }
    if (family && languageFamily(language) === family) { score += 1000; }
    if (!family && preferredFamily && languageFamily(language) === preferredFamily) { score += 50; }
    if (languageFamily(language) === 'cpp') {
      const version = cppVersion(language);
      if (requiredCpp && version < requiredCpp) { score -= 10000; }
      if (version === 17) { score += 20; } else if (version === 20) { score += 10; }
    }
    if (languageFamily(language) === 'python' && (family === 'python' || (!family && preferredFamily === 'python'))) {
      if (new RegExp(`(?:python|pypy)\\s*${pythonVersion}`, 'i').test(language)) { score += 200; }
    }
    return score;
  };
  const language = candidates.map((language, order) => ({ language, score: rank(language), order })).sort((a, b) => b.score - a.score || a.order - b.order)[0].language;
  const compatible = !(family === 'cpp' && requiredCpp && cppVersion(language) < requiredCpp);
  const reason = family ? `${hint?.fileName ? path.extname(hint.fileName) || hint.languageId : hint?.languageId} 文件${requiredCpp ? ' · 代码使用 C++20 特性' : ''} · 题目允许` : language === preferred ? '默认语言 · 题目允许' : '题目允许的语言';
  return { language, reason: compatible ? reason : '代码包含 C++20 特性，但此题没有提供 C++20', compatible };
}
