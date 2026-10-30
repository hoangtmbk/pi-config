# Human steering informs the parent

A human's message to a running run, sent from the Inspector, goes straight into the child as an
RPC `steer`; the parent session gets a note saying what was sent, delivered without `triggerTurn`.
Going through the parent instead — the human asks, the parent's model relays — would put a model
between a person and a task they can already see is going wrong. But the child alone cannot be the
only one who knows: the parent delegated a specific task, and a result shaped by an instruction the
parent never saw looks like a run that ignored its task. So the parent has to know the run's
direction changed before the result arrives. It does not have to *act* on it, and triggering a turn
would have the parent model react to every small redirect, spending a turn and possibly
second-guessing the human each time.

## Consequences

A message to a Waiting run is an answer from the user, which makes two answerers for one question;
the user's wins, and a later `subagent_answer` for that question fails with "already answered by
the user" rather than feeding the run a second, stale prompt. The note uses its own `customType`
(`subagent-steer`) so it reads as distinct from a delivered result. The parent's model gets no steer
tool: steering is a human seeing a transcript and correcting course, and the model's channel into a
run stays `subagent_answer`.
