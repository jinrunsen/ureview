# PR-Agent 实现拆解：git provider 抽象、diff 解析、PR Compression

- 对应 ticket：`../issues/05-pr-agent-的-gitlab-适配与大-pr-压缩算法.md`
- 调研时间：2026-09-11
- 调研对象：`https://github.com/The-PR-Agent/pr-agent`，commit `1421c673effb7644239e18fdea5403ccf04bb190`（2026-09-10），`pyproject.toml` version = `0.45.0`
- 源码本地路径（临时 clone，读完即可删）：`/private/tmp/claude-501/-Users-jinrunsen-Projects-github-ureview/1279d33b-a08b-431f-b0b8-1fff2cb22d82/scratchpad/pr-agent`

下文所有路径均相对仓库根，行号对应上述 commit。

> 两点与 ticket 前提不符，先记在这里：
> 1. 当前 `LICENSE` 是 **MIT**（`Copyright (c) 2026 The PR Agent`，21 行的标准 MIT 文本），不是 Apache-2.0。两者都是宽松许可，对「读实现、不 fork」没有影响，但如果后续要抄代码片段，按 MIT 处理。
> 2. 官方文档 `docs/docs/core-abilities/compression_strategy.md` 里写「扩展上下文 3 行」，这条已经过期——代码里的默认值是 before=5 / after=1（在 git 自带的 3 行之上）。**文档不可信，以代码和 `configuration.toml` 为准**，这也是 ticket 要求「必须读源码」的原因。

---

## 0. 先建立全局图景

一次 `/review` 的数据流：

```
webhook / CLI
  └─ PRAgent.handle_request           pr_agent/agent/pr_agent.py:210
       ├─ apply_repo_settings(pr_url)          # 拉仓库内 .pr_agent.toml 合并配置
       └─ command2class[action](...).run()     # 每个 tool 一个类
            └─ retry_with_fallback_models(self._prepare_prediction)
                                               pr_agent/algo/pr_processing.py:330
                 ├─ get_pr_diff(...)           pr_agent/algo/pr_processing.py:45   ← PR Compression 入口
                 │    ├─ git_provider.get_diff_files()   → List[FilePatchInfo]
                 │    ├─ sort_files_by_main_languages()  pr_agent/algo/language_handler.py:80
                 │    ├─ pr_generate_extended_diff()     （全量+扩展上下文，先试一把）
                 │    └─ pr_generate_compressed_diff()   （超限才走，逐级裁剪）
                 └─ ai_handler.chat_completion(system, user)   # 单次 LLM 调用
            └─ _prepare_pr_review() → publish_persistent_comment()
```

关键类型只有一个，`pr_agent/algo/types.py:14`：

```python
@dataclass
class FilePatchInfo:
    base_file: str        # base 侧完整文件内容（可能为 ''）
    head_file: str        # head 侧完整文件内容（可能为 ''）
    patch: str            # unified diff，只含 hunk（无 ---/+++ 头）
    filename: str
    tokens: int = -1
    edit_type: EDIT_TYPE = EDIT_TYPE.UNKNOWN
    old_filename: str = None      # 仅重命名时非空
    num_plus_lines: int = -1
    num_minus_lines: int = -1
    language: Optional[str] = None
    ai_file_summary: str = None
    head_file_is_complete: bool = True
```

**整个压缩算法只依赖这一个结构**。provider 的唯一职责就是把各家 API 的 diff 塞进这个 dataclass。这个切法很干净，值得直接抄。

---

## 1. PR Compression 算法（重点）

### 1.1 关键常量

全部在 `pr_agent/algo/pr_processing.py:21-29`：

```python
DELETED_FILES_       = "Deleted files:\n"
MORE_MODIFIED_FILES_ = "Additional modified files (insufficient token budget to process):\n"
ADDED_FILES_         = "Additional added files (insufficient token budget to process):\n"

OUTPUT_BUFFER_TOKENS_SOFT_THRESHOLD = 1500   # 软阈值：给模型输出预留
OUTPUT_BUFFER_TOKENS_HARD_THRESHOLD = 1000   # 硬阈值：连文件名清单都塞不下就停
MAX_EXTRA_LINES = 10                         # patch_extra_lines_* 的硬上限
```

配置默认值（`pr_agent/settings/configuration.toml:39-58`）：

| key | 默认 | 含义 |
|---|---|---|
| `max_model_tokens` | `32000` | **对任何模型都强行封顶 32k**。注释写明理由：输入太长模型质量会退化 |
| `custom_model_max_tokens` | `-1` | 不在内置表里的模型用这个 |
| `model_token_count_estimate_factor` | `0.3` | 非 OpenAI/Anthropic 模型，token 估算乘 1.3 |
| `patch_extension_skip_types` | `[".md",".txt"]` | 这些后缀不做上下文扩展 |
| `allow_dynamic_context` | `true` | 动态上下文（见 1.4） |
| `max_extra_lines_before_dynamic_context` | `10` | 动态模式下最多往前找 10 行 |
| `patch_extra_lines_before` | `5` | hunk 前扩展行数（git 自带 3 行之外） |
| `patch_extra_lines_after` | `1` | hunk 后扩展行数 |
| `large_patch_policy` | `"clip"` | 单文件超预算时 `clip` 还是 `skip`（**只在多 chunk 路径生效**） |
| `use_extra_bad_extensions` | `false` | 是否启用扩展的坏后缀名单 |

`get_max_tokens(model)` 在 `pr_agent/algo/utils.py:1384-1473`，解析顺序：
1. `MAX_TOKENS` 内置表（`pr_agent/algo/__init__.py:278+`，几百个型号硬编码）
2. `config.custom_model_max_tokens`（>0）
3. `_thinking` 别名归一后再查表
4. `litellm.get_model_info(...)` 的 `max_input_tokens`
5. 查不到直接抛异常
最后统一 `min(max_model_tokens, max_tokens_model)` 收口。

`get_max_tokens` 返回的是**输入预算**，不是模型总窗口。默认 32000 这个数字很保守：意思是「即便你给我 1M 窗口，我也只塞 32k」。

### 1.2 主流程：`get_pr_diff()`（pr_processing.py:45-146）

```
1. 取 diff_files = git_provider.get_diff_files()
2. pr_languages = sort_files_by_main_languages(git_provider.get_languages(), diff_files)
3. patches_extended, total_tokens, _ = pr_generate_extended_diff(...)   # 全量 + 扩展上下文
4. if total_tokens + 1500 < get_max_tokens(model):
       return "\n".join(patches_extended)            # ← 小 PR 快速路径，到此结束
5. 超限 → pr_generate_compressed_diff(...)           # 压缩路径
6. large_pr_handling=True 且压出多组 → return ""     # 交给 tool 层走多次调用
7. 否则取第一组 patches_compressed
8. 用剩下的预算，按 ADDED → MODIFIED/RENAMED → DELETED 的顺序，
   把没进 diff 的文件名拼成三段纯文本清单追加到末尾，每段都 clip_tokens 收口
9. return final_diff (, remaining_files_list)
```

第 4 步的 `total_tokens` 已经包含 `token_handler.prompt_tokens`（system+user 模板渲染后的 token），所以这个判断是「prompt + diff + 1500 输出预留 < 预算」。

### 1.3 文件排序与分组（这是取舍的核心）

两级排序，`pr_processing.py:176-178`：

```python
sorted_files = []
for lang in top_langs:                                    # 第一级：语言
    sorted_files.extend(sorted(lang['files'],
                               key=lambda x: x.tokens,     # 第二级：token 数
                               reverse=True))              # 降序！大文件优先
```

- **第一级：按仓库主语言排序**。`sort_files_by_main_languages()`（`pr_agent/algo/language_handler.py:80-126`）拿 `git_provider.get_languages()`（各家 API 的语言统计，按字节数）降序排，把 PR 文件按后缀归到语言桶里，归不上的进 `"Other"` 桶排最后。结果形如 `[[a.py, b.py], [c.js], [Other: readme.md]]`。
- **第二级：桶内按 patch token 数降序**。**大文件排前面**。

> 这个「大文件优先」的选择很反直觉，也是我认为**最不该直接抄**的一条。它的逻辑大概是「大改动信息量大」，但实际效果是：一个 3000 行的自动生成文件会吃掉整个预算，把 20 个 50 行的手写改动全挤出去。对 review 质量是负优化。见第 7 节。

排序前的过滤（`language_handler.py:8-39` `filter_bad_extensions` / `is_valid_file`）：
- `bad_extensions.default`（`settings/language_extensions.toml`）：二进制/资源类后缀（png/zip/pdf/class/bin…），大小写不敏感比较。
- 精确文件名黑名单（硬编码在 `is_valid_file:24-28`）：`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`composer.lock`、`Gemfile.lock`、`poetry.lock`、`go.sum`、`.terraform.lock.hcl`、`uv.lock`、`Cargo.lock`、`Pipfile.lock`、`mix.lock`、`pubspec.lock`、`bun.lockb`。
- 后缀黑名单：`.min.js`、`.min.css`、`.js.map`、`.ts.map`、`.css.map`。

另有用户可配的忽略规则，`pr_agent/algo/file_filter.py:8-90`：`ignore.regex` + `ignore.glob`（glob 用 `fnmatch.translate` 转 regex，`**/` 前缀额外补一条覆盖根级文件），加上 `config.ignore_language_framework` 指定的代码生成框架（protobuf 之类）。**这个过滤在 provider 的 `get_diff_files()` 里就调用了**，即在进入压缩算法之前文件已经被剔掉了。

### 1.4 上下文行扩展：`extend_patch()`（git_patch_processing.py:30-202）

只在**未超预算**的路径上调用。一旦进入压缩路径，扩展上下文**整个被放弃**，回落到 provider 给的原始 patch（git 默认 3 行上下文）。这是压缩的第一刀，也是最粗的一刀。

扩展逻辑（`process_patch_lines:75-202`）：

1. 逐行扫 patch，遇到 `@@` 用 `RE_HUNK_HEADER = r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)"` 解析出 `start1,size1,start2,size2,section_header`。
2. **先校验 hunk 与原文件是否对得上**（`check_if_hunk_lines_matches_to_file:204-228`）：取 hunk 头后第一行（如果是 ` ` 上下文行），和 `original_lines[start1-1]` 比对 strip 后是否相等。不等就尝试几种编码（`iso-8859-1`/`latin-1`/`ascii`/`utf-16`）再比一次；仍不等则 `is_valid_hunk = False`，**这个 hunk 不做任何扩展**。这一步是防止行号错位把无关代码当成上下文喂给模型——是踩过坑才会写的代码。
3. **动态上下文（`allow_dynamic_context=true`，默认开）**：先按 `max_extra_lines_before_dynamic_context=10` 往前取 10 行，在这 10 行里找 `section_header`（就是 `@@ ... @@` 后面 git 给出的那个函数/类签名）。找到就从那行开始截断——效果是「把上下文扩到所在函数的开头为止」。找到了还会把 `section_header` 置空（避免重复信息）。找不到就退回固定的 `patch_extra_lines_before=5`。
4. **base/head 一致性检查**（`:145-169`）：扩展出来的「上文」必须在 base 和 head 两侧完全一致才能当 ` ` 上下文行输出。不一致就逐行向后收缩找最长公共后缀（`found_mini_match`）；还不行就完全放弃扩展这一 hunk。
5. 不能越过原文件末尾（`:108-112` 的 `delta_cap`）。
6. 重写 hunk header 为扩展后的 `@@ -s1,n1 +s2,n2 @@ section_header`。

