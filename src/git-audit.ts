import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { Address, Ticket } from './types.ts';

/** Agent 改动的一个文件 */
export interface AuditChange {
  path: string;
  content: string;
}

export interface AuditCommit {
  ticketId: string;
  action: string;
  by: Address;
  hash: string;
  message: string;
}

/**
 * 真实 Git 审计仓库。
 *
 * 每次任务单消费都会：
 *   1. 把 Agent 改动的文件写入隔离仓库
 *   2. 写一份任务单状态快照 tickets/<id>.json
 *   3. git commit，message 强制带 [ticketId]
 *
 * 文件操作用 execFileSync + 参数数组，不拼 shell 字符串。
 */
export class GitAuditStore {
  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = resolve(repoPath);
  }

  /** 初始化隔离仓库（幂等） */
  init(): void {
    mkdirSync(this.repoPath, { recursive: true });
    if (!existsSync(join(this.repoPath, '.git'))) {
      this.git('init', '-q');
      this.git('config', 'user.email', 'ledger@utxo.local');
      this.git('config', 'user.name', 'UTXO Ledger');
      writeFileSync(
        join(this.repoPath, 'README.md'),
        '# UTXO Ticket Audit\n\n由账本自动生成，每次任务单消费对应一个 commit。\n',
        'utf8',
      );
      this.git('add', '.');
      this.git('commit', '-q', '-m', 'chore: init audit repository');
    }
  }

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** 安全解析相对路径，拒绝路径穿越与绝对路径 */
  private safePath(rel: string): string {
    if (isAbsolute(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`非法审计文件路径: ${rel}`);
    }
    const full = resolve(this.repoPath, rel);
    const relCheck = relative(this.repoPath, full);
    if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
      throw new Error(`非法审计文件路径: ${rel}`);
    }
    return full;
  }

  /** 落盘改动 + commit，返回真实 git 记录 */
  record(ticket: Ticket, action: string, by: Address, changes: AuditChange[] = []): AuditCommit {
    this.init();

    for (const c of changes) {
      const full = this.safePath(c.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c.content, 'utf8');
    }

    this.snapshot(ticket);

    this.git('add', '.');
    const message = `ticket: [${ticket.id}] ${action} by ${by}`;
    this.git('commit', '-q', '-m', message, '--allow-empty');
    const hash = this.git('rev-parse', '--short', 'HEAD');
    return { ticketId: ticket.id, action, by, hash, message };
  }

  /** 为一张任务单落状态快照（不产生 commit），开单/派生时调用 */
  snapshot(ticket: Ticket): void {
    const full = this.safePath(`tickets/${ticket.id}.json`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(ticket, null, 2), 'utf8');
  }

  /** 按任务单 ID 追溯全部 commit */
  queryByTicket(ticketId: string): AuditCommit[] {
    this.init();
    // --fixed-strings：把 [ticket-xxx] 当字面量，避免方括号被当作正则字符类
    const out = this.git('log', '--format=%h%x09%s', '--fixed-strings', `--grep=[${ticketId}]`);
    if (!out) return [];
    return out.split('\n').flatMap((line) => {
      const [hash, ...rest] = line.split('\t');
      const message = rest.join('\t');
      const m = message.match(/^ticket: \[([^\]]+)\] (\S+) by (\S+)$/);
      if (!m) return [];
      return [{
        ticketId: m[1],
        action: m[2],
        by: m[3] as Address,
        hash,
        message,
      }];
    });
  }

  /** 审计仓库的 commit 总数 */
  count(): number {
    this.init();
    try {
      return Number(this.git('rev-list', '--count', 'HEAD'));
    } catch {
      return 0;
    }
  }
}
