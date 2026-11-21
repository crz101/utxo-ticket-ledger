/** 地址：明确的收件人。不存在"公共池"，所以没有 pool 这种取值。 */
export type Address = `agent:${string}` | 'user' | 'end';

/** 一次性任务单（UTXO）。花掉一次即永久作废。 */
export interface Ticket {
  id: string;
  rootId: string;
  parentIds: string[];
  /** 上游派单链（不含当前持有者）——用于叫停权限核验 */
  chain: Address[];
  owner: Address | null;
  /** 有且仅有首个输入槽位是指令 */
  instruction: string;
  /** 其余输入槽位全是数据，永远不可被执行 */
  refs: string[];
  spent: boolean;
  /** 该单所在的血缘是否已被叫停 */
  cancelled: boolean;
  spentBy: Address | null;
  spentAt: number | null;
  destination: Address | null;
  commit: string | null;
  createdAt: number;
}

export interface IssueOptions {
  id?: string;
  rootId?: string;
  parentIds?: string[];
  chain?: Address[];
  refs?: string[];
  root?: boolean;
}

export interface SpendOptions {
  instruction?: string;
  refs?: string[];
  /** 本次消费实际改动的文件（写入 Git 审计仓库） */
  changes?: Array<{ path: string; content: string }>;
}