上限保护：`cap_and_log_extra_lines()`（`pr_processing.py:32-42`）把 `patch_extra_lines_*` 强制 clamp 到 `MAX_EXTRA_LINES=10`。

跳过条件：`should_skip_patch()`（`git_patch_processing.py:68-72`）——`.md`/`.txt` 不扩展；`base_file` 为空也不扩展（`extend_patch:32-38`）。

### 1.5 裁剪 diff 第二刀：删除 deletion-only hunk

`handle_patch_deletions()`（`git_patch_processing.py:281-311`）：

- 如果 `head_file` 为空且 `edit_type` 是 `DELETED`/`UNKNOWN` → **整个 patch 置为 None**，文件名收进 `deleted_files_list`，正文完全不给模型。
- 否则调 `omit_deletion_hunks()`（`:241-278`）：按 hunk 切段，**只要这个 hunk 里没有任何 `+` 行就整段丢弃**。注释特意说明「deletion-only hunk 不能泄漏到下一个 hunk 的输出里」——早期有过 bug。

设计意图直白：**加法比减法重要**。删掉的代码没有 review 价值。

### 1.6 压缩主体：`pr_generate_compressed_diff()`（pr_processing.py:165-236）

```python
# 1) 给没算过 token 的文件补算
for lang in top_langs:
    for file in lang["files"]:
        if file.tokens is None or file.tokens < 0:
            file.tokens = token_handler.count_tokens(file.patch) if file.patch else 0

# 2) 两级排序（见 1.3）
sorted_files = ...

# 3) 逐文件预处理，产出 file_dict（保持 sorted_files 的插入顺序）
for file in sorted_files:
    patch = file.patch
    if not patch: continue
    patch = handle_patch_deletions(patch, base, head, filename, edit_type)
    if patch is None:                     # 整文件删除
        deleted_files_list.append(filename); continue
    if convert_hunks_to_line_numbers:
        patch = decouple_and_convert_to_hunks_with_lines_numbers(patch, file)
    file_dict[filename] = {'patch': patch,
                           'tokens': token_handler.count_tokens(patch),
                           'edit_type': file.edit_type}

# 4) 第一轮打包
total_tokens, patches, remaining, files_in = generate_full_patch(
        convert_hunks_to_line_numbers, file_dict, max_tokens_model,
        remaining_files_list=[所有文件], token_handler)

# 5) large_pr_handling 时继续打包剩下的（最多 max_ai_calls-2 轮）
if large_pr_handling:
    NUMBER_OF_ALLOWED_ITERATIONS = get_settings().pr_description.get("max_ai_calls", 4) - 1
    for _ in range(NUMBER_OF_ALLOWED_ITERATIONS - 1):
        if not remaining: break
        ... generate_full_patch(...) 再来一轮 ...
```

注意第 3 步**没有调用 `extend_patch`**——压缩路径下扩展上下文全丢。

### 1.7 打包器：`generate_full_patch()`（pr_processing.py:239-283）

这是真正的装箱函数，逻辑非常简单（**没有任何背包优化，就是贪心**）：

```python
total_tokens = token_handler.prompt_tokens
for filename, data in file_dict.items():          # 已按 1.3 排好序
    if filename not in remaining_files_list_prev: continue

    # 硬停：预算见底，后面所有文件直接丢进 remaining
    if total_tokens > max_tokens_model - OUTPUT_BUFFER_TOKENS_HARD_THRESHOLD:   # -1000
        remaining_files_list_new.append(filename); continue

    patch_final = ("\n\n## File: '<name>'\n\n<patch>\n"  if 不带行号
                   else "\n\n" + patch.strip())
    new_patch_tokens = token_handler.count_tokens(patch_final)

    # 软停：这一个放不下 → 整个文件丢进 remaining，继续试下一个（不 clip！）
    if total_tokens + new_patch_tokens > max_tokens_model - OUTPUT_BUFFER_TOKENS_SOFT_THRESHOLD:  # -1500
        remaining_files_list_new.append(filename); continue

    patches.append(patch_final); total_tokens += new_patch_tokens
    files_in_patch_list.append(filename)
```

关键取舍，逐条列清楚：

1. **粒度是文件，不是 hunk**。放不下就整个文件不看。源码里留了 TODO：
   > `# TODO: Option for alternative logic to remove hunks from the patch to reduce the number of tokens until we meet the requirements`

   也就是说**「按 hunk 降级」这条路他们想过但没做**。
2. **跳过而非截断**。软停时 `continue` 而不是 break——后面更小的文件还有机会进来。所以最终结果是「按大小降序装箱，装不下的跳过」，实际效果近似「优先塞大文件，再用小文件填缝」。
3. **两条阈值线**：软阈值 1500 是「新文件能否进」的判据，硬阈值 1000 是「还要不要继续遍历」的判据。硬停之后仍然遍历完（为了把文件名收进 remaining），只是不再放任何内容。
4. **单文件超大时没有救济**。一个文件的 patch 单独就超过 `max_tokens - 1500`？它永远进不了这条路径的任何一轮，只会出现在「未处理文件」清单里。`large_patch_policy = "clip"` **在这条路径上不生效**——只有 `get_pr_multi_diffs()` 才读这个配置（见 1.9）。这是个实打实的不一致。

### 1.8 超限时丢弃的东西怎么向用户交代

三层交代，都在 `get_pr_diff:96-146`：

**第一层，给模型**：用剩下的预算，按 `ADDED` → `MODIFIED`/`RENAMED` → `DELETED` 的顺序，把没进 diff 的文件名拼成三段纯文本追加到 diff 末尾：

```
Additional added files (insufficient token budget to process):
src/foo.py
src/bar.py

Additional modified files (insufficient token budget to process):
...

Deleted files:
...
```

每段都过一遍 `clip_tokens(s, max_tokens - curr_token)`，预算是 `get_max_tokens(model) - OUTPUT_BUFFER_TOKENS_HARD_THRESHOLD`（硬阈值 1000）。三段按顺序吃预算，`DELETED` 排最后——预算不够时最先被砍掉。注意 `DELETED` 的文件名**不**计入 `unprocessed_files`（代码注释：文件都删了没什么可 review 的）。

`clip_tokens()`（`utils.py:1476-1580`）的实现是**按字符比例估算**，不是精确按 token 切：

```python
chars_per_token = len(text) / num_input_tokens
factor = 0.9                                   # 保险起见砍 10%
num_output_chars = int(0.9 * chars_per_token * max_tokens)
clipped = text[:num_output_chars]
if delete_last_line: clipped = clipped.rsplit('\n', 1)[0]
if add_three_dots:   clipped += "\n...(truncated)"
```

**第二层，给人（review 正文页脚）**：`pr_agent/tools/pr_reviewer.py:942-952`

```python
if self.remaining_files_list and get_settings().pr_reviewer.enable_review_coverage_footer:
    displayed_files = self.remaining_files_list[:MAX_REVIEW_COVERAGE_FILES]     # 50
    markdown_text += ("\n\n<hr>\n\n"
        "⚠️ **Review coverage:** The following files were not included in this review "
        "because of the token budget:\n" + "\n".join(f"- `{f}`" for f in displayed_files))
    remaining_count = len(self.remaining_files_list) - len(displayed_files)
    if remaining_count: markdown_text += f"\n... and {remaining_count} more"
```

默认 `enable_review_coverage_footer = true`（`configuration.toml:153`），封顶 50 个文件名（`pr_reviewer.py:60`）。分块模式下还额外加一段：

```python
if self.review_chunk_count > 1:                                # pr_reviewer.py:932-940
    markdown_text += ("ℹ️ **Chunked review:** the diff exceeded the model token budget, "
                      f"so it was reviewed in {self.review_chunk_count} chunks and the "
                      "per-chunk results were merged.")
    if self.review_failed_chunk_count:
        markdown_text += f" {self.review_failed_chunk_count} chunk(s) failed and are not covered by this review."
```

`/describe` 有对应的 `_get_description_coverage_footer()`（`pr_description.py:453-472`），文案是「N of M file-description chunks failed」，同样封顶 50 个文件名（`MAX_DESCRIPTION_COVERAGE_FILES = 50`）。

**第三层，影响状态机**：`remaining_files_list` 非空会关掉「把上一轮的 finding 标记为已解决」这个动作（`pr_reviewer.py:727-739`）——因为「这次没看这个文件」不等于「问题没了」。这个判断很关键，抄的时候不要漏（详见第 6 节）。

### 1.9 另一条路：`get_pr_multi_diffs()`（pr_processing.py:394-537）

`/improve` 和开了 `enable_large_pr_chunking` 的 `/review` 走这条。跟 `get_pr_diff` 的区别：

| | `get_pr_diff` | `get_pr_multi_diffs` |
|---|---|---|
| 输出 | 一个字符串 | `List[str]`，每个是一次 LLM 调用的 diff |
| 超大单文件 | 只能跳过 | 读 `large_patch_policy`：`clip` 会截断后放进去 |
| 装不下时 | `continue`（跳过，继续填缝） | **开新 chunk**（`call_number += 1`），装满 `max_calls` 为止 |
| 上下文扩展 | 超限就全丢 | **每个 chunk 都保留扩展**（`pr_generate_extended_diff` 的结果被复用来算 `file.tokens`，切分时按 `decouple_and_convert_to_hunks_with_lines_numbers` 重新生成，未再 extend） |

`clip` 分支（`:479-497`）：

```python
if patch and (prompt_tokens + new_patch_tokens) > get_max_tokens(model) - 1500:
    policy = get_settings().config.get('large_patch_policy', 'skip')
    if policy == 'skip':   continue
    elif policy == 'clip':
        delta_tokens = get_max_tokens(model) - 1500 - token_handler.prompt_tokens
        patch_clipped = clip_tokens(patch, delta_tokens, delete_last_line=True,
                                    num_input_tokens=new_patch_tokens)
        if 仍然超限: continue          # clip 完还超就还是跳过
        patch = patch_clipped
```

切 chunk（`:499-510`）：

```python
if patch and (total_tokens + new_patch_tokens > get_max_tokens(model) - 1500):
    final_diff_list.append("\n".join(patches))   # 封存当前 chunk
    patches = []; total_tokens = token_handler.prompt_tokens; call_number += 1
    if call_number > max_calls: break             # 超过预算的调用次数，剩下的全丢
```

