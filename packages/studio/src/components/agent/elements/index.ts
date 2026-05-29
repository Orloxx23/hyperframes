/**
 * AI-Elements-inspired chat primitives, hand-rolled for Tailwind v3.
 *
 * These mirror the structure of Vercel's @ai-sdk/elements but skip the
 * shadcn / Tailwind v4 / framer-motion stack. Look-and-feel is intended
 * to converge with the original so the docs over there still serve as a
 * good reference.
 */

export { Conversation, type ConversationProps } from "./Conversation";
export { Message, MessageContent, type MessageProps, type MessageContentProps } from "./Message";
export {
  Tool,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolProps,
  type ToolContentProps,
  type ToolInputProps,
  type ToolOutputProps,
  type ToolState,
} from "./Tool";
export { Reasoning, type ReasoningProps } from "./Reasoning";
export { PromptInput, type PromptInputProps } from "./PromptInput";
export { Loader, type LoaderProps } from "./Loader";
