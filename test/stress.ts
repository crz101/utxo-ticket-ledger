import { Ledger, LedgerError } from '../src/index.ts';

const NODES = Number(process.env.NODES ?? 1000);
const line = (s = '') => console.log(s);
const now = () => Number(process.hrtime.bigint() / 1_000_000n);

line('================ UTXO 账本千级并发压测 ================');
line(`目标节点数: ${NODES}`);
line('');

// ---------- 场景一：千级并行派单 + 消费（无锁并发） ----------
{
  const led = new Ledger(20);
  const roots = Array.from({ length: NODES }, (_, i) =>
    led.issue(`并行任务 ${i}`, 'agent:planner' as const),
  );

  const t0 = now();
  // 每个根单花给独立 worker，再并行由 worker 花进 end 销毁
  await Promise.all(
    roots.map(async (root) => {
      const t1 = now();
      const child = led.spend(root.id, 'agent:planner', `agent:w${root.id}`);
      led.spend(child.id, `agent:${child.owner!.replace('agent:', '')}`, 'end');
      return now() - t1;
    }),
  );
  const elapsed = now() - t0;

  const allComplete = roots.every((r) => led.isComplete(r.id));
  const valid = led.validate();
  line('[场景一] 千级并行消费');
  line(`  耗时: ${elapsed} ms  |  吞吐: ${Math.round((NODES * 2) / (elapsed / 1000))} ops/s`);
  line(`  全部完结: ${allComplete}  |  不变式自检: ${valid}`);
  if (!allComplete || !valid) process.exitCode = 1;
}

// ---------- 场景二：千级并发下的重复消费（防重用） ----------
{
  const led = new Ledger(20);
  const root = led.issue('防重用压测', 'agent:planner');

  let rejected = 0;
  await Promise.all(
    Array.from({ length: NODES }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          led.spend(root.id, 'agent:planner', `agent:w${i}`);
        } catch (e) {
          if (e instanceof LedgerError && e.code === 'ALREADY_SPENT') rejected += 1;
        }
      }),
    ),
  );

  line('');
  line('[场景二] 同一张单并发双花');
  line(`  尝试 ${NODES} 次，成功 1 次，拒绝 ${rejected} 次`);
  const ok = rejected === NODES - 1;
  if (!ok) process.exitCode = 1;
  line(`  防重用生效: ${ok}`);
}

// ---------- 场景三：并发退单触发熔断 ----------
{
  const led = new Ledger(20);
  const root = led.issue('熔断压测', 'agent:planner');
  let cur = led.spend(root.id, 'agent:planner', 'agent:A');
  let to: 'agent:A' | 'agent:B' = 'agent:B';

  for (let i = 0; i < 25; i++) {
    if (led.isHalted(root.id)) break;
    try {
      cur = led.reject(cur.id, cur.owner!, to);
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'CIRCUIT_OPEN') break;
      throw e;
    }
    to = to === 'agent:A' ? 'agent:B' : 'agent:A';
  }

  line('');
  line('[场景三] 反复退单熔断');
  line(`  退单计数: ${led.rejectCount(root.id)}  |  已熔断: ${led.isHalted(root.id)}`);
  if (!led.isHalted(root.id)) process.exitCode = 1;
}

// ---------- 场景四：长血缘追溯开销 ----------
{
  const led = new Ledger(20);
  let cur = led.issue('深链压测', 'agent:planner');
  const DEPTH = Math.min(NODES, 500);
  for (let i = 0; i < DEPTH; i++) {
    cur = led.spend(cur.id, cur.owner!, `agent:hop${i}`);
  }
  const t0 = now();
  const chain = led.lineage(cur.id);
  const queryMs = now() - t0;
  line('');
  line('[场景四] 长血缘追溯');
  line(`  链深 ${DEPTH}  |  追溯节点 ${chain.length}  |  耗时 ${queryMs} ms`);
  if (chain.length !== DEPTH + 1) process.exitCode = 1;
}

line('');
line('================ 压测结束 ================');