`return_remaining_files=True` 时（`:527-537`）还会算一份「真正因为预算被挤掉的文件」清单——**排除掉「没有 patch」和「deletion-only」的文件**，因为那些本来就没内容可看，不算 coverage 缺口。这个细节很讲究。

### 1.10 diff 呈现给模型的格式

不是原始 unified diff。`decouple_and_convert_to_hunks_with_lines_numbers()`（`git_patch_processing.py:314-437`）把每个 hunk 拆成 `__new hunk__` / `__old hunk__` 两段：

```
## File: 'src/file.ts'

@@ -880,7 +881,8 @@ def func1():
__new hunk__
881        line1
882        line2
887 +      line4
889        line6
__old hunk__
        line1
-       line3
        line5
```

要点：
- `__new hunk__` 每行前缀是**绝对行号**（`start2 + i`），这是模型能报出准确行号的唯一依据。
- `__old hunk__` **不带行号**——省 token，而且旧行号没人需要。
- `__old hunk__` 只在该 hunk 确有 `-` 行时才输出（`is_minus_lines`）。
- `__new hunk__` 则「只要有 +/- 任一就总是输出」，代码注释：`otherwise LLM gets confused`。
- 文件被删除时直接返回 `"## File 'x' was deleted"`，不给内容。
- `no newline at end of file` 这类噪声行直接丢掉。
- 对应的 prompt 说明在 `pr_agent/settings/prompt_fragments.toml` 的 `diff_hunk_format`，用 Jinja 条件（`include_line_numbers` / `include_ai_metadata`）拼出格式说明，由各 tool 的 prompt 用 `{{ diff_hunk_format }}` 引入。**格式说明和格式生成代码是分开的两份，靠人工保持一致**——这是个维护隐患。

### 1.11 还有一层：AI metadata（enable_ai_metadata）

默认关（`configuration.toml:92`）。开了之后，`/describe` 先跑一轮产出每个文件的 `long_summary`，`add_ai_metadata_to_diff_files()`（`pr_processing.py:540-561`）把它挂到 `FilePatchInfo.ai_file_summary` 上，`add_ai_summary_top_patch()`（`:564-580`）在每个 `## File:` 下面插一段 `### AI-generated changes summary:`。

注意：**压缩路径下这段代码是被注释掉的**（`pr_processing.py:200-202`），只在未超限的扩展路径生效。也就是说「越是大 PR 越需要摘要，它越不给」。这是个明显的设计缺陷。

### 1.12 小 PR 走便宜模型：model_routing

`pr_agent/algo/model_routing.py`。按 **hunk 数 + 文件数**（不是 token 数，理由写在模块 docstring：不依赖 tokenizer）匹配规则列表，第一条满足 `max_hunks` / `max_files` 的规则胜出，替换 primary model：

```toml
[model_routing]
enable = true
rules = [{ model = "gpt-5.6-luna", max_hunks = 20, max_files = 10 }]
```

只对 `ModelType.REGULAR` 生效（weak/reasoning 是 tool 主动选的，不覆盖）。`count_hunks()` 数 `@@` 开头的行，patch 非空但没有 hunk header 时算 1。

---

## 2. Git provider 抽象

### 2.1 基类切面（`pr_agent/git_providers/git_provider.py`，930 行）

抽象方法（子类必须实现）共 17 个，按用途分：

| 类别 | 方法 | 行号 |
|---|---|---|
| 能力声明 | `is_supported(capability)` | 152 |
| 文件/diff | `get_files()`、`get_diff_files()`、`get_languages()`、`get_pr_branch()` | 322/325/348/352 |
| 身份 | `get_user_id()` | 356 |
| PR 元数据 | `get_pr_description_full()` | 360 |
| 配置 | `get_repo_settings()` | 471 |
| 发布 | `publish_description()`、`publish_code_suggestions()` | 332/344 |
| 评论 | `publish_comment()`、`publish_inline_comment()`、`publish_inline_comments()`、`remove_initial_comment()`、`remove_comment()`、`get_issue_comments()` | 557/722/730/734/738/742 |
| 标签 | `publish_labels()`、`get_pr_labels()` | 754/758 |
| 其他 | `remove_reaction()`、`get_commit_messages()` | 815/820 |

**能力位（capability flags）是这个设计里最值钱的部分**。基类给一堆 `supports_xxx()` 默认返回 False，各 provider 按需覆盖：

`supports_incremental_kind`(155)、`supports_code_suggestions_artifact`(162)、`supports_code_suggestion_state`(177)、`supports_threaded_pr_questions`(180)、`supports_line_question_history`(183)、`supports_checkbox_commands`(186)、`supports_pr_chat`(193)、`supports_issue_indexing`(197)、`supports_inline_help_footer`(209)、`supports_changelog_update_review`(218)、`supports_markdown_tables`(227)、`supports_issue_url_tickets` / `supports_issue_reference_tickets` / `supports_linked_work_item_tickets`(235-245)、`supports_review_comment_identity`(567)、`supports_review_finding_state`(570)、`supports_thread_resolution`(584)、`supports_comment_editing`(591，**通过检查子类是否覆盖了 `edit_comment` 自动推导**)。

外加一个字符串版 `is_supported(capability)`，用于 `'gfm_markdown'`、`'publish_inline_comments'`、`'create_inline_comment'`、`'publish_file_comments'`、`'push_code'` 这几个。

> 两套能力查询机制（bool 方法 + 字符串 key）并存，是历史包袱。**我们自己做的话应该只留一套**，建议是带类型的 `Capability` 枚举 + 一个 `supports(cap) -> bool`。

有默认实现的模板方法里，值得注意的：
- `publish_persistent_comment` / `publish_persistent_comment_full`（601-720）：查找已有的自己发的评论 → 编辑，找不到 → 新建。详见第 6 节。
- `get_user_description` + `_is_generated_by_pr_agent`（391-469）：识别 PR 描述是不是自己生成的，避免把自己的输出当用户输入再喂一遍。
- `add_eyes_reaction` / `react_to_outcome` / `_remove_start_reaction`（774-813）：一个「开始 eyes → 成功/失败换表情」的小状态机。
- `clone()` / `ScopedClonedRepo`（267-319）：浅克隆 + 超时 + 凭证脱敏日志 + 析构自动 `rmtree`。
- `MAX_FILES_ALLOWED_FULL = 50`（第 21 行）：**超过 50 个文件后，不再拉取文件全文**，只留 patch。这直接导致大 PR 的上下文扩展失效（`extend_patch` 需要 `base_file`），是一条隐性的降级。

`IncrementalPR`（917-931）：`is_incremental` / `commits_range` / `first_new_commit` / `last_seen_commit`。

`get_main_pr_language(languages, files)`（848-912）是模块级函数。注意 `find_line_number_of_relevant_line_in_file` **不在**这个文件里，它在 `pr_agent/algo/utils.py:1593`。

### 2.2 GitLab provider 实现到什么程度

`pr_agent/git_providers/gitlab_provider.py`，1754 行。

**明确不支持的能力**（`:416-422`）：

```python
def is_supported(self, capability: str) -> bool:
    if capability in ['create_inline_comment', 'publish_inline_comments',
        'publish_file_comments']:  # gfm_markdown is supported in gitlab !
        return False
    if capability == "push_code" and get_settings().config.restricted_mode:
        return False
    return True
```

- `create_inline_comment` / `create_inline_comments`（1067-1071）直接 `raise NotImplementedError`
- `publish_inline_comments`（~1610）是空 `pass`
- `publish_file_comments`（1313）空 `pass`

覆盖的 `supports_*` 只有 4 个：`supports_incremental_kind`(424)、`supports_issue_reference_tickets`(427)、`supports_review_comment_identity`(923)、`supports_review_finding_state`(926)。GitHub provider 覆盖了十几个。**GitLab 上的交互体验是系统性降级的**。

一个有意思的不一致：`resolve_comment_thread` 已经实现（992-1007），但 `supports_thread_resolution()` 保持默认 False，代码注释（993-994）说明这是故意的——`/ask_line` 依赖这个能力位，让它在 GitLab 上跳过。

**MR diff 获取**：
- `self.mr.changes()`，包装在 `_get_merge_request_changes()`（405-414）里；GitLab 返回 `overflow: true`（超大 diff）时，自动用 `access_raw_diffs=True` 重试一次。
- `diff_refs` 三件套：`base_sha` / `head_sha` / `start_sha`，来自 python-gitlab 的 MR 对象属性。
- 文件内容：`get_pr_file_content(path, sha)`（736-747）→ `projects.files.get(path, ref).decode()`，404 时返回 `''`（当作新文件）。
- 增量 review（`/review -i`）：走 `project.repository_compare(last_seen_sha, head_sha)`（577），再和 `mr.changes()` 的路径集合取交集，剔除「目标分支合并进来的幽灵文件」（590-629 有大段注释解释这个坑）。
- submodule 展开（197-403）：`GITLAB.EXPAND_SUBMODULE_DIFFS` 开了以后，识别 `Subproject commit` 变更、解析 `.gitmodules`、对子模块仓库 `repository_compare` 展开成真实 diff。这是自托管场景才会遇到的需求，值得记一笔。

**`get_diff_files()` 的核心循环**（`gitlab_provider.py:829-882`）：

```python
for diff in diffs:                                    # 已过 filter_ignored(…, 'gitlab')
    if not is_valid_file(diff['new_path']): continue  # 坏后缀 / lock 文件
    counter_valid += 1
    if counter_valid < MAX_FILES_ALLOWED_FULL or not diff['diff']:
        original = self.get_pr_file_content(diff['old_path'], base_sha)
        new      = self.get_pr_file_content(diff['new_path'], head_sha)
    else:
        original = new = ''        # 超过 50 个文件后不再拉全文
    edit_type = ADDED if diff['new_file'] else DELETED if diff['deleted_file'] \
                else RENAMED if diff['renamed_file'] else MODIFIED
    patch = diff['diff'] or load_large_diff(filename, new, original)
    ...
    diff_files.append(FilePatchInfo(original, new, patch=patch, filename=diff['new_path'],
        edit_type=edit_type,
        old_filename=None if diff['old_path'] == diff['new_path'] else diff['old_path'],
        num_plus_lines=..., num_minus_lines=...))
```

**认证与自托管**（149-163）：`GITLAB.URL`（必填，支持自托管）、`GITLAB.SSL_VERIFY`（默认 true，可关掉走自签名证书）、`GITLAB.AUTH_TYPE` 二选一（`oauth_token` 默认 / `private_token`）、token 来自 `GITLAB.PERSONAL_ACCESS_TOKEN`。克隆 URL 拼成 `oauth2:<token>@host`（1745-1755）。

**限流：没有**。整个文件没有任何 429/backoff/retry 逻辑，完全依赖 python-gitlab 的默认行为。

**分页：全量拉**。`mr.diffs.list` / `mr.notes.list` / `mr.discussions.list` / `mr.draft_notes.list` 共 7 处全部传 `get_all=True`，没有游标控制。大 MR + 长讨论历史上这会很痛。

