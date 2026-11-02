# Teammates are Claude Code background sessions, with tmux only as a viewer

A Teammate is a `claude --bg` session started by the team extension, and the human gets in with
`claude attach <id>` from any terminal. When tmux is installed, the extension can also open every
Teammate in tmux windows (`claude attach` in each), but tmux never hosts a Teammate. Both hosts meet
the two requirements: each is an interactive Claude Code session billed to the human's subscription
(never `-p`), and each lets the human watch the live TUI and type into it. The difference is what
the host costs. tmux as host brings back the hard dependency ADR-0001 rejected for subagents, and
keystroke injection, which appends to the human's half-typed draft, loses Enters and races TUI
readiness. `--bg` is built in, its inbox socket, clear mod, wake and trust handling were tested end
to end on Claude Code 2.1.316 (#84), and several terminals can attach at once.

## Consequences

An unattached, idle background session is stopped silently after about an hour. The extension wakes
it on the next message with `claude --bg --resume <session id> "<message>"`, which keeps its saved
options but gives it a new socket path. Nothing can press a key in a Teammate, so a dialog that waits
for a person, such as the plan-approval card, waits for the human: Teammates are launched with
`EnterPlanMode` disallowed for that reason. Choosing tmux as host would buy no idle stop and a keystroke fallback, and
would cost a dependency and an untested socket.
