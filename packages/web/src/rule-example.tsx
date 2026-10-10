import { useMemo } from "react";
import { highlightReadingLines } from "./reading-code";

export function RuleExample({ source, language = "text" }: { source: string; language?: string }) {
  const html = useMemo(() => highlightReadingLines(source, language).join("\n"), [source, language]);
  return <pre className="code-block rule-example"><code data-language={language} dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}