### 2.3 MR discussion 的行内定位

`send_inline_comment()`（`gitlab_provider.py:1077-1132`），position 字典构造在 1108-1118：

```python
pos_obj = {'position_type': 'text',
           'new_path': target_file.filename,
           'old_path': target_file.old_filename if target_file.old_filename else target_file.filename,
           'base_sha': diff.base_commit_sha,
           'start_sha': diff.start_commit_sha,
           'head_sha': diff.head_commit_sha}
if edit_type == 'deletion':
    pos_obj['old_line'] = source_line_no - 1
elif edit_type == 'addition':
    pos_obj['new_line'] = target_line_no - 1
else:                                     # context 行，两边都要给
    pos_obj['new_line'] = target_line_no - 1
    pos_obj['old_line'] = source_line_no - 1
```

三个 sha **不是**直接取 `mr.diff_refs`，而是来自 `get_relevant_diff(relevant_file, relevant_line)`（1212-1228）：在 `mr.diffs.list(get_all=True)` 里挑出「包含这一行」的那个 diff 版本，挑不到才回落 `self.last_diff`。这是为了应对「MR 有多次 push，行号属于哪个 diff version」的问题。

行号怎么算出来：`search_line` → `find_in_file`（1317-1360），纯手工扫 patch：

```python
for line in patch_lines:
    if line.startswith('@@'):
        start_old, size_old, start_new, size_new, _ = RE_HUNK_HEADER.match(line).groups()
        source_line_no = int(start_old); target_line_no = int(start_new); continue
    if   line.startswith('-'): source_line_no += 1
    elif line.startswith('+'): target_line_no += 1
    elif line.startswith(' '): source_line_no += 1; target_line_no += 1
    if relevant_line_in_file in line:
        found = True; edit_type = self.get_edit_type(line); break
    elif relevant_line_in_file[0] == '+' and relevant_line_in_file[1:].lstrip() in line:
        # 模型常给上下文行也加个 '+'
        found = True; edit_type = self.get_edit_type(line); break
```

**定位靠的是「模型回传的那行文本」而不是行号**——模型给 `relevant_line_in_file`（一行源码文本），代码在 patch 里找它。这跟 `pr_agent/algo/utils.py:1593` 的 `find_line_number_of_relevant_line_in_file()` 是同一个思路，那边还多了 `difflib.get_close_matches(..., n=3, cutoff=0.93)` 的模糊匹配兜底。

**失败与降级链**：
1. `found == False` → 直接 `return False`，**不调 API**（1082-1084）。
2. `found == True` 但 GitLab 服务端拒绝（那一行不是合法 diff 位置）→ `_create_suggestion_note`（1134-1210）捕获异常，降级成**不带行号的文件级 note**：position 只留 `position_type: 'text'` + 三个 sha + `file_path`（1191-1197），正文改用 `difflib.unified_diff` 生成的代码块，并注明 "GitLab API allows committable suggestions strictly on MR diff lines"。
3. draft note 创建失败 → 整体降级为实时评论重试一次（1122-1132）。

**多行建议**：`gitlab_provider.py` **完全没有用 GitLab position 的 `line_range` 字段**（全仓库 grep，`line_range` 只出现在 `servers/gitlab_webhook.py` 解析 GitLab 自己发来的 DiffNote position 时）。多行是靠 GitLab Markdown 的建议块偏移语法实现的（`publish_code_suggestions`，1230-1310）：

```python
range = relevant_lines_end - relevant_lines_start
body = body.replace('```suggestion', f'```suggestion:-0+{range}')
```

即锚点仍是单行，覆盖范围写在 ```` ```suggestion:-0+N ```` 里。这只对「可提交建议」有效；**普通多行内联评论在 GitLab 上没有等价实现**。GitHub 那边则是真的用 `start_line` + `line` + `start_side`。

**Draft notes 批量发布**（1230-1310）：`gitlab.publish_code_suggestions_as_review` 开启后，每条建议先 `mr.draft_notes.create(...)`（对其他人不可见），最后 `mr.draft_notes.bulk_publish()` 一次性发出。这是 GitLab 侧唯一的「防刷屏」手段——因为它不支持 GitHub 那种 `create_review(comments=[...])` 批量提交。

### 2.4 Webhook 接线（servers/gitlab_webhook.py）

- 单入口 `POST /webhook`（302）。
- `object_kind == 'merge_request'`（328-395）：`open`/`reopen` → `pr_commands`；`update` + `is_draft_ready` → 草稿转正；`update` + `oldrev` → push 事件走 `push_commands`（受 `gitlab.handle_push_trigger` 控制）；`update` 无 `oldrev` → reviewer 变更，检测 bot 是否被指派为 reviewer（受 `gitlab.handle_reviewer_assignment` 控制）。
- `object_kind == 'note'`（397-408）：MR 评论；`DiffNote` 且含 `/ask` → `handle_ask_line`（412-437），把 webhook payload 里的 `position.line_range` 转成 `/ask_line --line_start=... --line_end=... --side=... --file_name=... --comment_id=...`。
- **去重**靠几层过滤而不是 delivery-id 缓存：`is_bot_user`（88-111，按 `config.bot_user_indicators` 匹配显示名，防自触发循环）、`should_process_pr_logic`（234-278，仓库名/作者/标题/标签/源目标分支的正则黑名单）、`is_draft`/`is_draft_ready`（113-146）、`push_trigger_slot(url, allow_backlog=True, ttl=300)`（142/181，push 事件 300 秒节流槽）。
- **Secret 校验**（281-308）：读 `X-Gitlab-Token` 头，配了 `secret_provider` 就按 token 查存储的 secret（多租户），否则比 `GITLAB.SHARED_SECRET`，用 `hmac.compare_digest` 恒定时间比较。

---

## 3. diff 解析

### 3.1 hunk 怎么切

全仓库只有一条正则，`git_patch_processing.py:12-13`：

```python
RE_HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)")
```

`extract_hunk_headers()`（`:231-238`）把它拆成 `(section_header, size1, size2, start1, start2)`，**省略的 size 默认为 1**（`-5 +6 @@` 等价于 `-5,1 +6,1 @@`）——这是标准 unified diff 语义，很多手写解析器会漏。

第五个捕获组 `section_header` 是 git 给出的所在函数/类签名，被用在动态上下文扩展里（见 1.4）——**这是一条几乎零成本的语义信息，我们也该用上**。

有两处手写扫描器（`process_patch_lines`、`decouple_and_convert_to_hunks_with_lines_numbers`）+ 一处基于 `unidiff` 库的解析器（`diff_parsing.py`），三者并存。

### 3.2 怎么映射回文件行号

两条不同的路子，分别服务两个方向：

**方向 A：把 patch 转成带行号的展示**（喂给模型）——`decouple_and_convert_to_hunks_with_lines_numbers`，行号 = `start2 + i`，`i` 是该 hunk 内 `__new hunk__` 段的序号（`+` 行和 ` ` 行都计数，`-` 行不计）。

**方向 B：把模型报的「某行源码文本」映射回行号**（发内联评论）——两个实现：
- provider 内的 `find_in_file`（`gitlab_provider.py:1327`）：逐行扫，`-` 行只推进 old，`+` 行只推进 new，` ` 行两边都推进。
- 通用版 `find_line_number_of_relevant_line_in_file`（`utils.py:1593-1677`）：返回 `(position, absolute_position)` 二元组。`position` 是「在 patch 字符串里的第几行」，`absolute_position` 是「文件里的绝对行号」= `start2 + delta - 1`，`delta` 是非 `-` 行的累计计数。匹配策略是四级递降：
  1. `difflib.get_close_matches(relevant_line, patch_lines, n=3, cutoff=0.93)`，唯一命中且以 `+` 开头就用它
  2. 精确相等（`line == target` 或 `line[1:] == target`）
  3. 子串包含（`target in line`）
  4. 模型给的行以 `+` 开头但其实是上下文行 → 去掉 `+` 再找一遍

这套「靠文本找行号」的做法很脏，但它解决了一个真问题：**LLM 报的行号不可靠，报的代码文本相对可靠**。

### 3.3 重命名

- `FilePatchInfo.old_filename` 只在重命名时非空（GitLab：`None if diff['old_path'] == diff['new_path'] else diff['old_path']`）。
- 压缩时 `EDIT_TYPE.RENAMED` 和 `MODIFIED` 合并处理（`pr_processing.py:114`，都进 `MORE_MODIFIED_FILES_` 清单）。
- 内联评论的 `old_path` 用 `old_filename or filename`（`gitlab_provider.py:1110`）——GitLab 的 position 要求两个路径都给。
- `diff_parsing.py:38-47`：`pf.is_rename` → `EDIT_TYPE.RENAMED`，`old_filename = _strip_prefix(pf.source_file)`。

### 3.4 二进制文件

三道防线：
1. `is_valid_file()` 的 `bad_extensions` 名单（后缀级，`language_handler.py:16-39`）。
2. `parse_unified_diff()` 里 `if pf.is_binary_file: continue`（`diff_parsing.py:31-33`），依赖 `unidiff` 库判断。
3. provider 层：patch 为空且拿不到内容时 `load_large_diff` 会返回 `''`，下游 `if not patch: continue` 跳过。

没有用文件内容嗅探（比如查 NUL 字节）——纯靠后缀 + `unidiff` 的 `is_binary_file`。

### 3.5 patch 缺失时自己造一个

`load_large_diff()`（`utils.py:891-909`）：provider 没给 patch（GitLab 对超大文件会省略 `diff` 字段）时，用 `difflib.unified_diff(base.splitlines(keepends=True), head.splitlines(keepends=True))` 现场生成，再用 `to_hunk_only_patch()` 剥掉 `---`/`+++` 文件头。

`to_hunk_only_patch()`（`git_patch_processing.py:16-27`）：找到第一个 `@@` 开头的行，返回从那里开始的部分；没有 hunk（纯重命名）返回 `''`。docstring 说明了理由：下游会把 `---`/`+++` 当成源码行处理。

### 3.6 反向还原 base 文件

`reconstruct_base_file(head_file_str, patch_str)`（`diff_parsing.py:62-105`）：只有 head 内容 + patch 时，反向 apply 出 base 内容。逐 hunk 走，context 行和 added 行都要跟 head 逐字校验，对不上直接 `return ""`（宁可放弃也不产出错误的 base）。末尾换行处理得很仔细：空 base 必须保持 `""`，否则 `extend_patch()` 会误以为有原文件。

### 3.7 怎么判断一个文件值不值得看

按执行顺序，五道闸：

1. **`ignore.regex` / `ignore.glob` / `ignore_language_framework`**（`file_filter.py:8`）——用户配置，在 provider 的 `get_diff_files()` 里就执行。
2. **`bad_extensions` + lock 文件 + `.min.js`/`.map` 名单**（`language_handler.py:16`）。
3. **`MAX_FILES_ALLOWED_FULL = 50`**——不是丢弃文件，是**不再拉全文**，后果是这些文件没法做上下文扩展。
4. **deletion-only hunk 丢弃 / 整文件删除只留文件名**（`handle_patch_deletions`）。
5. **token 预算装箱**（`generate_full_patch`）。

值得注意的是：**没有任何一步是基于「改动的语义重要性」判断的**。没有「配置文件改动优先级低」「测试文件优先级低」这类规则，也没有基于路径的 CODEOWNERS 式加权。全部是「格式 → 大小」两个维度。

---

## 4. 「一个 tool 尽量只做一次 LLM 调用」的取舍

这条约束在源码里有一处直白的自述，`pr_agent/algo/skills_loader.py:25-35`：

> The agent-skills standard supports bundled files for progressive disclosure: `references/` (markdown context loaded on demand), `scripts/` (executables the agent can invoke), and `assets/`. **PR-Agent runs single-shot model calls and has no tool-use loop, so progressive disclosure is not implementable here.** Instead, this loader inlines every text resource directly into the prompt. […] Skills that depend on script execution will not work.
> In short, this implementation supports **text-only** agent skills.

也就是说：**没有 tool-use 循环 → 渐进式加载不可能 → 所有上下文必须一次性塞满 prompt → 上下文预算成为死约束 → 才需要 PR Compression**。压缩算法是这条设计约束的直接产物，不是独立的优化。

### 4.1 各 tool 实际的调用次数

| tool | 正常 | 大 PR | 说明 |
|---|---|---|---|
| `/review` | **1** | `max_number_of_calls=3` 并发 + 合并（默认关） | `enable_large_pr_chunking=false` |
| `/describe` | **1** | `max_ai_calls=4`：最多 3 次「只出文件表」+ 1 次「只出标题/摘要」 | `enable_large_pr_handling=true`（默认开） |
| `/improve` | **2**/chunk | `max_number_of_calls=3` chunk × 2 | 每 chunk 一次生成 + 一次**强制**的 self-reflection 打分 |

`/improve` 的 self-reflection 是强制的（`pr_code_suggestions.py:821-829`，注释：`mandatory, since line numbers are generated now here`），失败时所有建议统一给 `score = 7`。另外 `decouple_hunks = false`（默认）时还可能多一次 `convert_to_decoupled_with_line_numbers`（1599-1631，这个其实是纯本地转换，不是 LLM 调用，函数名容易误导）。

所以「一次调用」这条约束**只在 `/review` 上被严格遵守，而且是默认配置下**。`/describe` 和 `/improve` 早就妥协成多次调用了。

### 4.2 妥协的三种形态

**形态一：分块 + 合并（`/review`）**

`pr_reviewer.py:788-839` 的 `_prepare_chunked_prediction()`：
```python
patches_diff_list, remaining = get_pr_multi_diffs(..., max_calls=3, add_line_numbers=True,
                                                  return_remaining_files=True)
