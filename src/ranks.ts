import { AcmCell, Contest, ContestRankRow, durationText, Page, RankKind, RankRow, Site } from './domain';

const cell = (value: unknown): string => String(value ?? '').replace(/[\\|]/g, m => `\\${m}`).replace(/[\r\n]+/g, ' ').trim();
const userCell = (row: { username?: string; nickname?: string | null }, me?: string): string => {
  const name = cell(row.username) || '?', nickname = cell(row.nickname);
  const label = nickname && nickname !== name ? `${name} (${nickname})` : name;
  return row.username && row.username === me ? `**${label}** ←` : label;
};
export interface RankView { kind: RankKind; page: number; limit: number; keyword?: string; me?: string }
function rankHeader(title: string, view: RankView, total: number, note = ''): string[] {
  const pages = Math.max(1, Math.ceil(total / view.limit));
  return [`# ${title}`, [`第 ${view.page}/${pages} 页 · 共 ${total} 人`, view.keyword ? `搜索：${cell(view.keyword)}` : '', note].filter(Boolean).join(' · ')];
}
/** Contest scoreboard; `problems` are display IDs in contest order. */
export function contestRankMarkdown(contest: Contest, problems: readonly string[], data: Page<ContestRankRow>, view: RankView): string {
  const oi = contest.type === 1, now = Date.now();
  const running = Date.parse(contest.startTime) <= now && now < Date.parse(contest.endTime);
  const head = rankHeader(`${contest.title} · ${oi ? 'OI' : 'ACM'} 排行榜`, view, data.total, running ? '比赛进行中，每 30 秒自动刷新' : '');
  if (!data.records.length) { return [...head, '暂无排名数据。'].join('\n\n'); }
  const columns = oi ? ['排名', '用户', '总分', ...problems] : ['排名', '用户', '通过', '罚时', ...problems];
  const rows = data.records.map((row, index) => {
    const info = row.submissionInfo ?? {};
    const problemCells = problems.map(id => {
      const value = info[id];
      if (value == null) { return ''; }
      if (oi || typeof value === 'number') { return cell(typeof value === 'number' ? value : ''); }
      const acm = value as AcmCell, tries = Number(acm.errorNum ?? 0);
      if (acm.isAC) { return `${acm.isFirstAC ? '★' : '✓'} ${acm.ACTime == null ? '' : durationText(acm.ACTime * 1000)}${tries ? ` (-${tries})` : ''}`.trim(); }
      return tries || acm.tryNum ? `✗ -${tries || acm.tryNum}` : '';
    });
    const rank = row.rank == null || row.rank < 0 ? '*' : String(row.rank);
    const fixed = oi ? [rank || String((view.page - 1) * view.limit + index + 1), userCell(row, view.me), cell(row.totalScore ?? 0)]
      : [rank, userCell(row, view.me), cell(row.ac ?? 0), row.totalTime == null ? '' : durationText(row.totalTime * 1000)];
    return `| ${[...fixed, ...problemCells].join(' | ')} |`;
  });
  return [...head, [`| ${columns.map(cell).join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows].join('\n'),
    oi ? '' : '★ 一血 · ✓ 通过时间（-错误次数） · ✗ 未通过 · * 打星'].filter(Boolean).join('\n\n');
}
/** Site-wide ACM (solved / submitted) or OI (total score) ranking. */
export function rankListMarkdown(site: Site, data: Page<RankRow>, view: RankView): string {
  const oi = view.kind === 'oi', head = rankHeader(`${site.name} · ${oi ? 'OI' : 'ACM'} 排行榜`, view, data.total);
  if (!data.records.length) { return [...head, '暂无排名数据。'].join('\n\n'); }
  const rows = data.records.map((row, index) => {
    const ac = row.ac ?? row.solved ?? 0, total = row.total ?? 0;
    const rate = total ? `${(ac / total * 100).toFixed(1)}%` : '-';
    const rank = String((view.page - 1) * view.limit + index + 1);
    return `| ${(oi ? [rank, userCell(row, view.me), cell(row.totalScore ?? 0), cell(ac), cell(total)] : [rank, userCell(row, view.me), cell(ac), cell(total), rate]).join(' | ')} |`;
  });
  const columns = oi ? ['排名', '用户', '总分', '通过', '提交'] : ['排名', '用户', '通过', '提交', '通过率'];
  return [...head, [`| ${columns.join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows].join('\n')].join('\n\n');
}
