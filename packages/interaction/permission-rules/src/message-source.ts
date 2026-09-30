/**
 * Message-source kind for the permission-rules producer (own named kind;
 * harness-0.1.7 write side never uses the retired 'plugin' kind).
 * @module @dsh-cc/permission-rules/message-source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'permission-rules': { readonly kind: 'permission-rules' } & ContextFormed
  }
}