if len(patches_diff_list) < 2: return False      # 只有一块就退回单次
predictions = await asyncio.gather(*[self._get_prediction(model, d) for d in patches_diff_list],
                                   return_exceptions=True)
# 逐个解析，失败的 chunk 记账但不中断
self.prediction_data = merge_review_chunks(chunk_outputs)
```

合并规则在 `pr_agent/algo/review_merge.py`，模块 docstring 写得很清楚，三条：
- **「发现了什么」的字段**（key issues、security concerns、TODO、priority files、sub-PR）→ **按 chunk 顺序并集，去重**。
- **「对整个 PR 的判断」的字段**（score、risk level、merge recommendation、review effort、有没有测试）→ **取最保守的那个值**。「合并后的 review 绝不会比它最差的 chunk 更乐观」。具体：`_merge_score` 取最小分（`:108-114`）、`_merge_effort` 取最大值并 clamp 到 1-5（`:96-105`，注释说明「求和会让任何几块的 PR 都饱和到 5，这个字段就失去区分度了」）、`_worst_of(RISK_LEVELS)` / `_worst_of(MERGE_RECOMMENDATIONS)` 取序最靠后的。
- **贡献时间** → 求和（chunk 是对改动的划分）。
- 兜底：匹配不上规则的 key 取第一个非空值，「以后往 prompt 里加字段也不会在合并时消失」。

这套合并规则是我读到的最值得直接抄的部分之一。

**形态二：两阶段 map-reduce（`/describe`）**

`pr_description.py:303-451`。map：每个 chunk 用 `pr_description_only_files_prompts` 只产出文件级表格（`pr_files:` YAML），可并发（`async_ai_calls`，默认开）。reduce：把所有 chunk 的文件表拼起来，用 `pr_description_only_description_prompts` 再跑一次出标题/类型/摘要。

reduce 的输入里还会拼上：
```
No more token budget. Additional unprocessed files:
- a.py
...（封顶 MAX_EXTRA_FILES_TO_PROMPT = 50，超了写 "... and N more"）

Additional deleted files:
- ...
```
然后整体 `clip_tokens` 到 `max_tokens - 1000`。

失败容忍：单个 chunk 失败/YAML 解析失败只记账（`description_failed_chunk_count` / `description_failed_files`），保留成功的部分，全失败才抛。最后 `extend_uncovered_files()`（474-543）把没被任何 chunk 覆盖的文件补进表格，`changes_title: "..."`、`label: "additional files"`，封顶 `MAX_EXTRA_FILES_TO_OUTPUT = 100`，超了加一行 `filename: "Additional files not shown"`。

**形态三：分块 + 并发 + 阈值过滤（`/improve`）**

`pr_code_suggestions.py:1497-1597`。每 chunk 一次生成 + 一次 self-reflection 打分，`parallel_calls=true` 时全部 `asyncio.gather`。结果按 `suggestions_score_threshold`（默认 0）过滤，再 `_limit_suggestions_per_file`（`max_suggestions_per_file`，默认 0=不限）收口。

### 4.3 这条约束带来的实际代价

1. **没有「先看一眼再决定看什么」的能力**。没有 tool-use 循环，就不能让模型说「这个函数的调用方在哪我需要看看」。所有跨文件依赖只能靠碰运气塞进同一个 chunk。
2. **chunk 之间完全无共享状态**。三个 chunk 并发跑，互相不知道对方看到了什么。跨文件的一致性问题（改了接口没改实现）系统性地检测不到。
3. **合并只能做保守的规则合并**，不能做语义去重。两个 chunk 报同一个问题的不同侧面，合并后就是两条重复建议（`review_merge` 的去重是基于文本归一化后的精确匹配，`_normalize_text` 只做空白压缩 + 小写）。
4. **上下文扩展在最需要的时候被关掉**。大 PR → 压缩路径 → 不扩展上下文 → 模型看到的更少 → 误报率上升。AI metadata 同理（1.11）。

---

## 5. 配置系统

### 5.1 Dynaconf 装配与请求级隔离

`pr_agent/config_loader.py`。

- `global_settings = Dynaconf(...)`（第 17-47 行）：**关掉了 Dynaconf 默认的 `core_loaders`（置为 `[]`）**，只启用自定义的 `pr_agent.custom_merge_loader` + `dynaconf.loaders.env_loader`。理由写在第 13 行注释：默认 loader 会重复加载 toml，而且同名 section 是整段覆盖而非字段级合并。
- `load_dotenv=False`，注释标注 `Security: Don't load .env files`。
- `settings_files` 是一个写死顺序的 24 项列表（20-45 行）：`configuration.toml` → `ignore.toml` → `generated_code_ignore.toml` → `language_extensions.toml` → `prompt_fragments.toml` → 各 tool 的 `*_prompts.toml` → `custom_labels.toml` → `.secrets.toml` → `settings_prod/.secrets.toml`。**prompt 是配置的一部分，跟普通配置走同一套加载和覆盖机制**。
- 环境变量（`env_loader` 在 loaders 列表最后）永远是最高优先级层。

**请求级隔离**（`get_settings()`，第 50-63 行）：

```python
def get_settings(use_context=False):
    try:
        return context["settings"]           # starlette_context
    except Exception:
        return global_settings
```

隔离本身不在 config_loader 里，而是各 webhook 入口手动做的：

```python
context["settings"] = copy.deepcopy(global_settings)
```

出现在 `servers/github_app.py:48`、`servers/gitlab_webhook.py:337`、`servers/gitea_app.py:31`、`servers/bitbucket_app.py:373`、`servers/bitbucket_server_webhook.py:150`、`servers/azuredevops_server_webhook.py:290`、`servers/gerrit_server.py:67`。

即：**每个 HTTP 请求 deepcopy 一份全局配置进 starlette_context，该请求内所有 `get_settings()` 拿到的都是这份副本**，仓库配置合并、CLI 参数覆盖都只影响本请求。CLI 模式没有 context，`get_settings()` 落回 `global_settings`，所以 CLI 下仓库配置会直接改到全局单例。

这个方案很简单，但依赖「每个入口都记得 deepcopy」这条人工约定。我们自己做的话应该封装成中间件强制执行。

### 5.2 仓库级覆盖：`.pr_agent.toml`

入口 `apply_repo_settings(pr_url)`（`pr_agent/git_providers/utils.py:226-309`），在 `PRAgent._handle_request` 里每次命令都调一次（`agent/pr_agent.py:210`）。

顺序：
1. `os.environ["AUTO_CAST_FOR_DYNACONF"] = "false"`。
2. **先处理 `config.extra_config_url`**（外部配置 URL，支持 http(s) / file:// / 裸路径，1MB 上限、10s 超时，见 `utils.py:20-21, 43-132`）——**必须在构造 git_provider 之前**，因为 `GitLabProvider.__init__` 要读 `GITLAB.PERSONAL_ACCESS_TOKEN`。
3. 构造 git provider。
4. `config.use_repo_settings_file`（默认 true）→ `git_provider.get_repo_settings()` 拉仓库根目录的 `.pr_agent.toml`。可能返回多个来源（`[("global", ...), ("local", ...)]`），**逐个落成临时文件、逐个合并**，而不是一次性合并——理由写在 276-279 行注释：一个来源出错不该让另一个也失败，而且要能把错误精确归因到 global 还是 local。
5. 解析失败的来源收集进 `config_errors`，最后 `handle_configurations_errors`（384-431）在 PR 上发一条持久化评论，用 `config-errors-{category}` 区分 global/local 避免互相覆盖。

**组织级配置**：GitHub 组织下的 `pr-agent-settings` 仓库、GitLab 命名空间下的同名仓库（`git_provider.py:487` `get_org_wide_settings`，带 TTL 缓存）。这是「组织默认规范 + 仓库微调」两层的现成实现，**对企业内部平台很有参考价值**。

单文件合并的细节（`utils.py:311-376`）里有几条值得抄的工程细节：
- 先 `tomllib.load` 解析并 `validate_file_security(parsed, ".pr_agent.toml")`——**故意传固定字符串而不是真实临时路径**，避免 SecurityError 把服务器文件系统路径泄露到 PR 评论里。
- 合并完立刻 `_reapply_env_overrides()`（重放 `env_loader`），保证「环境变量永远最高优先级」这条契约不被仓库配置打破。
- **日志里永不打印合并后的字典**，只打 section 名——`.pr_agent.toml` 可能含 `openai.key` / `gitlab.personal_access_token`。

