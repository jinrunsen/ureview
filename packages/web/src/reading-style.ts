/** 解读正文在 Shadow DOM 内使用的宿主样式，导出的 HTML 也用它；模型只能使用这里定义的类名。 */
export const readingDocumentStyle = `
:host { display: block; color: var(--foreground, #253a36); font-size: 14px; line-height: 1.8; }
* { box-sizing: border-box; }
article { min-width: 0; overflow-wrap: anywhere; }
section.doc-section { padding-top: 34px; scroll-margin-top: 88px; outline: none; }
section.doc-section:first-child { padding-top: 6px; }
.doc-kicker { margin: 0 0 6px; color: var(--accent, #28816f); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
h2.doc-title { margin: 0 0 14px; font-size: 19px; line-height: 1.5; font-weight: 650; }
h3 { font-size: 15px; margin: 22px 0 8px; }
h4, h5 { font-size: 14px; margin: 16px 0 6px; }
p { margin: 8px 0; }
ul, ol { padding-left: 22px; margin: 8px 0; }
li { margin: 3px 0; }
code { font: 12.5px/1.6 "SFMono-Regular", Consolas, monospace; background: var(--surface-subtle, #f1f5f3); padding: 1px 5px; border-radius: 4px; }
pre { margin: 10px 0; padding: 12px; background: var(--surface-subtle, #f1f5f3); border: 1px solid var(--border, #e2eae6); border-radius: 6px; overflow-x: auto; font-size: 12px; }
pre code { padding: 0; background: none; }
blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid var(--border, #e2eae6); color: var(--muted, #6e817b); }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border, #e2eae6); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--surface-subtle, #f1f5f3); font-weight: 600; }
details { margin: 8px 0; } summary { cursor: pointer; color: var(--muted, #6e817b); }
figure { margin: 14px 0; } figcaption { color: var(--muted, #6e817b); font-size: 12.5px; margin-top: 6px; }
mark { background: #fbefc9; padding: 0 2px; }
small, .muted { color: var(--muted, #6e817b); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.badge { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 12px; line-height: 20px; background: var(--surface-subtle, #f1f5f3); }
.badge.ok { background: #e3f2e8; color: #2e7d4f; } .badge.warn { background: #faefd6; color: #8a5d0c; } .badge.bad { background: #fae3e0; color: #b3362b; }
svg { max-width: 100%; height: auto; display: block; margin: 12px auto; }
svg rect, svg circle, svg ellipse, svg polygon { fill: var(--surface, #fff); stroke: #8b9b95; stroke-width: 1.2; }
svg line, svg polyline, svg path { stroke: #8b9b95; stroke-width: 1.2; fill: none; }
svg marker path, svg marker polygon { fill: #8b9b95; stroke: none; }
svg text { fill: var(--foreground, #253a36); font-family: inherit; font-size: 12px; }
svg .c-text { fill: var(--foreground, #253a36); }
svg .c-ok { fill: #e3f2e8; stroke: #2e7d4f; } svg .c-bad { fill: #fae3e0; stroke: #b3362b; } svg .c-warn { fill: #faefd6; stroke: #9a6a12; }
svg .c-accent { fill: #e8f3ee; stroke: #28816f; } svg .c-muted { fill: #f1f5f3; stroke: #8b9b95; }
svg text.c-ok { fill: #2e7d4f; stroke: none; } svg text.c-bad { fill: #b3362b; stroke: none; } svg text.c-warn { fill: #9a6a12; stroke: none; } svg text.c-accent { fill: #28816f; stroke: none; } svg text.c-muted { fill: #6e817b; stroke: none; }

ur-code, ur-diagram, ur-compare, ur-callout, ur-source { display: block; margin: 14px 0; }
ur-source { padding: 8px 14px; border-left: 3px solid var(--accent, #28816f); background: var(--surface-subtle, #f1f5f3); border-radius: 0 8px 8px 0; }
ur-source .source-head { font-size: 12px; color: var(--muted, #6e817b); }
ur-source .source-quote { border-left: 0; padding-left: 0; margin: 2px 0; color: var(--foreground, #253a36); }
ur-note { display: none; }
.code-head { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: baseline; padding: 8px 12px; background: var(--surface-subtle, #f1f5f3); border: 1px solid var(--border, #e2eae6); border-radius: 6px 6px 0 0; font-size: 12px; }
.code-head .code-path { font: 11.5px "SFMono-Regular", Consolas, monospace; color: var(--muted, #6e817b); }
.code-head .code-title { font-weight: 600; }
.code-link { border: 0; background: none; color: var(--accent, #28816f); font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
.code-link:focus-visible { outline: 2px solid var(--accent, #28816f); outline-offset: 2px; }
.code-body { border: 1px solid var(--border, #e2eae6); border-top: 0; border-radius: 0 0 6px 6px; padding: 8px 0; background: #fafcfb; overflow-x: auto; }
.code-line { display: grid; grid-template-columns: 46px minmax(0, 1fr); align-items: baseline; }
.code-line .num { padding: 0 10px 0 4px; text-align: right; font: 11px/1.85 "SFMono-Regular", Consolas, monospace; color: #8b9b95; user-select: none; }
.code-line > code { display: block; padding: 0 12px 0 0; background: none; white-space: pre; font-size: 12px; line-height: 1.85; border-radius: 0; }
.code-note { grid-column: 2; margin: 3px 12px 8px 0; padding: 6px 10px; border-left: 2px solid #7aaf98; background: #eef5f1; color: #4d665b; font-size: 12.5px; white-space: normal; }
.hljs-comment, .hljs-quote { color: #7b8c83; } .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #92508a; }
.hljs-string, .hljs-regexp, .hljs-attribute { color: #337746; } .hljs-number, .hljs-built_in, .hljs-type { color: #94632d; }
.hljs-title, .hljs-function, .hljs-property { color: #326c99; }
.diagram { padding: 12px; border: 1px solid var(--border, #e2eae6); border-radius: 8px; background: #fff; overflow-x: auto; }
.diagram img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.diagram .status { color: var(--muted, #6e817b); font-size: 12.5px; }
ur-compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
ur-before, ur-after { display: block; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border, #e2eae6); min-width: 0; }
ur-before { background: #fbf5f3; } ur-after { background: #f2f8f5; }
ur-before::before, ur-after::before { content: attr(label); display: block; font-size: 12px; font-weight: 600; color: var(--muted, #6e817b); margin-bottom: 4px; }
ur-callout { padding: 10px 14px; border-radius: 8px; background: #eef5f1; border: 1px solid #cfe3d8; }
ur-callout[tone="warn"] { background: #fdf6e7; border-color: #f0dcae; }
ur-term { border-bottom: 1px dotted var(--accent, #28816f); cursor: help; }
.glossary dt { font-weight: 600; margin-top: 8px; } .glossary dd { margin: 2px 0 0; color: var(--muted, #6e817b); }
`;
