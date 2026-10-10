# 规范库条目写作标准

规范库里的每一条，都要让没读过原书或原文档的工程师一次读懂：这条规则说的是什么、代码里长什么样、为什么要管、怎么改。条目同时会注入评审模型的提示词，写法要让模型能直接调用它已有的相关知识。

## 原则

- **贴合原文**：一条对应原文的一条规则、条款或坏味道，不合并、不拆散。正文完整表达原文的意思，术语与原文一致。
- **关键英文术语保留原文**：规则名、坏味道名与重构手法名、设计模式名、标准术语、API 与宏名一律保留英文，例如 Feature Envy、Move Function、Extract Function、Strategy、EOF、undefined behavior、sequence point、lcore、mempool、`RING_F_SP_ENQ`。这些名称在模型训练数据中权重很高，保留原文能让评审模型直接调用相关知识。中文用于解释，不替代术语。
- **直白**：标题以关键英文术语开头（如有），冒号后用中文写一句能照着做的话。
- **有例子**：每条都有反例与正例代码。例子要短，能直接看出问题所在。
- **判断题**：代码坏味道（code smell）这类启发式条目是判断题，不是硬性违规。摘要与正文用「可能的 X」的口吻，严重级别默认为建议或警告。团队规范与之冲突时以团队规范为准（见 Story 15 的覆盖关系）。

## 字段

| 字段 | 内容 |
|---|---|
| `title` | 以英文术语开头（如有）的一句话规则，中文部分 25 字以内 |
| `originalName` | 原文名称：英文原名为准，有通行中文译名的放括号里；或原文条款编号 |
| `summary` | 一行「是什么 → 怎么改」，写法参照 `.agents/skills/code-review/SKILL.md` 的 smell baseline |
| `body` | 规则正文：按原文意思完整表述 |
| `check` | 评审时检查什么：代码里这个问题长什么样 |
| `why` | 为什么：违反后的具体后果 |
| `fix` | 怎么改 |
| `badExample`、`goodExample` | 反例与正例代码，必填 |
| `exampleLanguage` | 示例代码的语言 |
| `source` | 出处：书或文档、章节或条款；开放文档附链接 |
| `judgement` | 是否为启发式判断题；条目声明优先于规范集声明，缺省为 `false`。判断题默认严重级别为建议或警告 |

## 《重构》规范集的固定条目

`.agents/skills/code-review/SKILL.md` 的 smell baseline 列出的 12 个坏味道必须收录，英文名称完全一致：Mysterious Name、Duplicated Code、Feature Envy、Data Clumps、Primitive Obsession、Repeated Switches、Shotgun Surgery、Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest。其余第 3 章坏味道按评审中是否可对照代码判断选择收录。

## 样板

### 《C 陷阱与缺陷》第 5.1 节

```json
{
  "id": "c-traps-and-pitfalls-getchar-int",
  "title": "getchar 返回值用 int 保存，再与 EOF 比较",
  "originalName": "Getchar returns an integer（返回整数的 getchar 函数）",
  "summary": "用 char 接收 getchar 的返回值 → 改用 int，确认不是 EOF 后再转成 char",
  "body": "getchar 返回 int：读到字符时返回该字符（按 unsigned char 取值后转成 int），到达文件末尾或出错时返回 EOF。EOF 是一个负数，与任何有效字符都不相等。只有用 int 保存返回值，才能同时容纳全部字符和 EOF。原书指出，把结果存进 char 的写法在某些编译器上碰巧能工作，这正是它危险的地方。",
  "check": "保存 getchar、getc、fgetc 返回值的变量是不是 char；与 EOF 比较之前，返回值有没有先被截断成 char。",
  "why": "char 是 unsigned 的平台上，变量永远不等于 EOF，循环停不下来；char 是 signed 的平台上，读到值为 0xFF 的字节会被当成 EOF，提前结束。同一份代码换个编译器或平台，行为就不同。",
  "fix": "用 int 声明保存返回值的变量；确认不是 EOF 之后，需要时再转换成 char。",
  "badExample": "char c;\nwhile ((c = getchar()) != EOF)\n    putchar(c);",
  "goodExample": "int c;\nwhile ((c = getchar()) != EOF)\n    putchar(c);",
  "exampleLanguage": "c"
}
```

### 《重构》第 3 章

