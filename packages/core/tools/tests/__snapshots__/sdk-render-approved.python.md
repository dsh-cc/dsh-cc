# language: python

## Writing code for run_code

`run_code` takes two required arguments: `code`, the program to execute, and `description`, a short summary of what the program does. At run time exactly two of the names declared below are bound: `tools` and `ToolCallError`. Everything else is a STATIC STUB describing argument and return types — in particular the `TypedDict` classes do NOT exist at run time, so build arguments as plain `dict`/`list` JSON values: `await tools.name({"field": 1})`, never `FooArgs(field=1)`, which raises `NameError`. Inside the program:

- Call tools as `await tools.name(args)` — subscript access for exotic, reserved, or underscore-leading names: `await tools["my-tool"](args)`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises `ToolCallError`, whose `toolName` identifies the failed tool and whose message is human-readable — wrap in `try/except` to handle and continue.
- Independent read-only calls MAY overlap under `asyncio.gather` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Only values emitted as program output enter the conversation. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:

```python
from typing import Literal, NotRequired, Protocol, TypedDict

class ToolCallError(Exception):
    toolName: str

class BashArgs(TypedDict):
    # The command to run.
    command: str
    # What this command does.
    description: str
    # Optional deadline in seconds.
    timeout: NotRequired[float]
    # Additional keys beyond those declared are allowed.

class BashCommandConstrainedArgs(TypedDict):
    command: Literal["ls", "cat"]
    description: str
    # Additional keys beyond those declared are allowed.

class BashExtraRequiredArgs(TypedDict):
    command: str
    description: str
    workdir: str
    # Additional keys beyond those declared are allowed.

class McpExternalArgs(TypedDict):
    query: str

class McpNestedArgsInner(TypedDict):
    value: float
    # Additional keys beyond those declared are allowed.

class McpNestedArgs(TypedDict):
    inner: McpNestedArgsInner
    # Additional keys beyond those declared are allowed.

class SearchIndexArgsFilter(TypedDict):
    pathPrefix: NotRequired[str]
    mode: Literal["exact", "fuzzy", "regex"]
    # Additional keys beyond those declared are allowed.

class SearchIndexArgs(TypedDict):
    # The text to search for.
    query: str
    filter: NotRequired[SearchIndexArgsFilter]
    # Additional keys beyond those declared are allowed.

class SearchIndexOutput(TypedDict):
    hits: list[str]
    total: float
    # Additional keys beyond those declared are allowed.

class Tools(Protocol):
    async def bash(self, args: BashArgs) -> str:
        """Run a command in the shell and return its output."""
    # tools["bash-command-constrained"](args: BashCommandConstrainedArgs) -> str
    #   Bash shape whose command field only accepts a constrained enum; the example must not render.
    # tools["bash-extra-required"](args: BashExtraRequiredArgs) -> str
    #   Bash shape with one required key beyond command/description; the example must not render.
    # tools["mcp-external"](args: McpExternalArgs) -> str
    #   An MCP-shaped tool whose parameters carry a root $schema annotation.
    async def mcp_nested(self, args: McpNestedArgs) -> str:
        """An MCP-shaped tool with a $schema annotation nested inside a property."""
    # tools["search-index"](args: SearchIndexArgs) -> SearchIndexOutput
    #   Search the workspace index with a nested filter and an enum mode.

tools: Tools
```