### 5.3 仓库能覆盖什么、不能覆盖什么

`pr_agent/config_security.py`，全文 33 行，两张表：

```python
REPO_OVERRIDABLE_KEYS_BY_HOST_SECTION = {          # 白名单模式
    "skills":           frozenset({"enabled", "max_skills_tokens"}),
    "push_outputs":     frozenset(),               # 空集 = 整节禁止
    "prompt_fragments": frozenset(),               # 空集 = 整节禁止
}

REPO_HOST_ONLY_KEYS_BY_SECTION = {                 # 黑名单模式
    "pr_reviewer": frozenset({"publish_error_details"}),
}
```

理由都写在注释里，每一条都是真实攻击面：
- `skills.paths` 指向宿主机文件系统 → 恶意仓库可以让 agent 把 `~/.ssh/*` 当「技能」读进 prompt。
- `push_outputs` 决定 review 数据推到哪个 webhook/slack/文件 → SSRF + 数据外泄 + 任意文件写入。
- `prompt_fragments` 是宿主端渲染进 prompt 的 Jinja 源码 → 允许仓库覆盖等于给了「往系统提示词里塞可执行模板表达式」的入口。
- `pr_reviewer.publish_error_details` 控制是否把内部失败原因暴露在评论里 → PR 作者（可能就是攻击者）不能自己打开。

**⚠️ 需要注意的是：除了这 3 个 section + 1 个 key，其余所有配置（包括 `[config].model`、`[config].git_provider`、`[config].secret_provider`、`[config].extra_config_url`）仓库都可以任意覆盖。** 这不是一个通用的白名单机制，只是针对四类已知高危面打的补丁。企业内部平台**不能照抄这个边界**——至少 `model`、`extra_config_url`、任何 URL 类配置都应该是 host-only。

另有一层独立的加载层校验，`pr_agent/custom_merge_loader.py:103-171` `validate_file_security`：禁止 toml 里出现 `dynaconf_include(s)` / `includes` / `preload(s)` / `dynaconf_merge` / `merge_enabled` / `loaders` / `core_loaders` / `settings_module` / `settings_file(s)_for_dynaconf` / `envvar_prefix_for_dynaconf` 这些 Dynaconf 元指令（每条都给了原因：动态包含任意文件 / 预加载导致代码执行 / 覆盖 loader 导致任意代码执行），嵌套深度 ≤50 防栈溢出，只允许 `.toml`，单文件 ≤100MB。

> 这条经验是普适的：**配置格式本身如果支持 include/loader 之类的元指令，那么「让用户提供配置文件」就等于「让用户执行代码」**。选配置格式的时候要把这点算进去。

### 5.4 Prompt 系统

- 引擎：普通 `jinja2.Environment(undefined=StrictUndefined)`（`pr_reviewer.py:856-858` 等）。StrictUndefined 意味着模板引用了 `vars` 里不存在的变量会直接抛异常——倒逼调用方补全变量。
- **例外**：`pr_agent/algo/prompt_fragments.py:1-14` 的 `render_diff_hunk_format` 用的是 `jinja2.sandbox.SandboxedEnvironment`。这和「`[prompt_fragments]` 整节禁止仓库覆盖」是同一个安全考虑的两面。
- 结构：每个 prompt toml 是一个 `[xxx_prompt]` table，含 `system` 和 `user` 两个多行字符串。`system` 放角色设定 + 输出规范，`user` 放具体 PR 数据。
- **输出 schema 的表达方式**：把 Pydantic class 定义**当纯文本**写进 system prompt（`pr_reviewer_prompts.toml:55-136`），不是真的 import pydantic 做结构化输出。而且字段本身也是 Jinja 条件渲染的——`require_score_review` / `require_risk_assessment` / `require_merge_recommendation` / `require_priority_files` / `require_todo_scan` / `require_can_be_split_review` / `require_estimate_contribution_time_cost` 这些开关直接决定最终「虚拟 schema」长什么样。
- `user` 段固定以 ` ```yaml ` 开口结尾（`pr_reviewer_prompts.toml:366-368`），诱导模型直接续写 YAML 而不是先讲一段开场白。
- **输出格式选 YAML 不是 JSON**。配套的 `load_yaml()`（`algo/utils.py:1034-1071`）+ `try_fix_yaml()`（1075 行起，延伸几百行）是一整套**多级字符串层面的解析自愈**：剥 ```` ```yaml ```` 围栏 → 去掉模型多说的总结语 → 剔除 C0 控制字符 → 把已知 key 的裸值转成 `|` block scalar → `|` 换 `|2` 修缩进 → 修单独一行 `}` 导致的缩进错 → 用 `first_key`/`last_key` 截取片段 → 去掉模型误加的 diff 风格 `+`/`-` 前缀（含「真实 YAML 列表项 vs diff 删除标记」的启发式）→ tab 转空格 → latin-1/utf-8 mojibake 修复。全失败返回 `{}` 并把原始响应记进 artifact 日志。

  **这是纯解析容错，不是重新调 LLM**。真正的 LLM 重试在 `ai_handlers/litellm_ai_handler.py` 用 tenacity 做，只针对 API 异常（超时/限流），YAML 解析失败**不会**触发重新生成。

  > 这一整套 `try_fix_yaml` 是「用 YAML 做结构化输出」的必然代价。我们如果用支持 structured output / tool use 的模型，这几百行可以整个不要。

### 5.5 团队自定义规范的四个注入口

| 机制 | 位置 | 仓库可控 | 说明 |
|---|---|---|---|
| `extra_instructions` | 各 `[pr_xxx]` section | ✅ 完全可覆盖 | 自由文本，直接拼进 system prompt（`{%- if extra_instructions %}`） |
| Agent Skills | `[skills]`，`algo/skills_loader.py` | ⚠️ 只能开关 + 调预算，`paths` 是 host-only | 宿主维护的技能库 |
| repo context | `config.repo_context_files`，`algo/repo_context.py` | ✅ | 默认读 `AGENTS.md` |
| custom labels | `[custom_labels]`，`algo/utils.py:1324-1345` | ✅ | 自定义 PR 分类标签 |

**Agent Skills**（`algo/skills_loader.py`，359 行）值得细看：
- 约定：一个目录含 `SKILL.md`，头部 YAML frontmatter（`name` / `description`），正文是自由文本评审指南。
- **激活方式是「全量注入」而不是检索**：「every discovered skill is included with its name, description, and body. The model decides which guidance applies based on the descriptions.」——不是 RAG，是把所有技能都塞进 system prompt 让模型自己挑。
- `SKILL.md` 同目录及子目录下所有 `*.md`（含 `references/`）一并内联；`scripts/` 和 `assets/` 显式排除，因为没有 tool-use 循环（见第 4 节）。
- token 预算 `skills.max_skills_tokens = 8000`，超了截断并记日志。
- 请求级缓存：同一请求内 review/improve/describe 共享一次发现+格式化结果。

**repo context**（`algo/repo_context.py`，310 行）：
- `config.repo_context_files = ["AGENTS.md"]`（默认）、`repo_context_from_default_branch = true`（**默认只信任默认分支上的内容**，防止 PR 分支临时改指令文件来越狱模型）、`repo_context_max_lines = 500`。
- 两级缓存（进程级 256 条 / 15 分钟 TTL + per-provider 缓存），渲染成 `<instruction_files>` XML 风格文本，超预算插 `...(truncated)...`。

**`[best_practices]` / `[auto_best_practices]` 是死配置**。`configuration.toml:527-539` 里有完整的 section，但全仓库 grep `.py` 只有一处引用：`pr_code_suggestions.py:187` 的 `"relevant_best_practices": ""`，而且**没有任何 prompt 模板引用 `relevant_best_practices` 这个变量**。也就是说「团队最佳实践文件」这个功能在当前开源版里只剩配置壳，实现已经被抽掉了。ticket 里如果看到 PR-Agent 文档提这个功能，**不要当真**。

顺带：全仓库搜不到任何 `qodo` / `enterprise` 的功能门禁。`config.is_auto_command` 只是「是否自动触发」的普通标志，不是企业版开关。

---

## 6. 评论发布

### 6.1 持久评论：编辑而非重发

`git_provider.py:601-716`，三段：

`publish_persistent_comment()`（601-624）→ 先看 `supports_comment_editing()`（592-599，**判定依据是子类有没有覆盖 `edit_comment`**），不支持就退化成 `publish_comment()` 永远发新的；支持则走 `publish_persistent_comment_full()`。

`publish_persistent_comment_full()`（655-716）：

1. 打隐藏身份标记：`add_comment_identity()`（`algo/utils.py:193-200`）把 HTML 注释插到可见标题之后：

   ```python
   heading, separator, remainder = pr_comment.partition("\n\n")
   return f"{heading}\n\n{identity_marker}\n\n{remainder}"
   ```

   标记定义在 `algo/utils.py:86-98`：
   ```python
   class PRReviewIdentity(str, Enum):
       REGULAR     = "<!-- pr-agent:review:full -->"
       INCREMENTAL = "<!-- pr-agent:review:incremental -->"
   class PRCodeSuggestionsIdentity(str, Enum):
       SUMMARY        = "<!-- pr-agent:improve:summary -->"
       NO_SUGGESTIONS = "<!-- pr-agent:improve:no-suggestions -->"
       UNANCHORED     = "<!-- pr-agent:improve:unanchored -->"
   ```

2. 在历史评论里按「身份优先、时间倒序」找匹配（`_iter_persistent_comments`，634-653）。匹配规则 `comment_matches_identity()`（`utils.py:159-168`）很讲究：

   ```python
   if identity.startswith("<!--"):
       return any(line.strip() == identity
                  for line in body.splitlines()[:5])    # _REVIEW_IDENTITY_HEADER_LINES = 5
   return body.startswith(identity)                     # legacy 可见标题前缀，兼容旧版本
   ```

   **只在前 5 行做整行精确匹配**——防止评论正文里引用了 marker 语法造成误判。另有 `comment_carries_other_identity()`（175-181）防止把 review 摘要和 suggestions 摘要认错。

3. 找到 → `self.edit_comment(comment, updated)` **原地编辑**。`update_header=True` 时在标题后插一行 `#### (Review updated until commit <latest_commit_url>)`。
4. `final_update_message`（默认 true，`configuration.toml:143`）→ 编辑完**额外**发一条极短的通知评论 `**[Persistent review](url)** updated to latest commit ...`。**设成 false 就完全零新评论**。这是唯一会追加内容的分支，且它失败会被吞掉（编辑本身已成功）。
5. `as_thread=True`（GitLab）→ 编辑后调 `unresolve_comment_thread(comment)`，把人工 resolve 掉的线程重新打开，避免新一轮 review 被「沉默」在旧线程里。
6. 找不到，或编辑抛异常 → 兜底 `publish_comment()` 发新的。

