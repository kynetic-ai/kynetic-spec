---
name: reflect
description: Reflect on a session to identify learnings, friction points, and improvements. Captures valuable insights for future sessions and system evolution.
---

# Session Reflection

Structured reflection after significant work sessions. Surfaces learnings, identifies friction, and captures improvements.

## When to Reflect

- After completing a significant task or set of tasks
- After trying a new workflow or process
- When user requests reflection
- At natural session boundaries

## Reflection Framework

### 1. What Worked Well

Identify practices that were effective:
- Workflows that flowed smoothly
- Tools/commands that helped
- Communication patterns that kept alignment
- Decisions that proved correct

*Be specific - "categorizing items first" not "good planning"*

### 2. Friction Points

Identify where things were harder than needed:
- Repetitive manual steps
- Missing commands or options
- Context loss or re-explanation
- Workarounds used
- Bugs encountered

*Focus on systemic issues, not one-off mistakes*

### 3. Potential Improvements

For each friction point, consider:
- Could a CLI command help?
- Could a skill capture this pattern?
- Is this a spec gap?
- Is this a process/documentation issue?

Propose concrete improvements with:
- What it would do
- How it would help
- Rough scope (small/medium/large)

### 4. Discussion

Present findings to user:
- Summarize what worked (brief)
- Detail friction points (these matter most)
- Propose improvements (concrete ideas)

**Ask one at a time** about each improvement:
- Is this worth capturing?
- Any refinements to the idea?
- Related ideas from user perspective?

### 5. Capture

For improvements worth keeping:
```bash
kspec inbox add "Description of improvement idea" --tag reflection --tag <area>
```

Tag appropriately: `dx`, `workflow`, `cli`, `validation`, `process`

## Reflection Prompts

Use these to guide thinking:

**Process:**
- What pattern did I repeat more than 3 times?
- Where did I have to work around something?
- What context did I have to re-explain?

**Tools:**
- What command did I wish existed?
- What flag would have saved steps?
- What output format would have helped?

**Communication:**
- Where was the user surprised by my action?
- What decision should I have asked about earlier?
- What assumption did I make that was wrong?

**Learning:**
- What do I know now that I didn't at session start?
- What would I do differently if starting over?
- What should future agents know about this area?

## Output Format

Structure reflection as:

```markdown
## Session Reflection

### What Worked Well
- [Specific practice] - [Why it helped]
- ...

### Friction Points
1. **[Issue]** - [Description of friction]
2. ...

### Potential Improvements
| Idea | Value | Scope |
|------|-------|-------|
| [Concrete idea] | [How it helps] | small/medium/large |
| ...

### Capture These?
[Ask user which to add to inbox]
```

## Key Principles

- **Specific over general** - "No bulk AC add" not "CLI could be better"
- **Systemic over incidental** - Focus on repeatable friction
- **Concrete over vague** - Propose actual solutions
- **Ask don't assume** - User decides what's worth capturing
- **Brief on successes** - Friction points are the value

## Anti-patterns

- Listing everything that happened (not reflection)
- Vague complaints without solutions
- Assuming all ideas should be captured
- Skipping user discussion
- Forgetting to actually capture approved ideas

## Integration

Reflection pairs well with:
- `/triage` - Reflect after triage sessions
- Task completion - Reflect on significant implementations
- Debugging sessions - Capture what made it hard
