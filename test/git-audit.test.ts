import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitAuditStore, Ledger } from '../src/index.ts';

/** 每次测试建独立临时仓库，跑完删除 */
function withRepo(fn: (repo: string, audit: GitAuditStore, led: Ledger) => void) {
  const repo = mkdtempSync(join(tmpdir(), 'utxo-audit-'));
  try {
    const audit = new GitAuditStore(join(repo, 'audit'));
    const led = new Ledger(20, audit);
    fn(repo, audit, led);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('Git 联动：初始化隔离仓库并生成基线 commit', () => {
  withRepo((_repo, audit) => {
    audit.init();
    assert.ok(existsSync(join(audit.repoPath, '.git')));
    assert.equal(audit.count(), 1); // 基线 commit
  });
});

test('Git 联动：spend 自动落真实 commit，message 带任务单 ID', () => {
  withRepo((_repo, audit, led) => {
    const root = led.issue('修复登录超时', 'agent:planner');
    led.spend(root.id, 'agent:planner', 'agent:coder', {
      changes: [
        { path: 'src/auth.ts', content: '// extended pool to 50\nexport const POOL_SIZE = 50;\n' },
        { path: 'notes/fix.md', content: '# 修复说明\n连接池扩容\n' },
      ],
    });

    // 改动文件与任务单快照都已落盘
    assert.equal(
      readFileSync(join(audit.repoPath, 'src/auth.ts'), 'utf8'),
      '// extended pool to 50\nexport const POOL_SIZE = 50;\n',
    );
    assert.ok(existsSync(join(audit.repoPath, `tickets/${root.id}.json`)));

    // 真实 git commit：基线 1 + spend 1 = 2
    assert.equal(audit.count(), 2);
    assert.match(led.get(root.id).commit!, /spend:/);

    const commits = audit.queryByTicket(root.id);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].action, 'spend');
    assert.equal(commits[0].by, 'agent:planner');
    assert.match(commits[0].message, new RegExp(root.id));
  });
});

test('Git 联动：按任务单 ID 精确追溯整条血缘的 commit', () => {
  withRepo((_repo, audit, led) => {
    const root = led.issue('任务', 'agent:planner');
    const a = led.spend(root.id, 'agent:planner', 'agent:coder');
    const b = led.spend(a.id, 'agent:coder', 'agent:reviewer');

    // 每次 spend 为「被消费的那张单」留一个 commit
    assert.equal(audit.queryByTicket(root.id).length, 1);
    assert.equal(audit.queryByTicket(a.id).length, 1);
    // b 尚未被消费，所以没有以它为 source 的 commit
    assert.equal(audit.queryByTicket(b.id).length, 0);
    // b 的状态快照已落盘，血缘可查
    assert.ok(existsSync(join(audit.repoPath, `tickets/${b.id}.json`)));
    assert.equal(audit.count(), 3); // 基线 + 2 次消费
  });
});

test('Git 联动：叫停 cascade 作废的每张单都留 commit', () => {
  withRepo((_repo, audit, led) => {
    const root = led.issue('任务', 'agent:planner');
    const a = led.spend(root.id, 'agent:planner', 'agent:coder');
    const b = led.spend(a.id, 'agent:coder', 'agent:tester');

    led.cancel(root.id, 'agent:planner');

    assert.equal(led.get(b.id).destination, 'end');
    const cancels = audit.queryByTicket(b.id);
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].action, 'invalidate->end');
  });
});

test('Git 联动：路径穿越的改动被拒绝', () => {
  withRepo((_repo, audit, led) => {
    const root = led.issue('任务', 'agent:planner');
    assert.throws(
      () => led.spend(root.id, 'agent:planner', 'agent:coder', {
        changes: [{ path: '../../evil.ts', content: 'x' }],
      }),
      /非法审计文件路径/,
    );
    assert.ok(audit);
  });
});
