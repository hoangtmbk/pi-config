# RPC child processes for subagents

A run is a `pi --mode rpc` child process driven by pi's exported `RpcClient`, rather than an
in-process `createAgentSession()` or an interactive pi in a tmux pane. A separate process gives
crash isolation and a hard tool boundary that an in-process session cannot; RPC's bidirectional
JSONL stdio gives multi-turn prompting, steering and abort, which pi's own `--mode json -p` example
cannot (it is one-shot and output-only, so a child could never be asked a second thing — and
child→parent questions are a requirement). tmux panes were the other real option and are what
`pi-interactive-subagents` does: they buy a human-attachable session, at the cost of a hard tmux
dependency, pane layout management, shell-readiness races, and not working in a plain terminal.

## Consequences

The process is long-lived and must be explicitly killed — children are SIGTERMed on parent abort
and on `session_shutdown`, because an orphaned pi child burns tokens invisibly. The RPC stream is
strict LF-only JSONL: Node's `readline` is not protocol-compliant for it (it also splits on
U+2028/U+2029, legal inside JSON strings), which is a reason to use `RpcClient` rather than a
hand-rolled reader.
