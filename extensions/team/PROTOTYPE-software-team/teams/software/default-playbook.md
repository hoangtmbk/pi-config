---
sendBackLimit: 2
checkpoints:
  - id: design-review
    when: >-
      The architect's design is accepted by the Lead and adds a module, a dependency, a public
      interface (a tool's parameters or output, a command, a config key) or a data format. Before
      any dev Task starts. A design that changes none of these needs no checkpoint.
  - id: new-dependency
    when: >-
      A Task's result adds a third-party dependency the human didn't see in an approved design.
      Before the Lead accepts that Task.
  - id: ci-and-release
    when: >-
      A Task's result changes CI config, release or publish scripts, or anything that runs
      outside this checkout. Before the Lead accepts that Task.
permissions:
  grants: []                   # none by default; e.g. {id: push-effort-branch, allow: push team/<effort-id> to origin, never with force}
  escalate:
    - id: history-rewrite
      when: >-
        Any git reset --hard, git clean, branch deletion, rebase or force-push, even on the
        Effort's own branch.
      ask:                     # forces a prompt so the request reaches the Lead; best effort, literal match
        - "Bash(git reset --hard:*)"
        - "Bash(git clean:*)"
        - "Bash(git branch -D:*)"
        - "Bash(git branch -d:*)"
        - "Bash(git rebase:*)"
        - "Bash(git push --force:*)"
        - "Bash(git push -f:*)"
  roles: {}                    # no per-Role mode or rules; Roles run in auto
---

# Software Team: default Playbook

How the Lead runs this Team. **Rules** are the bullets that start with a bold id. The Lead must
follow them, and departing from one is a per-Effort override on the Brief, named by that id.
Everything else is guidance, and the Lead uses its judgment there.

## Who does what

| Role | Gets Tasks to | Hands back |
|---|---|---|
| architect | design the change; review a dev's diff against the design | a design note; a review |
| dev | build one slice of the design | commits on the Effort's branch, test output |
| qa | verify the integrated change against the Brief | a criteria → evidence → verdict table, defects |

- **one-architect**: at most one architect per Effort. Design is one voice.
- **parallel-devs-disjoint**: two devs run at once only on slices the design says share no files.
  Otherwise dev Tasks run one after another.
- The Lead staffs QA only once there's an integrated change to verify, and stops the architect
  once the last review is done, to free a slot under `maxTeammates`.

## Order of work

The usual shape is **design → build → review → verify**:

1. **design-first**: an architect Task comes before any dev Task, unless the Brief already gives
   the design: files, interfaces, approach. A one-file fix with an obvious approach counts.
   Then the Lead writes the Task breakdown itself.
2. Dev Tasks follow the design's breakdown and order. The Lead may split or reorder them (that is
   re-planning, its own call) but never changes the design's approach without a new architect
   Task.
3. **review-against-design**: when a dev Task changes more than ~200 lines or touches an
   interface the design names, the architect reviews the diff before the Lead accepts it.
   Smaller Tasks the Lead reviews alone.
4. **qa-before-signoff**: a QA Task covering every acceptance criterion runs on the final commit
   range before the Lead proposes done. A send-back at sign-off that changes code needs a fresh
   QA pass on what changed.

## What a Task says

Every Task the Lead hands out names:

- the goal, in a sentence, and the parts of the Brief it serves (acceptance criterion ids),
- its inputs: the Brief files, the design note, the commit range, earlier results,
- what the Teammate owns (files, for a dev) and what it must not touch,
- how the Lead will judge it done, and the evidence to hand back,
- where to write any output file.

A Teammate shouldn't have to ask the Lead what its Task means. If one does, the Task was
under-specified, and the Lead fixes that in the next Task it writes.

## What counts as done

- **A design** is done when every acceptance criterion maps to a part of it, the breakdown names
  file ownership, and it has no open question the Brief doesn't answer.
- **A dev Task** is done when its commits are on the branch, the repo's tests and type check pass,
  the new behaviour has tests, and the result lists what was skipped.
- **QA** is done when every acceptance criterion has evidence and a verdict, and there are no
  open defects. A defect the Lead judges outside the Brief goes in the final report, not into
  another Task.
- **The Effort** is done when QA says every criterion is met on the final commit range and the
  delivery the Brief asks for (a branch, a PR) exists. The final report maps each criterion to
  QA's evidence.

## Reviewing and send-backs

- The Lead checks each result against its Task and the Brief, from the evidence handed back. It
  re-runs nothing heavier than a quick check. Anything heavier is a Task for QA.
- **feedback-is-specific**: a send-back lists each problem with where it is and what "fixed"
  looks like. "Make it better" is not a send-back.
- After `sendBackLimit` send-backs of the same Task, the Lead brings it to the human with the
  feedback history and its own guess at why it keeps failing (a wrong design, a vague Brief, a
  Teammate stuck in a loop).

## When to come back to the human

On top of the fixed checkpoints and the `checkpoints` above:

- **criteria-are-the-human's**: if an acceptance criterion turns out ambiguous or wrong, the Lead
  asks. It doesn't reinterpret it. A clarification answers an ambiguity; anything that changes a
  criterion is a Brief change.
- Naming, internal structure, test layout and refactors inside the files a Task owns are the
  Lead's call (and the Teammates') unless the Brief says otherwise.
- **scope-creep**: work a Teammate finds that the Brief doesn't ask for (a bug nearby, a tempting
  refactor) goes in the final report as a suggestion. It never becomes a Task without a Brief
  change.

## Conventions

- **one-branch**: the Effort works on one branch, `team/<effort-id>`, cut from the default
  branch at Brief approval. Nobody commits to the default branch.
- Teammates follow the repo's `AGENTS.md`, `CLAUDE.md` and coding standards. The Lead passes
  any the Brief adds.
- Pushing the branch or opening a PR is past the Lead's floor. It happens only when the Brief's
  delivery asks for it, or with the human's answer at the time.
