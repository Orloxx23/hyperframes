/**
 * Role-aware message bubble.
 *
 * Like AI Elements' <Message>: user messages float right, assistant
 * messages span the full column. We omit the avatar prop for now since
 * the editor has a single user identity — easy to add later.
 */

import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MessageProps {
  role: "user" | "assistant" | "system";
  children: ReactNode;
}

export function Message({ role, children }: MessageProps) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-studio-accent/15 border border-studio-accent/30 text-[12px] text-neutral-100 whitespace-pre-wrap leading-relaxed">
          {children}
        </div>
      </div>
    );
  }
  if (role === "system") {
    return (
      <div className="text-[11px] text-neutral-500 italic px-2 leading-relaxed">{children}</div>
    );
  }
  // assistant
  return <div className="flex flex-col gap-1.5">{children}</div>;
}

export interface MessageContentProps {
  /**
   * Assistant text. Rendered as GitHub-flavored markdown — partial markdown
   * during streaming still renders cleanly (any incomplete syntax falls back
   * to literal text on that line).
   */
  children: string;
}

// Render-time components map. Tuned for the 12px chat density of the agent
// panel — keep spacing tight and inherit colors from the surrounding theme.
// Keys mirror the HTML tag names ReactMarkdown emits.
const MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-neutral-50">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-studio-accent underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => (
    <h1 className="text-[14px] font-semibold text-neutral-50 mt-2 mb-1 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[13px] font-semibold text-neutral-50 mt-2 mb-1 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[12px] font-semibold text-neutral-50 mt-1.5 mb-0.5 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[12px] font-semibold text-neutral-100 mt-1.5 mb-0.5 first:mt-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="marker:text-neutral-500">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-neutral-700 pl-2 my-1 text-neutral-400 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-neutral-800" />,
  code: ({ className, children }) => {
    // react-markdown emits inline code as <code> without `className`, fenced
    // code blocks as <code className="language-foo"> inside a <pre>. The
    // <pre> handler below styles the block container; here we only style
    // inline code.
    const isInline = !className;
    if (isInline) {
      return (
        <code className="px-1 py-0.5 rounded bg-neutral-800/80 text-neutral-100 font-mono text-[11px]">
          {children}
        </code>
      );
    }
    return <code className={`${className} font-mono text-[11px]`}>{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="my-1 p-2 rounded bg-neutral-900 border border-neutral-800 overflow-x-auto text-[11px] leading-snug">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="border-collapse border border-neutral-800 text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-neutral-800 px-2 py-0.5 bg-neutral-900 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-neutral-800 px-2 py-0.5">{children}</td>,
};

/** Markdown-rendered assistant text. Preserves whitespace inside code blocks. */
export function MessageContent({ children }: MessageContentProps) {
  return (
    <div className="text-[12px] text-neutral-200 leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