GitHub 侧还叠了一层作者校验：`is_comment_authored_by_pr_agent`（`github_provider.py:472-527`，通过 `_agent_login()` / `_resolve_app_login()` / `_resolve_user_login()` 比登录名），读状态时要求 `require_agent_authorship=True`——**防止别人伪造 marker 篡改状态**。

### 6.2 Finding 级状态机（跨轮次跟踪）

`pr_agent/algo/review_finding_state.py`。比「整段编辑评论」细一级：跟踪每条 `key_issues_to_review` 的生命周期。

**指纹**（`normalize_finding`，54-98）：

```python
finding_id = key_issue_fingerprint(path, _WHITESPACE_RE.sub(" ", body).lower())
# key_issue_fingerprint(file, body) = sha256(f"{file}|{body}")[:12]
```

**指纹只含「文件路径 + 归一化后的问题描述文本」，不含行号、不含 commit sha**。这是它能扛住 force-push / 新 commit 插入行的关键：只要问题描述没变，`finding_id` 就稳定。`line_start` / `line_end` 单独存在 normalized dict 里，但不参与指纹。

**状态存在哪**：**评论正文里**，没有数据库、没有本地文件、没有 provider 专有 API。

```python
def serialize_review_state(state):
    payload = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    # HTML 注释在第一个 "-->" 或 "--!>" 处结束，而 finding 会引用 diff 里的任意内容
    payload = payload.replace("-->", "--\\u003e").replace("--!>", "--!\\u003e")
    return f"<!-- pr-agent-review-state:v{STATE_SCHEMA_VERSION}\n{payload}\n-->"
```

`sort_keys=True` 是为了「重复更新时 diff 可读」。转义 `-->` 是因为 finding 正文会引用 diff 内容——**这个坑不踩一次想不到**。

读回来时校验极严（`_is_valid_state`，111-133）：schema_version 必须匹配、`finding_id` 不可重复、state 必须是 `ACTIVE`/`RESOLVED` 之一。任何畸形判为 `present=True, valid=False`，触发降级。

**协调逻辑**（`reconcile_review_findings`，189-286）：
- 本轮仍报告的 finding：之前是 `RESOLVED` → 标 `reopened_at` / `reopened_count += 1`；否则只更新 `last_seen`。
- 之前有、本轮没报的：**只有 `allow_resolution=True` 才标 `RESOLVED`**，否则原样保留。
- `allow_resolution` 的判定（`pr_reviewer.py:727-739`）要求全部满足：
  - 这次真的出了 prediction
  - 不是增量 review
  - **没有失败的 chunk**（`review_failed_chunk_count == 0`）
  - **没有因 token 预算被挤掉的文件**（`remaining_files_list` 为空）
  - 上一轮状态解析有效
  - **没有因为 `num_max_findings` 上限被截断**（`len(current_findings) < max_findings`，且 `dropped_findings` 为 False）

  > 这段逻辑是整个仓库里我最欣赏的一处。它把「这次没看到」和「问题解决了」**严格区分开**。任何一种「这次看得不全」都会让它退回「只增不减」。企业内部平台必须有这条，否则「AI 说问题已修复」会变成灾难。
- `RESOLVED` 的 finding 渲染进一个折叠的 `<details><summary>✅ Resolved findings</summary>` 区块，且只保留最近 `max_resolved_findings = 20`（`_retained_findings`，170-186）防止评论无限膨胀。

### 6.3 行内评论去重

`pr_agent/algo/inline_comment_dedup.py`。解决「同一条建议每次运行都重发」。**默认关**（`config.persistent_inline_comments = false`，`configuration.toml:63`），只对 GitHub / GitLab / Azure DevOps 生效。

两种指纹，**OR 匹配**：

```python
def _body_fingerprint(file, line_no, body, max_chars):
    s = _LEAD_RE.sub("", _strip_markers(body))       # 剥已有 marker、"**Suggestion:**" 前缀
    s = _TAG_RE.sub("", s)                           # 剥 "[category, importance: N]"
    s = _WS_RE.sub(" ", s).strip().lower()
    if max_chars is not None: s = s[:max_chars]      # body_fingerprint 取前 80 字符
    return sha256(f"{file}|{line_no}|{s}").hexdigest()[:12]

def code_fingerprint(file, line_no, body):           # 只对第一个 ```suggestion 代码块
    code = _WS_RE.sub(" ", match.group(1)).strip()   # 不 lower！代码大小写敏感
    return sha256(f"{file}|{line_no}|code|{code}").hexdigest()[:12]
