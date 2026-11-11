# language: typescript

## Writing code for run_code

`run_code` takes two required arguments: `code`, the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped), and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "return await tools.bash({ description: 'Show current directory', command: 'pwd' })", description: "Show current directory" })`

Inside the program:

- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.
- Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  /** Run a command in the shell and return its output. */
  bash: {
    /** The command to run. */
    command: string;
    /** What this command does. */
    description: string;
    /** Optional deadline in seconds. */
    timeout?: number;
  } & Record<string, JsonValue>;
  /** Bash shape whose command field only accepts a constrained enum; the example must not render. */
  "bash-command-constrained": {
    command: "ls" | "cat";
    description: string;
  } & Record<string, JsonValue>;
  /** Bash shape with one required key beyond command/description; the example must not render. */
  "bash-extra-required": {
    command: string;
    description: string;
    workdir: string;
  } & Record<string, JsonValue>;
  /** An MCP-shaped tool whose parameters carry a root $schema annotation. */
  "mcp-external": {
    query: string;
  };
  /** An MCP-shaped tool with a $schema annotation nested inside a property. */
  mcp_nested: {
    inner: {
      value: number;
    } & Record<string, JsonValue>;
  } & Record<string, JsonValue>;
  /** Search the workspace index with a nested filter and an enum mode. */
  "search-index": {
    /** The text to search for. */
    query: string;
    filter?: {
      pathPrefix?: string;
      mode: "exact" | "fuzzy" | "regex";
    } & Record<string, JsonValue>;
  } & Record<string, JsonValue>;
}

interface ToolOutputMap {
  bash: string;
  "bash-command-constrained": string;
  "bash-extra-required": string;
  "mcp-external": string;
  mcp_nested: string;
  "search-index": {
    hits: string[];
    total: number;
  } & Record<string, JsonValue>;
}

type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: "ToolCallError";
  readonly toolName: ToolName;
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
}
```