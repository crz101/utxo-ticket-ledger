import type { Address, IssueOptions, SpendOptions, Ticket } from './types.ts';
import type { AuditChange, GitAuditStore } from './git-audit.ts';

export type LedgerErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_SPENT'
  | 'NOT_OWNER'
  | 'NO_RECIPIENT'
  | 'PUBLIC_POOL_FORBIDDEN'
  | 'SELF_RECIPIENT'
  | 'CIRCUIT_OPEN'
  | 'INVALID_ADDRESS'
  | 'INVALID_INSTRUCTION';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const isAddress = (v: unknown): v is Address =>
  typeof v === 'string' &&
  (v === 'user' || v === 'end' || /^agent:[^:\s]+$/.test(v));

/**
 * UTXO 一次性任务单账本。
 *
 * 四条硬规则全部落在代码结构里，不依赖提示词自觉：
 *  R1 指令与数据隔离 —— instruction 只能来自首个输入槽位，refs 恒为数据。
 *  R2 派单链权限     —— 只有 ticket.chain 上的上游可以叫停；下游无权撤销。
 *  R3 点名交接       —— spend 必须给出明确 to，禁止公共池。
 *  R4 查账完结 + 熔断 —— isComplete 查未花费子单；退单计数达阈值触发熔断。
 */
export class Ledger {
  private readonly tickets = new Map<string, Ticket>();
  private readonly rejectsByRoot = new Map<string, number>();
  private readonly openCircuits = new Set<string>();
  private seq = 0;
  private commitSeq = 0;
  readonly rejectThreshold: number;
  private readonly audit: GitAuditStore | null;

  constructor(rejectThreshold = 20, audit: GitAuditStore | null = null) {
    this.rejectThreshold = rejectThreshold;
    this.audit = audit;
  }

  // ---------- 内部工具 ----------

  private nextId(): string {
    this.seq += 1;
    return `ticket-${String(this.seq).padStart(4, '0')}`;
  }

  /**
   * 写一次消费记录。挂了 GitAuditStore 则落真实 commit，否则退化为内存模拟 hash。
   * 真实 commit 的 message 强制带 [ticketId]，可按单号精确追溯。
   */
  private writeCommit(ticket: Ticket, action: string, by: Address, changes?: AuditChange[]): string {
    this.commitSeq += 1;
    if (this.audit) {
      const rec = this.audit.record(ticket, action, by, changes);
      return `${rec.hash} ${action}: [${ticket.id}] by ${by} (#${this.commitSeq})`;
    }
    const hash = Math.random().toString(16).slice(2, 10);
    return `${hash.slice(0, 7)} ${action}: [${ticket.id}] by ${by} (#${this.commitSeq})`;
  }

  private requireTicket(id: string): Ticket {
    const t = this.tickets.get(id);
    if (!t) throw new LedgerError('NOT_FOUND', `ticket ${id} 不存在`);
    return t;
  }

  private assertNoCircuit(rootId: string): void {
    if (this.openCircuits.has(rootId)) {
      throw new LedgerError('CIRCUIT_OPEN', `root ${rootId} 已熔断，移交人工裁决`);
    }
  }

  // ---------- 基础操作 ----------

  /** 开一张根任务单。instruction 由调用方显式给出（首个输入槽位）。 */
  issue(instruction: string, owner: Address, opts: IssueOptions = {}): Ticket {
    if (typeof instruction !== 'string' || instruction.trim() === '') {
      throw new LedgerError('INVALID_INSTRUCTION', 'instruction 不能为空');
    }
    if (!isAddress(owner)) {
      throw new LedgerError('INVALID_ADDRESS', `非法持有者地址: ${String(owner)}`);
    }
    const id = opts.id ?? this.nextId();
    const rootId = opts.root ?? id;
    const ticket: Ticket = {
      id,
      rootId,
      parentIds: opts.parentIds ?? [],
      chain: opts.chain ?? [],
      owner,
      instruction,
      refs: opts.refs ?? [],
      spent: false,
      cancelled: false,
      spentBy: null,
      spentAt: null,
      destination: null,
      commit: null,
      createdAt: Date.now(),
    };
    this.tickets.set(id, ticket);
    if (this.audit) this.audit.snapshot(ticket);
    return ticket;
  }