```

`github_provider.py:707-717` 的注释说明了 OR 语义的目的：同时捕获「同一 bug、措辞不同」和「同一措辞、代码微调」两种 LLM 重复输出。

**抗 force-push**：指纹不含 commit sha。GitHub 侧更激进，直接传 `target_line_no=None`（`github_provider.py:687-689`，注释：GitHub committable comment 的 position 会随新 commit 漂移，索性不把行号纳入指纹，只靠文件 + 内容锚定）。GitLab 侧按编辑类型选 `source_line_no` / `target_line_no`。

**状态存哪**：同样没有本地存储，`InlineCommentStore`（206-267）懒加载扫 provider 上已有评论正文里嵌的 marker，进程内缓存一次。GitHub 拉 `pr.get_comments()`；GitLab 拉 `discussions` + `notes` + **`draft_notes`**（连没发布的草稿也扫，防止上一轮 bulk_publish 失败后重复建草稿）。任何 provider 未实现就抛 `NotImplementedError`，调用方捕获后**退化为「仅本轮内去重」**——去重故障从不阻断发布主流程。

### 6.4 已解决 / 过期评论

- **人工 resolve 的持久 review 线程**：GitLab 会在编辑后重新打开（`unresolve_comment_thread`，`gitlab_provider.py:975-988`）；GitHub 没有覆写（基类 no-op），所以 GitHub 上人工 resolve 后再跑不会自动重开。**行为不一致**。
- **过期的行内线程**：GitLab 独有的 `resolve_outdated_inline_threads()`（`gitlab_provider.py:1009-1048`），默认关（`gitlab.resolve_outdated_inline_threads = false`）。判定条件（`_is_outdated_own_inline_thread`，74-92）：未被人工 resolve + `position_type == 'text'` + `position.head_sha != 当前 MR head_sha` + body 判定是自己发的 + **线程里所有非系统 note 的作者都是机器人自己**（有人回复过就跳过，保护人工讨论）。命中则 `discussion.resolved = True`，**并把该线程的指纹从 `InlineCommentStore` 里 `release()`**，让下一轮同样内容的建议能在新位置重新发一条。这个清理在 `publish_code_suggestions()` 开头就跑，确保指纹释放先于本轮去重判断。
- **两套「已解决」互不驱动**：`review_finding_state` 的 `RESOLVED`（LLM 本轮没再报）和平台层面的 thread resolved（人点的）是两个独立概念，代码里没有任何桥接。
- `/ask_line` 有个可选的「AI 判断问题已解决就 resolve 线程」开关，`pr_line_questions.resolve_threads = false`，默认关，注释说明**也会误 resolve 人工发起的线程**。

### 6.5 摘要 vs 行内的 fallback 链

**`/review`**：主输出永远是一条摘要评论（走 6.1 的持久编辑），行内评论是附加的、可选的、失败会回落到摘要。

- 开关 `pr_reviewer.inline_key_issues`，**默认 false**（`configuration.toml:140`）。
- 完整链路 `_publish_key_issues_as_inline_comments()`（`pr_reviewer.py:1068-1156`）：
  1. 要求 provider 同时实现 `get_persistent_comment_bodies` 和 `get_recent_inline_comment_bodies`——**目前只有 Azure DevOps 满足**，其余 provider 整批放弃、全部留在摘要里。
  2. 逐条校验能否定位（文件必须在 diff 里、行号必须落在 `head_file` 范围内），定位失败 → 该 issue 留在摘要（日志明确写 `keeping it in the summary`）。
  3. 定位成功但指纹命中 → 计为已发布但不重发。
  4. 批量发布；发布异常，或事后核验发现没真正落地 → 退回 `remaining_issues`，仍出现在摘要里。
  5. **只有核验成功的 issue 才从 `key_issues_to_review` 里移除**——摘要始终兜底，永不因行内发布失败丢 finding。

**`/improve`**：由 `commitable_code_suggestions`（默认 false）决定：
- false → `generate_summarized_suggestions()` 出一张表，走持久评论 + 最多 `max_history_len = 4` 条折叠的历史版本。纯摘要无行内。
- true → `push_inline_code_suggestions()`（1043-1141）：校验 `is_applicable` / `has_valid_anchor`；建议代码被截断或 Python 语法校验失败 → `requires_pr_fallback=True`；锚定失败或需要 fallback 且 provider 不支持 artifact → 降级成**纯文本 PR 评论**（附 `Location: file:start-end` 供人工定位）；批量发布失败 → 逐条重试；最后所有 fallback 拼成**一条**评论一次性发出。

两个工具的 fallback 方向一致：**优先行内，行内失败必然回落到一条聚合评论，从不静默丢弃**。这条原则应该直接抄。

### 6.6 进度评论

`pr_agent/tools/progress_comment.py`，很薄：`build_progress_comment()` 拼出 `"## Generating PR code suggestions\n\nWork in progress ...<br><img src=... width=...>"`，GIF 地址/宽度可配（`config.progress_gif_url` / `progress_gif_width`）。关键在于这条占位评论后续**被编辑覆盖成最终结果**而不是删掉重发（`pr_code_suggestions.py:365-369` 的 `_edit_comment_safely` 复用 `self.progress_response`），避免「进度评论 + 结果评论」两条并存。仅当编辑失败才退化为发新评论 + 删进度评论。

### 6.7 增量 review（`/review -i`）

- `IncrementalPR`（`git_provider.py:917-930`）只是数据容器。
- **区间怎么定**（GitHub，`github_provider.py:196-235`）：在 issue comments 里倒序找**上一条带 review 身份标记的评论**，用它的 `created_at` 时间戳，从 PR 全部 commits 倒序扫，`commit.author.date > last_review_time` 的算新 commit。即**按上次 review 评论的发布时间切分 commit 时间线**，而不是记录 commit sha 区间。找不到旧 review 评论就退化为全量。
- 二次把关（`pr_reviewer._can_run_incremental_review()`，1188-1229）：自动模式下没新 commit 直接放弃；另有 `minimal_commits_for_incremental_review`（默认 0）和 `minimal_minutes_for_incremental_review`（默认 0，判断「最后看到的 commit 是不是太新，可能还在连续 push」），`require_all_thresholds_for_incremental_review` 决定 any 还是 all。
- 呈现只加一行 `Starting from commit {last_commit_url}`，不做 diff 展示优化；但 `get_files()` 只返回 `commits_range` 内变更过的文件，所以 diff 范围是真的收窄了。
- **增量 review 永不走持久编辑路径**（`pr_reviewer.py:374` 显式排除），每次新发一条，只打 `INCREMENTAL` 身份标记供下次识别。防刷屏靠「有新 commit 才触发」那道阈值闸门，不靠编辑复用。

> 「用评论时间戳切 commit 区间」这个做法很脆：评论时间 ≠ review 实际看到的 head sha，并发/重跑会错位。我们自己做应该直接把 head sha 记进状态 marker（`review_finding_state` 里其实已经存了 `head_sha`，但增量 review 没用它）。

---

## 7. 对我们的启示

### 7.1 能直接搬的

1. **`FilePatchInfo` 这个单一数据结构 + provider 只负责填充它**。整个压缩算法、diff 解析、行号映射都只依赖这一个 dataclass，provider 换成 GitLab / Gitea / 自研什么都不影响。这是最值钱的一条架构决策。
2. **能力位（capability flags）机制**。provider 之间能力差异巨大（GitLab 没有批量内联评论、没有原生多行 position），与其在 tool 里写 `if isinstance(provider, GitLabProvider)`，不如让 provider 自报能力、tool 按能力降级。但**只留一套查询方式**，不要像它那样 bool 方法和字符串 key 并存。
3. **`__new hunk__` / `__old hunk__` + 绝对行号的 diff 呈现格式**。这是让 LLM 能报出准确行号的关键，而且 `__old hunk__` 不带行号省了可观的 token。格式说明（`prompt_fragments.toml`）和格式生成（`decouple_and_convert_to_hunks_with_lines_numbers`）应该**放在一起**或者由同一份定义生成，不要像它那样分成两处人工同步。
4. **`allow_resolution` 的六个前置条件**（6.2）。把「这次没看到」和「问题解决了」严格区分，任何一种「看得不全」都退回只增不减。这条不抄会出事。
5. **状态存在评论正文的隐藏 HTML 注释里**。零外部依赖、跟着 PR 走、平台迁移不丢。配套的细节要一起抄：`sort_keys=True` 让 diff 可读、转义 `-->` 和 `--!>`、schema_version、严格校验后降级而非崩溃、resolved 列表封顶 20 条。
6. **指纹不含行号和 commit sha**，只含文件路径 + 归一化文本。这是抗 force-push 的关键。GitHub 那边连行号都不要的做法值得考虑。
7. **body 指纹 + code 指纹 OR 匹配**。分别覆盖「同一 bug 措辞不同」和「同一措辞代码微调」。
8. **「优先行内，失败必然回落到聚合评论，从不静默丢弃」** 这条 fallback 原则，以及「只有核验成功才从摘要移除」。
9. **持久评论的身份标记方案**：隐藏 HTML 注释 + **只在前 5 行做整行精确匹配** + 兼容旧版可见标题前缀 + 作者身份二次校验。
10. **`review_merge.py` 的三条合并规则**：发现类字段并集去重、判断类字段取最保守值、工作量类字段求和、未知字段取第一个非空。分块 review 迟早要做，这套规则可以原样用。
11. **进度评论被编辑覆盖成最终结果**，不是删掉重发。
12. **组织级配置仓库 + 仓库级 `.pr_agent.toml` 两层覆盖**，以及「多来源分别落盘分别合并、错误精确归因、失败在 PR 上留言」的做法。
13. **配置安全的几条具体教训**：错误信息里用固定文件名不用真实路径；合并后重放环境变量层；日志只打 section 名不打内容；禁止配置格式里的 include/loader 元指令。
14. **`check_if_hunk_lines_matches_to_file`**——扩展上下文前先验证 hunk 头对不对得上原文件，对不上就不扩展。这是踩过坑的代码。
15. **`repo_context_from_default_branch = true`**——仓库内的指令文件默认从默认分支读，不从 PR 分支读。防越狱，成本为零。

### 7.2 不适用 / 要改的

1. **「大文件优先」的排序必须改掉。** `sorted(files, key=lambda x: x.tokens, reverse=True)` 会让一个巨型生成文件吃光预算。企业内部 PR 里这种文件（proto 生成、migration、快照测试）非常多。应该改成**按「值得看的程度」排序**：手写代码 > 配置 > 测试 > 生成物；核心模块 > 边缘模块（可以用 CODEOWNERS 或目录权重）；小而密的改动优先于大而稀的改动。至少也该是升序（小文件优先，先保证覆盖面）。
2. **文件粒度的取舍太粗。** 源码里那个 TODO（`pr_processing.py:270-271`）指出的方向是对的：**应该做 hunk 粒度的降级**。一个 2000 行的文件里可能只有 3 个 hunk 值得看。我们应该实现「文件放不下 → 按 hunk 打分 → 保留高分 hunk + 其余折叠成摘要」这条路，而不是整个文件丢掉。
3. **32k 的 `max_model_tokens` 默认值是 2023 年的遗产。** 这个值在今天没有意义。但它背后的直觉——「输入越长模型质量越差」——**在今天仍然部分成立**，尤其是「大海捞针」类任务。我们应该实测自己用的模型在多长输入下 review 质量开始掉，而不是照抄 32k，也不是无脑塞满 1M。
4. **「一次 LLM 调用」这条约束我们不该继承。** PR-Agent 的整个压缩算法是这条约束的产物。我们如果做 agent runtime（有 tool-use 循环），完全可以换成「先看文件清单 → 决定看哪些 → 按需拉取上下文」，压缩问题从「怎么把所有东西塞进去」变成「怎么决定看什么」。这是本质区别，也是 ticket 里「不要拿 PR-Agent 当核心 runtime」这个结论的技术依据。
   - 但**压缩算法本身仍然有用**：作为 agent 每一步「拉取一批 diff」的子程序，或者作为没有 tool-use 时的降级路径。
5. **`config_security.py` 的边界不能照抄。** 它只挡了四类已知高危面，`[config].model`、`extra_config_url` 这些仓库都能随便改。企业内部平台应该反过来做：**默认全部 host-only，显式列出仓库可覆盖的 key**。
6. **GitLab 的分页全部 `get_all=True`、零限流处理**。自托管 GitLab + 大 MR + 长讨论历史，这会直接打爆。必须自己做分页 + 退避。
7. **`MAX_FILES_ALLOWED_FULL = 50` 是一条隐性降级**，超过 50 个文件后不再拉全文，导致上下文扩展静默失效。这个阈值应该可配，并且失效时要在日志/输出里显式说明。
8. **YAML + `try_fix_yaml` 几百行的解析自愈**。如果我们用支持 structured output / tool use 的模型，这整块可以不要。不要为了「模型兼容性」把这个技术债背过来。
9. **GitLab 的多行内联评论是真缺口**。它只能靠 ```` ```suggestion:-0+N ```` 覆盖多行，而且只对可提交建议有效。如果我们的 review 需要「这一段 5 行有问题」这种定位，得自己调 GitLab 的 discussion `position.line_range` API（PR-Agent **完全没用这个字段**，说明这条路它没走通或者没做）。这块需要单独验证——建议归到 ticket 07（GitLab MR API 能力边界）。
10. **增量 review 用评论时间戳切 commit 区间**，脆且不准。我们应该把 head sha 存进状态 marker 并据此切分。

### 7.3 它没解决好的

1. **跨文件 / 跨 chunk 的一致性问题检测不到。** 三个 chunk 并发跑，互相不知道对方看到了什么。改了接口没改所有调用方这类问题，系统性漏检。这是「无状态分块 + 并发」的固有缺陷，也是我们做 agent runtime 最大的差异化空间。
2. **合并只能做保守的规则合并，不能做语义去重。** `review_merge` 的去重是文本归一化后的精确匹配（`_normalize_text` 只压空白 + 小写），两个 chunk 报同一问题的不同侧面就是两条重复建议。
3. **越是大 PR，给模型的信息越少。** 压缩路径下上下文扩展被整个关掉、AI metadata 的注入被注释掉（`pr_processing.py:200-202`）。这是反向优化——大 PR 本来就更需要上下文。
4. **单文件超预算时两条路径行为不一致。** `get_pr_diff` 只能整个跳过，`get_pr_multi_diffs` 才读 `large_patch_policy` 做 clip。同一个配置项在不同 tool 上行为不同。
5. **`clip_tokens` 是按字符比例估算的**，乘 0.9 兜底，不是精确按 token 切。在 CJK 内容上这个估算会明显偏差（中文的 chars_per_token 跟英文差好几倍）。**我们做中文 code review 平台，这块得自己实现。**
6. **「什么文件值得看」完全没有语义判断。** 只有格式（后缀名 / lock 文件）和大小两个维度，没有「测试文件优先级低」「配置文件改动风险高」「这个目录是核心模块」这类规则。这恰好是企业内部平台最有条件做好的地方——我们知道自己的代码库结构。
7. **`best_practices` / `auto_best_practices` 是死配置**，功能已被抽走。团队规范注入实际只剩 `extra_instructions`（自由文本）、Agent Skills（宿主维护，全量注入不检索）、`AGENTS.md`（单文件）三条路。**「规范怎么组织、怎么按 PR 选取相关规范」这个问题 PR-Agent 完全没解决**——Skills 是「全塞进去让模型自己挑」，8000 token 封顶。这正是 ticket 12（大 PR 的递归拆分与动态规范选取）和 ticket 11（规范的领域模型与生命周期）要解决的问题，PR-Agent 这里没有可抄的东西。
8. **两套「已解决」概念不互通**：LLM 判断的 `RESOLVED` 和人工 resolve 的 thread 之间没有任何桥接。人工 resolve 了一个线程，下一轮 AI 还是会重新报（除非指纹命中去重）；AI 标了 RESOLVED，平台上的线程也不会自动关。
9. **GitHub / GitLab 行为不一致的地方很多**（人工 resolve 后是否重开、能否批量发内联评论、能否真多行定位、行内 key issues 只有 Azure DevOps 能用）。抽象没有真正统一行为，只是让代码能跑。我们只对接 GitLab，反而可以做得更彻底。

---

## 附：值得优先精读的源码清单

按投入产出比排序：

| 文件 | 行数 | 为什么 |
|---|---|---|
| `pr_agent/algo/pr_processing.py` | 580 | 压缩算法全部在这 |
| `pr_agent/algo/git_patch_processing.py` | 508 | diff 解析 + 上下文扩展 |
| `pr_agent/algo/review_finding_state.py` | 356 | 跨轮次状态机，设计最精细 |
| `pr_agent/algo/review_merge.py` | 318 | 分块合并规则 |
| `pr_agent/algo/inline_comment_dedup.py` | 276 | 指纹去重 |
| `pr_agent/git_providers/git_provider.py` | 930 | 基类切面 + 持久评论 |
| `pr_agent/config_security.py` | 33 | 33 行，全是踩过的坑 |
| `pr_agent/settings/prompt_fragments.toml` | 57 | diff 呈现格式的完整说明 |
