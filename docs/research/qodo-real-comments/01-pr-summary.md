<h3>PR Summary by Qodo</h3>

Bundle dependency-backed library modules with esbuild

<code>✨ Enhancement</code> <code>⚙️ Configuration changes</code> <code>🕐 Less than 10 minutes</code>

<img src="https://www.qodo.ai/wp-content/uploads/2025/11/light-grey-line.svg" height="10%" alt="Grey Divider">

<details>
<summary>AI Description</summary>

<dl>
<dd>
<br/>

><pre>
>• Adds an esbuild utility for producing self-contained CommonJS library artifacts.
>• Targets Node.js 20 while externalizing built-in modules.
>• Enables installation without npm dependencies at the target.
></pre>

</dd>
</dl>

</details>

<details>
<summary>Diagram</summary>

<dl>
<dd>

<br/>

```mermaid
graph TD
  SRC["Library Sources"] -->|"allowlisted entry"| SCRIPT["Build Script"] -->|"build request"| ESBUILD["esbuild"] -->|"Node 20 CJS"| DIST["Bundled Output"]
```

</dd>
</dl>

</details>




<details>
<summary>High-Level Assessment</summary>

<dl>
<dd>

<br/>

>The following are alternative approaches to this PR:

<details>
<summary><b>1. Automatic dependency discovery</b></summary>

<dl>
<dd>

- ➕ Avoids manually maintaining the module allowlist
- ➕ Scales as more library modules acquire npm dependencies
- ➖ Requires dependency-graph analysis or broader bundling
- ➖ May unintentionally bundle modules intended to remain source-only

</dd>
</dl>

</details>

<details>
<summary><b>2. Bundle the complete CLI</b></summary>

<dl>
<dd>

- ➕ Produces one deployable artifact
- ➕ Eliminates per-module bundling decisions
- ➖ Creates a larger artifact
- ➖ Changes module boundaries and may complicate testing or dynamic resolution

</dd>
</dl>

</details>

>**Recommendation:** The explicit allowlist is appropriate while only a small, controlled set of modules requires bundling. Before relying on it for releases, expose the script through package.json, invoke it during prepublish, and confirm the installer selects dist artifacts; otherwise the new utility remains a manual build step.

</dd>
</dl>

</details>

<details>
<summary> Files changed (1) <code> +49 / -0 </code> </summary>

<dl>
<dd>

<br/>

<details>
<summary>Other (1) <code> +49 / -0 </code></summary>

<dl>
<dd>

<details>
<summary>build-lib.js<code>Add esbuild pipeline for dependency-backed library modules</code> <code>+49/-0</code></summary>

<br/>

>Add esbuild pipeline for dependency-backed library modules
>
><pre>
>• Introduces an executable build utility that bundles allowlisted library modules into redpill/bin/lib/dist as Node.js 20 CommonJS files. It externalizes selected Node.js built-ins, creates the output directory, reports successful builds, and exits nonzero on failure.
></pre>
>
><a href='https://github.com/jinrunsen/redpill/pull/1/files#diff-a05517244411e5e0f9925072128e63cb802ece3a279739e667ec1b8cd482fed0'>scripts/build-lib.js</a>

</details>

</dd>
</dl>

</details>

</dd>
</dl>

</details>