  /**
   * R1：把原始输入数组拆成"首槽位=指令，其余=参考资料"。
   * refs 里的任何文本（哪怕写着"忽略上述要求"）都永远不会被当成指令。
   */
  issueFromInputs(inputs: string[], owner: Address, opts: IssueOptions = {}): Ticket {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new LedgerError('INVALID_INSTRUCTION', 'inputs 至少需要一个元素作为指令');
    }
    const [instruction, ...refs] = inputs;
    return this.issue(instruction, owner, { ...opts, refs });
  }

  /** 读取指令：只返回首个槽位，杜绝从 refs 里"捞"命令。 */
  readInstruction(ticketId: string): string {
    return this.requireTicket(ticketId).instruction;
  }

  /**
   * 花费一张任务单，派生新单交给明确收件人 to。
   * R3：to 必填且必须是合法地址；禁止把任务扔进公共池或自己转自己。
   */
  spend(ticketId: string, by: Address, to: Address, opts: SpendOptions = {}): Ticket {
    const t = this.requireTicket(ticketId);
    this.assertNoCircuit(t.rootId);

    if (t.spent) {
      throw new LedgerError('ALREADY_SPENT', `ticket ${ticketId} 已作废，重复消费被拒`);
    }
    if (t.owner !== by) {
      throw new LedgerError('NOT_OWNER', `${by} 不是 ${ticketId} 的持有者`);
    }
    if (to === undefined || to === null || (typeof to === 'string' && to.trim() === '')) {
      throw new LedgerError('NO_RECIPIENT', '交接必须点名收件人 to');
    }
    if (!isAddress(to)) {
      if (to === 'pool' || to === 'public') {
        throw new LedgerError('PUBLIC_POOL_FORBIDDEN', '禁止把任务扔进公共池');
      }
      throw new LedgerError('INVALID_ADDRESS', `非法收件人地址: ${String(to)}`);
    }
    if (to === by) {
      throw new LedgerError('SELF_RECIPIENT', '不能把任务单转给自己');
    }

    const now = Date.now();
    t.spent = true;
    t.spentBy = by;
    t.spentAt = now;
    t.destination = to;

    // 新单继承指令（除非显式覆盖）；refs 只累加，永不改写 instruction。
    const child = this.issue(opts.instruction ?? t.instruction, to, {
      root: t.rootId,
      parentIds: [t.id],
      chain: [...t.chain, by],
      refs: [...t.refs, ...(opts.refs ?? [])],
    });
    t.commit = this.writeCommit(t, 'spend', by, opts.changes);

    // end 是销毁地址：新输出立即作废，不产生可继续流转的 UTXO。
    if (to === 'end') {
      child.spent = true;
      child.spentBy = by;
      child.spentAt = now;
      child.destination = 'end';
      child.owner = null;
      child.commit = this.writeCommit(child, 'burn', by);
    }
    return child;
  }

  /**
   * R2 叫停：把根任务单花进 end 销毁地址，其所有子单同步失效。
   * 权限：只有派单链上的上游（chain 内）或当前持有者可以叫停；下游无权。
   */
  cancel(rootId: string, by: Address): void {
    const root = this.requireTicket(rootId);
    const authorized = root.owner === by || root.chain.includes(by);
    if (!authorized) {
      throw new LedgerError('NOT_OWNER', `${by} 不在派单链上，无权叫停 ${rootId}`);
    }

    const now = Date.now();
    root.cancelled = true;

    // 级联作废该 root 下所有未花费单（含根单未花的情况），花进 end 销毁地址。
    // 派生出去的历史单已 spent，保留其审计记录不动。
    for (const t of this.tickets.values()) {
      if (t.rootId === rootId && !t.spent) {
        t.spent = true;
        t.spentBy = by;
        t.spentAt = now;
        t.destination = 'end';
        t.commit = this.writeCommit(t, 'invalidate->end', by);
      }
    }
    this.openCircuits.add(rootId);
  }

  /**
   * R4 退单：把任务单退回明确收件人（通常是上游），并累计退单计数。
   * 达到阈值即熔断，整条 root 链条冻结并移交人工。
   */
  reject(ticketId: string, by: Address, backTo: Address): Ticket {
    const child = this.spend(ticketId, by, backTo);
    const count = (this.rejectsByRoot.get(child.rootId) ?? 0) + 1;
    this.rejectsByRoot.set(child.rootId, count);
    if (count >= this.rejectThreshold) {
      this.openCircuits.add(child.rootId);
      this.commitSeq += 1;
    }
    return child;
  }

  // ---------- 查账 ----------

  /** R4：一次请求是否结束，不看模型自报，只查 root 下有没有未花费的子单。 */
  isComplete(rootId: string): boolean {
    this.requireTicket(rootId);
    for (const t of this.tickets.values()) {
      if (t.rootId === rootId && !t.spent) return false;
    }
    return true;
  }

  unspentOf(rootId: string): Ticket[] {
    return [...this.tickets.values()].filter((t) => t.rootId === rootId && !t.spent);
  }

  /** 全链路血缘：从某单一路追溯到最初源头。 */
  lineage(ticketId: string): Ticket[] {
    const chain: Ticket[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const t = this.tickets.get(id);
      if (!t) return;
      chain.push(t);
      for (const p of t.parentIds) walk(p);
    };
    walk(ticketId);
    return chain;
  }

  isHalted(rootId: string): boolean {
    return this.openCircuits.has(rootId);
  }

  rejectCount(rootId: string): number {
    return this.rejectsByRoot.get(rootId) ?? 0;
  }

  get(ticketId: string): Ticket {
    return this.requireTicket(ticketId);
  }

  /** 账本中的任务单总数 */
  size(): number {
    return this.tickets.size;
  }

  /** UTXO 不变式自检：任何未花费的单，其父单必须已作废。 */
  validate(): boolean {
    for (const t of this.tickets.values()) {
      if (!t.spent) {
        for (const p of t.parentIds) {
          const parent = this.tickets.get(p);
          if (!parent || !parent.spent) {
            throw new LedgerError('NOT_FOUND', `不变式破坏：${t.id} 的父单 ${p} 未作废`);
          }
        }
      }
    }
    return true;
  }
}
