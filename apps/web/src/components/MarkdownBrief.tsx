import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownBrief({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:text-ink-100 prose-a:text-accent-bright">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