```json
{
  "id": "refactoring-smells-feature-envy",
  "title": "Feature Envy：函数更依赖别的对象的数据，就把它搬过去",
  "originalName": "Feature Envy（依恋情结）",
  "summary": "函数读取别的对象的数据多于自己的 → 用 Move Function 把它搬到那个对象上",
  "body": "一个函数跟另一个模块的函数和数据交流得特别多，远多于跟自己所在模块的交流，这就是可能的 Feature Envy。最常见的样子是：为了算出一个值，连续调用另一个对象的好几个 getter。原书的处理是 Move Function，把函数搬到它依赖的数据所在的地方；如果只有一部分代码在依恋别处，先 Extract Function 再搬。判断标准是：哪个模块拥有这个函数用到的大部分数据，函数就该放在哪里，把总是一起变化的东西放在一起。Strategy、Visitor 等模式有意把行为和数据分开，不算 Feature Envy。",
  "check": "一个函数里，对同一个外部对象连续调用多个 getter，再用这些值做计算；而对自己所在对象的字段用得很少。",
  "why": "数据和使用数据的逻辑分在两处。被依恋的对象一改字段，就要去别处找所有用到它的计算；同样的计算还容易在多个地方各写一遍。",
  "fix": "用 Move Function 把这段计算搬到拥有数据的对象里，调用方只调用一个方法拿结果；只有一部分在依恋时，先 Extract Function 再搬。",
  "badExample": "class ShippingService {\n  double fee(Order order) {\n    double weight = 0;\n    for (Item item : order.getItems()) weight += item.getWeight() * item.getQuantity();\n    return weight * order.getAddress().getRegion().getRatePerKg();\n  }\n}",
  "goodExample": "class Order {\n  double totalWeight() {\n    double weight = 0;\n    for (Item item : items) weight += item.weight() * item.quantity();\n    return weight;\n  }\n  double shippingFee() { return totalWeight() * address.ratePerKg(); }\n}",
  "exampleLanguage": "java"
}
```

### DPDK Programmer's Guide：Ring Library

```json
{
  "id": "dpdk-data-plane-ring-sync-mode",
  "title": "SP/SC 模式的 rte_ring：同一方向禁止并发调用",
  "originalName": "Ring Library: Producer/Consumer Synchronization Modes（MP/MC、SP/SC）",
  "summary": "SP/SC 的对应方向被多个线程并发调用 → 保证该方向同一时刻只有一个调用，或改用 MP/MC",
  "body": "lcore（logical core）是 DPDK 编号的执行线程，通常绑定逻辑 CPU；普通 pthread 也可以调用 rte_ring。rte_ring 支持 multi-producer（MP）与 single-producer（SP）入队、multi-consumer（MC）与 single-consumer（SC）出队。SP/SC 要求对应方向的调用同一时刻只发生在一个线程上；多个线程经外部锁完整串行化调用也满足此前提，普通 pthread 同样计入。允许入队线程与出队线程同时工作。MP/MC 负责相应方向的多线程同步。创建时用 RING_F_SP_ENQ、RING_F_SC_DEQ 指定模式，也可用 rte_ring_sp_enqueue、rte_ring_mc_dequeue 等函数显式选择。示例的 socket_id 是 NUMA 内存节点编号。",
  "check": "rte_ring_create 带 RING_F_SP_ENQ 或 RING_F_SC_DEQ，或调用 rte_ring_sp_*、rte_ring_sc_* 时，确认对应方向的调用同一时刻只发生在一个线程上，普通 pthread 也算；外部锁必须覆盖该方向的每个调用点。",
  "why": "多个线程同时以 SP 模式入队，会覆盖槽位或破坏 ring 状态；SC 模式并发出队也可能重复领取对象。这类故障依赖并发时序，低负载测试可能看不到。",
  "fix": "逐方向确认调用已串行化；存在并发入队就使用 MP，存在并发出队就使用 MC。去掉对应 SP/SC 创建标志后，还要把显式的 sp/sc 调用改成匹配的 mp/mc 或通用接口。",
  "badExample": "struct rte_ring *r = rte_ring_create(\"rx_to_worker\", 1024, socket_id, RING_F_SP_ENQ);\n/* 多个 RX 线程可能同时执行 */\nrte_ring_enqueue(r, pkt);",
  "goodExample": "/* 多个 RX 线程并发入队，只有一个 worker 线程出队：使用 MP/SC */\nstruct rte_ring *r = rte_ring_create(\"rx_to_worker\", 1024, socket_id, RING_F_SC_DEQ);\nif (r == NULL) return ERROR;\n/* 每个 RX 线程：处理未能交接的包 */\nif (rte_ring_enqueue(r, pkt) != 0)\n    rte_pktmbuf_free(pkt);\n/* 唯一 worker 线程：仅处理成功取得的对象 */\nif (rte_ring_dequeue(r, &obj) == 0)\n    process_object(obj);",
  "exampleLanguage": "c"
}
```

## 开源前的处理

当前条目以让团队读懂为目标，正文贴近原书表述。来自受版权保护书籍的条目，开源发布前需要重新审核，改为不依赖原文表述的写法，或移出公开发布的规范库。
