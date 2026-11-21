# UTXO Ticket Ledger

借用比特币 UTXO（未花费交易输出）账本模型实现的一次性任务单调度原型，用于管理千级多 Agent 并行时的派单、叫停、留痕与熔断。

> 设计文档（云端权威版本）：https://www.workbuddy.cn/space/d/8BvPih4UFmQYKAPehX8jL9
> 本地副本：`DESIGN.md`

## 核心机制

四条硬规则全部落在代码结构上，不依赖提示词"自觉"：

| 规则 | 实现 |
|---|---|
| R1 指令与数据隔离 | 只认首个输入槽位为指令，网页/上游内容恒为数据，注入文本无法变成命令 |
| R2 派单链权限 | 只有派单链上的上游可以叫停；根单进 `end` 后子单级联作废，下游无权撤销 |
| R3 点名交接 | `spend` 必须指定明确收件人，禁止公共池与自转 |
| R4 查账完结 + 熔断 | 完结靠查未花单，不看模型自报；退单计数达阈值触发熔断交人工 |

UTXO 三特性：天然防重用、全链路血缘、无锁并发。另含真实 Git 审计留痕与账本不变式自检。

## 运行

环境：Node >= 22.6（原生类型剥离），零第三方运行时依赖。

```bash
npm test            # 21 个用例（16 账本 + 5 Git 联动）
npm run demo        # 终端版派单闭环
npm run demo:visual # 生成可视化页面 demo/index.html
npm run stress      # 千级并发压测
NODES=5000 npm run stress
```

`npm run demo:visual` 会读取 `demo/template.html`，把真实 Git 审计数据注入后生成 `demo/index.html`。生成物不入库，避免带上本机临时路径。

## 结构

```
src/
  types.ts       Ticket / Address 类型
  ledger.ts      Ledger 账本核心（四条规则）
  git-audit.ts   GitAuditStore 真实 Git 留痕
  index.ts       统一导出
test/
  ledger.test.ts    账本规则测试
  git-audit.test.ts Git 联动测试
  stress.ts         千级并发压测
  demo.ts           终端演示
  visual-demo.ts    可视化演示生成器
demo/
  template.html  可视化页面模板
docs/
  index.html     收款渠道入口页（GitHub Pages 源，线上：crz101.github.io/utxo-ticket-ledger/）
.github/
  FUNDING.yml    仓库 Sponsor 入口配置
DESIGN.md       设计文档（云端为权威版本）
```

## 支持这个项目

收款渠道入口已上线：**https://crz101.github.io/utxo-ticket-ledger/** （仓库 Sponsor 按钮直达）。源码在 [`docs/index.html`](docs/index.html)。

作者居住于中国大陆，GitHub Sponsors 不支持该地区的收款，且财政托管方无大陆主体，因此走的是大陆可用的渠道（爱发电为主，Ko-fi / Buy Me a Coffee 需海外收款账户），另直挂 BTC 主网地址（一键复制 + BIP21）。`.github/FUNDING.yml` 的 `custom` 已指向线上收款页。

自定义方式：编辑 `docs/index.html` 里的渠道链接与底部 `BTC_ADDRESS` 配置，推送到 `main` 后 GitHub Pages 自动更新。

## 安全披露

发现漏洞请勿开公开 Issue，优先用仓库 Security 标签页的 **Report a vulnerability** 私有上报。受理范围、响应时限与披露原则见 [`SECURITY.md`](SECURITY.md)。

注意：本项目是教学/原型性质，不是生产级安全组件，不应用于处理真实资金或关键状态。

## 实测

- `npm test`：21/21 通过
- 1000 节点并行消费：约 4-5ms，40-50 万 ops/s
- 并发双花 1000 次：成功 1、拒绝 999
- 500 深血缘追溯：501 节点，约 0ms
